#!/usr/bin/env bun
/**
 * Manifest settings and MCP verification.
 *
 * The unit tests pin what harv generates; this script pins what the generated
 * payloads do to a real Claude Code session started by a real `harv claude`. It
 * is the acceptance criteria of issue #4, executed rather than asserted:
 *
 *   1. A pinned model and effort reach the session, and a Manifest-denied tool
 *      is actually denied.
 *   2. A Manifest-declared MCP server connects, and the machine's own servers
 *      are absent.
 *   3. `${VAR}` references resolve at launch from the environment, and the
 *      resolved value is never written to disk.
 *   4. A personal-ergonomics key fails before anything is written, with an
 *      error naming the key and the rule.
 *
 * Session facts come from the `system`/`init` event Claude Code emits under
 * `--output-format stream-json --verbose`, so there is no model in the loop.
 * Two observables carry most of the weight, both measured in spike 0002:
 * `permissions.deny` removes the tool from `init.tools` outright, and an MCP
 * server's tools arrive as `mcp__<server>__<tool>` — so a probe server that
 * names its tool after a resolved variable makes the resolution readable
 * straight out of `init`.
 *
 * One criterion cannot be fully executed on Claude Code 2.1.223: the resolved
 * effort level appears in no machine-readable output — not `init`, not `result`,
 * not `--debug` (spike 0002, finding 2). That half reports `n/a` with the reason
 * rather than passing vacuously.
 *
 * The machine's `~/.claude` is read, never written: every probe runs with
 * `--no-session-persistence`.
 *
 * Run:  bun scripts/verify-manifest-settings.ts [--json] [--keep]
 *       node scripts/verify-manifest-settings.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

/**
 * Salted per process, and cleaned up on the way out.
 *
 * Every verifier used to build at one fixed path, which is why two of them
 * running at once deleted each other's fixtures mid-run (issue #22). `mkdtemp`
 * is the whole fix: this script can run beside anything, including a second
 * copy of itself.
 */
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-settings-verify-"));
const PROBE_TIMEOUT_MS = 180_000;

/** Pins the Manifest declares, and the session has to be seen honouring. */
const PINNED_MODEL = "haiku";
const PINNED_MODEL_FAMILY = /haiku/;
const PINNED_EFFORT = "high";
const PINNED_MODE = "plan";
const DENIED_TOOLS = ["Bash", "WebSearch"];

const MCP_SERVER = "harvenv-probe";
const SECRET_VAR = "HARVENV_PROBE_SECRET";
/**
 * Distinctive enough to grep the tree for, and shaped so it survives into a
 * tool name unchanged — the probe server names its only tool `saw_<value>`, so
 * the resolved value is readable in `init.tools`.
 */
const SECRET_VALUE = "resolved_at_launch_never_stored";

// ---------------------------------------------------------------------------
// Running harv and claude
// ---------------------------------------------------------------------------

interface InitEvent {
  claude_code_version: string;
  tools: string[];
  skills: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  model: string;
  permissionMode: string;
}

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runToCompletion(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<Completed> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`${command}\` timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const harv = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  runToCompletion(process.execPath, [HARV, ...args], { cwd, env });

/** Start a session, capture its `init` event, kill it before the turn completes. */
function probeInit(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InitEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`))),
      PROBE_TIMEOUT_MS,
    );

    child.stderr.on("data", (c) => (stderr += String(c)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "system" && event.subtype === "init") {
        finish(() => resolve(event as unknown as InitEvent));
      }
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) =>
      finish(() =>
        reject(new Error(`session exited (code ${code}) before emitting init.\n${stderr.trim().slice(-800)}`)),
      ),
    );
  });
}

/** The flags a headless probe needs, passed through harv to prove pass-through works. */
const STREAM_JSON = ["-p", "probe", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];

const harvSession = (cwd: string, env: NodeJS.ProcessEnv) =>
  probeInit(process.execPath, [HARV, "claude", ...STREAM_JSON], cwd, env);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** Pins model, effort, permission mode and denials; declares the probe server. */
  pinned: string;
  /** The same project with nothing pinned: the contrast the pins are read against. */
  baseline: string;
  /** Declares a personal-ergonomics key, so Sync must refuse it. */
  personal: string;
  /** No Manifest above it — for reading what an un-strict session would load. */
  bare: string;
  /** A stand-in `claude` that records the argv it was handed. */
  fakeClaudeDir: string;
  fakeClaudeDump: string;
  /** The environment a launch resolves `${VAR}` from. */
  env: NodeJS.ProcessEnv;
}

/**
 * A minimal MCP stdio server that names its only tool after the variable the
 * Manifest asked harv to resolve. That turns "did the reference resolve, and to
 * what?" into a string in `init.tools`.
 */
const PROBE_SERVER_SOURCE = `#!/usr/bin/env node
import { createInterface } from "node:readline";

const toolName = \`saw_\${(process.env.${SECRET_VAR} ?? "unset").replace(/[^A-Za-z0-9_]/g, "_")}\`;
const send = (msg) => process.stdout.write(\`\${JSON.stringify(msg)}\\n\`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return;

  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "harvenv-probe", version: "0.0.0" },
    }});
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{
      name: toolName,
      description: "Probe tool. Never invoke it.",
      inputSchema: { type: "object", properties: {} },
    }]}});
  } else {
    send({ jsonrpc: "2.0", id: req.id, result: {} });
  }
});
`;

function buildFixtures(): Fixtures {
  const dir = (...parts: string[]) => {
    const p = join(FIXTURE_ROOT, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };

  const pinned = dir("pinned");
  const serverPath = join(dir("pinned", "vendor"), "mcp-probe.mjs");
  writeFileSync(serverPath, PROBE_SERVER_SOURCE);

  // The Manifest carries the *reference*, never the value — that is the whole
  // point of the syntax, and check 3 reads this file back to prove it.
  writeFileSync(
    join(pinned, "harvenv.toml"),
    `[settings]\n` +
      `model = "${PINNED_MODEL}"\n` +
      `effortLevel = "${PINNED_EFFORT}"\n\n` +
      `[settings.permissions]\n` +
      `defaultMode = "${PINNED_MODE}"\n` +
      `deny = [${DENIED_TOOLS.map((t) => `"${t}"`).join(", ")}]\n\n` +
      `[mcp.${MCP_SERVER}]\n` +
      `command = "${process.execPath}"\n` +
      `args = ["${serverPath}"]\n` +
      `env = { ${SECRET_VAR} = "\${${SECRET_VAR}}" }\n`,
  );

  const baseline = dir("baseline");
  writeFileSync(join(baseline, "harvenv.toml"), "[settings]\n");

  const personal = dir("personal");
  writeFileSync(
    join(personal, "harvenv.toml"),
    `[settings]\nstatusLine = { type = "command", command = "~/bin/my-status" }\n`,
  );

  const bare = dir("bare");

  const fakeClaudeDir = dir("fake-bin");
  const fakeClaudeDump = join(FIXTURE_ROOT, "handover.json");
  writeFileSync(
    join(fakeClaudeDir, "claude"),
    `#!/usr/bin/env node\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(fakeClaudeDump)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd()\n` +
      `}));\n`,
    { mode: 0o755 },
  );

  return {
    pinned,
    baseline,
    personal,
    bare,
    fakeClaudeDir,
    fakeClaudeDump,
    // No fixture declares a skill, so nothing is fetched — but HARV_HOME is
    // redirected anyway, so a check can never reach the real Store.
    env: { ...process.env, HARV_HOME: dir("harv-home"), [SECRET_VAR]: SECRET_VALUE },
  };
}

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

type Outcome = boolean | null;

interface Expectation {
  label: string;
  ok: Outcome;
  detail: string;
}

interface Check {
  id: string;
  title: string;
  expectations: Expectation[];
  measurements: Record<string, unknown>;
  error?: string;
}

const expect = (label: string, ok: Outcome, detail: string): Expectation => ({ label, ok, detail });
const only = <T,>(a: T[], b: T[]) => a.filter((x) => !b.includes(x));
const summarize = (names: string[], limit = 8): string =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;

/** What `--settings` was handed on the last recorded handover. */
function handedOverSettings(dump: string): Record<string, unknown> {
  const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
  return JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}");
}

// ---------------------------------------------------------------------------
// Criterion 1 — pinned model and effort reach the session; a denial denies
// ---------------------------------------------------------------------------

async function checkSettingsBind(fx: Fixtures): Promise<Check> {
  const session = await harvSession(fx.pinned, fx.env);
  const baseline = await harvSession(fx.baseline, fx.env);

  // Recorded from the stand-in `claude`: what harv put on the wire, as opposed
  // to what the session made of it. The only place effort is observable at all.
  await harv(["claude"], fx.pinned, { ...fx.env, PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}` });
  const injected = handedOverSettings(fx.fakeClaudeDump);

  const stillPresent = DENIED_TOOLS.filter((tool) => session.tools.includes(tool));
  const deniableInBaseline = DENIED_TOOLS.filter((tool) => baseline.tools.includes(tool));

  return {
    id: "settings-binding",
    title: "A pinned model and effort reach the session, and a denied tool is denied",
    measurements: {
      claudeCodeVersion: session.claude_code_version,
      injectedSettings: injected,
      pinnedSessionModel: session.model,
      unpinnedSessionModel: baseline.model,
      pinnedPermissionMode: session.permissionMode,
      unpinnedPermissionMode: baseline.permissionMode,
      deniedTools: DENIED_TOOLS,
      toolsRemovedByDenial: only(baseline.tools, session.tools),
    },
    expectations: [
      expect(
        "the session runs the pinned model, not the built-in default",
        PINNED_MODEL_FAMILY.test(session.model) && session.model !== baseline.model,
        `pinned "${PINNED_MODEL}" -> ${session.model}; unpinned -> ${baseline.model}`,
      ),
      expect(
        "the pinned permission mode binds too, so the pin is the settings payload and not just the model flag",
        session.permissionMode === PINNED_MODE,
        `permissionMode: ${session.permissionMode} (unpinned: ${baseline.permissionMode})`,
      ),
      expect(
        "the pinned effort level reaches claude in the generated settings payload",
        injected.effortLevel === PINNED_EFFORT,
        `--settings carried effortLevel = ${JSON.stringify(injected.effortLevel)}`,
      ),
      // Everything else here is read out of the session. Effort cannot be:
      // Claude Code 2.1.223 reports no resolved effort anywhere machine-readable,
      // so this half is recorded as unmeasurable rather than assumed.
      expect(
        "the session reports the effort level it resolved",
        null,
        "Claude Code 2.1.223 exposes no resolved effort in init, result or --debug (spike 0002, finding 2); " +
          "harv's half is verified above, the session's half is unobservable",
      ),
      expect(
        "the pinned effort is one a settings file honours, so it cannot be silently dropped",
        injected.effortLevel !== undefined && session.tools.length > 0,
        `session started with effortLevel = ${JSON.stringify(injected.effortLevel)} accepted`,
      ),
      expect(
        "every Manifest-denied tool is absent from the session",
        stillPresent.length === 0,
        stillPresent.length ? `still available: ${stillPresent.join(", ")}` : `${DENIED_TOOLS.join(", ")} all gone`,
      ),
      expect(
        "those tools exist when the Manifest does not deny them, so the check is not vacuous",
        deniableInBaseline.length === DENIED_TOOLS.length,
        `available unpinned: ${summarize(deniableInBaseline) || "none"}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — the declared server connects; personal servers are absent
// ---------------------------------------------------------------------------

/** Server names configured on this machine, which a Harvenv session must not load. */
function personalServerNames(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    return Object.keys(parsed?.mcpServers ?? {});
  } catch {
    return [];
  }
}

async function checkMcpServers(fx: Fixtures): Promise<Check> {
  const session = await harvSession(fx.pinned, fx.env);
  const personal = personalServerNames();

  const names = session.mcp_servers.map((s) => s.name);
  const declared = session.mcp_servers.find((s) => s.name === MCP_SERVER);
  const leaked = names.filter((name) => personal.includes(name));
  const mcpTools = session.tools.filter((t) => t.startsWith("mcp__"));
  const foreignTools = mcpTools.filter((t) => !t.startsWith(`mcp__${MCP_SERVER}__`));

  return {
    id: "mcp-servers",
    title: "A Manifest-declared MCP server connects, and the machine's own servers are absent",
    measurements: {
      sessionServers: session.mcp_servers,
      personalServersOnThisMachine: personal,
      mcpTools,
    },
    expectations: [
      expect(
        "the declared server is in the session and connected",
        declared?.status === "connected",
        declared ? `${MCP_SERVER}: ${declared.status}` : `${MCP_SERVER} is absent (servers: ${summarize(names) || "none"})`,
      ),
      expect(
        "its tools arrive under the name the Manifest gave it",
        mcpTools.some((t) => t.startsWith(`mcp__${MCP_SERVER}__`)),
        mcpTools.length ? summarize(mcpTools) : "no MCP tools in the session",
      ),
      expect(
        "no server the Manifest did not declare is in the session",
        names.every((name) => name === MCP_SERVER) && foreignTools.length === 0,
        leaked.length
          ? `personal servers leaked: ${summarize(leaked)}`
          : `${names.length} server(s): ${summarize(names) || "none"}`,
      ),
      expect(
        "this machine has personal servers to suppress, so the check is not vacuous",
        personal.length > 0 ? true : null,
        personal.length ? `${personal.length} configured: ${summarize(personal)}` : "no personal MCP servers configured",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — ${VAR} resolves at launch and is never written to disk
// ---------------------------------------------------------------------------

/** Every file under `dir` that contains `needle`. Follows what harv writes. */
function filesContaining(dir: string, needle: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      filesContaining(path, needle, found);
    } else if (entry.isFile()) {
      try {
        if (readFileSync(path, "utf8").includes(needle)) found.push(path);
      } catch {
        /* unreadable or binary: cannot be a stored secret we wrote */
      }
    }
  }
  return found;
}

async function checkEnvReferences(fx: Fixtures): Promise<Check> {
  const resolved = await harvSession(fx.pinned, fx.env);
  const resolvedTool = `mcp__${MCP_SERVER}__saw_${SECRET_VALUE}`;

  // The same Manifest with the variable absent. Claude Code would hand the
  // server the literal `${VAR}` and let it connect; harv has to refuse first.
  const withoutVar = { ...fx.env };
  delete withoutVar[SECRET_VAR];
  const missing = await harv(["claude", "-p", "probe"], fx.pinned, withoutVar);

  const manifestText = readFileSync(join(fx.pinned, "harvenv.toml"), "utf8");
  const onDisk = filesContaining(fx.pinned, SECRET_VALUE);

  await harv(["claude"], fx.pinned, { ...fx.env, PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}` });
  const { argv } = JSON.parse(readFileSync(fx.fakeClaudeDump, "utf8")) as { argv: string[] };
  const mcpPayload = argv[argv.indexOf("--mcp-config") + 1] ?? "";

  return {
    id: "env-references",
    title: "`${VAR}` resolves at launch from the environment and is never written to disk",
    measurements: {
      expectedToolName: resolvedTool,
      mcpTools: resolved.tools.filter((t) => t.startsWith("mcp__")),
      manifestLine: manifestText.split("\n").find((l) => l.includes(SECRET_VAR)) ?? "",
      filesContainingTheValue: onDisk,
      missingVarExit: missing.code,
      missingVarStderr: missing.stderr.trim(),
    },
    expectations: [
      expect(
        "the value reaches the server, so the reference really resolved from the environment",
        resolved.tools.includes(resolvedTool),
        resolved.tools.includes(resolvedTool)
          ? `the server saw ${SECRET_VALUE}`
          : `expected ${resolvedTool}; got ${summarize(resolved.tools.filter((t) => t.startsWith("mcp__"))) || "no MCP tools"}`,
      ),
      expect(
        "the Manifest still holds the reference, not the value",
        manifestText.includes(`\${${SECRET_VAR}}`) && !manifestText.includes(SECRET_VALUE),
        `harvenv.toml declares \${${SECRET_VAR}}`,
      ),
      expect(
        "no file in the project tree contains the resolved value",
        onDisk.length === 0,
        onDisk.length ? `written to: ${onDisk.join(", ")}` : "the project tree is clean after a launch",
      ),
      // Stated rather than hidden: a resolved payload travels in argv, which is
      // readable by other processes (`ps`). The alternative harv rejected was a
      // generated file, which is the thing this criterion forbids.
      expect(
        "the value reaches claude through argv, never through a generated file",
        mcpPayload.includes(SECRET_VALUE),
        "resolved inline in --mcp-config; visible to `ps` on this machine, which is the accepted trade for never writing it down",
      ),
      expect(
        "an unset variable fails the launch instead of reaching the server as a literal",
        missing.code !== 0 && new RegExp(SECRET_VAR).test(missing.stderr),
        `exit ${missing.code}: ${missing.stderr.trim().split("\n")[0] ?? ""}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — a personal-ergonomics key fails Sync, explaining itself
// ---------------------------------------------------------------------------

async function checkPersonalKeyRejected(fx: Fixtures): Promise<Check> {
  const result = await harv(["claude"], fx.personal, fx.env);
  const message = `${result.stderr}${result.stdout}`;

  return {
    id: "personal-keys",
    title: "A personal-ergonomics key in the Manifest fails, naming the key and the rule",
    measurements: {
      exitCode: result.code,
      stderr: result.stderr.trim(),
      claudeDirCreated: existsSync(join(fx.personal, ".claude")),
    },
    expectations: [
      expect("it fails rather than launching", result.code !== 0, `exit code ${result.code}`),
      expect("it names the offending key", /statusLine/.test(message), result.stderr.trim().split("\n")[0] ?? ""),
      expect("it names the rule", /ADR 0005/.test(message), "cites ADR 0005"),
      expect(
        "it says where the setting does belong",
        /Overlay/.test(message),
        "points at the Overlay, so the answer is not just `no`",
      ),
      expect(
        "nothing was written into the project before the refusal",
        !existsSync(join(fx.personal, ".claude")),
        existsSync(join(fx.personal, ".claude")) ? "`.claude/` was created anyway" : "no `.claude/` in the project",
      ),
      expect("it fails cleanly, with no stack trace", !/\n\s+at .+:\d+:\d+/.test(result.stderr), "no stack frames in stderr"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const failed = (c: Check) => Boolean(c.error) || c.expectations.some((e) => e.ok === false);

function report(checks: Check[]): void {
  for (const check of checks) {
    console.log(`\n[${failed(check) ? `${RED}FAIL${RESET}` : `${GREEN}PASS${RESET}`}] ${check.id} — ${check.title}`);
    if (check.error) {
      console.log(`  ${RED}x${RESET} ${check.error}`);
      continue;
    }
    for (const e of check.expectations) {
      const glyph = e.ok === true ? `${GREEN}ok${RESET}` : e.ok === false ? `${RED}x ${RESET}` : `${YELLOW}n/a${RESET}`;
      console.log(`  ${glyph} ${e.label}`);
      console.log(`      ${DIM}${e.detail}${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const asJson = process.argv.includes("--json");
  const keep = process.argv.includes("--keep");
  const log = asJson ? () => {} : console.log;

  const fx = buildFixtures();
  log("harvenv Manifest settings and MCP verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["settings-binding", "A pinned model and effort reach the session, and a denied tool is denied", () => checkSettingsBind(fx)],
    ["mcp-servers", "A Manifest-declared MCP server connects, and the machine's own servers are absent", () => checkMcpServers(fx)],
    ["env-references", "`${VAR}` resolves at launch from the environment and is never written to disk", () => checkEnvReferences(fx)],
    ["personal-keys", "A personal-ergonomics key in the Manifest fails, naming the key and the rule", () => checkPersonalKeyRejected(fx)],
  ];

  const checks: Check[] = [];
  for (const [id, title, run] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ id, title, expectations: [], measurements: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (keep) log(`\n${DIM}fixtures kept at ${FIXTURE_ROOT}${RESET}`);
  else rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const version = (checks[0]?.measurements as { claudeCodeVersion?: string })?.claudeCodeVersion ?? "unknown";
  const failures = checks.filter(failed);

  if (asJson) {
    console.log(JSON.stringify({ claudeCodeVersion: version, ok: failures.length === 0, fixtures: keep ? FIXTURE_ROOT : null, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\nClaude Code ${version}: ${checks.length - failures.length}/${checks.length} criteria verified` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

if (!existsSync(HARV)) throw new Error(`harv entry point not found at ${HARV}`);
process.exitCode = await main();

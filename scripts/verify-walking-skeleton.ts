#!/usr/bin/env bun
/**
 * Walking-skeleton verification.
 *
 * The unit tests pin harv's logic; this script pins the thing the logic exists
 * to produce — a real Claude Code session, started by a real `harv claude`,
 * loading exactly the declared Harvenv. It is the acceptance criteria of
 * issue #2, executed rather than asserted:
 *
 *   1. `harv claude` in a Manifest-bearing project yields a session containing
 *      only declared skills plus Claude Code's built-ins.
 *   2. Outside a harvenv project it fails with a clear "no Manifest" error.
 *   3. Login, session history and MCP auth are unaffected — the user config
 *      directory is neither redirected nor written to.
 *   4. Extra arguments reach claude unchanged (`harv claude -p "hi"`).
 *
 * Like spike 0001, the session facts come from the `system`/`init` event
 * Claude Code emits under `--output-format stream-json --verbose`: it carries
 * the fully resolved inventory the session runs with, so there is no model in
 * the loop. Check 3 additionally runs harv against a *stand-in* `claude` that
 * records the argv, environment and working directory it was handed — the only
 * way to observe what harv passes rather than what the session made of it.
 *
 * The machine's `~/.claude` is read, never written. Check 3 does complete one
 * persisted session, which writes that session's own history under
 * `~/.claude/projects` exactly as any session does; the fixture path is stable
 * across runs, so repeated verification reuses one history entry rather than
 * accumulating them.
 *
 * Run:  bun scripts/verify-walking-skeleton.ts [--json] [--keep]
 *       node scripts/verify-walking-skeleton.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

/**
 * Stable, so repeated runs reuse one entry under `~/.claude/projects` instead
 * of accumulating them. Resolved through `realpath` because macOS reaches its
 * temp directory through the `/var` -> `/private/var` symlink, and a spawned
 * process reports the resolved form as its cwd.
 */
const FIXTURE_ROOT = join(realpathSync(tmpdir()), "harvenv-skeleton-verify");
const FIXTURE_MARKER = "harvenv-skeleton-verify";

const DECLARED_SKILLS = ["harvenv-skeleton-alpha", "harvenv-skeleton-beta"];
const PROBE_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Running harv and claude
// ---------------------------------------------------------------------------

interface InitEvent {
  claude_code_version: string;
  skills: string[];
  slash_commands: string[];
  agents: string[];
  plugins: Array<{ name: string }>;
  mcp_servers: Array<{ name: string; status: string }>;
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
function probeInit(command: string, args: string[], cwd: string): Promise<InitEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** A harvenv project declaring DECLARED_SKILLS from local paths. */
  project: string;
  /** No Manifest anywhere above it. */
  bare: string;
  /** Holds a stand-in `claude` that records how it was invoked. */
  fakeClaudeDir: string;
  fakeClaudeDump: string;
}

function buildFixtures(): Fixtures {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  const dir = (...parts: string[]) => {
    const p = join(FIXTURE_ROOT, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };

  const project = dir("project");
  for (const name of DECLARED_SKILLS) {
    writeFileSync(
      join(dir("project", "vendor", name), "SKILL.md"),
      `---\nname: ${name}\ndescription: Marker skill for the harvenv walking-skeleton check. Never invoke it.\n---\n\nMarker only.\n`,
    );
  }
  writeFileSync(
    join(project, "harvenv.toml"),
    `[skills]\n${DECLARED_SKILLS.map((n) => `${n} = { path = "vendor/${n}" }`).join("\n")}\n`,
  );

  // `bare` sits under the fixture root, which has no Manifest above it either.
  const bare = dir("bare");

  // A `claude` that answers the question "what did harv actually hand over?".
  const fakeClaudeDir = dir("fake-bin");
  const fakeClaudeDump = join(FIXTURE_ROOT, "handover.json");
  const fake = join(fakeClaudeDir, "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(fakeClaudeDump)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env\n` +
      `}));\n`,
    { mode: 0o755 },
  );

  return { project, bare, fakeClaudeDir, fakeClaudeDump };
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
const isNamespaced = (name: string) => name.includes(":");
const only = <T,>(a: T[], b: T[]) => a.filter((x) => !b.includes(x));

/**
 * A leak is measured in hundreds of names — a suppression failure listed one
 * skill at a time buries its own headline. The full set stays in the JSON
 * measurements; the human report gets the shape.
 */
const summarize = (names: string[], limit = 8): string =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;

// ---------------------------------------------------------------------------
// Criterion 1 — the session contains declared skills and built-ins, nothing else
// ---------------------------------------------------------------------------

async function checkSessionContents(fx: Fixtures): Promise<Check> {
  // The built-in baseline: the recipe's own flags, in a directory with nothing
  // declared. Whatever survives here is Claude Code's, not the Harvenv's. The
  // count drifts between releases, so it is measured rather than pinned.
  const builtins = await probeInit(
    "claude",
    [...STREAM_JSON, "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
    fx.bare,
  );
  const session = await probeInit(process.execPath, [HARV, "claude", ...STREAM_JSON], fx.project);

  const added = only(session.skills, builtins.skills);
  const missingBuiltins = only(builtins.skills, session.skills);
  const namespaced = [
    ...session.skills.filter(isNamespaced),
    ...session.slash_commands.filter(isNamespaced),
    ...session.agents.filter(isNamespaced),
  ];

  return {
    id: "session-contents",
    title: "`harv claude` yields declared skills plus built-ins, and nothing else",
    measurements: {
      claudeCodeVersion: session.claude_code_version,
      declared: DECLARED_SKILLS,
      builtinSkillCount: builtins.skills.length,
      sessionSkillCount: session.skills.length,
      skillsBeyondBuiltins: added,
      plugins: session.plugins.map((p) => p.name),
      mcpServers: session.mcp_servers.length,
    },
    expectations: [
      expect(
        "every declared skill is present under its bare Manifest name",
        DECLARED_SKILLS.every((name) => session.skills.includes(name)),
        `declared ${DECLARED_SKILLS.join(", ")}; ${only(DECLARED_SKILLS, session.skills).length === 0 ? "both present" : `missing ${summarize(only(DECLARED_SKILLS, session.skills))}`}`,
      ),
      expect(
        "nothing loads beyond the built-ins and what the Manifest declared",
        added.length === DECLARED_SKILLS.length && added.every((s) => DECLARED_SKILLS.includes(s)),
        added.length === DECLARED_SKILLS.length
          ? `${session.skills.length} skills = ${builtins.skills.length} built-in + ${added.length} declared`
          : `${only(added, DECLARED_SKILLS).length} undeclared skill(s) leaked: ${summarize(only(added, DECLARED_SKILLS))}`,
      ),
      expect(
        "the built-ins are still there",
        missingBuiltins.length === 0,
        missingBuiltins.length ? `lost: ${summarize(missingBuiltins)}` : `${builtins.skills.length} built-ins intact`,
      ),
      // ADR 0008: materialization into project scope, not `--plugin-dir`, is
      // what keeps the Manifest key and the invocation name the same string.
      expect(
        "declared skills keep bare names — no `<plugin>:<skill>` prefix",
        namespaced.length === 0,
        namespaced.length ? `namespaced: ${summarize(namespaced)}` : "no namespaced components",
      ),
      expect(
        "no plugins load",
        session.plugins.length === 0,
        `plugins: ${summarize(session.plugins.map((p) => p.name)) || "none"}`,
      ),
      expect(
        "no MCP servers load",
        session.mcp_servers.length === 0,
        `${session.mcp_servers.length} server(s)`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — a clear failure outside a harvenv project
// ---------------------------------------------------------------------------

async function checkNoManifest(fx: Fixtures): Promise<Check> {
  const result = await harv(["claude"], fx.bare);
  const message = `${result.stderr}${result.stdout}`;

  return {
    id: "no-manifest",
    title: "Outside a harvenv project, `harv claude` fails with a clear error",
    measurements: { exitCode: result.code, stderr: result.stderr.trim(), stdout: result.stdout.trim() },
    expectations: [
      expect("it fails rather than launching an un-isolated session", result.code !== 0, `exit code ${result.code}`),
      expect("it says a Manifest is what is missing", /no Manifest found/i.test(message), result.stderr.trim().split("\n")[0] ?? ""),
      expect("it names the file to create", message.includes("harvenv.toml"), "mentions harvenv.toml"),
      expect("it says where it looked", message.includes(fx.bare), `mentions ${fx.bare}`),
      expect("it fails cleanly, with no stack trace", !/\n\s+at .+:\d+:\d+/.test(result.stderr), "no stack frames in stderr"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — the user config directory is neither redirected nor written to
// ---------------------------------------------------------------------------

/**
 * The user-scope state a config-dir swap would strand, in two parts.
 *
 * `~/.claude/settings.json` and `~/.claude/.credentials.json` are pinned whole:
 * no session has any business rewriting them.
 *
 * `~/.claude.json` cannot be pinned whole, and asserting that it were would be
 * asserting the wrong thing. It is where a session records its own bookkeeping
 * — `numStartups`, `lastSessionId`, per-project costs — so *every* session
 * changes it, harv-launched or not. A frozen file would mean session state was
 * no longer reaching the user's config dir, which is the failure this criterion
 * is guarding against, not the success. What must survive untouched is the
 * durable half: the login identity and every MCP server definition, including
 * the per-project ones `--strict-mcp-config` suppresses for the session.
 */
function fileHashes(): Record<string, string> {
  const paths = {
    "~/.claude/settings.json": join(homedir(), ".claude", "settings.json"),
    "~/.claude/.credentials.json": join(homedir(), ".claude", ".credentials.json"),
  };
  const hashes: Record<string, string> = {};
  for (const [label, path] of Object.entries(paths)) {
    try {
      hashes[label] = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
    } catch {
      hashes[label] = "absent";
    }
  }
  return hashes;
}

interface ClaudeJson {
  /** Login identity and machine-wide MCP servers. */
  durable: Record<string, unknown>;
  /** Per-project MCP configuration, keyed by project path. */
  projectMcp: Record<string, unknown>;
  /** Everything else, so churn can be reported rather than asserted on. */
  topLevel: Record<string, string>;
}

const DURABLE_KEYS = ["oauthAccount", "userID", "mcpServers", "hasCompletedOnboarding"];
const PROJECT_MCP_KEYS = ["mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "mcpContextUris"];

function readClaudeJson(): ClaudeJson {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  } catch {
    /* absent is reported by the empty shapes below */
  }

  const durable = Object.fromEntries(DURABLE_KEYS.map((k) => [k, parsed[k]]));
  const projects = (parsed.projects ?? {}) as Record<string, Record<string, unknown>>;
  const projectMcp = Object.fromEntries(
    Object.entries(projects).map(([path, entry]) => [
      path,
      Object.fromEntries(PROJECT_MCP_KEYS.map((k) => [k, entry?.[k]])),
    ]),
  );
  const topLevel = Object.fromEntries(
    Object.entries(parsed).map(([k, v]) => [k, createHash("sha256").update(JSON.stringify(v) ?? "").digest("hex").slice(0, 8)]),
  );
  return { durable, projectMcp, topLevel };
}

/** Project-path keys present before, whose MCP configuration must not move. */
function preExistingProjectMcpChanged(before: ClaudeJson, after: ClaudeJson): string[] {
  return Object.keys(before.projectMcp).filter(
    (path) => JSON.stringify(before.projectMcp[path]) !== JSON.stringify(after.projectMcp[path]),
  );
}

const changedTopLevelKeys = (before: ClaudeJson, after: ClaudeJson): string[] =>
  Object.keys({ ...before.topLevel, ...after.topLevel }).filter((k) => before.topLevel[k] !== after.topLevel[k]);

const projectHistoryDirs = (): string[] => {
  try {
    return readdirSync(join(homedir(), ".claude", "projects"));
  } catch {
    return [];
  }
};

async function checkConfigDirUntouched(fx: Fixtures): Promise<Check> {
  // What harv hands over, observed directly: a stand-in `claude` first on PATH.
  const fakeEnv = { ...process.env, PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}` };
  await harv(["claude"], fx.project, fakeEnv);
  const handover = JSON.parse(readFileSync(fx.fakeClaudeDump, "utf8")) as {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
  };
  const configEnvKeys = Object.keys(handover.env).filter((k) => /CLAUDE_CONFIG|CLAUDE_HOME/i.test(k));
  const configFlags = handover.argv.filter((a) => /config-dir|^--bare$/.test(a));

  // A real session, bracketed by a read of everything a config-dir swap strands.
  const filesBefore = fileHashes();
  const jsonBefore = readClaudeJson();
  const historyBefore = projectHistoryDirs();
  const session = await harv(["claude", "-p", "reply with the single word: ok"], fx.project);
  const filesAfter = fileHashes();
  const jsonAfter = readClaudeJson();
  const historyAfter = projectHistoryDirs();

  const rewrittenFiles = Object.keys(filesBefore).filter((k) => filesBefore[k] !== filesAfter[k]);
  const durableChanged = DURABLE_KEYS.filter(
    (k) => JSON.stringify(jsonBefore.durable[k]) !== JSON.stringify(jsonAfter.durable[k]),
  );
  const projectMcpChanged = preExistingProjectMcpChanged(jsonBefore, jsonAfter);
  const authWorked = session.code === 0 && !/not logged in|invalid api key|please run.*login/i.test(session.stdout + session.stderr);
  const fixtureHistory = historyAfter.filter((d) => d.includes(FIXTURE_MARKER));

  return {
    id: "config-dir-untouched",
    title: "Login, history and MCP auth survive: the config directory is never touched",
    measurements: {
      handedOverArgv: handover.argv,
      handedOverCwd: handover.cwd,
      configEnvKeys,
      fileHashesBefore: filesBefore,
      fileHashesAfter: filesAfter,
      mcpServerCount: Object.keys((jsonAfter.durable.mcpServers ?? {}) as object).length,
      projectEntriesWithMcpConfig: Object.keys(jsonBefore.projectMcp).length,
      claudeJsonKeysThatChanged: changedTopLevelKeys(jsonBefore, jsonAfter),
      sessionExitCode: session.code,
      sessionOutput: session.stdout.trim().slice(0, 200),
      historyDirsAdded: only(historyAfter, historyBefore),
    },
    expectations: [
      expect(
        "harv sets no CLAUDE_CONFIG_DIR — the session reads the user's own config dir",
        configEnvKeys.length === 0,
        configEnvKeys.length ? `injected: ${configEnvKeys.join(", ")}` : "no config-dir variables in the handed-over environment",
      ),
      expect(
        "harv passes no config-dir or --bare flag",
        configFlags.length === 0,
        configFlags.length ? `flags: ${configFlags.join(", ")}` : `argv: ${handover.argv.slice(0, 7).join(" ")} ...`,
      ),
      expect(
        "the session runs from the project root",
        handover.cwd === fx.project,
        `cwd: ${handover.cwd}`,
      ),
      expect(
        "the user's settings and credentials files are never rewritten",
        rewrittenFiles.length === 0,
        rewrittenFiles.length
          ? `rewritten: ${rewrittenFiles.join(", ")}`
          : Object.entries(filesAfter).map(([k, v]) => `${k}=${v}`).join("; "),
      ),
      expect(
        "the login identity in ~/.claude.json is untouched",
        durableChanged.filter((k) => k !== "mcpServers").length === 0,
        durableChanged.length ? `changed: ${durableChanged.join(", ")}` : `${DURABLE_KEYS.join(", ")} all identical`,
      ),
      // `--strict-mcp-config` scopes the *session* to the Harvenv's servers. It
      // must not disturb the definitions the user's other projects rely on.
      expect(
        "every MCP server definition survives --strict-mcp-config",
        !durableChanged.includes("mcpServers") && projectMcpChanged.length === 0,
        projectMcpChanged.length
          ? `project MCP config moved for: ${projectMcpChanged.join(", ")}`
          : `${Object.keys((jsonAfter.durable.mcpServers ?? {}) as object).length} global + ${Object.keys(jsonBefore.projectMcp).length} project entries intact`,
      ),
      // ADR 0003's failure mode for a config-dir swap is "Not logged in". A
      // session that completes a turn is direct evidence the login survived.
      expect(
        "login still works — a real session completes a turn",
        authWorked,
        `exit ${session.code}: ${session.stdout.trim().slice(0, 80) || session.stderr.trim().slice(0, 80)}`,
      ),
      expect(
        "this project's session history lands under ~/.claude/projects",
        fixtureHistory.length > 0,
        fixtureHistory.length ? fixtureHistory.join(", ") : "no history directory for the fixture project",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — extra arguments reach claude unchanged
// ---------------------------------------------------------------------------

async function checkPassthrough(fx: Fixtures): Promise<Check> {
  const fakeEnv = { ...process.env, PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}` };
  const extras = ["-p", "hi", "--resume", "--", "--settings", "not-a-flag-to-harv"];
  await harv(["claude", ...extras], fx.project, fakeEnv);
  const { argv } = JSON.parse(readFileSync(fx.fakeClaudeDump, "utf8")) as { argv: string[] };

  const recipe = argv.slice(0, argv.length - extras.length);
  const tail = argv.slice(-extras.length);

  // A real `-p` run: proof the arguments are not merely forwarded but honoured.
  const answered = await harv(["claude", "-p", "reply with the single word: ok"], fx.project);

  return {
    id: "passthrough",
    title: "Extra arguments reach claude unchanged",
    measurements: { recipe, tail, realRunExit: answered.code, realRunOutput: answered.stdout.trim().slice(0, 200) },
    expectations: [
      expect("extra arguments arrive verbatim, in order", JSON.stringify(tail) === JSON.stringify(extras), tail.join(" ")),
      expect(
        "they land after the recipe, so harv's flags cannot be shadowed by accident",
        recipe.includes("--setting-sources") && recipe.includes("--strict-mcp-config"),
        recipe.join(" "),
      ),
      expect(
        "`harv claude -p \"...\"` really answers",
        answered.code === 0 && answered.stdout.trim().length > 0,
        `exit ${answered.code}: ${answered.stdout.trim().slice(0, 80)}`,
      ),
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
  log("harvenv walking-skeleton verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["session-contents", "`harv claude` yields declared skills plus built-ins, and nothing else", () => checkSessionContents(fx)],
    ["no-manifest", "Outside a harvenv project, `harv claude` fails with a clear error", () => checkNoManifest(fx)],
    ["config-dir-untouched", "Login, history and MCP auth survive: the config directory is never touched", () => checkConfigDirUntouched(fx)],
    ["passthrough", "Extra arguments reach claude unchanged", () => checkPassthrough(fx)],
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

  if (!keep) rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const version = (checks[0]?.measurements as { claudeCodeVersion?: string })?.claudeCodeVersion ?? "unknown";
  const failures = checks.filter(failed);

  if (asJson) {
    console.log(JSON.stringify({ claudeCodeVersion: version, ok: failures.length === 0, checks }, null, 2));
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

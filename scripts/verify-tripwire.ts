#!/usr/bin/env bun
/**
 * Tripwire and `harv init` verification.
 *
 * The unit tests pin the scaffolding and the merge; this script pins the thing
 * they exist to produce — a real Claude Code session that really does, or
 * really does not, warn the person sitting in front of it. It is the acceptance
 * criteria of issue #6, executed rather than asserted:
 *
 *   1. `harv init` on an empty project produces a valid Manifest, gitignore
 *      entries, and the Tripwire.
 *   2. A bare `claude` in that project surfaces the warning.
 *   3. A `harv claude` session shows no warning.
 *   4. Init merges into existing committed settings non-destructively, and
 *      re-running is idempotent.
 *
 * Checks 2 and 3 read Claude Code's own `hook_response` events under
 * `--output-format stream-json --verbose`. Each one carries the hook's name,
 * exit code and stdout verbatim, so what the session made of the Tripwire is
 * observed rather than inferred — the same no-model-in-the-loop method as
 * spike 0001. The step from that stdout to pixels is Claude Code's documented
 * contract for `systemMessage` ("Display a message to the user"), measured once
 * through a real pty and recorded in ADR 0012.
 *
 * Check 1 launches through a stand-in `claude` that records its argv, so the
 * scaffolded Manifest is proven launchable without spending a model turn.
 *
 * Nothing of the machine's is written: every probe runs against a Store inside
 * the fixture tree via `HARV_HOME`, and `~/.claude` is read but never written
 * (each session uses `--no-session-persistence`).
 *
 * Run:  bun scripts/verify-tripwire.ts [--json] [--keep]
 *       node scripts/verify-tripwire.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GITIGNORE_ENTRIES, PROJECT_SETTINGS_PATH } from "../src/init.ts";
import { MANIFEST_FILENAME } from "../src/manifest.ts";
import { hasTripwire, LAUNCHER_ENV, TRIPWIRE_WARNING } from "../src/tripwire.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

/** Stable, so repeated runs reuse one entry under `~/.claude/projects`. */
const FIXTURE_ROOT = join(realpathSync(tmpdir()), "harvenv-tripwire-verify");

const PROBE_TIMEOUT_MS = 180_000;
/** Grace after `init` for hook events still in flight, before the session is killed. */
const DRAIN_MS = 500;

// ---------------------------------------------------------------------------
// Running harv and claude
// ---------------------------------------------------------------------------

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runToCompletion(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<Completed> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
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

interface HookResponse {
  hook_name: string;
  hook_event: string;
  stdout: string;
  exit_code: number;
}

interface Probe {
  claudeCodeVersion: string;
  /** Every SessionStart hook that reported back before the session initialized. */
  sessionStart: HookResponse[];
}

/**
 * Start a session, collect its SessionStart hook responses, and kill it once
 * `init` arrives — the event Claude Code emits after hooks have run and before
 * the first assistant token, so no model turn is ever completed.
 */
function probeSessionStart(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const sessionStart: HookResponse[] = [];
    let version = "unknown";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`))), PROBE_TIMEOUT_MS);

    child.stderr.on("data", (c) => (stderr += String(c)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.subtype === "hook_response" && event.hook_event === "SessionStart") {
        sessionStart.push(event as unknown as HookResponse);
      }
      if (event.type === "system" && event.subtype === "init") {
        version = String(event.claude_code_version ?? "unknown");
        setTimeout(() => finish(() => resolve({ claudeCodeVersion: version, sessionStart })), DRAIN_MS);
      }
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) =>
      finish(() => reject(new Error(`session exited (code ${code}) before emitting init.\n${stderr.trim().slice(-800)}`))),
    );
  });
}

const STREAM_JSON = ["-p", "probe", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];

/** The `systemMessage` values the SessionStart hooks handed the session. */
function systemMessages(probe: Probe): string[] {
  return probe.sessionStart.flatMap((hook) => {
    try {
      const parsed = JSON.parse(hook.stdout);
      const message = (parsed as { systemMessage?: unknown }).systemMessage;
      return typeof message === "string" ? [message] : [];
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** An empty directory, for `harv init` to scaffold from nothing. */
  fresh: string;
  /** A project that already has committed settings and a `.gitignore`. */
  existing: string;
  /** The Store these probes use. Never the machine's own. */
  store: string;
  /** A stand-in `claude` that records its argv instead of starting a session. */
  fakeClaudeDir: string;
  fakeClaudeDump: string;
}

/**
 * The environment every probe runs in: the fixture's Store rather than the
 * user's, and no Launcher marker unless the Launcher itself sets one. Verifying
 * from inside a harv session must not silence the Tripwire and pass vacuously.
 */
function probeEnv(fx: Fixtures, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { [LAUNCHER_ENV]: _inherited, ...clean } = process.env;
  return { ...clean, HARV_HOME: fx.store, ...extra };
}

/** What a project might plausibly already have in its committed Claude settings. */
const PRIOR_SETTINGS = {
  model: "opus",
  permissions: { allow: ["Bash(npm test:*)"], defaultMode: "acceptEdits" },
  hooks: {
    PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "prettier --write" }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "echo their own context" }] }],
  },
};

const PRIOR_GITIGNORE = "node_modules/\ndist/\n";

function buildFixtures(): Fixtures {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  const dir = (...parts: string[]) => {
    const p = join(FIXTURE_ROOT, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };

  const fresh = dir("fresh");

  const existing = dir("existing");
  mkdirSync(join(existing, ".claude"), { recursive: true });
  writeFileSync(join(existing, ...PROJECT_SETTINGS_PATH), `${JSON.stringify(PRIOR_SETTINGS, null, 2)}\n`);
  writeFileSync(join(existing, ".gitignore"), PRIOR_GITIGNORE);

  const fakeClaudeDir = dir("fake-bin");
  const fakeClaudeDump = join(FIXTURE_ROOT, "handover.json");
  writeFileSync(
    join(fakeClaudeDir, "claude"),
    `#!/usr/bin/env node\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(fakeClaudeDump)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env[${JSON.stringify(LAUNCHER_ENV)}] ?? null\n` +
      `}));\n`,
    { mode: 0o755 },
  );

  return { fresh, existing, store: dir("store-home"), fakeClaudeDir, fakeClaudeDump };
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

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const ignoreLines = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

// ---------------------------------------------------------------------------
// Criterion 1 — init scaffolds a valid Manifest, gitignore entries, the Tripwire
// ---------------------------------------------------------------------------

async function checkScaffold(fx: Fixtures): Promise<Check> {
  const init = await harv(["init"], fx.fresh, probeEnv(fx));

  const manifestPath = join(fx.fresh, MANIFEST_FILENAME);
  const gitignorePath = join(fx.fresh, ".gitignore");
  const settingsPath = join(fx.fresh, ...PROJECT_SETTINGS_PATH);

  const entries = existsSync(gitignorePath) ? ignoreLines(gitignorePath) : [];
  const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !entries.includes(entry));
  const planted = existsSync(settingsPath) && hasTripwire(readJson(settingsPath));

  // Launching through a stand-in `claude` proves harv accepted the scaffolded
  // Manifest — the strongest available reading of "valid" — for no model turn.
  const launch = await harv(["claude"], fx.fresh, probeEnv(fx, { PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}` }));
  const handover = existsSync(fx.fakeClaudeDump)
    ? (JSON.parse(readFileSync(fx.fakeClaudeDump, "utf8")) as { argv: string[]; marker: string | null })
    : null;

  return {
    id: "scaffold",
    title: "`harv init` on an empty project produces a valid Manifest, gitignore entries and the Tripwire",
    measurements: {
      initExitCode: init.code,
      initOutput: init.stdout.trim(),
      gitignoreEntries: entries,
      settings: existsSync(settingsPath) ? readJson(settingsPath) : null,
      launchExitCode: launch.code,
      launcherMarker: handover?.marker ?? null,
    },
    expectations: [
      expect("`harv init` succeeds", init.code === 0, `exit ${init.code}: ${init.stdout.trim().split("\n")[0] ?? init.stderr.trim()}`),
      expect(`it writes ${MANIFEST_FILENAME}`, existsSync(manifestPath), manifestPath),
      expect(
        "the Manifest is valid — `harv claude` accepts it and launches",
        launch.code === 0 && handover !== null,
        launch.code === 0 ? `launched with: ${handover?.argv.slice(0, 4).join(" ")} ...` : `exit ${launch.code}: ${launch.stderr.trim().slice(0, 160)}`,
      ),
      expect(
        "every generated and personal path is gitignored",
        missingEntries.length === 0,
        missingEntries.length ? `missing: ${missingEntries.join(", ")}` : entries.join(", "),
      ),
      expect("the Tripwire is planted in committed project settings", planted, PROJECT_SETTINGS_PATH.join("/")),
      expect(
        "the Launcher marks its sessions, so the Tripwire can tell them apart",
        handover?.marker === "1",
        `${LAUNCHER_ENV}=${handover?.marker ?? "(unset)"}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criteria 2 and 3 — bare `claude` warns, `harv claude` does not
// ---------------------------------------------------------------------------

/**
 * Both sessions start in the same scaffolded project, so the only variable is
 * how they were started — and neither inherits a Launcher marker, so the only
 * thing that can set one is the Launcher itself.
 */
async function checkWarnings(fx: Fixtures): Promise<Check> {
  const env = probeEnv(fx);

  const bare = await probeSessionStart("claude", STREAM_JSON, fx.fresh, env);
  const launched = await probeSessionStart(process.execPath, [HARV, "claude", ...STREAM_JSON], fx.fresh, env);

  const bareMessages = systemMessages(bare);
  const launchedMessages = systemMessages(launched);
  const warned = bareMessages.filter((message) => message.includes(TRIPWIRE_WARNING));
  const leaked = launchedMessages.filter((message) => /harvenv|not isolated/i.test(message));

  return {
    id: "warning",
    title: "A bare `claude` surfaces the warning; a `harv claude` session does not",
    measurements: {
      claudeCodeVersion: bare.claudeCodeVersion,
      expectedWarning: TRIPWIRE_WARNING,
      bareSessionStartHooks: bare.sessionStart.length,
      bareSystemMessages: bareMessages,
      launcherSessionStartHooks: launched.sessionStart.map((hook) => ({ stdout: hook.stdout, exit: hook.exit_code })),
      launcherSystemMessages: launchedMessages,
    },
    expectations: [
      expect(
        "a bare `claude` fires the project's Tripwire",
        bare.sessionStart.length > 0,
        `${bare.sessionStart.length} SessionStart hook(s) reported`,
      ),
      expect(
        "and the session carries the warning to the user as a systemMessage",
        warned.length > 0,
        warned[0] ?? `systemMessages seen: ${bareMessages.length ? bareMessages.join(" | ").slice(0, 200) : "none"}`,
      ),
      expect(
        "the warning says the session is not isolated and names the way out",
        warned.some((m) => /NOT isolated/.test(m) && /harv claude/.test(m)),
        warned[0]?.slice(0, 160) ?? "no warning to read",
      ),
      // The suppression has to be the hook choosing silence, not the hook being
      // absent: under `--setting-sources project,local` the Tripwire still loads.
      expect(
        "a `harv claude` session still runs the Tripwire",
        launched.sessionStart.length > 0,
        `${launched.sessionStart.length} SessionStart hook(s) reported`,
      ),
      expect(
        "and it stays silent",
        leaked.length === 0,
        leaked.length ? `leaked: ${leaked.join(" | ").slice(0, 200)}` : "no harvenv systemMessage in the session",
      ),
      expect(
        "the Tripwire succeeds either way, so it never reads as a broken hook",
        [...bare.sessionStart, ...launched.sessionStart].every((hook) => hook.exit_code === 0),
        `exit codes: ${[...bare.sessionStart, ...launched.sessionStart].map((h) => h.exit_code).join(", ")}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — merging into existing settings, and idempotence
// ---------------------------------------------------------------------------

async function checkMerge(fx: Fixtures): Promise<Check> {
  const settingsPath = join(fx.existing, ...PROJECT_SETTINGS_PATH);
  const gitignorePath = join(fx.existing, ".gitignore");

  const first = await harv(["init"], fx.existing, probeEnv(fx));
  const merged = readJson(settingsPath);
  const mergedText = readFileSync(settingsPath, "utf8");
  const mergedIgnore = readFileSync(gitignorePath, "utf8");

  const second = await harv(["init"], fx.existing, probeEnv(fx));
  const afterText = readFileSync(settingsPath, "utf8");
  const afterIgnore = readFileSync(gitignorePath, "utf8");
  const afterManifest = readFileSync(join(fx.existing, MANIFEST_FILENAME), "utf8");

  const third = await harv(["init"], fx.existing, probeEnv(fx));

  const hooks = (merged.hooks ?? {}) as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  const theirSessionStart = hooks.SessionStart?.[0]?.hooks?.[0]?.command;
  const entries = ignoreLines(gitignorePath);

  return {
    id: "merge",
    title: "Init merges into existing committed settings non-destructively, and re-running is idempotent",
    measurements: {
      firstExitCode: first.code,
      firstOutput: first.stdout.trim(),
      secondOutput: second.stdout.trim(),
      mergedSettings: merged,
      gitignore: entries,
    },
    expectations: [
      expect("`harv init` succeeds on a project that already has settings", first.code === 0, `exit ${first.code}`),
      expect("every pre-existing settings key survives", merged.model === "opus" && JSON.stringify(merged.permissions) === JSON.stringify(PRIOR_SETTINGS.permissions), `model=${String(merged.model)}, permissions=${JSON.stringify(merged.permissions)}`),
      expect(
        "the project's own hooks survive, in place",
        JSON.stringify(hooks.PostToolUse) === JSON.stringify(PRIOR_SETTINGS.hooks.PostToolUse) && theirSessionStart === "echo their own context",
        `PostToolUse intact; SessionStart[0] = ${JSON.stringify(theirSessionStart)}`,
      ),
      expect("the Tripwire is appended alongside them", hasTripwire(merged) && (hooks.SessionStart?.length ?? 0) === 2, `${hooks.SessionStart?.length ?? 0} SessionStart entries`),
      expect(
        "the pre-existing gitignore lines survive and harv's are appended",
        PRIOR_GITIGNORE.trim().split("\n").every((line) => entries.includes(line.trim())) && GITIGNORE_ENTRIES.every((entry) => entries.includes(entry)),
        entries.join(", "),
      ),
      expect(
        "re-running changes nothing on disk",
        afterText === mergedText && afterIgnore === mergedIgnore,
        afterText === mergedText && afterIgnore === mergedIgnore ? "settings, gitignore and Manifest byte-identical" : "a second run rewrote something",
      ),
      expect(
        "and says so",
        /Already a harvenv project/.test(second.stdout) && /Already a harvenv project/.test(third.stdout),
        second.stdout.trim().split("\n")[0] ?? "",
      ),
      expect(
        "the Manifest it scaffolded is still the one it wrote",
        afterManifest.includes("[skills]") && afterManifest.includes("[settings]"),
        `${afterManifest.split("\n").length} lines`,
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
  log("harvenv Tripwire verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["scaffold", "`harv init` on an empty project produces a valid Manifest, gitignore entries and the Tripwire", () => checkScaffold(fx)],
    ["warning", "A bare `claude` surfaces the warning; a `harv claude` session does not", () => checkWarnings(fx)],
    ["merge", "Init merges into existing committed settings non-destructively, and re-running is idempotent", () => checkMerge(fx)],
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

  const version = (checks.find((c) => c.measurements.claudeCodeVersion)?.measurements as { claudeCodeVersion?: string })?.claudeCodeVersion ?? "unknown";
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

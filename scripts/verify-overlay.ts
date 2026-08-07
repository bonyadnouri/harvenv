#!/usr/bin/env bun
/**
 * Overlay verification.
 *
 * The unit tests pin what harv composes; this script pins what the composition
 * does to a real Claude Code session started by a real `harv claude`. It is the
 * acceptance criteria of issue #5, executed rather than asserted:
 *
 *   1. A staple declared once in the global Overlay file is loaded by sessions
 *      in two different harvenv projects.
 *   2. A project's own extras file adds a Component, and a disable entry takes a
 *      staple out of that project while leaving it in the other one.
 *   3. An Overlay value for a key the Manifest binds is rejected at Sync with a
 *      warning naming the key — and the session runs the Manifest's value.
 *   4. `--no-overlay` starts a session composed from the Manifest alone.
 *
 * What the session loaded comes from the `system`/`init` event Claude Code emits
 * under `--output-format stream-json --verbose`, as in spikes 0001 and 0002:
 * `init.skills` names every skill by the name it answers to, and `init.model` is
 * the model the session resolved. Both are direct reads with no model in the
 * loop. The one thing `init` cannot show is a personal-ergonomics key —
 * `statusLine` has no observable — so that half is read from the `--settings`
 * payload harv hands over, captured by a stand-in `claude` that records its
 * argv. The distinction is labelled in the output rather than glossed.
 *
 * Nothing here touches the machine's own Store or Overlay: `HARV_HOME` points at
 * the fixture tree, which is where the global staples file is read from too. The
 * machine's `~/.claude` is read, never written — every probe runs with
 * `--no-session-persistence`.
 *
 * Run:  bun scripts/verify-overlay.ts [--json] [--keep]
 *       node scripts/verify-overlay.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

const FIXTURE_ROOT = join(realpathSync(tmpdir()), "harvenv-overlay-verify");
const PROBE_TIMEOUT_MS = 180_000;

/** The staple: declared once, in the global file, and expected everywhere. */
const STAPLE = "harvenv-staple";
/** Declared by one project's extras file, and expected only there. */
const EXTRA = "harvenv-extra";
/** Declared by a Manifest, so it is the thing `--no-overlay` must keep. */
const PROJECT_SKILL = "harvenv-project";

/** The Manifest binds this; the Overlay tries to move it and must not. */
const BOUND_MODEL = "haiku";
const BOUND_MODEL_FAMILY = /haiku/;
const OVERRIDDEN_MODEL = "opus";

/** A key ADR 0005 calls personal — refused in a Manifest, and the Overlay's job. */
const PERSONAL_KEY = "statusLine";

// ---------------------------------------------------------------------------
// Running harv, git and claude
// ---------------------------------------------------------------------------

interface InitEvent {
  claude_code_version: string;
  skills: string[];
  model: string;
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

const harv = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  runToCompletion(process.execPath, [HARV, ...args], { cwd, env });

const GIT_FIXTURE = [
  "-c", "user.name=harvenv verification",
  "-c", "user.email=verify@harvenv.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runToCompletion("git", [...GIT_FIXTURE, ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Start a session, capture its `init` event, kill it before the turn completes. */
function probeInit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<InitEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARV, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

const session = (cwd: string, env: NodeJS.ProcessEnv, harvFlags: string[] = []) =>
  probeInit(["claude", ...harvFlags, ...STREAM_JSON], cwd, env);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** Declares `PROJECT_SKILL` and binds `model`. Keeps every staple. */
  alpha: string;
  /** Declares nothing of its own — the second project the staple must reach. */
  beta: string;
  /** Adds `EXTRA` and disables `STAPLE`, through its own extras file. */
  gamma: string;
  /** A stand-in `claude` that records the argv it was handed. */
  fakeClaudeDir: string;
  fakeClaudeDump: string;
  env: NodeJS.ProcessEnv;
}

const skillSource = (name: string) =>
  `---\nname: ${name}\ndescription: Fixture skill for harvenv Overlay verification. Never invoke it.\n---\n\nMarker.\n`;

async function buildFixtures(): Promise<Fixtures> {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  const dir = (...parts: string[]) => {
    const p = join(FIXTURE_ROOT, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };

  // The staple comes from a real repository, so criterion 1 exercises the whole
  // path a personal skill actually takes: resolve, fetch, hash, Store, link.
  const repo = dir("staple-repo");
  await git(["init", "--quiet"], repo);
  writeFileSync(join(repo, "SKILL.md"), skillSource(STAPLE));
  await git(["add", "--all"], repo);
  await git(["commit", "--quiet", "--message", "the staple"], repo);

  const home = dir("harv-home");
  writeFileSync(
    join(home, "overlay.toml"),
    `[skills]\n${STAPLE} = { git = "file://${repo}" }\n\n` +
      `[settings]\n` +
      // A key the Manifest binds. The Overlay must lose it, loudly.
      `model = "${OVERRIDDEN_MODEL}"\n` +
      // A key a Manifest may not set at all. The Overlay is where it belongs.
      `${PERSONAL_KEY} = { type = "command", command = "echo harvenv" }\n`,
  );

  const alpha = dir("alpha");
  writeFileSync(join(dir("alpha", "vendor", PROJECT_SKILL), "SKILL.md"), skillSource(PROJECT_SKILL));
  writeFileSync(
    join(alpha, "harvenv.toml"),
    `[skills]\n${PROJECT_SKILL} = { path = "vendor/${PROJECT_SKILL}" }\n\n[settings]\nmodel = "${BOUND_MODEL}"\n`,
  );

  const beta = dir("beta");
  writeFileSync(join(beta, "harvenv.toml"), "[settings]\n");

  const gamma = dir("gamma");
  writeFileSync(join(gamma, "harvenv.toml"), "[settings]\n");
  writeFileSync(join(dir("gamma", "vendor", EXTRA), "SKILL.md"), skillSource(EXTRA));
  writeFileSync(
    join(gamma, "harvenv.local.toml"),
    `[skills]\n${EXTRA} = { path = "vendor/${EXTRA}" }\n${STAPLE} = { disable = true }\n`,
  );

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
    alpha,
    beta,
    gamma,
    fakeClaudeDir,
    fakeClaudeDump,
    // HARV_HOME is both the Store and where the global staples file is read
    // from, so redirecting it keeps the whole run off the real machine's.
    env: { ...process.env, HARV_HOME: home },
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

const summarize = (names: string[], limit = 8): string =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;

/** What `--settings` was handed on the last recorded handover. */
function handedOverSettings(dump: string): Record<string, unknown> {
  const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
  return JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}");
}

/** The content hash the project's Overlay Lockfile pins for one entry. */
function lockedHash(root: string, name: string): string {
  const lock = join(root, ".harv", "overlay.lock");
  if (!existsSync(lock)) return "";
  const entry = readFileSync(lock, "utf8").split(/^\[\[skills\]\]$/m).find((block) => block.includes(`"${name}"`));
  return /hash = "(sha256:[0-9a-f]{64})"/.exec(entry ?? "")?.[1] ?? "";
}

/** Run `harv claude` against the stand-in, so the payload can be read back. */
const handover = (fx: Fixtures, cwd: string, flags: string[] = []) =>
  harv(["claude", ...flags], cwd, {
    ...fx.env,
    PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}`,
  });

// ---------------------------------------------------------------------------
// Criterion 1 — one staples file, two projects
// ---------------------------------------------------------------------------

async function checkStaplesEverywhere(fx: Fixtures): Promise<Check> {
  const syncedAlpha = await harv(["sync"], fx.alpha, fx.env);
  const syncedBeta = await harv(["sync"], fx.beta, fx.env);

  const alpha = await session(fx.alpha, fx.env);
  const beta = await session(fx.beta, fx.env);

  // One declaration, one set of bytes: both projects must land on the same
  // Store address, which is the Store's promise (ADR 0010) rather than an
  // accident of two fetches happening to agree.
  const alphaHash = lockedHash(fx.alpha, STAPLE);
  const betaHash = lockedHash(fx.beta, STAPLE);

  return {
    id: "staples-everywhere",
    title: "A staple declared once in the global Overlay reaches two different projects",
    measurements: {
      claudeCodeVersion: alpha.claude_code_version,
      alphaSkills: alpha.skills,
      betaSkills: beta.skills,
      alphaSync: syncedAlpha.stdout.trim(),
      betaSync: syncedBeta.stdout.trim(),
      stapleHash: alphaHash,
    },
    expectations: [
      expect(
        `the first project's session loads \`${STAPLE}\``,
        alpha.skills.includes(STAPLE),
        `skills: ${summarize(alpha.skills)}`,
      ),
      expect(
        `the second project's session loads it too, declaring nothing itself`,
        beta.skills.includes(STAPLE),
        `${fx.beta}/harvenv.toml declares no skills; skills: ${summarize(beta.skills)}`,
      ),
      expect(
        "both projects resolve it to the same Store entry, so it is stored once",
        alphaHash !== "" && alphaHash === betaHash,
        `both pin ${alphaHash || "(nothing)"}; the Store address is the content, so this is one directory`,
      ),
      expect(
        "the second Sync does contact the remote — an Overlay carries no shared pin",
        null,
        `${syncedBeta.stdout.trim()} — the committed Lockfile is what lets a second machine skip the network, ` +
          `and an Overlay deliberately has none (ADR 0013). Each project asks what its staple's ref means the ` +
          `first time it meets it; the bytes are then deduplicated by the Store rather than by the fetch.`,
      ),
      expect(
        "the staple is pinned outside the committed Lockfile",
        !readFileSync(join(fx.alpha, "harvenv.lock"), "utf8").includes(STAPLE) &&
          readFileSync(join(fx.alpha, ".harv", "overlay.lock"), "utf8").includes(STAPLE),
        `harvenv.lock does not mention it; .harv/overlay.lock does`,
      ),
      expect(
        "the project's own Component is still loaded alongside it",
        alpha.skills.includes(PROJECT_SKILL),
        `skills: ${summarize(alpha.skills)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — extras add, and a disable subtracts, in one project only
// ---------------------------------------------------------------------------

async function checkProjectExtras(fx: Fixtures): Promise<Check> {
  const synced = await harv(["sync"], fx.gamma, fx.env);
  const gamma = await session(fx.gamma, fx.env);
  // Re-read the project that declares no extras, to show the staple survived
  // there — "in that project only" is a claim about two projects, not one.
  const alpha = await session(fx.alpha, fx.env);

  return {
    id: "project-extras",
    title: "Project-local extras add Components, and a disable removes a staple in that project only",
    measurements: { gammaSkills: gamma.skills, alphaSkills: alpha.skills, gammaSync: synced.stdout.trim() },
    expectations: [
      expect(
        `the extras file's \`${EXTRA}\` is loaded`,
        gamma.skills.includes(EXTRA),
        `skills: ${summarize(gamma.skills)}`,
      ),
      expect(
        `the disabled \`${STAPLE}\` is absent from this project's session`,
        !gamma.skills.includes(STAPLE),
        `skills: ${summarize(gamma.skills)}`,
      ),
      expect(
        "and absent from its project scope on disk, not merely from the session",
        !existsSync(join(fx.gamma, ".claude", "skills", STAPLE)),
        `${join(fx.gamma, ".claude", "skills", STAPLE)} does not exist`,
      ),
      expect(
        "while the other project still loads it",
        alpha.skills.includes(STAPLE),
        `skills: ${summarize(alpha.skills)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — the Manifest binds; the Overlay is told so
// ---------------------------------------------------------------------------

async function checkBindingWins(fx: Fixtures): Promise<Check> {
  const synced = await harv(["sync"], fx.alpha, fx.env);
  const alpha = await session(fx.alpha, fx.env);

  await handover(fx, fx.alpha);
  const injected = handedOverSettings(fx.fakeClaudeDump);
  const warning = synced.stderr;

  return {
    id: "binding-wins",
    title: "An Overlay value for a Manifest-bound key is rejected at Sync, and the session runs the Manifest's",
    measurements: {
      syncStderr: warning.trim(),
      resolvedModel: alpha.model,
      injectedSettings: injected,
    },
    expectations: [
      expect(
        "`harv sync` warns rather than passing it on in silence",
        /warning/i.test(warning),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "the warning names the locked key",
        /\bmodel\b/.test(warning),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "and names the rule, so the reason is findable",
        /ADR 0005/.test(warning),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "the Sync still succeeds — a personal file cannot fail a project",
        synced.code === 0,
        `exit ${synced.code}`,
      ),
      expect(
        `the session resolves the Manifest's model, not the Overlay's`,
        BOUND_MODEL_FAMILY.test(alpha.model),
        `init.model = ${alpha.model} (Manifest said ${BOUND_MODEL}, Overlay said ${OVERRIDDEN_MODEL})`,
      ),
      expect(
        `the Overlay's own \`${PERSONAL_KEY}\` does reach the payload — the remedy is real`,
        Object.hasOwn(injected, PERSONAL_KEY),
        `--settings carried: ${Object.keys(injected).join(", ")}. ` +
          `A Manifest declaring ${PERSONAL_KEY} is refused; an Overlay is not.`,
      ),
      expect(
        "no observable for a resolved statusLine exists, so this half is read from the payload",
        null,
        "`init` reports model and permissionMode but nothing about statusLine (spike 0002, finding 2's shape)",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — --no-overlay is the Manifest, alone
// ---------------------------------------------------------------------------

async function checkNoOverlay(fx: Fixtures): Promise<Check> {
  const bare = await session(fx.alpha, fx.env, ["--no-overlay"]);

  await handover(fx, fx.alpha, ["--no-overlay"]);
  const injected = handedOverSettings(fx.fakeClaudeDump);

  // And back again, so the flag is shown to be per-invocation rather than a
  // state change: the next ordinary launch has the Overlay again.
  const restored = await session(fx.alpha, fx.env);

  return {
    id: "no-overlay",
    title: "`--no-overlay` starts a session composed from the Manifest alone",
    measurements: { bareSkills: bare.skills, injectedSettings: injected, restoredSkills: restored.skills },
    expectations: [
      expect(
        `the Manifest's \`${PROJECT_SKILL}\` is still loaded`,
        bare.skills.includes(PROJECT_SKILL),
        `skills: ${summarize(bare.skills)}`,
      ),
      expect(
        `the Overlay's \`${STAPLE}\` is not`,
        !bare.skills.includes(STAPLE),
        `skills: ${summarize(bare.skills)}`,
      ),
      expect(
        `and no Overlay setting reaches the payload`,
        !Object.hasOwn(injected, PERSONAL_KEY),
        `--settings carried: ${Object.keys(injected).join(", ")}`,
      ),
      expect(
        "the probe's own arguments still arrive, so the flag was taken out and nothing else was",
        bare.claude_code_version.length > 0,
        `the session started under ${STREAM_JSON.join(" ")} and emitted init`,
      ),
      expect(
        "the next launch without the flag has the Overlay back",
        restored.skills.includes(STAPLE),
        `skills: ${summarize(restored.skills)}`,
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

  const fx = await buildFixtures();
  log("harvenv Overlay verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  // Ordered, and deliberately so: criterion 2 reads the project criterion 1
  // synced, which is what makes "in that project only" a comparison rather
  // than an assertion about one tree.
  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["staples-everywhere", "A staple declared once reaches two different projects", () => checkStaplesEverywhere(fx)],
    ["project-extras", "Extras add a Component; a disable removes a staple in that project only", () => checkProjectExtras(fx)],
    ["binding-wins", "An Overlay override of a Manifest-bound key is rejected, naming the key", () => checkBindingWins(fx)],
    ["no-overlay", "`--no-overlay` launches a Manifest-only session", () => checkNoOverlay(fx)],
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

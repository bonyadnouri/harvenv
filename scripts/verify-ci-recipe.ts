#!/usr/bin/env bun
/**
 * CI-recipe verification.
 *
 * ADR 0002 ends in a consequence rather than a mechanism: "CI runs with
 * Manifest only (no Overlay), giving a canonical baseline harness." This script
 * is that consequence executed. It runs the same recipe
 * `.github/workflows/harvenv.yml` runs — a clean Store, `harv sync` from a
 * committed Lockfile, a headless `harv claude -p` — against the repository's
 * sample Manifest, and measures what a runner actually ends up with. It is the
 * acceptance criteria of issue #12, executed rather than asserted:
 *
 *   1. A runner with an empty Store reproduces the Harvenv from the committed
 *      Lockfile, and the Lockfile it ends up with is the one it started from.
 *   2. The session CI starts is composed from the Manifest and nothing else —
 *      no user scope, no personal settings, no MCP servers, no plugins.
 *   3. `harv claude -p` behaves like a build step: arguments pass through, the
 *      session's output passes through, and its exit code becomes harv's.
 *   4. A cached Store makes the next run network-free, at sync and at launch.
 *   5. Credentials reach the session through the environment and nowhere else,
 *      and warming the Store needs none at all.
 *
 * Two seams are worth naming, because a check that hides them would be
 * claiming more than it measures.
 *
 * The first is `claude`. This repository's CI has no Claude subscription and
 * no API key, so every launch here goes to a stand-in that records the argv,
 * environment and working directory it was handed. That is enough to measure
 * everything *harv* does — the recipe it composes and the project scope it
 * materializes — and it is deliberately not enough to measure what Claude Code
 * then does with those flags. That half is `verify-launch-recipe.ts`,
 * `verify-walking-skeleton.ts` and `verify-manifest-settings.ts`, which need a
 * real session; the workflow runs them only when an API key is present, and
 * says so when it does not.
 *
 * The second is the machine. Criterion 2 plants a skill, a conflicting settings
 * file and an MCP server in a fixture `$HOME`, so the machine under test looks
 * like a developer's rather than like a clean room, and then shows that none of
 * the three reached the Harvenv. Whether `--setting-sources project,local` and
 * `--strict-mcp-config` keep them out of the *session* is Claude Code's
 * behaviour, measured against a live one by spikes 0001 and 0002. Here the
 * claim is narrower and still worth having: nothing on this machine reached the
 * Harvenv, and the recipe carries the flags that exclude it.
 *
 * Nothing here touches the machine's Store or `~/.claude`: `HARV_HOME` points
 * into the fixture tree, launches run against a fixture `HOME`, and no real
 * Claude Code session is ever started. Sync runs with the real `HOME`, because
 * fetching a Source is allowed to use the machine's git credentials — that is
 * how a private Source works at all (ADR 0004).
 *
 * Run:  bun scripts/verify-ci-recipe.ts [--project <dir>] [--json] [--keep]
 *       node scripts/verify-ci-recipe.ts [--project <dir>] [--json] [--keep]
 *
 * Needs git and network access to the sample Manifest's Sources. Needs no
 * `claude` binary, no API key and no Claude subscription.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

/** The sample Manifest the workflow uses. Overridable with `--project`. */
const DEFAULT_PROJECT = join(REPO_ROOT, "examples", "ci");

/**
 * Salted per process, and cleaned up on the way out.
 *
 * Every verifier used to build at one fixed path, which is why two of them
 * running at once deleted each other's fixtures mid-run (issue #22). `mkdtemp`
 * is the whole fix: this script can run beside anything, including a second
 * copy of itself.
 */
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-ci-verify-"));

/** A personal skill of the kind a developer's machine is full of, and CI is not. */
const USER_SCOPE_SKILL = "harvenv-ci-intruder";

/** Deliberately not the Manifest's model, so "whose settings won?" has an answer. */
const USER_SCOPE_MODEL = "haiku";

/**
 * Obvious nonsense, and never a real credential: what is being measured is
 * where the value travels, not whether it authenticates.
 */
const FIXTURE_API_KEY = "not-a-real-key-harvenv-ci-fixture";

const COMMAND_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  /** Merged over the current environment. */
  env?: NodeJS.ProcessEnv;
  /** Removed from it afterwards, so a variable can be proven absent. */
  unset?: string[];
}

function runCommand(command: string, args: string[], cwd: string, options: RunOptions = {}): Completed {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const key of options.unset ?? []) delete env[key];

  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, timeout: COMMAND_TIMEOUT_MS });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const harv = (args: string[], cwd: string, options: RunOptions = {}): Completed =>
  runCommand(process.execPath, [HARV, ...args], cwd, options);

/**
 * An executable that records how it was called and then does as it is told.
 *
 * Standing in for `claude`, it answers the only question a runner without
 * credentials can ask: what did harv hand over? Its exit code and stdout come
 * from the environment, so the same binary can play a session that succeeds
 * and one that fails.
 */
function writeClaudeStandIn(dir: string, dump: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node\n` +
      `const fs = require("node:fs");\n` +
      `fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env\n` +
      `}));\n` +
      `process.stdout.write(process.env.HARV_VERIFY_STDOUT ?? "");\n` +
      `process.exit(Number(process.env.HARV_VERIFY_EXIT ?? 0));\n`,
    { mode: 0o755 },
  );
}

/**
 * A `git` that records the fact it ran and then fails. "This run needed no
 * network" is the absence of an event, so it is checked by removing the
 * possibility rather than by reading output.
 */
function writeGitStandIn(dir: string, receipt: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "git"),
    `#!/usr/bin/env node\n` +
      `require("node:fs").appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `process.exit(1);\n`,
    { mode: 0o755 },
  );
}

// ---------------------------------------------------------------------------
// Reading the sample Manifest
// ---------------------------------------------------------------------------

interface Declared {
  /** Manifest keys, which are also the names a session answers to (ADR 0008). */
  names: string[];
  /** Keys whose Source is a local path — the one thing a runner cannot reproduce. */
  pathSources: string[];
  /** The `[settings]` table, which is what `--settings` must carry. */
  settings: Record<string, unknown>;
  /** `[mcp]` keys — the only servers `--mcp-config` may name. */
  mcpServers: string[];
}

function readDeclared(manifestPath: string): Declared {
  const raw = parseToml(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const skills = (raw.skills ?? {}) as Record<string, Record<string, unknown>>;
  return {
    names: Object.keys(skills),
    pathSources: Object.entries(skills)
      .filter(([, source]) => source?.path !== undefined)
      .map(([name]) => name),
    settings: (raw.settings ?? {}) as Record<string, unknown>,
    // Names only: a `${VAR}` in a definition is resolved from the launching
    // environment (ADR 0005's MCP half), so the payload's values are not the
    // Manifest's text and comparing them would be comparing the wrong thing.
    mcpServers: Object.keys((raw.mcp ?? {}) as Record<string, unknown>),
  };
}

/** Locked content hashes by name, so a symlink target can be checked against its pin. */
function readLockedHashes(lockPath: string): Map<string, string> {
  const raw = parseToml(readFileSync(lockPath, "utf8")) as { skills?: Array<Record<string, unknown>> };
  return new Map(
    (raw.skills ?? [])
      .filter((entry) => typeof entry.hash === "string")
      .map((entry) => [String(entry.name), String(entry.hash)]),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** The sample project as checked in — read, never written. */
  sample: string;
  declared: Declared;
  /** What a runner has after `git clone`: the two committed files, nothing else. */
  project: string;
  /** An empty machine-global Store, so the first Sync is a cold one. */
  store: string;
  /** A `$HOME` with a populated user scope, used for every launch. */
  home: string;
  /** The MCP servers that `$HOME` declares, which no session here may load. */
  machineMcpServers: string[];
  claudeStandIn: string;
  claudeDump: string;
  gitStandIn: string;
  gitReceipt: string;
}

function buildFixtures(sample: string): Fixtures {
  const manifestPath = join(sample, "harvenv.toml");
  const lockPath = join(sample, "harvenv.lock");
  for (const path of [manifestPath, lockPath]) {
    if (!existsSync(path)) {
      throw new Error(`${path} does not exist — \`--project\` must name a synced harvenv project.`);
    }
  }

  const dir = (...parts: string[]): string => {
    const path = join(FIXTURE_ROOT, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };

  const project = dir("project");
  copyFileSync(manifestPath, join(project, "harvenv.toml"));
  copyFileSync(lockPath, join(project, "harvenv.lock"));
  // The project's own committed settings, Tripwire and all — a clone arrives
  // with them, so a fixture standing in for a clone has to as well.
  const committedSettings = join(sample, ".claude", "settings.json");
  if (existsSync(committedSettings)) {
    copyFileSync(committedSettings, join(dir("project", ".claude"), "settings.json"));
  }

  // The personal pile ADR 0002 exists to keep out of a shared baseline. It is
  // planted rather than assumed, so its absence downstream is evidence.
  const home = dir("home");
  writeFileSync(
    join(dir("home", ".claude", "skills", USER_SCOPE_SKILL), "SKILL.md"),
    `---\nname: ${USER_SCOPE_SKILL}\ndescription: A personal skill on this machine's user scope. No Harvenv declares it. Never invoke it.\n---\n\nUser scope.\n`,
  );
  writeFileSync(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify({ model: USER_SCOPE_MODEL, outputStyle: "Explanatory" }, null, 2)}\n`,
  );
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "Personal instructions that belong to this machine.\n");

  // MCP servers live in `~/.claude.json`, which is not a settings source — so
  // keeping the machine's own out of the session is the job of a second pair of
  // flags rather than of `--setting-sources`. Planting one is how that is
  // checked instead of assumed.
  const machineMcpServers = ["harvenv-ci-machine-server"];
  writeFileSync(
    join(home, ".claude.json"),
    `${JSON.stringify(
      { mcpServers: Object.fromEntries(machineMcpServers.map((name) => [name, { command: "false" }])) },
      null,
      2,
    )}\n`,
  );

  const claudeStandIn = dir("stand-in", "claude");
  const claudeDump = join(FIXTURE_ROOT, "handover.json");
  writeClaudeStandIn(claudeStandIn, claudeDump);

  const gitStandIn = dir("stand-in", "git");
  const gitReceipt = join(FIXTURE_ROOT, "git-was-run.jsonl");
  writeGitStandIn(gitStandIn, gitReceipt);

  return {
    sample,
    declared: readDeclared(manifestPath),
    project,
    store: dir("store-home"),
    home,
    machineMcpServers,
    claudeStandIn,
    claudeDump,
    gitStandIn,
    gitReceipt,
  };
}

// ---------------------------------------------------------------------------
// Launching, and reading back what harv handed over
// ---------------------------------------------------------------------------

interface Handover {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

interface LaunchOptions {
  /** What the stand-in session prints, so stdout pass-through is observable. */
  stdout?: string;
  /** What it exits with, so exit-code adoption is observable. */
  exit?: number;
  /** Prepended to PATH ahead of the stand-in `claude` — a `git` that must not run. */
  alsoStub?: string;
  env?: NodeJS.ProcessEnv;
  unset?: string[];
}

interface Launched {
  result: Completed;
  handover: Handover;
}

/**
 * `harv claude ...` against the stand-in, with the fixture's populated user
 * scope as `$HOME`. Returns both what the caller saw and what the session was
 * handed.
 */
function launch(fx: Fixtures, passthrough: string[], options: LaunchOptions = {}): Launched {
  rmSync(fx.claudeDump, { force: true });
  const path = [options.alsoStub, fx.claudeStandIn, process.env.PATH ?? ""].filter(Boolean).join(":");

  const result = harv(["claude", ...passthrough], fx.project, {
    env: {
      HARV_HOME: fx.store,
      HOME: fx.home,
      PATH: path,
      HARV_VERIFY_STDOUT: options.stdout ?? "",
      HARV_VERIFY_EXIT: String(options.exit ?? 0),
      ...options.env,
    },
    // Stripped from harv's own environment so that finding it in the session's
    // is evidence the Launcher set it, rather than evidence that this script
    // happens to be running inside a harv session itself.
    unset: [...(options.unset ?? []), "HARV_SESSION"],
  });

  if (!existsSync(fx.claudeDump)) {
    throw new Error(
      `\`harv claude\` never reached a session (exit ${result.code}).\n${(result.stderr || result.stdout).trim().slice(0, 600)}`,
    );
  }
  return { result, handover: JSON.parse(readFileSync(fx.claudeDump, "utf8")) as Handover };
}

const flagValue = (argv: string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

/** Key order is not meaning, so it is normalized away before comparing. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : nested,
  );

const materializedNames = (project: string): string[] => {
  const dir = join(project, ".claude", "skills");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const only = <T,>(a: T[], b: T[]): T[] => a.filter((item) => !b.includes(item));

/** Multi-line output flattened for a one-line report detail. */
const oneLine = (text: string): string => text.trim().split("\n").join(" / ");

/**
 * Sync prints drift on stdout — as the work it is about to do — and warnings
 * on stderr. Both mean the committed state and the runner's disagree, so both
 * are read. Drift lines are the ones that are not harv's own summary.
 */
const complaints = (synced: Completed): string[] => [
  ...synced.stdout.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("harv:")),
  ...synced.stderr.split("\n").filter((line) => line.trim() !== ""),
];

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

// ---------------------------------------------------------------------------
// Criterion 1 — a runner with an empty Store reproduces the committed Harvenv
// ---------------------------------------------------------------------------

function checkCleanMachine(fx: Fixtures): Check {
  const committedLock = readFileSync(join(fx.sample, "harvenv.lock"), "utf8");
  const synced = harv(["sync"], fx.project, { env: { HARV_HOME: fx.store } });
  const lockAfter = readFileSync(join(fx.project, "harvenv.lock"), "utf8");

  const locked = readLockedHashes(join(fx.sample, "harvenv.lock"));
  const materialized = materializedNames(fx.project);
  // A Store entry is named by the hash of its own content (ADR 0010), so the
  // link target is where "the runner got the pinned bytes" is legible without
  // re-hashing anything.
  const targets = Object.fromEntries(
    materialized.map((name) => [name, readlinkSync(join(fx.project, ".claude", "skills", name))]),
  );
  const wrongTarget = [...locked].filter(([name, hash]) => basename(targets[name] ?? "") !== hash.replace("sha256:", ""));

  return {
    id: "clean-machine",
    title: "A runner with an empty Store reproduces the Harvenv the Lockfile pins",
    measurements: {
      exit: synced.code,
      stdout: synced.stdout.trim(),
      stderr: synced.stderr.trim(),
      declared: fx.declared.names,
      materialized,
      targets,
    },
    expectations: [
      expect(
        "the Manifest and Lockfile alone are enough — no Store, no `.claude/`",
        synced.code === 0,
        synced.code === 0 ? `exit 0: ${oneLine(synced.stdout)}` : `exit ${synced.code}: ${oneLine(synced.stderr).slice(0, 300)}`,
      ),
      expect(
        "every declared Component is materialized, and only those",
        canonical(materialized) === canonical([...fx.declared.names].sort()),
        `declared ${fx.declared.names.join(", ") || "nothing"}; materialized ${materialized.join(", ") || "nothing"}`,
      ),
      expect(
        "each one resolves to the Store entry its Lockfile hash names",
        wrongTarget.length === 0,
        wrongTarget.length === 0
          ? `${locked.size} pinned entr${locked.size === 1 ? "y" : "ies"} resolved by content hash`
          : `mismatched: ${wrongTarget.map(([name]) => name).join(", ")}`,
      ),
      // A Sync that rewrote the Lockfile means the committed one was not what a
      // clean machine produces — the workflow enforces this with `git diff`.
      expect(
        "the committed Lockfile is what the runner ends up with, unchanged",
        lockAfter === committedLock,
        lockAfter === committedLock ? "byte-identical" : "the runner rewrote harvenv.lock",
      ),
      expect(
        "nothing in the Harvenv is a local path a runner could not resolve",
        fx.declared.pathSources.length === 0,
        fx.declared.pathSources.length === 0
          ? "every Source is fetchable"
          : `non-portable: ${fx.declared.pathSources.join(", ")}`,
      ),
      expect(
        "the Sync reports nothing amiss — no drift, no non-portable Source",
        complaints(synced).length === 0,
        complaints(synced).join(" / ") || "the runner had nothing to say about the committed state",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — the session is composed from the Manifest and nothing else
// ---------------------------------------------------------------------------

function checkManifestOnly(fx: Fixtures): Check {
  const { handover } = launch(fx, ["-p", "probe"]);
  const { argv } = handover;

  const settingSources = flagValue(argv, "--setting-sources");
  const settings = flagValue(argv, "--settings");
  const mcpConfig = flagValue(argv, "--mcp-config");

  let sessionSettings: Record<string, unknown> | null = null;
  try {
    sessionSettings = JSON.parse(settings ?? "") as Record<string, unknown>;
  } catch {
    /* reported by the expectation below */
  }

  const userScopeSkills = readdirSync(join(fx.home, ".claude", "skills"));
  const materialized = materializedNames(fx.project);
  const owned = JSON.parse(
    readFileSync(join(fx.project, ".claude", ".harv-materialized.json"), "utf8"),
  ) as { skills: string[] };

  let sessionMcpServers: string[] = [];
  try {
    sessionMcpServers = Object.keys(
      (JSON.parse(mcpConfig ?? "{}") as { mcpServers?: Record<string, unknown> }).mcpServers ?? {},
    ).sort();
  } catch {
    /* reported by the expectation below */
  }

  const configEnvKeys = Object.keys(handover.env).filter((key) => /CLAUDE_CONFIG|CLAUDE_HOME/i.test(key));
  const configFlags = argv.filter((arg) => /config-dir|^--bare$/.test(arg));
  const declaresSettings = Object.keys(fx.declared.settings).length > 0;

  return {
    id: "manifest-only",
    title: "The CI session is composed from the Manifest and nothing else",
    measurements: {
      settingSources,
      settings,
      mcpConfig,
      machineMcpServers: fx.machineMcpServers,
      pluginDirs: argv.filter((arg) => arg === "--plugin-dir").length,
      userScopeSkills,
      materialized,
      ownedByHarv: owned.skills,
      cwd: handover.cwd,
    },
    expectations: [
      expect(
        "the Harvenv holds exactly what the Manifest declares",
        canonical(materialized) === canonical([...fx.declared.names].sort()),
        `declared ${fx.declared.names.join(", ") || "nothing"}; loaded ${materialized.join(", ") || "nothing"}`,
      ),
      // The machine is not a clean room: it has a personal skill on it, and the
      // Harvenv still does not.
      expect(
        "a personal skill on this machine's user scope is not among them",
        userScopeSkills.length > 0 && only(userScopeSkills, materialized).length === userScopeSkills.length,
        `${fx.home}/.claude/skills holds ${userScopeSkills.join(", ")}; project scope holds ${materialized.join(", ")}`,
      ),
      expect(
        "the recipe suppresses user scope — `--setting-sources project,local`",
        settingSources === "project,local",
        `--setting-sources ${settingSources ?? "(absent)"}`,
      ),
      expect(
        "the settings the session gets are the Manifest's, not the machine's",
        declaresSettings ? canonical(sessionSettings) === canonical(fx.declared.settings) : null,
        declaresSettings
          ? `--settings ${settings} (this machine's user scope asks for model "${USER_SCOPE_MODEL}")`
          : "the sample Manifest declares no settings",
      ),
      // The machine's servers are in `~/.claude.json`, which `--setting-sources`
      // does not reach — so this is the second flag pair's job, and the fixture
      // `$HOME` declares a server precisely so its absence here means something.
      expect(
        "the session's MCP servers are exactly the Manifest's, not the machine's",
        argv.includes("--strict-mcp-config") &&
          canonical(sessionMcpServers) === canonical([...fx.declared.mcpServers].sort()),
        `--strict-mcp-config ${argv.includes("--strict-mcp-config") ? "present" : "absent"}; ` +
          `the Manifest declares ${fx.declared.mcpServers.join(", ") || "no servers"} and the session gets ` +
          `${sessionMcpServers.join(", ") || "none"}, while this machine declares ${fx.machineMcpServers.join(", ")}`,
      ),
      // ADR 0008: Components are materialized into project scope, so the name a
      // Manifest declares is the name the session answers to.
      expect(
        "no `--plugin-dir`, so declared names stay bare",
        !argv.includes("--plugin-dir"),
        argv.includes("--plugin-dir") ? "the recipe serves Components as plugins" : "Components come from project scope",
      ),
      expect(
        "harv owns every materialized Component, so the set is harv's to state",
        canonical([...owned.skills].sort()) === canonical(materialized),
        `.harv-materialized.json records ${owned.skills.join(", ") || "nothing"}`,
      ),
      // ADR 0003. CI has no login to protect, but the recipe has to be the same
      // one a developer gets, or what CI proves does not transfer to them.
      expect(
        "it is the developer's recipe: no config-dir redirect, no `--bare`",
        configEnvKeys.length === 0 && configFlags.length === 0,
        [...configEnvKeys, ...configFlags].join(", ") || "the session reads the machine's own config dir",
      ),
      // The project's committed Tripwire (ADR 0009) fires on every session and
      // stays silent when it sees this marker. Without it every CI run would
      // open by announcing that it is not isolated, which it is.
      expect(
        "the session is marked as a Launcher session, so the Tripwire stays quiet",
        handover.env.HARV_SESSION === "1",
        `HARV_SESSION=${JSON.stringify(handover.env.HARV_SESSION ?? null)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — `harv claude -p` behaves like a build step
// ---------------------------------------------------------------------------

function checkHeadlessRun(fx: Fixtures): Check {
  const extras = ["-p", "Reply with the single word: ok", "--output-format", "json"];
  const answer = `{"type":"result","subtype":"success","result":"ok"}\n`;
  const ran = launch(fx, extras, { stdout: answer });

  const argv = ran.handover.argv;
  const tail = argv.slice(-extras.length);
  const recipe = argv.slice(0, argv.length - extras.length);

  // A gate is only a gate if a failing session fails the step.
  const failed = launch(fx, extras, { exit: 7 });

  return {
    id: "headless-run",
    title: "`harv claude -p` behaves like a build step: arguments, output and exit code all pass through",
    measurements: {
      recipe,
      tail,
      exitOnSuccess: ran.result.code,
      stdout: ran.result.stdout,
      exitOnFailure: failed.result.code,
    },
    expectations: [
      expect(
        "the headless arguments arrive verbatim, in order",
        canonical(tail) === canonical(extras),
        tail.join(" "),
      ),
      expect(
        "they land after the recipe, so harv's flags cannot be shadowed by accident",
        recipe.includes("--setting-sources") && recipe.includes("--strict-mcp-config"),
        recipe.join(" "),
      ),
      expect("a session that succeeds exits 0", ran.result.code === 0, `exit ${ran.result.code}`),
      expect(
        "the session's output reaches the caller unchanged, so a step can pipe it",
        ran.result.stdout === answer,
        JSON.stringify(ran.result.stdout),
      ),
      expect(
        "harv adopts the session's exit code, so a failing run fails the job",
        failed.result.code === 7,
        `the session exited 7; harv exited ${failed.result.code}`,
      ),
      expect(
        "the run needs no terminal — nothing is written to stderr on the way",
        ran.result.stderr.trim() === "",
        ran.result.stderr.trim() || "(nothing on stderr)",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — a cached Store makes the next run network-free
// ---------------------------------------------------------------------------

function checkStoreCache(fx: Fixtures): Check {
  rmSync(fx.gitReceipt, { force: true });

  // A `git` that records its invocation and fails. A Sync that needed the
  // network cannot survive it, so a zero exit is proof that none was needed —
  // which is the whole reason a workflow caches `~/.harv/store`.
  const synced = harv(["sync"], fx.project, {
    env: { HARV_HOME: fx.store, PATH: `${fx.gitStandIn}:${process.env.PATH ?? ""}` },
  });
  const gitAfterSync = existsSync(fx.gitReceipt) ? readFileSync(fx.gitReceipt, "utf8").trim().split("\n") : [];

  // ADR 0009: the Launcher never syncs, so it never needs a remote either.
  const launched = launch(fx, ["-p", "probe"], { alsoStub: fx.gitStandIn });
  const gitAfterLaunch = existsSync(fx.gitReceipt) ? readFileSync(fx.gitReceipt, "utf8").trim().split("\n") : [];

  return {
    id: "store-cache",
    title: "A cached Store makes the next run network-free, at sync and at launch",
    measurements: {
      syncExit: synced.code,
      syncStdout: synced.stdout.trim(),
      launchExit: launched.result.code,
      gitInvocations: gitAfterLaunch,
    },
    expectations: [
      expect(
        "the second Sync succeeds with a `git` that cannot fetch",
        synced.code === 0,
        synced.code === 0 ? "exit 0" : `exit ${synced.code}: ${synced.stderr.trim().slice(0, 300)}`,
      ),
      expect(
        "it reports the Sources as reused rather than fetched",
        /reused/.test(synced.stdout) && !/fetched/.test(synced.stdout),
        synced.stdout.trim(),
      ),
      expect("git was never invoked", gitAfterSync.length === 0, gitAfterSync.join(" / ") || "no invocation recorded"),
      expect(
        "the launch needs no remote either",
        launched.result.code === 0 && gitAfterLaunch.length === 0,
        gitAfterLaunch.length === 0 ? `exit ${launched.result.code}, git untouched` : gitAfterLaunch.join(" / "),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 5 — credentials travel through the environment, and nowhere else
// ---------------------------------------------------------------------------

function checkCredentials(fx: Fixtures): Check {
  const { handover } = launch(fx, ["-p", "probe"], { env: { ANTHROPIC_API_KEY: FIXTURE_API_KEY } });

  const inArgv = handover.argv.some((arg) => arg.includes(FIXTURE_API_KEY));
  const inSettings = (flagValue(handover.argv, "--settings") ?? "").includes(FIXTURE_API_KEY);

  // Warming a Store is a git operation. A workflow that only needs the cache
  // filled — a nightly, a fork's pull request — should need no secret at all.
  rmSync(join(fx.store, "store"), { recursive: true, force: true });
  const syncedWithoutKey = harv(["sync"], fx.project, {
    env: { HARV_HOME: fx.store },
    unset: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  });

  return {
    id: "credentials",
    title: "Credentials reach the session through the environment and nowhere else",
    measurements: {
      keyReachedSession: handover.env.ANTHROPIC_API_KEY === FIXTURE_API_KEY,
      argv: handover.argv,
      syncWithoutKeyExit: syncedWithoutKey.code,
      syncWithoutKeyStdout: syncedWithoutKey.stdout.trim(),
    },
    expectations: [
      // harv composes flags; it does not manage credentials. Auth is personal
      // and is never a Component (CONTEXT.md), so the API key a workflow sets
      // from a secret has to arrive the ordinary way: inherited, untouched.
      expect(
        "an API key in the environment arrives at the session unchanged",
        handover.env.ANTHROPIC_API_KEY === FIXTURE_API_KEY,
        handover.env.ANTHROPIC_API_KEY === FIXTURE_API_KEY
          ? "ANTHROPIC_API_KEY inherited verbatim"
          : `the session saw ${JSON.stringify(handover.env.ANTHROPIC_API_KEY ?? null)}`,
      ),
      expect(
        "it is never put on the command line, where a process list or `set -x` would show it",
        !inArgv && !inSettings,
        inArgv || inSettings ? "the key appears in the arguments harv passes" : "no argument contains the key",
      ),
      expect(
        "warming the Store needs no credentials at all",
        syncedWithoutKey.code === 0,
        syncedWithoutKey.code === 0
          ? `\`harv sync\` with no key: ${syncedWithoutKey.stdout.trim()}`
          : `exit ${syncedWithoutKey.code}: ${syncedWithoutKey.stderr.trim().slice(0, 300)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const failed = (check: Check): boolean => Boolean(check.error) || check.expectations.some((e) => e.ok === false);

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

function projectArgument(argv: string[]): string {
  const index = argv.indexOf("--project");
  if (index === -1) return DEFAULT_PROJECT;
  const value = argv[index + 1];
  if (value === undefined) throw new Error("`--project` needs the path of a synced harvenv project.");
  return realpathSync(value);
}

async function main(): Promise<number> {
  const asJson = process.argv.includes("--json");
  const keep = process.argv.includes("--keep");
  const log = asJson ? () => {} : console.log;

  const sample = projectArgument(process.argv);
  const fx = buildFixtures(sample);
  log("harvenv CI-recipe verification");
  log(`${DIM}sample Manifest: ${sample}${RESET}`);
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  // Ordered, not independent: the first check is the cold Sync every later one
  // runs against, exactly as a runner would perform it.
  const runners: Array<[string, string, () => Check]> = [
    ["clean-machine", "A runner with an empty Store reproduces the Harvenv the Lockfile pins", () => checkCleanMachine(fx)],
    ["manifest-only", "The CI session is composed from the Manifest and nothing else", () => checkManifestOnly(fx)],
    ["headless-run", "`harv claude -p` behaves like a build step", () => checkHeadlessRun(fx)],
    ["store-cache", "A cached Store makes the next run network-free", () => checkStoreCache(fx)],
    ["credentials", "Credentials reach the session through the environment and nowhere else", () => checkCredentials(fx)],
  ];

  const checks: Check[] = [];
  for (const [id, title, runCheck] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(runCheck());
    } catch (err) {
      checks.push({
        id,
        title,
        expectations: [],
        measurements: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (keep) log(`\n${DIM}fixtures kept at ${FIXTURE_ROOT}${RESET}`);
  else rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const failures = checks.filter(failed);
  if (asJson) {
    console.log(JSON.stringify({ ok: failures.length === 0, fixtures: keep ? FIXTURE_ROOT : null, project: sample, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\n${checks.length - failures.length}/${checks.length} criteria verified` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

if (!existsSync(HARV)) throw new Error(`harv entry point not found at ${HARV}`);
process.exitCode = await main();

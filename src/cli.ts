/**
 * `harv` — the command line surface.
 *
 * Three subcommands, and the split between them is deliberate. `sync` is the
 * only one that reaches a network or writes a Lockfile; `claude` only ever
 * reads one. A Launcher that quietly fetched would be a second, invisible
 * Sync, and the reproducibility the Lockfile exists for would depend on which
 * command a teammate happened to run.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { AddError, entryLine, parseCoordinate, validateName, withEntry } from "./add.ts";
import { driftAgainst, LockfileError, readLockfile } from "./lockfile.ts";
import type { DriftEntry } from "./lockfile.ts";
import { findManifest, loadManifest, ManifestError, MANIFEST_FILENAME } from "./manifest.ts";
import type { Manifest, Source } from "./manifest.ts";
import { materialize, MaterializeError } from "./materialize.ts";
import { launch as launchSession, SettingsError, validateSettings } from "./launch.ts";
import { GitError } from "./git.ts";
import { plan, sync, SyncError } from "./sync.ts";
import type { Env } from "./store.ts";

export interface CliDeps {
  cwd: string;
  /** Where the Store lives. Injected so a test never touches the real one. */
  env: Env;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Injected so tests can exercise the whole command without a real session. */
  launch: (manifest: Manifest, passthrough: string[]) => Promise<number>;
}

const USAGE = `Usage: harv <command> [args...]

Commands:
  sync               Resolve every Manifest entry into the Store and write
                     ${"harvenv.lock"}. Run it after editing the Manifest, and
                     after cloning a project that has one.
  add <name> --git <coordinate> [--ref <ref>] [--subdir <dir>]
  add <name> --path <dir>
                     Declare a skill in the Manifest and sync it. A coordinate
                     may carry its ref and subdirectory: repo.git@v1#skills/x
  claude [args...]   Start a Claude Code session composed strictly from this
                     project's Harvenv. Arguments after \`claude\` are passed
                     through unchanged (harv claude -p "hi", --resume, ...).

harv reads ${MANIFEST_FILENAME} from the current directory or the nearest ancestor.`;

/** Errors whose message is written for the user, not for a debugger. */
const EXPECTED_ERRORS = [ManifestError, MaterializeError, SettingsError, LockfileError, SyncError, GitError, AddError];

export function defaultDeps(): CliDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    launch: launchSession,
  };
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command === undefined) {
    deps.stderr(USAGE);
    return 2;
  }

  const commands: Record<string, (args: string[], deps: CliDeps) => Promise<number> | number> = {
    claude,
    sync: syncCommand,
    add,
  };
  const handler = commands[command];
  if (handler === undefined) {
    deps.stderr(`harv: unknown command \`${command}\`.\n`);
    deps.stderr(USAGE);
    return 2;
  }

  try {
    return await handler(rest, deps);
  } catch (err) {
    if (EXPECTED_ERRORS.some((type) => err instanceof type)) {
      deps.stderr(`harv: ${(err as Error).message}`);
      return 1;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// claude — the Launcher
// ---------------------------------------------------------------------------

async function claude(passthrough: string[], deps: CliDeps): Promise<number> {
  const manifest = requireManifest(deps);
  if (manifest === null) return 1;

  // Everything that can be judged from the Manifest alone is judged before the
  // first write, so a Manifest that cannot launch leaves no trace in the tree.
  validateSettings(manifest.settings);

  const lock = readLockfile(manifest.root);
  const drift = driftAgainst(manifest, lock);
  if (drift.length > 0) {
    deps.stderr(driftReport(drift));
    return 1;
  }

  materialize(plan(manifest, lock, deps.env));
  return deps.launch(manifest, passthrough);
}

const driftReport = (drift: DriftEntry[]): string =>
  `harv: the Manifest and ${"harvenv.lock"} have drifted, so this session would not be the Harvenv the Manifest ` +
  `describes.\n${drift.map((entry) => `  ${entry.name}: ${entry.reason}`).join("\n")}\n` +
  `  Run \`harv sync\` to reconcile them.`;

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

function syncCommand(args: string[], deps: CliDeps): number {
  if (args.length > 0) {
    deps.stderr(`harv: \`sync\` takes no arguments, but got \`${args.join(" ")}\`.`);
    return 2;
  }
  const manifest = requireManifest(deps);
  if (manifest === null) return 1;

  validateSettings(manifest.settings);
  report(sync(manifest, { env: deps.env }), deps);
  return 0;
}

function report(result: ReturnType<typeof sync>, deps: CliDeps): void {
  for (const entry of result.drift) deps.stdout(`  ${entry.name}: ${entry.reason}`);

  const done = [
    result.fetched.length > 0 ? `fetched ${result.fetched.join(", ")}` : "",
    result.reused.length > 0 ? `reused ${result.reused.join(", ")} from the Store` : "",
    result.local.length > 0 ? `linked ${result.local.join(", ")} from a local path` : "",
    result.materialized.removed.length > 0 ? `removed ${result.materialized.removed.join(", ")}` : "",
  ].filter((line) => line !== "");

  deps.stdout(done.length > 0 ? `harv: ${done.join("; ")}.` : "harv: up to date.");
  for (const warning of result.warnings) deps.stderr(`harv: warning: ${warning}`);
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

function add(args: string[], deps: CliDeps): number {
  const manifest = requireManifest(deps);
  if (manifest === null) return 1;

  const name = validateName(args[0]);
  const source = sourceFrom(args.slice(1), name);
  if (manifest.skills.some((skill) => skill.name === name)) {
    throw new AddError(
      `\`${name}\` is already declared in ${manifest.path}. ` +
        `Edit that entry, or remove it and run \`harv add\` again.`,
    );
  }

  const before = readFileSync(manifest.path, "utf8");
  writeFileSync(manifest.path, withEntry(before, entryLine(name, source)));

  try {
    // Reloaded rather than patched in memory: the entry now has to survive the
    // same parse a teammate's clone will give it.
    report(sync(loadManifest(manifest.path), { env: deps.env }), deps);
  } catch (err) {
    // A Manifest declaring something that could not be fetched is worse than
    // no change at all — the next `harv claude` would refuse to start.
    writeFileSync(manifest.path, before);
    throw err;
  }
  return 0;
}

function sourceFrom(args: string[], name: string): Source {
  const flags = parseFlags(args);
  const git = flags.get("--git");
  const path = flags.get("--path");

  if (git !== undefined && path !== undefined) {
    throw new AddError("`--git` and `--path` are two different Sources. Pass one.");
  }
  if (path !== undefined) {
    for (const flag of ["--ref", "--subdir"]) {
      if (flags.has(flag)) throw new AddError(`\`${flag}\` describes a repository, and \`--path\` is not one.`);
    }
    return { kind: "path", declared: path, path };
  }
  if (git === undefined) {
    throw new AddError(
      `\`harv add ${name}\` needs a Source: \`--git <coordinate>\` for a repository, or \`--path <dir>\` ` +
        `for a local directory.`,
    );
  }

  const coordinate = parseCoordinate(git);
  const ref = flags.get("--ref") ?? coordinate.ref;
  const subdir = flags.get("--subdir") ?? coordinate.subdir;
  if (flags.has("--ref") && coordinate.ref !== undefined) {
    throw new AddError(`the coordinate already pins \`@${coordinate.ref}\`, so \`--ref\` has nothing to add.`);
  }
  if (flags.has("--subdir") && coordinate.subdir !== undefined) {
    throw new AddError(`the coordinate already selects \`#${coordinate.subdir}\`, so \`--subdir\` has nothing to add.`);
  }

  return {
    kind: "git",
    repo: coordinate.repo,
    ...(ref === undefined ? {} : { ref }),
    ...(subdir === undefined ? {} : { subdir }),
  };
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new AddError(`unexpected argument \`${flag}\`. Sources are given as flags: --git, --path, --ref, --subdir.`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new AddError(`\`${flag}\` needs a value.`);
    flags.set(flag, value);
    i += 1;
  }
  for (const flag of flags.keys()) {
    if (!["--git", "--path", "--ref", "--subdir"].includes(flag)) {
      throw new AddError(`unknown flag \`${flag}\`. \`harv add\` takes --git, --path, --ref and --subdir.`);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The project's Manifest, or null after reporting that there is none. */
function requireManifest(deps: CliDeps): Manifest | null {
  const manifestPath = findManifest(deps.cwd);
  if (manifestPath === null) {
    deps.stderr(
      `harv: no Manifest found — this is not a harvenv project.\n` +
        `  Searched for ${MANIFEST_FILENAME} in ${deps.cwd} and every directory above it.\n` +
        `  Create one to declare this project's Harvenv, or run \`claude\` directly for an un-isolated session.`,
    );
    return null;
  }
  return loadManifest(manifestPath);
}

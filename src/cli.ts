/**
 * `harv` — the command line surface.
 *
 * The splits between the subcommands are deliberate. `init` is the only one
 * that runs before there is a project at all. `sync` is the only one that
 * reaches a network or writes a Lockfile; `claude` only ever reads one. A
 * Launcher that quietly fetched would be a second, invisible Sync, and the
 * reproducibility the Lockfile exists for would depend on which command a
 * teammate happened to run.
 *
 * `mise` and `--version` sit outside that split: they answer questions about
 * the installation rather than about a project, so neither looks for a
 * Manifest. That is what makes `harv --version` the one thing that always
 * works on a machine which has just met harv. `shim` sits outside it too, and
 * further out still: it is the only command that writes beyond the project, and
 * the only one a user runs once rather than daily.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { AddError, entryLine, parseCoordinate, validateName, withEntry } from "./add.ts";
import { driftAgainst, LockfileError, readLockfile } from "./lockfile.ts";
import type { DriftEntry } from "./lockfile.ts";
import { findManifest, loadManifest, ManifestError, MANIFEST_FILENAME } from "./manifest.ts";
import type { Manifest, Source } from "./manifest.ts";
import { materialize, MaterializeError } from "./materialize.ts";
import { launch as launchSession, LaunchError } from "./launch.ts";
import { McpError, validateMcpServers } from "./mcp.ts";
import { SettingsError, validateSettings } from "./settings.ts";
import { GitError } from "./git.ts";
import { init as initProject, InitError } from "./init.ts";
import type { InitResult } from "./init.ts";
import { MISE_VERSION, MiseError, runMise as runMiseBinary } from "./mise.ts";
import { currentPlatform } from "./platform.ts";
import {
  defaultShimContext,
  installShim,
  shimStatus,
  ShimError,
  uninstallShim,
  type ShimContext,
} from "./shim.ts";
import { TripwireError } from "./tripwire.ts";
import { plan, sync, SyncError } from "./sync.ts";
import type { Env } from "./store.ts";
import { defaultUpdateCheckDeps, isDevBuild, updateHint, VERSION } from "./version.ts";

export interface CliDeps {
  cwd: string;
  /**
   * The process environment: where the Store lives, where a server definition's
   * `${VAR}` resolves from, and what a launched session inherits. Injected so a
   * test never touches the real Store or the real environment.
   */
  env: Env;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Injected so tests can exercise the whole command without a real session. */
  launch: (manifest: Manifest, passthrough: string[], env: Env) => Promise<number>;
  /** Injected for the same reason: no test should need a 90MB binary on disk. */
  runMise: (args: string[]) => Promise<number>;
  /** Resolves to the one line worth printing, or null. Never throws. */
  updateHint: () => Promise<string | null>;
  /** Injected so tests never touch the real HOME, PATH or shell startup files. */
  shim: ShimContext;
}

const USAGE = `Usage: harv <command> [args...]

Commands:
  init               Scaffold this directory into a harvenv project: a
                     ${MANIFEST_FILENAME}, gitignore entries for generated and
                     personal files, and the Tripwire that warns an un-isolated
                     session. Safe to re-run; it only tops up what is missing.
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
  shim install       Route a bare \`claude\` through harv: hermetic inside a
                     harvenv project, the real claude everywhere else.
       [--shell <name>]  zsh, bash, fish, sh — or \`none\` to edit no startup file.
  shim uninstall     Remove the shim and the PATH entry it added.
  shim status        Report where the shim is, whether it is active, and what
                     a bare \`claude\` resolves to. Takes --json.
  mise [args...]     Run the vendored Toolchain engine. Mostly for diagnosis
                     until \`harv sync\` drives it.

Options:
  --version, -v      Print the harv and mise versions, and whether harv is
                     behind the latest release.
  --help, -h         Print this.

harv reads ${MANIFEST_FILENAME} from the current directory or the nearest ancestor.`;

/** Errors whose message is written for the user, not for a debugger. */
const EXPECTED_ERRORS = [
  ManifestError,
  MaterializeError,
  SettingsError,
  LaunchError,
  McpError,
  LockfileError,
  SyncError,
  GitError,
  AddError,
  MiseError,
  InitError,
  ShimError,
  TripwireError,
];

export function defaultDeps(): CliDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    launch: launchSession,
    runMise: runMiseBinary,
    updateHint: () => updateHint(defaultUpdateCheckDeps()).catch(() => null),
    shim: defaultShimContext(),
  };
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return await version(deps);
  }
  if (command === undefined) {
    deps.stderr(USAGE);
    return 2;
  }

  const commands: Record<string, (args: string[], deps: CliDeps) => Promise<number> | number> = {
    init,
    claude,
    sync: syncCommand,
    add,
    shim,
    mise: (args, d) => d.runMise(args),
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
// --version
// ---------------------------------------------------------------------------

/**
 * The facts go to stdout, so `harv --version` stays something a script can
 * read; the "you are behind" notice goes to stderr, because it is a remark
 * about the installation rather than an answer to the question asked.
 */
async function version(deps: CliDeps): Promise<number> {
  const suffix = isDevBuild() ? " — development build, run from source" : "";
  deps.stdout(`harv ${VERSION} (${currentPlatform()})${suffix}`);
  deps.stdout(`vendored mise ${MISE_VERSION}`);

  const hint = await deps.updateHint();
  if (hint !== null) deps.stderr(`\n${hint}`);
  return 0;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function init(args: string[], deps: CliDeps): number {
  if (args.length > 0) {
    deps.stderr(`harv: \`init\` takes no arguments, but got \`${args.join(" ")}\`. It scaffolds the current directory.`);
    return 2;
  }
  reportInit(initProject(deps.cwd), deps);
  return 0;
}

function reportInit(result: InitResult, deps: CliDeps): void {
  const untouched = result.steps.every((step) => step.action === "unchanged");
  const column = Math.max(...result.steps.map((step) => step.path.length));

  deps.stdout(untouched ? `Already a harvenv project: ${result.root}` : `Initialized a Harvenv in ${result.root}`);
  deps.stdout("");
  for (const step of result.steps) {
    deps.stdout(`  ${step.action.padEnd(9)} ${step.path.padEnd(column)}   ${step.detail}`);
  }
  // Only worth saying once. A re-run is someone checking, not someone starting.
  if (untouched) return;
  deps.stdout("");
  deps.stdout(
    `A bare \`claude\` here now warns that its session is not isolated. Declare a skill with ` +
      `\`harv add\`, then run \`harv claude\`.`,
  );
}

// ---------------------------------------------------------------------------
// claude — the Launcher
// ---------------------------------------------------------------------------

async function claude(passthrough: string[], deps: CliDeps): Promise<number> {
  const manifest = requireManifest(deps);
  if (manifest === null) return 1;

  validateSessionConfig(manifest, deps.env);

  const lock = readLockfile(manifest.root);
  const drift = driftAgainst(manifest, lock);
  if (drift.length > 0) {
    deps.stderr(driftReport(drift));
    return 1;
  }

  materialize(plan(manifest, lock, deps.env));
  return deps.launch(manifest, passthrough, deps.env);
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

  validateSessionConfig(manifest, deps.env);
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
        `  Run \`harv init\` to declare this project's Harvenv, or run \`claude\` directly for an un-isolated session.`,
    );
    return null;
  }
  return loadManifest(manifestPath);
}

/**
 * The rules ADR 0005 makes harv responsible for: a settings key the Manifest may
 * not bind, or one Claude Code would silently discard, and a server definition
 * that could not run or whose `${VAR}` this environment cannot satisfy.
 *
 * Called by every command that acts on a Manifest, and always before the first
 * write, so a Manifest that cannot launch leaves no trace in the tree.
 */
function validateSessionConfig(manifest: Manifest, env: Env): void {
  validateSettings(manifest.settings);
  validateMcpServers(manifest.mcpServers, env);
}

// ---------------------------------------------------------------------------
// shim
// ---------------------------------------------------------------------------

const SHIM_USAGE = `Usage: harv shim <install|uninstall|status>

  install [--shell zsh|bash|fish|sh|none]   Put a \`claude\` lookalike on PATH.
  uninstall                                 Take it back off, and the PATH entry with it.
  status [--json]                           Report what a bare \`claude\` currently runs.`;

/** Two columns, so a report reads as a table rather than as prose. */
const field = (label: string, value: string): string => `  ${label.padEnd(16)}${value}`;

function shim(args: string[], deps: CliDeps): number {
  const [action, ...flags] = args;

  switch (action) {
    case "install":
      return shimInstall(flags, deps);
    case "uninstall":
      return shimUninstall(deps);
    case "status":
      return shimReport(flags, deps);
    case undefined:
      deps.stderr(SHIM_USAGE);
      return 2;
    default:
      deps.stderr(`harv: unknown shim action \`${action}\`.\n`);
      deps.stderr(SHIM_USAGE);
      return 2;
  }
}

/** `--shell <name>`, the only flag install takes. */
function shellFlag(flags: string[], deps: CliDeps): string | null | undefined {
  const at = flags.indexOf("--shell");
  if (at === -1) {
    const unknown = flags.filter((f) => f.startsWith("-"));
    if (unknown.length > 0) {
      deps.stderr(`harv: unknown option \`${unknown[0]}\`.\n`);
      deps.stderr(SHIM_USAGE);
      return null;
    }
    return undefined;
  }
  const name = flags[at + 1];
  if (name === undefined || name.startsWith("-")) {
    deps.stderr(`harv: --shell needs a shell name (zsh, bash, fish, sh, or none).`);
    return null;
  }
  return name;
}

function shimInstall(flags: string[], deps: CliDeps): number {
  const shell = shellFlag(flags, deps);
  if (shell === null) return 2;

  const result = installShim(deps.shim, shell);

  deps.stdout(`harv: shim ${result.created ? "installed" : "already installed"}.`);
  deps.stdout(field("claude", result.shimPath));
  for (const file of result.startupFiles) deps.stdout(field("PATH entry", `added to ${file}`));
  deps.stdout(field("real claude", result.realClaude ?? "not found on PATH"));
  deps.stdout("");

  if (result.unconfigurableShell !== null) {
    deps.stdout(
      `harv does not know where \`${result.unconfigurableShell}\` reads its startup files, so none were edited.`,
    );
    deps.stdout(`Put the shim directory first on PATH yourself:\n`);
    deps.stdout(`    ${result.pathLine}\n`);
  } else if (!result.activeNow) {
    deps.stdout(`Restart your shell — or run the line below — for \`claude\` to route through harv:\n`);
    deps.stdout(`    ${result.pathLine}\n`);
  }

  deps.stdout(
    `Inside a harvenv project \`claude\` now starts the session the Manifest describes;\n` +
      `everywhere else it runs Claude Code exactly as before. \`HARV_NO_SHIM=1 claude\`\n` +
      `always bypasses it, and \`harv shim uninstall\` removes it.`,
  );
  return 0;
}

function shimUninstall(deps: CliDeps): number {
  const result = uninstallShim(deps.shim);

  if (!result.removedShim && result.cleanedFiles.length === 0) {
    deps.stdout(`harv: no shim installed — nothing to remove.`);
    deps.stdout(field("claude", result.realClaude ?? "not found on PATH"));
    return 0;
  }

  deps.stdout(`harv: shim uninstalled.`);
  if (result.removedShim) deps.stdout(field("removed", deps.shim.shimPath));
  for (const file of result.cleanedFiles) deps.stdout(field("PATH entry", `removed from ${file}`));
  for (const dir of result.removedDirs) deps.stdout(field("removed", `${dir}/`));
  deps.stdout(field("claude", result.realClaude ?? "not found on PATH"));
  deps.stdout("");
  deps.stdout(`Restart your shell to drop the shim directory from PATH.`);
  return 0;
}

function shimReport(flags: string[], deps: CliDeps): number {
  const status = shimStatus(deps.shim);

  if (flags.includes("--json")) {
    deps.stdout(JSON.stringify(status, null, 2));
    return 0;
  }

  deps.stdout(`harv shim`);
  if (status.foreign) {
    deps.stdout(field("shim", `NOT harv's: ${status.shimPath} exists but harv did not create it`));
  } else {
    deps.stdout(field("shim", status.installed ? `installed at ${status.shimPath}` : `not installed`));
  }
  deps.stdout(
    field(
      "claude",
      status.resolvedClaude === null
        ? "not found on PATH"
        : `${status.resolvedClaude}${status.active ? " (the shim)" : ""}`,
    ),
  );
  deps.stdout(field("real claude", status.realClaude ?? "not found on PATH"));

  if (status.installed) {
    deps.stdout(
      field(
        "routes through",
        status.harvCommand === null
          ? "an unreadable shim — reinstall it with `harv shim install`"
          : `${status.harvCommand.join(" ")}${status.harvReachable ? "" : "  <- GONE: sessions would not be isolated"}`,
      ),
    );
  }

  if (status.installed && !status.active) {
    deps.stdout(
      field(
        "PATH",
        status.onPath
          ? `the shim is on PATH but shadowed — ${status.resolvedClaude} comes first`
          : `${deps.shim.binDir} is not on PATH in this shell`,
      ),
    );
  }

  const withBlockPresent = status.startupFiles.filter((f) => f.blockPresent);
  deps.stdout(
    field(
      "shell",
      `${status.shell ?? "unknown"} — ${
        withBlockPresent.length > 0
          ? `PATH entry in ${withBlockPresent.map((f) => f.path).join(", ")}`
          : "no startup file carries harv's PATH entry"
      }`,
    ),
  );

  deps.stdout("");
  deps.stdout(
    status.active
      ? `A bare \`claude\` is hermetic inside a harvenv project and unchanged everywhere else.\n` +
          `\`HARV_NO_SHIM=1 claude\` bypasses the shim.`
      : `A bare \`claude\` runs Claude Code directly — only \`harv claude\` is hermetic.`,
  );
  return 0;
}

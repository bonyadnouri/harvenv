/**
 * The Shim: an opt-in `claude` lookalike on PATH that routes through the
 * Launcher inside harvenv projects and execs the real claude everywhere else.
 *
 * ADR 0003 leaves a gap it names out loud — "sessions are only hermetic when
 * started through the harvenv launcher; a bare `claude` in the same directory
 * is silently un-isolated". The Shim closes it for people who opt in, without
 * closing ADR 0005's escape hatch: `HARV_NO_SHIM=1 claude` still gets a plain
 * session, and the Shim is never installed by default.
 *
 * Three properties shape everything here:
 *
 *   * **Fail open.** Every path through the shim ends at the real claude. A
 *     missing, moved or broken harv makes a session un-isolated — with a word
 *     on stderr — never unavailable. Interception must not become a way to
 *     lose the tool it intercepts.
 *   * **Resolve, never record.** The real claude is looked up on PATH at every
 *     invocation. Claude Code's installer replaces the binary its `claude`
 *     symlink points at, so a recorded path would rot at the next upgrade.
 *   * **Remove only what harv wrote.** Like materialization (ADR 0008), the
 *     shim directory carries an ownership record, and uninstall refuses to
 *     delete a `claude` harv has no record of creating.
 *
 * The shim is POSIX `sh`, not a harv subcommand, for the first property: it
 * has to keep working when harv does not, and a `claude` outside a harvenv
 * project should not pay for a runtime start-up it has no use for.
 */

import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

import { MANIFEST_FILENAME } from "./manifest.ts";

/** The name the shim answers to — the whole point is that it is `claude`. */
export const SHIM_COMMAND = "claude";

/**
 * harv's ownership record, written beside the shim. It does double duty: it
 * marks the directory as harv's, so both this module and the shim script itself
 * can skip it while resolving the real claude, and it is what makes removal
 * safe — uninstall deletes a `claude` only where this file says harv wrote one.
 */
export const SHIM_RECORD_FILE = ".harv-shim.json";

const RECORD_VERSION = 1;
const RECORD_KIND = "harv-shim";

/** Delimiters of the PATH block in a shell startup file. */
export const BLOCK_BEGIN = "# >>> harv shim >>>";
export const BLOCK_END = "# <<< harv shim <<<";

export class ShimError extends Error {
  override name = "ShimError";
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ShimContext {
  /** `$HARV_HOME`, or `~/.harv`. */
  harvHome: string;
  /** The directory that goes on PATH. */
  binDir: string;
  /** The generated lookalike. */
  shimPath: string;
  /** harv's ownership record for `binDir`. */
  recordPath: string;
  home: string;
  configHome: string;
  platform: NodeJS.Platform;
  /** `$SHELL`, as given — the shell whose startup file install edits. */
  shell: string | undefined;
  /** `$PATH`, as given. */
  path: string;
  /**
   * The argv that re-invokes harv, embedded in the shim. Two elements while
   * harv runs as `node bin/harv.ts`, one once ADR 0007's compiled binary
   * exists — the shim handles both rather than assuming either.
   */
  harvCommand: string[];
}

/**
 * How to re-invoke this harv. `process.argv[1]` is the entry script under a
 * runtime and the executable itself under a single-file build, so the two are
 * compared rather than guessed.
 */
export function detectHarvCommand(execPath: string, entry: string | undefined): string[] {
  if (entry === undefined || entry === "" || !existsSync(entry)) return [execPath];
  try {
    const [a, b] = [statSync(entry), statSync(execPath)];
    if (a.dev === b.dev && a.ino === b.ino) return [execPath];
  } catch {
    /* an unreadable entry is simply not a separate script */
  }
  return [execPath, entry];
}

export function defaultShimContext(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): ShimContext {
  const home = env.HOME ?? homedir();
  const harvHome = env.HARV_HOME && env.HARV_HOME.length > 0 ? env.HARV_HOME : join(home, ".harv");
  return {
    harvHome,
    binDir: join(harvHome, "bin"),
    shimPath: join(harvHome, "bin", SHIM_COMMAND),
    recordPath: join(harvHome, "bin", SHIM_RECORD_FILE),
    home,
    configHome: env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config"),
    platform: process.platform,
    shell: env.SHELL,
    path: env.PATH ?? "",
    harvCommand: detectHarvCommand(argv[0] ?? process.execPath, argv[1]),
  };
}

// ---------------------------------------------------------------------------
// Resolving the real claude
// ---------------------------------------------------------------------------

export interface PathClaude {
  path: string;
  /** True when it sits in a directory carrying harv's ownership record. */
  isShim: boolean;
}

/** A directory harv has installed a shim into — this harv's, or another's. */
export const isShimDir = (dir: string): boolean => existsSync(join(dir, SHIM_RECORD_FILE));

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every `claude` on PATH, in the order a shell would find them.
 *
 * The shim script applies exactly this rule, in `sh`. Keeping them in step is
 * what stops `harv claude` from spawning the shim that invoked it and looping:
 * the launcher resolves past every shim directory, so the process it starts is
 * always Claude Code itself.
 */
export function claudesOnPath(pathString: string): PathClaude[] {
  const found: PathClaude[] = [];
  for (const raw of pathString.split(delimiter)) {
    const dir = raw === "" ? "." : raw;
    const candidate = join(dir, SHIM_COMMAND);
    if (!isExecutableFile(candidate)) continue;
    found.push({ path: candidate, isShim: isShimDir(dir) });
  }
  return found;
}

/** The first `claude` on PATH that is not a harv shim, or null if there is none. */
export function resolveRealClaude(pathString: string): string | null {
  return claudesOnPath(pathString).find((c) => !c.isShim)?.path ?? null;
}

// ---------------------------------------------------------------------------
// The shim script
// ---------------------------------------------------------------------------

/** POSIX single-quoting: the only escaping a `'…'` literal ever needs. */
const sq = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const unsq = (literal: string): string | null =>
  literal.length >= 2 && literal.startsWith("'") && literal.endsWith("'")
    ? literal.slice(1, -1).replaceAll(`'\\''`, "'")
    : null;

/**
 * The harv an *installed* shim will run, read back out of the shim itself.
 *
 * Not the same question as "how would harv install itself right now": a shim
 * written from a checkout that has since moved still points at the old path,
 * and that is a state status has to be able to name rather than paper over.
 */
export function installedHarvCommand(shimPath: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const runner = unsq(/^harv_runner=(.*)$/m.exec(text)?.[1] ?? "");
  const entry = unsq(/^harv_entry=(.*)$/m.exec(text)?.[1] ?? "");
  if (runner === null || runner === "") return null;
  return entry ? [runner, entry] : [runner];
}

export function renderShim(ctx: ShimContext): string {
  const [runner, entry] = ctx.harvCommand;
  return `#!/bin/sh
# claude — a harv shim. Generated by \`harv shim install\`.
# Do not edit: \`harv shim install\` overwrites it. \`harv shim uninstall\` removes it.
#
# Inside a harvenv project this hands \`claude\` to the Launcher, so a bare
# \`claude\` gets the hermetic session the project's Manifest describes. Anywhere
# else it execs the real claude, arguments untouched.
#
# The real claude is resolved from PATH on every run and never recorded here, so
# a Claude Code upgrade that replaces or moves the binary needs no reinstall.
#
# Every failure ends at the real claude: a missing or broken harv makes a session
# un-isolated, and says so, but never unavailable.
#
# \`HARV_NO_SHIM=1 claude\` goes straight to the real claude.

harv_shim_dir=${sq(ctx.binDir)}
harv_shim_record=${sq(SHIM_RECORD_FILE)}
harv_runner=${sq(runner ?? "")}
harv_entry=${sq(entry ?? "")}
harv_manifest=${sq(MANIFEST_FILENAME)}

# The real claude: the first \`claude\` on PATH outside a harv shim directory. A
# shim directory is one carrying harv's ownership record, so a second harv
# installation on the same PATH is skipped too and the search cannot loop.
real_claude=''
find_real_claude() {
    # \`set --\` inside a function leaves the script's own arguments alone, and
    # \`set -f\` keeps a PATH entry containing a glob character from expanding.
    harv_saved_ifs=$IFS
    set -f
    IFS=':'
    set -- $PATH
    set +f
    IFS=$harv_saved_ifs

    for entry in "$@"; do
        [ -n "$entry" ] || entry='.'
        [ "$entry" != "$harv_shim_dir" ] || continue
        [ ! -f "$entry/$harv_shim_record" ] || continue
        if [ -f "$entry/claude" ] && [ -x "$entry/claude" ]; then
            real_claude="$entry/claude"
            return 0
        fi
    done
    return 1
}

if ! find_real_claude; then
    printf 'claude: not found on PATH.\\n' >&2
    printf '  This is the harv shim at %s, and it could not resolve the real claude.\\n' "$harv_shim_dir/claude" >&2
    printf '  Reinstall Claude Code, or run \`harv shim uninstall\` to remove this shim.\\n' >&2
    exit 127
fi

# ADR 0005 keeps an un-isolated session reachable on purpose.
[ -z "\${HARV_NO_SHIM:-}" ] || exec "$real_claude" "$@"

# ADR 0001's discovery rule: the nearest harvenv.toml at or above the working
# directory. Switching environments is just \`cd\`, for the shim as for harv.
harv_in_project=''
dir=\${PWD:-$(pwd)}
while [ -n "$dir" ]; do
    if [ -f "$dir/$harv_manifest" ]; then
        harv_in_project=1
        break
    fi
    case "$dir" in
        /) break ;;
    esac
    dir=\${dir%/*}
    [ -n "$dir" ] || dir='/'
done

[ -n "$harv_in_project" ] || exec "$real_claude" "$@"

if [ -x "$harv_runner" ] && { [ -z "$harv_entry" ] || [ -r "$harv_entry" ]; }; then
    if [ -n "$harv_entry" ]; then
        exec "$harv_runner" "$harv_entry" claude "$@"
    fi
    exec "$harv_runner" claude "$@"
fi

printf 'claude: harv is no longer at %s, so this session is NOT isolated.\\n' "$harv_runner" >&2
printf '  Reinstall harv, or run \`harv shim uninstall\` to stop routing claude through it.\\n' >&2
exec "$real_claude" "$@"
`;
}

// ---------------------------------------------------------------------------
// Shell startup files
// ---------------------------------------------------------------------------

export interface ShellProfile {
  /** `zsh`, `bash`, `fish`, `sh`. */
  name: string;
  /** Startup files the PATH block is written to — all of them, for bash. */
  files: string[];
  /** The line that puts the shim directory first on PATH. */
  line: string;
}

/** Escaping for a `"…"` shell word, where `$`, backtick and `\` still bite. */
const dq = (value: string): string => value.replace(/[\\"$`]/g, "\\$&");

/**
 * The startup files install writes to, for the shell the user actually runs.
 *
 * bash gets both of its usual files when both exist: macOS Terminal starts
 * login shells, which read `.bash_profile` and never `.bashrc`, while most
 * Linux terminals do the reverse. Writing the one that happens to exist is how
 * a shim ends up installed and inert.
 */
export function shellProfile(ctx: ShimContext, name?: string): ShellProfile | null {
  const shell = name ?? (ctx.shell ? basename(ctx.shell) : undefined);
  const posixLine = `export PATH="${dq(ctx.binDir)}:$PATH"`;

  switch (shell) {
    case "zsh":
      return { name: "zsh", files: [join(ctx.home, ".zshrc")], line: posixLine };
    case "bash": {
      const candidates = [join(ctx.home, ".bashrc"), join(ctx.home, ".bash_profile")];
      const existing = candidates.filter((f) => existsSync(f));
      const fallback = ctx.platform === "darwin" ? candidates[1]! : candidates[0]!;
      return { name: "bash", files: existing.length > 0 ? existing : [fallback], line: posixLine };
    }
    case "fish":
      return {
        name: "fish",
        files: [join(ctx.configHome, "fish", "config.fish")],
        line: `set -gx PATH ${sq(ctx.binDir)} $PATH`,
      };
    case "sh":
    case "dash":
    case "ksh":
      return { name: shell, files: [join(ctx.home, ".profile")], line: posixLine };
    default:
      return null;
  }
}

/** Every startup file harv might have written to, whatever shell is current. */
export function knownStartupFiles(ctx: ShimContext): string[] {
  return [
    join(ctx.home, ".zshrc"),
    join(ctx.home, ".bashrc"),
    join(ctx.home, ".bash_profile"),
    join(ctx.home, ".profile"),
    join(ctx.configHome, "fish", "config.fish"),
  ];
}

const blockText = (line: string): string =>
  `${BLOCK_BEGIN}\n# Added by \`harv shim install\`; remove it with \`harv shim uninstall\`.\n${line}\n${BLOCK_END}`;

const escapeRe = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The block together with the blank line that installation puts in front of it,
 * so removal takes back exactly what was added and nothing of the file's own.
 */
const BLOCK_PATTERN = new RegExp(
  `(?:[ \\t]*\\n)?${escapeRe(BLOCK_BEGIN)}\\n[\\s\\S]*?\\n${escapeRe(BLOCK_END)}[ \\t]*\\n?`,
);

export const hasBlock = (content: string): boolean => content.includes(BLOCK_BEGIN);

/** Content with harv's block taken back out, separator included. */
export const withoutBlock = (content: string): string => content.replace(BLOCK_PATTERN, "");

/**
 * Content with the block present exactly once, at the end.
 *
 * An existing block is taken out before the new one goes in, so reinstalling
 * after moving `HARV_HOME` updates the PATH entry rather than stacking a second
 * one — and so installing twice is byte-for-byte the same as installing once.
 *
 * A file that did not end in a newline gains one. That is the single byte
 * uninstall cannot give back; appending to a file without it would splice the
 * block onto the last line instead.
 */
export function withBlock(content: string, line: string): string {
  const block = blockText(line);
  const base = hasBlock(content) ? withoutBlock(content) : content;
  if (base === "") return `${block}\n`;
  return `${base.endsWith("\n") ? base : `${base}\n`}\n${block}\n`;
}

// ---------------------------------------------------------------------------
// The ownership record
// ---------------------------------------------------------------------------

interface ShimRecord {
  version: number;
  kind: string;
  /** Names harv created in the shim directory. */
  entries: string[];
}

function readRecord(recordPath: string): ShimRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as Partial<ShimRecord>;
    if (parsed?.kind !== RECORD_KIND) return null;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter((e): e is string => typeof e === "string")
      : [];
    return { version: RECORD_VERSION, kind: RECORD_KIND, entries };
  } catch {
    return null;
  }
}

/** True when harv's record says harv wrote the `claude` sitting at `shimPath`. */
const ownsShim = (ctx: ShimContext): boolean =>
  readRecord(ctx.recordPath)?.entries.includes(SHIM_COMMAND) ?? false;

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallResult {
  shimPath: string;
  /** False when an identical shim was already in place. */
  created: boolean;
  /** Startup files the PATH block was added to or refreshed in. */
  startupFiles: string[];
  /** Named only when the shell is one harv does not know how to configure. */
  unconfigurableShell: string | null;
  /** The PATH line, always reported so it can be added by hand. */
  pathLine: string;
  /** What the shim will exec outside a harvenv project. */
  realClaude: string | null;
  /** True when the shim directory already precedes the real claude on PATH. */
  activeNow: boolean;
}

export function installShim(ctx: ShimContext, shellName?: string): InstallResult {
  if (ctx.platform === "win32") {
    throw new ShimError(
      "the shim is a POSIX shell script and has no Windows equivalent yet. Use `harv claude` instead.",
    );
  }

  const runner = ctx.harvCommand[0];
  if (runner === undefined || !existsSync(runner)) {
    throw new ShimError(`cannot record how to re-invoke harv: ${runner ?? "<unknown>"} does not exist.`);
  }

  // A `claude` here that harv has no record of writing is someone else's file.
  // Overwriting it is exactly the clobber materialization refuses to do.
  if (existsSync(ctx.shimPath) && !ownsShim(ctx)) {
    throw new ShimError(
      `${ctx.shimPath} already exists and harv did not create it. ` +
        `Move it aside, or set HARV_HOME to a directory harv can own.`,
    );
  }

  const script = renderShim(ctx);
  const unchanged = existsSync(ctx.shimPath) && readFileSync(ctx.shimPath, "utf8") === script;

  mkdirSync(ctx.binDir, { recursive: true });
  writeFileSync(ctx.shimPath, script, { mode: 0o755 });
  // `mode` applies only when the file is created, and a shim that is not
  // executable is a `claude` that has stopped existing.
  chmodSync(ctx.shimPath, 0o755);
  writeFileSync(
    ctx.recordPath,
    `${JSON.stringify({ version: RECORD_VERSION, kind: RECORD_KIND, entries: [SHIM_COMMAND] }, null, 2)}\n`,
  );

  // `none` is a request, not a failure to detect: the caller is wiring PATH up
  // themselves, so harv writes the shim and keeps its hands off their dotfiles.
  const optedOut = shellName === "none";
  const profile = optedOut ? null : shellProfile(ctx, shellName);
  const startupFiles: string[] = [];
  for (const file of profile?.files ?? []) {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const after = withBlock(before, profile!.line);
    if (after !== before) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, after);
    }
    startupFiles.push(file);
  }

  const claudes = claudesOnPath(ctx.path);
  return {
    shimPath: ctx.shimPath,
    created: !unchanged,
    startupFiles,
    unconfigurableShell:
      profile || optedOut ? null : (shellName ?? (ctx.shell ? basename(ctx.shell) : "unknown")),
    pathLine: (profile ?? shellProfile(ctx, "sh")!).line,
    realClaude: claudes.find((c) => !c.isShim)?.path ?? null,
    activeNow: claudes[0]?.path === ctx.shimPath,
  };
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export interface UninstallResult {
  /** True when a shim was there to remove. */
  removedShim: boolean;
  /** Startup files the PATH block was taken out of. */
  cleanedFiles: string[];
  /** Directories harv created and could give back. */
  removedDirs: string[];
  realClaude: string | null;
}

export function uninstallShim(ctx: ShimContext): UninstallResult {
  if (existsSync(ctx.shimPath) && !ownsShim(ctx)) {
    throw new ShimError(
      `${ctx.shimPath} exists but harv has no record of creating it, so it is not harv's to remove. ` +
        `Delete it by hand if you are sure.`,
    );
  }

  const removedShim = existsSync(ctx.shimPath);
  if (removedShim) rmSync(ctx.shimPath, { force: true });
  rmSync(ctx.recordPath, { force: true });

  // Every startup file, not just the current shell's: changing shells after
  // installing must not strand a block that keeps a deleted directory on PATH.
  const cleanedFiles: string[] = [];
  for (const file of knownStartupFiles(ctx)) {
    if (!existsSync(file)) continue;
    const before = readFileSync(file, "utf8");
    if (!hasBlock(before)) continue;
    writeFileSync(file, withoutBlock(before));
    cleanedFiles.push(file);
  }

  const removedDirs: string[] = [];
  for (const dir of [ctx.binDir, ctx.harvHome]) {
    if (!existsSync(dir) || readdirSync(dir).length > 0) continue;
    try {
      rmdirSync(dir);
      removedDirs.push(dir);
    } catch {
      /* a directory that will not go is not a failed uninstall */
    }
  }

  return { removedShim, cleanedFiles, removedDirs, realClaude: resolveRealClaude(ctx.path) };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface ShimStatus {
  /** A shim harv wrote is in place. */
  installed: boolean;
  shimPath: string;
  /** Something else is sitting where the shim goes. */
  foreign: boolean;
  /** The shim directory is on this process's PATH. */
  onPath: boolean;
  /** A bare `claude` reaches the shim — installed, on PATH, and first. */
  active: boolean;
  /** What a bare `claude` runs right now. */
  resolvedClaude: string | null;
  /** What the shim execs outside a harvenv project. */
  realClaude: string | null;
  /** The harv the installed shim routes to, as recorded in the shim itself. */
  harvCommand: string[] | null;
  /**
   * False when that harv has gone — the shim still runs Claude Code, but
   * un-isolated, so it is worth saying out loud before someone hits it.
   */
  harvReachable: boolean;
  shell: string | null;
  startupFiles: Array<{ path: string; blockPresent: boolean }>;
}

export function shimStatus(ctx: ShimContext): ShimStatus {
  const present = existsSync(ctx.shimPath);
  const owned = present && ownsShim(ctx);
  const claudes = claudesOnPath(ctx.path);
  const profile = shellProfile(ctx);
  const harvCommand = owned ? installedHarvCommand(ctx.shimPath) : null;

  return {
    harvCommand,
    harvReachable: harvCommand !== null && harvCommand.every((part) => existsSync(part)),
    installed: owned,
    shimPath: ctx.shimPath,
    foreign: present && !owned,
    onPath: ctx.path.split(delimiter).includes(ctx.binDir),
    active: owned && claudes[0]?.path === ctx.shimPath,
    resolvedClaude: claudes[0]?.path ?? null,
    realClaude: claudes.find((c) => !c.isShim)?.path ?? null,
    shell: profile?.name ?? (ctx.shell ? basename(ctx.shell) : null),
    startupFiles: knownStartupFiles(ctx)
      .filter((file) => existsSync(file))
      .map((file) => ({ path: file, blockPresent: hasBlock(readFileSync(file, "utf8")) })),
  };
}

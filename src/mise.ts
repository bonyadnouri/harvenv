/**
 * The vendored mise: the Toolchain engine harv shells out to (ADR 0006),
 * shipped inside harv rather than asked for (ADR 0007).
 *
 * Vendoring it is what keeps the install one command. The alternative — telling
 * people to install mise first — would put the tool whose whole job is "your
 * teammate clones the repo and it works" behind a prerequisite, and would make
 * the Toolchain's pinning a promise about someone else's binary. So the
 * platform-matched mise is embedded in the executable at build time — gzipped,
 * which is the difference between adding 28MB to harv and adding 84MB — and the
 * first run that needs it unpacks it under `~/.harv`, verified against the
 * checksum baked in beside it. The checksum pins the real mise binary, the one
 * mise itself publishes a hash for, so the compression is harv's business and
 * nothing has to be taken on trust across it.
 *
 * Three places to find it, in order:
 *
 *   HARV_MISE_BIN            an explicit path, for a test or a user who has a
 *                            reason — never silently, and never from PATH: a
 *                            different mise than the pinned one is exactly the
 *                            drift the Toolchain exists to prevent
 *   the embedded copy        released binaries; unpacked under `~/.harv` once
 *   vendor/mise/<platform>/  running from source, after `bun scripts/vendor-mise.ts`
 *
 * The second half of this module is what the Toolchain actually asks that
 * binary — the same job `git.ts` does for Sources — and it exists to keep two
 * promises the rest of the Toolchain simply assumes:
 *
 *   - **Nothing global is mutated.** Every invocation redirects mise's data,
 *     config, cache and state directories into harv's own home. No sudo, no
 *     system package manager, no writes outside `HARV_HOME`.
 *   - **Nothing ambient is read.** mise's normal job is to notice the config
 *     file in your working directory; harv's whole point is that a session's
 *     tools come from the Manifest. So every invocation runs from a neutral
 *     directory and names tools by explicit `tool@version` argument — a
 *     `mise.toml` in the project can neither add a tool nor move one's version.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { currentPlatform } from "./platform.ts";
import { harvHome, toolsRoot } from "./store.ts";
import type { Env } from "./store.ts";

/** Replaced at build time, alongside the embedded binary they describe. */
declare const __HARV_MISE_VERSION__: string;
declare const __HARV_MISE_SHA256__: string;

export class MiseError extends Error {
  override name = "MiseError";
}

interface Lock {
  version: string;
  platforms: Record<string, { asset: string; sha256: string } | undefined>;
}

/**
 * Set by the generated entry point `scripts/build.ts` compiles. The asset
 * import that produces this path (`with { type: "file" }`) is Bun-only syntax,
 * so it lives in generated code and is handed in here — which keeps every
 * module in `src/` runnable by plain Node, and the dev loop with it.
 */
let embeddedPath: string | undefined;

export function setEmbeddedMise(path: string): void {
  embeddedPath = path;
}

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The lock is the source of truth when running from source; a release has no copy of it. */
export function lockFile(): Lock | null {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "vendor", "mise.lock.json"), "utf8")) as Lock;
  } catch {
    return null;
  }
}

export const MISE_VERSION: string =
  typeof __HARV_MISE_VERSION__ === "string" ? __HARV_MISE_VERSION__ : (lockFile()?.version ?? "unknown");

/**
 * Where an unpacked mise lives: beside the Store, not in it. The Store
 * addresses fetched Component trees by content hash (ADR 0010), and mise is
 * neither fetched nor a tree — it arrives inside harv, already pinned by the
 * checksum built in next to it. Versioned, so two harvs can disagree in peace.
 */
export const unpackedMisePath = (version = MISE_VERSION, env = process.env): string =>
  join(harvHome(env), "mise", version, "mise");

/**
 * Everywhere a mise could come from. Passed in rather than read, so each branch
 * — and the checksum refusal in particular — can be exercised without a 90MB
 * fixture, the same way the Launcher is exercised without a real session.
 */
export interface MiseSources {
  env: NodeJS.ProcessEnv;
  /** The gzipped copy inside the executable, if this is a released harv. */
  embedded: string | undefined;
  /** A dev checkout's `vendor/mise/<platform>/mise`. */
  vendored: string;
  /** Where an embedded copy gets unpacked to. */
  target: string;
  /** The pinned SHA-256 of the *uncompressed* mise, when one is known. */
  sha256: string | undefined;
}

export function defaultSources(): MiseSources {
  return {
    env: process.env,
    embedded: embeddedPath,
    vendored: join(REPO_ROOT, "vendor", "mise", currentPlatform(), "mise"),
    target: unpackedMisePath(),
    sha256:
      typeof __HARV_MISE_SHA256__ === "string"
        ? __HARV_MISE_SHA256__
        : lockFile()?.platforms[currentPlatform()]?.sha256,
  };
}

/**
 * An executable mise, unpacking it if this is the first run that needed one.
 * Throws rather than falling back to a `mise` on PATH: an unpinned Toolchain
 * engine would produce exactly the "works on my machine" the Lockfile denies.
 */
export function resolveMise(sources: MiseSources): string {
  const override = sources.env.HARV_MISE_BIN;
  if (override && override.length > 0) {
    if (!existsSync(override)) {
      throw new MiseError(`HARV_MISE_BIN points at ${override}, which does not exist.`);
    }
    return override;
  }

  if (sources.embedded !== undefined) return unpack(sources);
  if (existsSync(sources.vendored)) return sources.vendored;

  throw new MiseError(
    `No vendored mise for ${currentPlatform()}.\n` +
      `  This harv was run from source, where mise is fetched rather than embedded.\n` +
      `  Run \`bun scripts/vendor-mise.ts\` to download the pinned ${MISE_VERSION}, or set HARV_MISE_BIN.`,
  );
}

export const miseBinary = (): string => resolveMise(defaultSources());

/**
 * Expand the embedded bytes onto disk, once. The write is a rename onto
 * the final path, so a crashed or concurrent run can leave a partial file lying
 * around but never one a later run would mistake for a whole mise.
 */
function unpack(sources: MiseSources): string {
  const target = sources.target;
  if (existsSync(target)) return target;

  let bytes: Buffer;
  try {
    bytes = gunzipSync(readFileSync(sources.embedded as string));
  } catch (err) {
    throw new MiseError(`The embedded mise could not be read: ${(err as Error).message}`);
  }

  if (sources.sha256 !== undefined) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sources.sha256) {
      throw new MiseError(
        `The embedded mise does not match its pinned checksum — this harv binary is damaged.\n` +
          `  expected ${sources.sha256}\n  actual   ${actual}\n  Reinstall harv.`,
      );
    }
  }

  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `mise.${process.pid}.partial`);
  try {
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { force: true });
    // A parallel harv that finished first is a success, not a collision.
    if (existsSync(target)) return target;
    throw new MiseError(`Could not unpack mise into ${target}: ${(err as Error).message}`);
  }
  return target;
}

/** Hand the terminal to mise and adopt its exit code, the way the Launcher does for claude. */
export function runMise(args: string[]): Promise<number> {
  const bin = miseBinary();
  return new Promise((resolveExit, reject) => {
    // Isolated like every other invocation — same environment and same neutral
    // working directory. This is an escape hatch onto the engine, not a way
    // around the promise that harv leaves the machine alone, and a diagnosis
    // that answered differently from `harv sync` would be worse than none.
    const child = spawn(bin, args, { stdio: "inherit", cwd: neutralCwd(), env: { ...process.env, ...miseEnv() } });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveExit(signal ? 128 : (code ?? 0)));
  });
}

// ---------------------------------------------------------------------------
// The Toolchain's use of it (ADR 0006)
// ---------------------------------------------------------------------------

/**
 * mise's view of the world, rewritten to live entirely inside harv's home.
 *
 * `MISE_DATA_DIR` is the load-bearing one — it is what puts installs in the
 * Store, per version, shared by every project on the machine. The rest exist so
 * that a run cannot read or write the user's own mise setup: config, cache and
 * state are redirected, the global and system config files are pointed at paths
 * under harv's home, and `MISE_YES` keeps a prompt from blocking a Sync nobody
 * is watching. A machine whose owner already uses mise keeps its
 * `~/.local/share/mise` untouched; one whose owner does not never acquires one.
 */
export function miseEnv(env: Env = process.env): Record<string, string> {
  // The data directory is the Store, because installs are shared artifacts.
  // Cache, state and config are harv's own working files, so they sit beside
  // the Store rather than inside it.
  const work = join(harvHome(env), "mise-work");
  return {
    MISE_DATA_DIR: toolsRoot(env),
    MISE_CACHE_DIR: join(work, "cache"),
    MISE_STATE_DIR: join(work, "state"),
    MISE_CONFIG_DIR: join(work, "config"),
    MISE_GLOBAL_CONFIG_FILE: join(work, "config", "config.toml"),
    MISE_SYSTEM_CONFIG_FILE: join(work, "config", "system.toml"),
    // A tool harv installs is one the Manifest asked for, so there is no
    // interactive question left to ask.
    MISE_YES: "1",
    // Progress bars and colour are for a terminal; this output gets parsed.
    MISE_QUIET: "1",
    NO_COLOR: "1",
  };
}

/**
 * A directory with nothing in it, inside harv's home. Every invocation runs
 * from here rather than from the project, because mise's normal job is to
 * notice the `mise.toml` in your working directory — and a session's Toolchain
 * has to come from the Manifest alone.
 */
function neutralCwd(env: Env = process.env): string {
  const cwd = join(harvHome(env), "mise-work", "cwd");
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/**
 * The engine, or the reason there isn't one.
 *
 * A source checkout that has not run `scripts/vendor-mise.ts` has no mise, and
 * that is not a reason to fail a Sync: it lands in the same place as a tool
 * mise cannot install, which ADR 0006 degrades to a recorded hint. An explicit
 * `HARV_MISE_BIN` is the exception — a path that points nowhere is a typo, and
 * degrading past it would hide the one case the user was being deliberate
 * about.
 */
export function findMise(env: Env = process.env): Engine {
  const sources = { ...defaultSources(), env: env as NodeJS.ProcessEnv };
  if (sources.env.HARV_MISE_BIN) return { bin: resolveMise(sources) };
  try {
    return { bin: resolveMise(sources) };
  } catch (err) {
    if (err instanceof MiseError) return { unavailable: err.message };
    throw err;
  }
}

/** An engine, or the reason there is none — phrased for whoever has to act. */
export type Engine = { bin: string; unavailable?: undefined } | { bin?: undefined; unavailable: string };

interface Completed {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run mise and read its answer back, with harv's isolation applied.
 *
 * The working directory is a neutral one inside harv's home rather than the
 * project: mise would otherwise pick up a `mise.toml` sitting in the project
 * tree, and a session's Toolchain has to come from the Manifest alone.
 */
export function captureMise(bin: string, args: string[], env: Env = process.env): Completed {
  const result = spawnSync(bin, args, {
    cwd: neutralCwd(env),
    encoding: "utf8",
    env: { ...process.env, ...miseEnv(env) } as NodeJS.ProcessEnv,
    // A tool that builds from source can take minutes; a tool that hangs must
    // not take a Sync with it forever.
    timeout: 30 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) throw new MiseError(`Cannot run mise at ${bin}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * The exact version a spec names right now — the Toolchain's `ls-remote`, and
 * the only step that asks what "latest" means. Everything after it names a
 * version, so a spec that drifts cannot change what a teammate installs.
 *
 * Null means mise cannot serve this requirement: the caller records a hint
 * instead of failing (ADR 0006).
 */
export function resolveVersion(bin: string, tool: string, spec: string, env: Env = process.env): string | null {
  const result = captureMise(bin, ["latest", `${tool}@${spec}`], env);
  const version = result.stdout.trim().split("\n").pop()?.trim() ?? "";
  return result.status !== 0 || version === "" ? null : version;
}

/** Whether the engine has an installer for this tool at all. */
export const isKnown = (bin: string, tool: string, env: Env = process.env): boolean =>
  captureMise(bin, ["registry", tool], env).status === 0;

/** Install one exact version into the Store. Idempotent: mise skips what it holds. */
export function install(bin: string, tool: string, version: string, env: Env = process.env): void {
  const result = captureMise(bin, ["install", `${tool}@${version}`], env);
  if (result.status !== 0) {
    throw new MiseError(
      `Could not install ${tool}@${version}: ${lastLine(result.stderr) || `mise exited ${result.status}`}`,
    );
  }
}

/**
 * The bin directories one installed version contributes, relative to the tools
 * Store root.
 *
 * They are returned relative on purpose. These paths end up in the Lockfile —
 * committed, and read on a machine whose `HARV_HOME` is somewhere else
 * entirely — so anything absolute would be a pin that only works where it was
 * written. `installs/node/22.18.0/bin` means the same thing everywhere.
 *
 * A path outside the Store is refused rather than recorded: the Lockfile's
 * `bins` become a session's PATH, and a Toolchain that could point PATH at an
 * arbitrary directory would be a worse promise than no Toolchain at all.
 */
export function binPaths(bin: string, tool: string, version: string, env: Env = process.env): string[] {
  const result = captureMise(bin, ["bin-paths", `${tool}@${version}`], env);
  if (result.status !== 0) {
    throw new MiseError(
      `Could not read the bin paths of ${tool}@${version}: ` +
        `${lastLine(result.stderr) || `mise exited ${result.status}`}`,
    );
  }

  const root = toolsRoot(env);
  const paths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const absolute = line.trim();
    if (absolute === "") continue;
    if (!isAbsolute(absolute)) {
      throw new MiseError(`mise reported a bin path that is not absolute for ${tool}@${version}: ${absolute}`);
    }
    const rel = relative(root, absolute);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new MiseError(
        `mise installed ${tool}@${version} outside harv's Store, at ${absolute}. ` +
          `harv only puts Store paths on a session's PATH, so this tool cannot be scoped to the project.`,
      );
    }
    paths.push(rel.split(sep).join("/"));
  }
  return paths;
}

/**
 * Whether the Store still holds a locked tool — asked before the engine is, and
 * answered from the bin directories the Lockfile recorded rather than from a
 * guess at where an installer puts things. Each backend has its own layout, and
 * a rule that happened to be right for `node` and wrong for `npm:prettier`
 * would send a session that has everything it needs back to `harv sync`.
 */
export const hasBins = (bins: string[], env: Env = process.env): boolean =>
  bins.length > 0 && bins.every((path) => existsSync(resolveBinPath(path, env)));

/**
 * A Lockfile `bins` entry as an absolute directory under this machine's Store.
 *
 * The Lockfile arrives from a clone and this path goes on a session's PATH, so
 * the entry is re-checked here rather than trusted: containment is verified
 * after resolution, which is what catches `..` however it is spelled.
 */
export function resolveBinPath(rel: string, env: Env = process.env): string {
  const root = toolsRoot(env);
  const absolute = resolve(root, rel);
  const inside = relative(root, absolute);
  if (isAbsolute(rel) || inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new MiseError(
      `A locked tool has a bin path that points outside harv's Store: ${rel}. ` +
        `Delete ${"harvenv.lock"} and run \`harv sync\` to write it again.`,
    );
  }
  return absolute;
}

const lastLine = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .pop() ?? "";

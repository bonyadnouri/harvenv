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
 * first run that needs it unpacks it into the Store, verified against the
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
 *   the embedded copy        released binaries; unpacked into the Store once
 *   vendor/mise/<platform>/  running from source, after `bun scripts/vendor-mise.ts`
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { currentPlatform } from "./platform.ts";
import { storePath } from "./store.ts";

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

/** Where an unpacked mise lives. Versioned, so two harvs can disagree in peace. */
export const misePathInStore = (version = MISE_VERSION): string => storePath("mise", version, "mise");

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
    target: misePathInStore(),
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
 * Expand the embedded bytes into the Store, once. The write is a rename onto
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
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveExit(signal ? 128 : (code ?? 0)));
  });
}

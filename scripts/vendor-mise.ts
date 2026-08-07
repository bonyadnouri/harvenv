#!/usr/bin/env bun
/**
 * Fetch the pinned mise binaries harv vendors.
 *
 * `vendor/mise.lock.json` is the pin: one mise version, one checksum per
 * platform. This script is the only thing that reads it into `vendor/mise/`,
 * and it refuses anything whose SHA-256 disagrees — a build that embedded an
 * unverified binary would make the pin decorative.
 *
 * Run:  bun scripts/vendor-mise.ts                  # this machine's platform
 *       bun scripts/vendor-mise.ts --all            # every release target
 *       bun scripts/vendor-mise.ts --platform linux-x64
 *       bun scripts/vendor-mise.ts --update 2026.9.1  # re-pin, then fetch
 *
 * `--update` rewrites the lock from mise's own published SHASUMS256.txt, so
 * bumping the Toolchain engine is a reviewable diff rather than a hand-copied
 * hash. It is a deliberate act: nothing bumps mise automatically.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORMS, currentPlatform, isPlatform } from "../src/platform.ts";
import type { Platform } from "../src/platform.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = join(REPO_ROOT, "vendor", "mise.lock.json");
const VENDOR_DIR = join(REPO_ROOT, "vendor", "mise");

/** How mise spells the platforms harv spells `darwin-arm64`. */
const MISE_PLATFORM: Record<Platform, string> = {
  "darwin-arm64": "macos-arm64",
  "darwin-x64": "macos-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
};

export interface PlatformPin {
  asset: string;
  sha256: string;
}

export interface Lock {
  _comment?: string;
  version: string;
  platforms: Record<string, PlatformPin>;
}

const releaseUrl = (version: string, file: string) =>
  `https://github.com/jdx/mise/releases/download/v${version}/${file}`;

export const readLock = (path = LOCK_PATH): Lock => JSON.parse(readFileSync(path, "utf8")) as Lock;

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Where a fetched mise lands. `scripts/build.ts` reads exactly this path. */
export const vendoredMisePath = (platform: Platform): string => join(VENDOR_DIR, platform, "mise");

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetch one platform's mise unless a verified copy is already there. Returns
 * whether anything was downloaded, so a re-run can say "already vendored"
 * rather than implying it went to the network.
 */
export async function vendor(platform: Platform, lock: Lock): Promise<{ path: string; fetched: boolean }> {
  const pin = lock.platforms[platform];
  if (!pin) throw new Error(`${LOCK_PATH} has no pin for ${platform}`);

  const path = vendoredMisePath(platform);
  if (existsSync(path) && sha256(readFileSync(path)) === pin.sha256) return { path, fetched: false };

  const bytes = await download(releaseUrl(lock.version, pin.asset));
  const actual = sha256(bytes);
  if (actual !== pin.sha256) {
    throw new Error(
      `Checksum mismatch for ${pin.asset}\n  expected ${pin.sha256}\n  actual   ${actual}\n` +
        `Refusing to vendor it. Either the pin is wrong or the download is not what it claims to be.`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial`;
  try {
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    renameSync(staging, path);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  return { path, fetched: true };
}

// ---------------------------------------------------------------------------
// Re-pinning
// ---------------------------------------------------------------------------

/** `<sha256>  ./<asset>` lines, as mise publishes them. */
export function parseShasums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\.?\/?(\S+)$/.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1]);
  }
  return sums;
}

export function buildLock(version: string, sums: Map<string, string>): Lock {
  const platforms: Record<string, PlatformPin> = {};
  for (const platform of PLATFORMS) {
    const asset = `mise-v${version}-${MISE_PLATFORM[platform]}`;
    const sum = sums.get(asset);
    if (!sum) throw new Error(`mise ${version} publishes no checksum for ${asset}`);
    platforms[platform] = { asset, sha256: sum };
  }
  return { version, platforms };
}

async function update(version: string): Promise<Lock> {
  const sums = parseShasums(new TextDecoder().decode(await download(releaseUrl(version, "SHASUMS256.txt"))));
  const existing = readLock();
  const next: Lock = { _comment: existing._comment, ...buildLock(version, sums) };
  writeFileSync(LOCK_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function targets(argv: string[]): Platform[] {
  if (argv.includes("--all")) return [...PLATFORMS];

  const explicit = argv.indexOf("--platform");
  const requested = explicit === -1 ? currentPlatform() : (argv[explicit + 1] ?? "");
  if (!isPlatform(requested)) {
    throw new Error(
      `harv does not vendor mise for \`${requested}\`. Supported: ${PLATFORMS.join(", ")}.` +
        (explicit === -1 ? " Pass --platform to fetch for another machine." : ""),
    );
  }
  return [requested];
}

async function main(argv: string[]): Promise<number> {
  const updateIndex = argv.indexOf("--update");
  let lock: Lock;
  if (updateIndex === -1) {
    lock = readLock();
  } else {
    const version = argv[updateIndex + 1];
    if (!version) throw new Error("--update needs a mise version, e.g. --update 2026.9.1");
    lock = await update(version.replace(/^v/, ""));
    console.log(`re-pinned vendor/mise.lock.json to mise ${lock.version}`);
  }

  for (const platform of targets(argv)) {
    const { path, fetched } = await vendor(platform, lock);
    console.log(`${fetched ? "vendored" : "already vendored"}  mise ${lock.version}  ${platform}  ${path}`);
  }
  return 0;
}

// Importable by scripts/build.ts, runnable on its own — so the guard has to be
// exact rather than a filename match.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2)).catch((err: Error) => {
    console.error(`vendor-mise: ${err.message}`);
    return 1;
  });
}

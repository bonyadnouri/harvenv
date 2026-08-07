/**
 * harv's own version, and the hint that it is out of date.
 *
 * The git tag is the version: `scripts/build.ts` bakes it into the compiled
 * binary with `bun --define`, so a released harv knows what it is without
 * reading a file that could have been left behind by a different install. Run
 * from source there is no tag, so the version is `0.0.0-dev` — honest, and it
 * switches the update check off, because a development build has nothing
 * meaningful to compare against a release.
 *
 * The check is deliberately timid. It runs only for `harv --version`, never for
 * `harv claude`, so no session start waits on the network; it caches for a day;
 * it gives up after a second and a half; and every failure is silent. Being
 * offline is not an error worth a paragraph.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { harvHome } from "./store.ts";

/** Replaced at build time. Absent — and safe to `typeof` — when run from source. */
declare const __HARV_VERSION__: string;

export const DEV_VERSION = "0.0.0-dev";

export const VERSION: string =
  typeof __HARV_VERSION__ === "string" && __HARV_VERSION__.length > 0 ? __HARV_VERSION__ : DEV_VERSION;

export const isDevBuild = (version = VERSION): boolean => version === DEV_VERSION;

export const REPO = "bonyadnouri/harvenv";
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const UPGRADE_HINT = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`;

const CACHE_FILE = "update-check.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 1_500;

// ---------------------------------------------------------------------------
// Comparing versions
// ---------------------------------------------------------------------------

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  core: [number, number, number];
  prerelease: string[];
}

export function parseVersion(value: string): Parsed | null {
  const m = SEMVER.exec(value.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] === undefined ? [] : m[4].split("."),
  };
}

/**
 * Semver precedence, to the extent harv needs it: -1, 0 or 1, and 0 for
 * anything unparseable — an unrecognisable version is a reason to say nothing,
 * never a reason to tell someone their current build is behind.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  // A release outranks any of its own pre-releases: 0.1.0 > 0.1.0-rc.1.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }

  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;

    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    // Numeric identifiers compare numerically and always rank below alphanumerics.
    if (lNum && rNum) return Number(l) < Number(r) ? -1 : 1;
    if (lNum !== rNum) return lNum ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The update check
// ---------------------------------------------------------------------------

interface CacheEntry {
  checkedAt: number;
  latest: string;
}

export interface UpdateCheckDeps {
  now: () => number;
  cachePath: string;
  fetch: typeof globalThis.fetch;
  env: NodeJS.ProcessEnv;
}

export function defaultUpdateCheckDeps(): UpdateCheckDeps {
  return {
    now: () => Date.now(),
    cachePath: join(harvHome(), CACHE_FILE),
    fetch: globalThis.fetch,
    env: process.env,
  };
}

/**
 * Whether asking GitHub is appropriate at all. A development build has no
 * release to be behind; CI has no human to tell; and anyone can say no.
 */
export function updateCheckEnabled(env: NodeJS.ProcessEnv, version = VERSION): boolean {
  if (isDevBuild(version)) return false;
  if (env.HARV_NO_UPDATE_CHECK) return false;
  if (env.CI) return false;
  return true;
}

/** The newest published version, or null if it cannot be established cheaply. */
export async function latestVersion(deps: UpdateCheckDeps): Promise<string | null> {
  const cached = readCache(deps.cachePath);
  if (cached && deps.now() - cached.checkedAt < CACHE_TTL_MS) return cached.latest;

  const fetched = await fetchLatest(deps.fetch);
  if (fetched === null) return cached?.latest ?? null;

  writeCache(deps.cachePath, { checkedAt: deps.now(), latest: fetched });
  return fetched;
}

async function fetchLatest(fetchImpl: typeof globalThis.fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": `harv/${VERSION}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown };
    return typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : null;
  } catch {
    // Offline, rate-limited, timed out, or handed something that is not JSON.
    return null;
  }
}

/**
 * The one line worth printing, or null. Written for stderr: `harv --version`
 * is something scripts read, and a notice does not belong in the answer.
 */
export async function updateHint(deps: UpdateCheckDeps, version = VERSION): Promise<string | null> {
  if (!updateCheckEnabled(deps.env, version)) return null;
  const latest = await latestVersion(deps);
  if (latest === null || compareVersions(version, latest) >= 0) return null;
  return `A newer harv is available: ${latest} (you have ${version}).\n  Upgrade: ${UPGRADE_HINT}`;
}

function readCache(path: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheEntry>;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") return null;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest };
  } catch {
    return null;
  }
}

function writeCache(path: string, entry: CacheEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // A cache that cannot be written costs one request per run, not a failure.
  }
}

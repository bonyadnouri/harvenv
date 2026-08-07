/**
 * The Lockfile: the committed, machine-resolved pin of every Manifest entry,
 * so that two Syncs on two machines produce the same Harvenv.
 *
 * A git entry is pinned twice over, because the two pins answer different
 * questions. The commit SHA says which fetch to perform. The content hash says
 * what that fetch must have produced — it is what a second machine checks its
 * own fetch against, and what lets a Sync skip the network entirely when the
 * Store already holds those bytes.
 *
 * A path entry is pinned by neither: a local directory is live, and hashing it
 * would report every edit as tampering in exactly the workflow local paths
 * exist to serve. That is the same fact as their non-portability, which Sync
 * warns about rather than hides.
 *
 * Like the Manifest, this file arrives from a clone and is read before it is
 * trusted — the more so because a locked hash becomes a Store path and a
 * locked name becomes a directory in the project tree.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";

import { COMPONENT_NAME_RULE, describeSource, isComponentName } from "./manifest.ts";
import type { Manifest, MarketplaceSource, Source } from "./manifest.ts";

export const LOCKFILE_FILENAME = "harvenv.lock";

/**
 * What this harv writes. Reading accepts anything up to it.
 *
 * Version 2 adds `[[plugins]]`, and the bump is the point: a harv that does not
 * know about plugin pins would read a `[[skills]]` list out of this file,
 * launch, and load a Harvenv missing every plugin the project declares —
 * silently, which is the one outcome a Lockfile exists to prevent. The
 * asymmetry is deliberate: refusing to read a *newer* file is that protection,
 * while refusing an older one would only make upgrading harv cost a re-fetch.
 */
const LOCK_VERSION = 2;

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const HEADER =
  `# ${LOCKFILE_FILENAME} — written by \`harv sync\`. Commit it: it is what makes a\n` +
  `# teammate's Harvenv identical to yours. Change Sources in ${"harvenv.toml"} and\n` +
  `# re-run \`harv sync\` rather than editing this file.\n\n`;

export class LockfileError extends Error {
  override name = "LockfileError";
}

export interface LockedSkill {
  name: string;
  source: Source;
  /** The commit a git Source resolved to. Absent for a path Source. */
  commit?: string;
  /** The content hash of what that commit produced. Absent for a path Source. */
  hash?: string;
}

/**
 * A pinned plugin. The commit is the *marketplace's*, because that is the fetch
 * to perform; the hash is the plugin's own tree, because that is what a session
 * loads and what a teammate's fetch has to reproduce (ADR 0010).
 *
 * Where the plugin sits inside the marketplace is not recorded: it is read from
 * the catalogue at that commit, which makes it a derived fact, and a derived
 * fact written down is a fact that can disagree with its source.
 */
export interface LockedPlugin {
  name: string;
  source: MarketplaceSource;
  commit: string;
  hash: string;
}

export interface Lockfile {
  version: number;
  skills: LockedSkill[];
  plugins: LockedPlugin[];
}

export interface DriftEntry {
  name: string;
  /** Phrased to be printed after the name, at sync and at launch alike. */
  reason: string;
}

export const lockfilePath = (root: string): string => join(root, LOCKFILE_FILENAME);

/** The Lockfile of a project, or null if it has never been synced. */
export function readLockfile(root: string): Lockfile | null {
  const path = lockfilePath(root);
  if (!existsSync(path)) return null;

  let raw: Record<string, unknown>;
  try {
    raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    const where = err instanceof TomlError ? ` (line ${err.line}, column ${err.column})` : "";
    throw new LockfileError(
      `${path} is not valid TOML${where}: ${(err as Error).message}. Delete it and run \`harv sync\`.`,
    );
  }

  // Only *newer* is a refusal. A Lockfile this harv predates may pin
  // Components it has no idea how to serve, and loading the ones it does
  // recognise would produce a Harvenv quietly missing the rest — which is the
  // failure the version exists to prevent. An older one is simply a subset:
  // every version so far only added a kind of entry, so reading one and
  // rewriting it current is a migration rather than a break.
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new LockfileError(
      `${path} has a \`version\` that is not a version: ${JSON.stringify(version)}. ` +
        `Delete the Lockfile and run \`harv sync\` to write it again.`,
    );
  }
  if (version > LOCK_VERSION) {
    throw new LockfileError(
      `${path} is version ${version}, and this harv reads up to version ${LOCK_VERSION}. ` +
        `Upgrade harv — a newer Lockfile can pin Components this one would silently leave out.`,
    );
  }

  const skills = raw.skills ?? [];
  if (!Array.isArray(skills)) throw new LockfileError(`${path} has a \`skills\` that is not a list of entries.`);
  const plugins = raw.plugins ?? [];
  if (!Array.isArray(plugins)) throw new LockfileError(`${path} has a \`plugins\` that is not a list of entries.`);

  return {
    version: LOCK_VERSION,
    skills: skills.map((entry) => readEntry(entry, root, path)),
    plugins: plugins.map((entry) => readPlugin(entry, path)),
  };
}

/** Write the Lockfile. Entries are ordered by name so the file is a stable diff. */
export function writeLockfile(root: string, skills: LockedSkill[], plugins: LockedPlugin[] = []): void {
  const body = stringifyToml({
    version: LOCK_VERSION,
    skills: byName(skills).map(toTable),
    plugins: byName(plugins).map(toPluginTable),
  });
  writeFileSync(lockfilePath(root), `${HEADER}${body}\n`);
}

const byName = <T extends { name: string }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * What the Manifest now says that the Lockfile does not yet reflect.
 *
 * Reported rather than silently repaired: Sync prints it as the work it is
 * about to do, and the Launcher prints it as the reason a session would not be
 * the one the Manifest describes.
 */
export function driftAgainst(manifest: Manifest, lock: Lockfile | null): DriftEntry[] {
  return [
    ...driftOver(manifest.skills, lock?.skills ?? []),
    ...driftOver(manifest.plugins, lock?.plugins ?? []),
  ];
}

/**
 * One comparison for both tables: a declared entry is drifted when the Lockfile
 * does not hold it or holds it at another coordinate, and a locked entry is
 * drifted when the Manifest has stopped declaring it.
 */
function driftOver(
  declared: Array<{ name: string; source: Source | MarketplaceSource }>,
  lockedEntries: Array<{ name: string; source: Source | MarketplaceSource }>,
): DriftEntry[] {
  const locked = new Map(lockedEntries.map((entry) => [entry.name, entry]));
  const drift: DriftEntry[] = [];

  for (const entry of declared) {
    const pinned = locked.get(entry.name);
    if (pinned === undefined) {
      drift.push({ name: entry.name, reason: `declared in the Manifest but not locked` });
      continue;
    }
    if (coordinate(entry.source) !== coordinate(pinned.source)) {
      drift.push({
        name: entry.name,
        // Described, not compared: the comparison needs the kind to tell a path
        // from a repository, and the reader does not need to read it.
        reason: `Source changed: locked ${describeSource(pinned.source)}, Manifest says ${describeSource(entry.source)}`,
      });
    }
  }

  const names = new Set(declared.map((entry) => entry.name));
  for (const name of locked.keys()) {
    if (!names.has(name)) drift.push({ name, reason: `locked but no longer declared in the Manifest` });
  }

  return drift;
}

/** The identity of a Source for drift purposes: kind and every coordinate part. */
const coordinate = (source: Source | MarketplaceSource): string => `${source.kind}:${describeSource(source)}`;

function toTable(entry: LockedSkill): Record<string, unknown> {
  // Built key by key, in a fixed order, because the serialized order is the
  // order these are inserted — and a Lockfile that reshuffles between Syncs
  // would produce diffs nobody can read.
  const table: Record<string, unknown> = { name: entry.name, source: entry.source.kind };
  if (entry.source.kind === "path") {
    // The declared path, not the resolved one: an absolute path from one
    // machine's checkout has no meaning in the repository this file is
    // committed to.
    table.path = entry.source.declared;
    return table;
  }

  table.git = entry.source.repo;
  if (entry.source.ref !== undefined) table.ref = entry.source.ref;
  if (entry.source.subdir !== undefined) table.subdir = entry.source.subdir;
  table.commit = entry.commit;
  table.hash = entry.hash;
  return table;
}

function toPluginTable(entry: LockedPlugin): Record<string, unknown> {
  const table: Record<string, unknown> = { name: entry.name, marketplace: entry.source.repo };
  if (entry.source.ref !== undefined) table.ref = entry.source.ref;
  table.commit = entry.commit;
  table.hash = entry.hash;
  return table;
}

function readEntry(value: unknown, root: string, path: string): LockedSkill {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LockfileError(`${path} has a [[skills]] entry that is not a table.`);
  }
  const entry = value as Record<string, unknown>;
  const name = entry.name;
  if (typeof name !== "string" || !isComponentName(name)) {
    throw new LockfileError(
      `${path} locks ${JSON.stringify(name)}, which is not a usable skill name: ${COMPONENT_NAME_RULE}. ` +
        `Delete the Lockfile and run \`harv sync\`.`,
    );
  }
  const where = `${path} entry \`${name}\``;

  if (entry.source === "path") {
    const declared = text(entry.path, "path", where);
    return { name, source: { kind: "path", declared, path: isAbsolute(declared) ? declared : join(root, declared) } };
  }
  if (entry.source !== "git") {
    throw new LockfileError(`${where} has an unknown source ${JSON.stringify(entry.source)}.`);
  }

  const source: Source = { kind: "git", repo: text(entry.git, "git", where) };
  if (entry.ref !== undefined) source.ref = text(entry.ref, "ref", where);
  if (entry.subdir !== undefined) source.subdir = text(entry.subdir, "subdir", where);

  const commit = text(entry.commit, "commit", where);
  if (!COMMIT.test(commit)) {
    throw new LockfileError(`${where} has a \`commit\` that is not a full 40-character SHA: ${commit}`);
  }
  const hash = text(entry.hash, "hash", where);
  // This becomes a path under the Store, so its shape is checked before it is
  // ever joined onto one.
  if (!HASH.test(hash)) {
    throw new LockfileError(`${where} has a \`hash\` that is not a sha256 content hash: ${hash}`);
  }

  return { name, source, commit, hash };
}

/**
 * A `[[plugins]]` entry. Read with the same suspicion as a skill: the name
 * becomes a directory in the project tree and the hash becomes a path under the
 * Store, and this file arrives from a clone.
 */
function readPlugin(value: unknown, path: string): LockedPlugin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LockfileError(`${path} has a [[plugins]] entry that is not a table.`);
  }
  const entry = value as Record<string, unknown>;
  const name = entry.name;
  if (typeof name !== "string" || !isComponentName(name)) {
    throw new LockfileError(
      `${path} locks the plugin ${JSON.stringify(name)}, which is not a usable plugin name: ${COMPONENT_NAME_RULE}. ` +
        `Delete the Lockfile and run \`harv sync\`.`,
    );
  }
  const where = `${path} plugin entry \`${name}\``;

  const source: MarketplaceSource = { kind: "marketplace", repo: text(entry.marketplace, "marketplace", where) };
  if (entry.ref !== undefined) source.ref = text(entry.ref, "ref", where);

  const commit = text(entry.commit, "commit", where);
  if (!COMMIT.test(commit)) {
    throw new LockfileError(`${where} has a \`commit\` that is not a full 40-character SHA: ${commit}`);
  }
  const hash = text(entry.hash, "hash", where);
  if (!HASH.test(hash)) {
    throw new LockfileError(`${where} has a \`hash\` that is not a sha256 content hash: ${hash}`);
  }

  return { name, source, commit, hash };
}

function text(value: unknown, key: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LockfileError(`${where} is missing \`${key}\`. Delete the Lockfile and run \`harv sync\`.`);
  }
  return value;
}

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
import type { Manifest, Source } from "./manifest.ts";

export const LOCKFILE_FILENAME = "harvenv.lock";

/** Bumped when the format changes in a way an older harv cannot read. */
const LOCK_VERSION = 1;

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

export interface Lockfile {
  version: number;
  skills: LockedSkill[];
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

  const version = raw.version;
  if (version !== LOCK_VERSION) {
    throw new LockfileError(
      `${path} is version ${JSON.stringify(version)}, and this harv writes version ${LOCK_VERSION}. ` +
        `Upgrade harv, or delete the Lockfile and run \`harv sync\` to write it again.`,
    );
  }

  const skills = raw.skills ?? [];
  if (!Array.isArray(skills)) throw new LockfileError(`${path} has a \`skills\` that is not a list of entries.`);

  return { version: LOCK_VERSION, skills: skills.map((entry) => readEntry(entry, root, path)) };
}

/** Write the Lockfile. Entries are ordered by name so the file is a stable diff. */
export function writeLockfile(root: string, skills: LockedSkill[]): void {
  const ordered = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const body = stringifyToml({ version: LOCK_VERSION, skills: ordered.map(toTable) });
  writeFileSync(lockfilePath(root), `${HEADER}${body}\n`);
}

/**
 * What the Manifest now says that the Lockfile does not yet reflect.
 *
 * Reported rather than silently repaired: Sync prints it as the work it is
 * about to do, and the Launcher prints it as the reason a session would not be
 * the one the Manifest describes.
 */
export function driftAgainst(manifest: Manifest, lock: Lockfile | null): DriftEntry[] {
  const locked = new Map((lock?.skills ?? []).map((entry) => [entry.name, entry]));
  const drift: DriftEntry[] = [];

  for (const skill of manifest.skills) {
    const entry = locked.get(skill.name);
    if (entry === undefined) {
      drift.push({ name: skill.name, reason: `declared in the Manifest but not locked` });
      continue;
    }
    if (coordinate(skill.source) !== coordinate(entry.source)) {
      drift.push({
        name: skill.name,
        // Described, not compared: the comparison needs the kind to tell a path
        // from a repository, and the reader does not need to read it.
        reason: `Source changed: locked ${describeSource(entry.source)}, Manifest says ${describeSource(skill.source)}`,
      });
    }
  }

  const declared = new Set(manifest.skills.map((skill) => skill.name));
  for (const entry of locked.keys()) {
    if (!declared.has(entry)) drift.push({ name: entry, reason: `locked but no longer declared in the Manifest` });
  }

  return drift;
}

/** The identity of a Source for drift purposes: kind and every coordinate part. */
const coordinate = (source: Source): string => `${source.kind}:${describeSource(source)}`;

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

function text(value: unknown, key: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LockfileError(`${where} is missing \`${key}\`. Delete the Lockfile and run \`harv sync\`.`);
  }
  return value;
}

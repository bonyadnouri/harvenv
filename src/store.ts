/**
 * The Store: the machine-global, deduplicated pool of fetched artifacts that
 * Harvenvs materialize from (ADR 0004). Entries are addressed by the hash of
 * their content, which is what makes dedup free — two projects that resolve to
 * the same bytes name the same directory, so the second one fetches nothing.
 *
 * The address is a hash of the *tree*, not of the commit that produced it. A
 * commit SHA identifies a fetch; a tree hash identifies what a session will
 * actually load, which is the thing the Lockfile has to promise is identical
 * on a teammate's machine.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

/** Bumped if the hashing rules below change; old addresses stay readable. */
const TREE_FORMAT = "harvenv-tree-v1";

const ALGORITHM = "sha256";

/** Transport, not content: two clones of one commit differ here and nowhere else. */
const NOT_CONTENT = new Set([".git"]);

export type Env = Partial<Record<string, string>>;

/**
 * harv's own home. Overridable so that tests, CI and the verification scripts
 * can exercise a real Store without touching the developer's.
 */
export function harvHome(env: Env = process.env): string {
  return env.HARV_HOME ?? join(env.HOME ?? homedir(), ".harv");
}

export const storeRoot = (env: Env = process.env): string => join(harvHome(env), "store");

/**
 * Where content with this hash lives. Sharded on the first byte of the digest,
 * because a Store that outlives a few projects holds thousands of entries and
 * some filesystems degrade badly on one flat directory.
 */
export function storePath(hash: string, env: Env = process.env): string {
  const digest = hash.startsWith(`${ALGORITHM}:`) ? hash.slice(ALGORITHM.length + 1) : hash;
  return join(storeRoot(env), ALGORITHM, digest.slice(0, 2), digest);
}

export const isStored = (hash: string, env: Env = process.env): boolean => isDirectory(storePath(hash, env));

/**
 * The content hash of a directory tree.
 *
 * Every byte that changes what a session loads is fed in, and nothing else is:
 * the relative path, the kind of entry, and the bytes. Timestamps, ownership
 * and directory order are excluded, because they differ between two machines
 * that fetched the identical commit — and a hash that differed there would
 * make the Lockfile's promise unkeepable rather than strict.
 */
export function hashTree(root: string): string {
  const hash = createHash(ALGORITHM).update(`${TREE_FORMAT}\0`);
  for (const rel of walk(root)) {
    const { kind, bytes } = describe(join(root, ...rel.split(posix.sep)));
    hash.update(`${rel}\0${kind}\0${bytes.byteLength}\0`).update(bytes);
  }
  return `${ALGORITHM}:${hash.digest("hex")}`;
}

/**
 * Move a staged tree into the Store under its content hash and return where it
 * landed. The staged tree must already be on the Store's filesystem, so the
 * publish is a rename: a reader either sees no entry or sees a complete one.
 *
 * If the address is already occupied the staged copy is discarded — the Store
 * already holds these exact bytes, by definition of the address.
 */
export function insert(staged: string, hash: string, env: Env = process.env): string {
  const destination = storePath(hash, env);
  if (isDirectory(destination)) {
    rmSync(staged, { recursive: true, force: true });
    return destination;
  }

  mkdirSync(join(destination, ".."), { recursive: true });
  try {
    renameSync(staged, destination);
  } catch (err) {
    // A concurrent sync of the same Source can win the race between the check
    // and the rename. Its bytes are ours by definition, so the loser cleans up.
    if (!isDirectory(destination)) throw err;
    rmSync(staged, { recursive: true, force: true });
  }
  return destination;
}

/** Relative POSIX paths of every file and symlink under `root`, sorted. */
function walk(root: string): string[] {
  const found: string[] = [];
  const descend = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (prefix === "" && NOT_CONTENT.has(entry.name)) continue;
      const rel = prefix === "" ? entry.name : `${prefix}${posix.sep}${entry.name}`;
      // `Dirent` reports the entry itself, so a symlink to a directory is a
      // leaf here — which is what the hash wants: the link, not its target.
      if (entry.isDirectory()) descend(join(dir, entry.name), rel);
      else found.push(rel);
    }
  };
  descend(root, "");
  // Sorted so the hash depends on the tree, not on the order a filesystem
  // happened to hand its entries back.
  return found.sort();
}

/**
 * What one entry contributes to the hash. A symlink contributes its target
 * rather than the bytes it resolves to: replacing a link with a copy of its
 * target changes what the tree *is*, even when every read through it agrees.
 *
 * Of a file's mode only the executable bit is kept — it is the one permission
 * git records, so it is the one that survives a fetch identically everywhere.
 */
function describe(path: string): { kind: string; bytes: Buffer } {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return { kind: "link", bytes: Buffer.from(readlinkSync(path)) };
  return { kind: stats.mode & 0o111 ? "exec" : "file", bytes: readFileSync(path) };
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

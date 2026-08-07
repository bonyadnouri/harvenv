/**
 * Sync: realizing the Manifest and Lockfile into a working harness
 * configuration for one project.
 *
 * The order of the questions is the whole design. For each declared entry:
 *
 *   1. Does the Lockfile already pin this exact coordinate? If not, the ref has
 *      to be resolved against the remote — the only step that asks what
 *      "latest" means.
 *   2. Does the Store already hold the content that pin promises? If so, Sync
 *      is finished with that entry, having touched no network. This is what
 *      makes the second project on a machine — and every re-run on the first —
 *      free, and it is why the Lockfile pins content and not only a commit.
 *   3. Otherwise fetch the *locked commit*, hash what came back, and refuse to
 *      continue if it is not what the Lockfile promised.
 *
 * Step 3 is where "a clean clone reproduces byte-identical Components" is won
 * or lost: it fetches the commit the Lockfile names, never the ref the
 * Manifest names, so a branch that moved cannot change what a teammate gets.
 */

import { driftAgainst, readLockfile, writeLockfile } from "./lockfile.ts";
import type { DriftEntry, Lockfile, LockedSkill } from "./lockfile.ts";
import { describeSource } from "./manifest.ts";
import type { GitSource, Manifest, Source } from "./manifest.ts";
import { fetchSource as realFetch, resolveCommit as realResolve } from "./git.ts";
import type { Fetched } from "./git.ts";
import { materialize } from "./materialize.ts";
import type { MaterializePlan, MaterializeResult } from "./materialize.ts";
import { hashTree, insert, isStored, storePath } from "./store.ts";
import type { Env } from "./store.ts";

export class SyncError extends Error {
  override name = "SyncError";
}

/** The git layer, injectable so tests can prove a Sync fetched nothing. */
export interface SyncDeps {
  env: Env;
  resolveCommit: (source: GitSource) => string;
  fetchSource: (source: GitSource, commit: string, env: Env) => Fetched;
}

export interface SyncResult {
  /** Names whose content was fetched from a remote on this run. */
  fetched: string[];
  /** Names served from bytes the Store already held. */
  reused: string[];
  /** Names whose Source is a local path, and so is not portable. */
  local: string[];
  /** What the Manifest said that the Lockfile did not yet reflect. */
  drift: DriftEntry[];
  /** Ready to print; one line each, naming the entry it is about. */
  warnings: string[];
  materialized: MaterializeResult;
}

export function sync(manifest: Manifest, deps: Partial<SyncDeps> = {}): SyncResult {
  const { env, resolveCommit, fetchSource } = withDefaults(deps);
  const lock = readLockfile(manifest.root);
  const drift = driftAgainst(manifest, lock);
  const locked = new Map((lock?.skills ?? []).map((entry) => [entry.name, entry]));

  const result: SyncResult = {
    fetched: [],
    reused: [],
    local: [],
    drift,
    warnings: [],
    materialized: { linked: [], removed: [] },
  };

  const entries: LockedSkill[] = [];
  const resolved: MaterializePlan["skills"] = [];

  for (const skill of manifest.skills) {
    if (skill.source.kind === "path") {
      result.local.push(skill.name);
      result.warnings.push(nonPortable(skill.name, skill.source.declared));
      entries.push({ name: skill.name, source: skill.source });
      resolved.push({ name: skill.name, path: skill.source.path });
      continue;
    }

    const pin = pinFor(skill.source, locked.get(skill.name));

    if (pin.hash !== undefined && isStored(pin.hash, env)) {
      result.reused.push(skill.name);
      entries.push({ name: skill.name, source: skill.source, commit: pin.commit, hash: pin.hash });
      resolved.push({ name: skill.name, path: storePath(pin.hash, env) });
      continue;
    }

    const commit = pin.commit ?? resolveCommit(skill.source);
    const fetched = fetchSource(skill.source, commit, env);
    const hash = hashTree(fetched.staged);
    if (pin.hash !== undefined && pin.hash !== hash) {
      throw new SyncError(
        `Skill \`${skill.name}\` fetched content that does not match the hash its Lockfile pins.\n` +
          `  Source:        ${describeSource(skill.source)}\n` +
          `  Commit:        ${commit}\n` +
          `  Locked hash:   ${pin.hash}\n` +
          `  Fetched hash:  ${hash}\n` +
          `The commit is the one the Lockfile names, so the content changed underneath the pin — ` +
          `a rewritten tag or a tampered remote. Verify the Source before re-running \`harv sync\`.`,
      );
    }

    result.fetched.push(skill.name);
    entries.push({ name: skill.name, source: skill.source, commit, hash });
    resolved.push({ name: skill.name, path: insert(fetched.staged, hash, env) });
  }

  // Materialization runs before the Lockfile is written: it is the step that
  // validates each fetched tree really is the skill its key names (ADR 0008),
  // and a Lockfile is a promise that should not outlive a failed one.
  result.materialized = materialize({ root: manifest.root, skills: resolved });
  writeLockfile(manifest.root, entries);
  return result;
}

/**
 * Where each declared Component lives, from the Lockfile alone.
 *
 * This is the Launcher's half of Sync: no remote is contacted and nothing is
 * written, because a session that quietly fetched would make `harv claude` a
 * second, invisible Sync. Anything missing is reported as work for `harv sync`.
 */
export function plan(manifest: Manifest, lock: Lockfile | null, env: Env = process.env): MaterializePlan {
  const locked = new Map((lock?.skills ?? []).map((entry) => [entry.name, entry]));

  return {
    root: manifest.root,
    skills: manifest.skills.map((skill) => {
      if (skill.source.kind === "path") return { name: skill.name, path: skill.source.path };

      const entry = locked.get(skill.name);
      if (entry?.hash === undefined) {
        throw new SyncError(`Skill \`${skill.name}\` is not in the Lockfile. Run \`harv sync\`.`);
      }
      if (!isStored(entry.hash, env)) {
        throw new SyncError(
          `Skill \`${skill.name}\` is locked at ${entry.hash} but the Store does not hold it. Run \`harv sync\`.`,
        );
      }
      return { name: skill.name, path: storePath(entry.hash, env) };
    }),
  };
}

export const nonPortable = (name: string, declared: string): string =>
  `skill \`${name}\` comes from the local path \`${declared}\`, which no clone of this project can resolve. ` +
  `Push it to a git repository and declare that instead to make this Harvenv portable.`;

/**
 * The commit and content a Lockfile entry pins for this Source — but only if it
 * still describes the same Source. A Manifest that moved to another ref has
 * nothing to reuse, and reusing it anyway would silently ignore the edit.
 */
function pinFor(source: Source, entry: LockedSkill | undefined): { commit?: string; hash?: string } {
  if (entry === undefined) return {};
  const same = coordinate(entry.source) === coordinate(source);
  return same ? { commit: entry.commit, hash: entry.hash } : {};
}

const coordinate = (source: Source): string => `${source.kind}:${describeSource(source)}`;

const withDefaults = (deps: Partial<SyncDeps>): SyncDeps => ({
  env: deps.env ?? process.env,
  resolveCommit: deps.resolveCommit ?? realResolve,
  fetchSource: deps.fetchSource ?? realFetch,
});

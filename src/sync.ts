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
 *
 * A pinned plugin runs the same three steps against its marketplace, with one
 * question inserted between the fetch and the hash: *which directory is the
 * plugin?* The marketplace's own catalogue answers it, read at the fetched
 * commit — so the Store ends up holding the plugin rather than the catalogue it
 * was listed in, and the hash covers exactly the tree a session will load.
 *
 * The Overlay's skills go through the same three questions and land in the same
 * Store — a personal staple is fetched, hashed and deduplicated exactly like a
 * project's own Component. What differs is where it is pinned: into an
 * uncommitted Lockfile of its own, because the resolution of somebody's staples
 * is not part of what the repository hands over (ADR 0013).
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { driftAgainst, readLockfile, removeLockfile, writeLockfile } from "./lockfile.ts";
import type { DriftEntry, Lockfile, LockedPlugin, LockedSkill } from "./lockfile.ts";
import { describePlugin, describeSource } from "./manifest.ts";
import type { GitSource, Manifest, MarketplaceSource, PluginEntry, SkillEntry, Source } from "./manifest.ts";
import { fetchSource as realFetch, resolveCommit as realResolve } from "./git.ts";
import type { Fetched } from "./git.ts";
import { declaredMcpServers, MarketplaceError, resolvePlugin } from "./marketplace.ts";
import { materialize } from "./materialize.ts";
import type { MaterializePlan, MaterializeResult, Resolved } from "./materialize.ts";
import { OVERLAY_LOCKFILE } from "./overlay.ts";
import type { Session } from "./overlay.ts";
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

export function sync(session: Session, deps: Partial<SyncDeps> = {}): SyncResult {
  const { env, resolveCommit, fetchSource } = withDefaults(deps);
  const { manifest } = session;
  const lock = readLockfile(manifest.root);
  const drift = driftAgainst(manifest, lock);
  const lockedPlugins = new Map((lock?.plugins ?? []).map((entry) => [entry.name, entry]));

  const result: SyncResult = {
    fetched: [],
    reused: [],
    local: [],
    drift,
    // Composing the session is what discovers an Overlay entry the Manifest
    // locked, so those warnings are already waiting by the time Sync runs.
    warnings: [...session.warnings],
    materialized: { linked: [], plugins: [], removed: [] },
  };

  const resolveSkills = (skills: SkillEntry[], from: Lockfile | null, portable: boolean) => {
    const locked = new Map((from?.skills ?? []).map((entry) => [entry.name, entry]));
    const entries: LockedSkill[] = [];
    const resolved: Resolved[] = [];

    for (const skill of skills) {
      if (skill.source.kind === "path") {
        result.local.push(skill.name);
        // An Overlay is never cloned, so a local directory in one is not a
        // handoff problem — it is the ordinary way to keep a skill you are
        // still writing.
        if (portable) result.warnings.push(nonPortable(skill.name, skill.source.declared));
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
        throw new SyncError(mismatch(`Skill \`${skill.name}\``, skill.source, commit, pin.hash, hash));
      }

      result.fetched.push(skill.name);
      entries.push({ name: skill.name, source: skill.source, commit, hash });
      resolved.push({ name: skill.name, path: insert(fetched.staged, hash, env) });
    }
    return { entries, resolved };
  };

  const own = resolveSkills(manifest.skills, lock, true);
  const overlay = resolveSkills(session.overlaySkills, readLockfile(manifest.root, OVERLAY_LOCKFILE), false);
  const entries = own.entries;
  const resolved = [...own.resolved, ...overlay.resolved];

  const pinned: LockedPlugin[] = [];
  const plugins: Resolved[] = [];

  for (const plugin of manifest.plugins) {
    const pin = pinFor(plugin.source, lockedPlugins.get(plugin.name));
    const marketplace = repositoryOf(plugin.source);

    let path: string;
    let commit: string;
    let hash: string;

    // A plugin pin has both halves or neither, so the Store can answer for it
    // without a remote: the Lockfile already says which bytes are wanted.
    if (pin.commit !== undefined && pin.hash !== undefined && isStored(pin.hash, env)) {
      commit = pin.commit;
      hash = pin.hash;
      path = storePath(hash, env);
      result.reused.push(plugin.name);
    } else {
      commit = pin.commit ?? resolveCommit(marketplace);
      const fetched = fetchSource(marketplace, commit, env);
      // The catalogue is read out of the fetched commit, not out of the
      // coordinate: where a plugin sits is the marketplace's to state, and
      // stating it at a commit is what keeps the answer the same everywhere.
      const root = located(plugin, fetched.staged);

      // The Store holds the plugin, not the marketplace that published it. A
      // session loads one directory, ADR 0010 addresses exactly the tree a
      // session loads, and pinning one plugin should not store a catalogue of
      // the hundreds it was listed beside.
      hash = hashTree(root);
      if (pin.hash !== undefined && pin.hash !== hash) {
        rmSync(fetched.staged, { recursive: true, force: true });
        throw new SyncError(mismatch(`Plugin \`${plugin.name}\``, plugin.source, commit, pin.hash, hash));
      }
      path = insert(root, hash, env);
      rmSync(fetched.staged, { recursive: true, force: true });
      result.fetched.push(plugin.name);
    }

    pinned.push({ name: plugin.name, source: plugin.source, commit, hash });
    plugins.push({ name: plugin.name, path });

    const servers = declaredMcpServers(path);
    if (servers.length > 0) result.warnings.push(unservedMcp(plugin.name, servers));
  }

  // Materialization runs before the Lockfile is written: it is the step that
  // validates each fetched tree really is the Component its key names
  // (ADR 0008), and a Lockfile is a promise that should not outlive a failed one.
  result.materialized = materialize({ root: manifest.root, skills: resolved, plugins });
  writeLockfile(manifest.root, entries, pinned);
  if (overlay.entries.length > 0) writeLockfile(manifest.root, overlay.entries, [], OVERLAY_LOCKFILE);
  else removeLockfile(manifest.root, OVERLAY_LOCKFILE);
  return result;
}

/** A marketplace, addressed as what it is underneath: a repository at a ref. */
const repositoryOf = (source: MarketplaceSource): GitSource => ({
  kind: "git",
  repo: source.repo,
  ...(source.ref === undefined ? {} : { ref: source.ref }),
});

/**
 * The directory a pinned plugin occupies in a fetched marketplace — with the
 * failure re-stated in the Manifest's own terms, because `resolvePlugin` knows
 * about a catalogue and the reader knows about a `[plugins]` entry.
 */
function located(plugin: PluginEntry, checkout: string): string {
  let subdir: string;
  try {
    subdir = resolvePlugin(checkout, plugin.name).subdir;
  } catch (err) {
    if (err instanceof MarketplaceError) {
      throw new MarketplaceError(`Plugin \`${describePlugin(plugin)}\`: ${err.message}`);
    }
    throw err;
  }

  const root = subdir === "" ? checkout : join(checkout, subdir);
  if (!existsSync(root)) {
    throw new MarketplaceError(
      `Plugin \`${describePlugin(plugin)}\`: its marketplace lists it at \`${subdir}\`, ` +
        `and that directory does not exist at the commit harv fetched.`,
    );
  }
  return root;
}

const mismatch = (
  what: string,
  source: Source | MarketplaceSource,
  commit: string,
  locked: string,
  fetched: string,
): string =>
  `${what} fetched content that does not match the hash its Lockfile pins.\n` +
  `  Source:        ${describeSource(source)}\n` +
  `  Commit:        ${commit}\n` +
  `  Locked hash:   ${locked}\n` +
  `  Fetched hash:  ${fetched}\n` +
  `The commit is the one the Lockfile names, so the content changed underneath the pin — ` +
  `a rewritten tag or a tampered remote. Verify the Source before re-running \`harv sync\`.`;

/**
 * Where each declared Component lives, from the Lockfile alone.
 *
 * This is the Launcher's half of Sync: no remote is contacted and nothing is
 * written, because a session that quietly fetched would make `harv claude` a
 * second, invisible Sync. Anything missing is reported as work for `harv sync`.
 */
export function plan(session: Session, locks: Locks, env: Env = process.env): MaterializePlan {
  const { manifest } = session;
  const lockedPlugins = new Map((locks.manifest?.plugins ?? []).map((entry) => [entry.name, entry]));

  const locate = (skills: SkillEntry[], lock: Lockfile | null): Resolved[] => {
    const locked = new Map((lock?.skills ?? []).map((entry) => [entry.name, entry]));
    return skills.map((skill) => {
      if (skill.source.kind === "path") return { name: skill.name, path: skill.source.path };
      return { name: skill.name, path: fromStore(`Skill \`${skill.name}\``, locked.get(skill.name)?.hash, env) };
    });
  };

  return {
    root: manifest.root,
    skills: [...locate(manifest.skills, locks.manifest), ...locate(session.overlaySkills, locks.overlay)],
    plugins: manifest.plugins.map((plugin) => ({
      name: plugin.name,
      path: fromStore(`Plugin \`${plugin.name}\``, lockedPlugins.get(plugin.name)?.hash, env),
    })),
  };
}

/** Both of a project's Lockfiles: the committed one and the Overlay's own. */
export interface Locks {
  manifest: Lockfile | null;
  overlay: Lockfile | null;
}

export const readLocks = (root: string): Locks => ({
  manifest: readLockfile(root),
  overlay: readLockfile(root, OVERLAY_LOCKFILE),
});

/** A locked hash turned into a Store path, or the reason it cannot be. */
function fromStore(what: string, hash: string | undefined, env: Env): string {
  if (hash === undefined) throw new SyncError(`${what} is not in the Lockfile. Run \`harv sync\`.`);
  if (!isStored(hash, env)) {
    throw new SyncError(`${what} is locked at ${hash} but the Store does not hold it. Run \`harv sync\`.`);
  }
  return storePath(hash, env);
}

export const nonPortable = (name: string, declared: string): string =>
  `skill \`${name}\` comes from the local path \`${declared}\`, which no clone of this project can resolve. ` +
  `Push it to a git repository and declare that instead to make this Harvenv portable.`;

/**
 * A pinned plugin ships MCP servers the recipe does not serve.
 *
 * `--strict-mcp-config` makes a session's servers exactly the ones `[mcp]`
 * declares, which is what keeps the user's own out (ADR 0003) — and measurement
 * shows it keeps a plugin's own out with them. Everything else the plugin
 * carries does load, so the gap is narrow, invisible from inside a session, and
 * exactly the kind of thing that has to be said out loud rather than found.
 */
export const unservedMcp = (name: string, servers: string[]): string =>
  `plugin \`${name}\` declares the MCP server${servers.length > 1 ? "s" : ""} ${servers.map((s) => `\`${s}\``).join(", ")}, ` +
  `which will not reach the session: \`--strict-mcp-config\` serves only the servers \`[mcp]\` declares. ` +
  `Declare ${servers.length > 1 ? "them" : "it"} in \`[mcp]\` to use ${servers.length > 1 ? "them" : "it"}. ` +
  `Everything else the plugin carries does load.`;

/**
 * The commit and content a Lockfile entry pins for this Source — but only if it
 * still describes the same Source. A Manifest that moved to another ref has
 * nothing to reuse, and reusing it anyway would silently ignore the edit.
 */
function pinFor(
  source: Source | MarketplaceSource,
  entry: LockedSkill | LockedPlugin | undefined,
): { commit?: string; hash?: string } {
  if (entry === undefined) return {};
  const same = coordinate(entry.source) === coordinate(source);
  return same ? { commit: entry.commit, hash: entry.hash } : {};
}

const coordinate = (source: Source | MarketplaceSource): string => `${source.kind}:${describeSource(source)}`;

const withDefaults = (deps: Partial<SyncDeps>): SyncDeps => ({
  env: deps.env ?? process.env,
  resolveCommit: deps.resolveCommit ?? realResolve,
  fetchSource: deps.fetchSource ?? realFetch,
});

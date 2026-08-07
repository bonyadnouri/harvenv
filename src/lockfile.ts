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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";

import { COMPONENT_NAME_RULE, describeSource, isComponentName, isToolName, isToolSpec } from "./manifest.ts";
import type { Manifest, MarketplaceSource, Source } from "./manifest.ts";
import type { Requirement, ResolvedTool } from "./tools.ts";

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
const LOCK_VERSION = 3;

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Which Lockfile: where it lives, and what it says about itself at the top.
 *
 * The header is not decoration. The two files carry opposite instructions —
 * one is the thing that makes a teammate's Harvenv identical to yours and must
 * be committed, the other pins your own Overlay and must not be (ADR 0013) —
 * and they are the same format, so the file has to say which one it is.
 */
export interface LockfileKind {
  /** Relative to the project root. */
  filename: string;
  header: string;
}

export const COMMITTED_LOCKFILE: LockfileKind = {
  filename: LOCKFILE_FILENAME,
  header:
    `# ${LOCKFILE_FILENAME} — written by \`harv sync\`. Commit it: it is what makes a\n` +
    `# teammate's Harvenv identical to yours. Change Sources in ${"harvenv.toml"} and\n` +
    `# re-run \`harv sync\` rather than editing this file.\n\n`,
};

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
  /**
   * The Toolchain, pinned at the exact versions a Sync resolved — plus the
   * requirements that could not be scoped at all, which are recorded here
   * rather than dropped so a teammate's Doctor reports the same gap (ADR 0006).
   */
  tools: ResolvedTool[];
}

export interface DriftEntry {
  name: string;
  /** Phrased to be printed after the name, at sync and at launch alike. */
  reason: string;
}

export const lockfilePath = (root: string, kind: LockfileKind = COMMITTED_LOCKFILE): string =>
  join(root, kind.filename);

/**
 * The Lockfile of a project, or null if it has never been synced.
 *
 * `kind` exists for the Overlay, which is pinned exactly like the Manifest and
 * into a file of exactly this format — but into an uncommitted one, because the
 * resolution of a personal staple is nobody else's business (ADR 0013).
 */
export function readLockfile(root: string, kind: LockfileKind = COMMITTED_LOCKFILE): Lockfile | null {
  const path = lockfilePath(root, kind);
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
  const tools = raw.tools ?? [];
  if (!Array.isArray(tools)) throw new LockfileError(`${path} has a \`tools\` that is not a list of entries.`);

  return {
    version: LOCK_VERSION,
    skills: skills.map((entry) => readEntry(entry, root, path)),
    plugins: plugins.map((entry) => readPlugin(entry, path)),
    tools: tools.map((entry) => readTool(entry, path)),
  };
}

/** Write the Lockfile. Entries are ordered by name so the file is a stable diff. */
export function writeLockfile(
  root: string,
  skills: LockedSkill[],
  plugins: LockedPlugin[] = [],
  tools: ResolvedTool[] = [],
  kind: LockfileKind = COMMITTED_LOCKFILE,
): void {
  const body = stringifyToml({
    version: LOCK_VERSION,
    skills: byName(skills, (entry) => entry.name).map(toTable),
    plugins: byName(plugins, (entry) => entry.name).map(toPluginTable),
    // Omitted rather than written empty: a project with no Toolchain should not
    // carry a key that only ever says so.
    ...(tools.length === 0 ? {} : { tools: byName(tools, (entry) => entry.tool).map(toolTable) }),
  });
  const path = lockfilePath(root, kind);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${kind.header}${body}\n`);
}

/**
 * Forget a Lockfile entirely — for the Overlay's, when there is no longer an
 * Overlay to pin. An empty file left behind would be read as "this project
 * locks nothing personal", which is true, but so is having no file, and the
 * absent one does not have to be gitignored by anyone reading the repo later.
 */
export function removeLockfile(root: string, kind: LockfileKind): void {
  rmSync(lockfilePath(root, kind), { force: true });
}

const byName = <T,>(entries: T[], name: (entry: T) => string): T[] =>
  [...entries].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));

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

export interface DriftOptions {
  /** What declared these entries, so an Overlay's drift does not read as a Manifest's. */
  source?: string;
  /**
   * Whether an entry the Lockfile holds and nothing declares any more counts.
   *
   * It does for the committed Lockfile, whose whole job is to agree with the
   * Manifest a teammate reads beside it. It does not for the Overlay's, which is
   * uncommitted and rewritten by every Sync: a staple you stopped declaring is
   * simply unmaterialized at the next launch, and nothing downstream is wrong.
   */
  orphans?: boolean;
}

/**
 * One comparison for every table: a declared entry is drifted when the Lockfile
 * does not hold it or holds it at another coordinate, and a locked entry is
 * drifted when the declaring file has stopped declaring it.
 *
 * Exported because the Overlay is compared against a Lockfile of its own, by
 * its own rules — see `DriftOptions`.
 */
export function driftOver(
  declared: Array<{ name: string; source: Source | MarketplaceSource }>,
  lockedEntries: Array<{ name: string; source: Source | MarketplaceSource }>,
  { source = "the Manifest", orphans = true }: DriftOptions = {},
): DriftEntry[] {
  const locked = new Map(lockedEntries.map((entry) => [entry.name, entry]));
  const drift: DriftEntry[] = [];

  for (const entry of declared) {
    const pinned = locked.get(entry.name);
    if (pinned === undefined) {
      drift.push({ name: entry.name, reason: `declared in ${source} but not locked` });
      continue;
    }
    if (coordinate(entry.source) !== coordinate(pinned.source)) {
      drift.push({
        name: entry.name,
        // Described, not compared: the comparison needs the kind to tell a path
        // from a repository, and the reader does not need to read it.
        reason: `Source changed: locked ${describeSource(pinned.source)}, ${source} says ${describeSource(entry.source)}`,
      });
    }
  }

  const names = new Set(declared.map((entry) => entry.name));
  if (orphans) {
    for (const name of locked.keys()) {
      if (!names.has(name)) drift.push({ name, reason: `locked but no longer declared in ${source}` });
    }
  }

  return drift;
}

/**
 * What the Harvenv now needs from its Toolchain that the Lockfile does not yet
 * reflect. Read alongside `driftAgainst`, and reported the same way.
 *
 * A locked entry that carries only a hint is deliberately not drift: an
 * unscopeable requirement is a recorded outcome, not an unfinished one, and a
 * Launcher that refused to start over it would turn ADR 0006's degradation path
 * back into the hard failure it exists to avoid.
 */
export function toolDrift(required: Requirement[], lock: Lockfile | null): DriftEntry[] {
  const locked = new Map((lock?.tools ?? []).map((entry) => [entry.tool, entry]));
  const drift: DriftEntry[] = [];

  for (const requirement of required) {
    const entry = locked.get(requirement.tool);
    if (entry === undefined) {
      drift.push({ name: requirement.tool, reason: `needed by ${requirement.from} but not locked` });
    } else if (entry.spec !== requirement.spec) {
      drift.push({
        name: requirement.tool,
        reason: `version changed: locked \`${entry.spec}\`, ${requirement.from} needs \`${requirement.spec}\``,
      });
    }
  }

  const needed = new Set(required.map((requirement) => requirement.tool));
  for (const tool of locked.keys()) {
    if (!needed.has(tool)) drift.push({ name: tool, reason: `locked but nothing needs it any more` });
  }

  return drift;
}

/** The identity of a Source for drift purposes: kind and every coordinate part. */
const coordinate = (source: Source | MarketplaceSource): string => `${source.kind}:${describeSource(source)}`;

function toolTable(entry: ResolvedTool): Record<string, unknown> {
  const table: Record<string, unknown> = { name: entry.tool, spec: entry.spec };
  if (entry.version !== undefined) table.version = entry.version;
  // Recorded rather than derived: where a tool puts its binaries is the
  // installer's business, and it differs by tool. They are relative to the
  // Store's tools root, so the pin means the same thing on a machine whose
  // `HARV_HOME` is somewhere else.
  if (entry.bins !== undefined) table.bins = entry.bins;
  if (entry.hint !== undefined) table.hint = entry.hint;
  return table;
}

/**
 * One `[[tools]]` entry, checked before it is believed.
 *
 * `bins` gets the hardest look of anything in this file: those paths are joined
 * onto the Store and prepended to a session's PATH, and this file arrives from
 * a clone. A relative path that climbs out of the Store would put a directory
 * of someone else's choosing ahead of everything the user has installed.
 */
function readTool(value: unknown, path: string): ResolvedTool {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LockfileError(`${path} has a [[tools]] entry that is not a table.`);
  }
  const entry = value as Record<string, unknown>;
  const tool = entry.name;
  if (typeof tool !== "string" || !isToolName(tool)) {
    throw new LockfileError(
      `${path} locks a tool named ${JSON.stringify(tool)}, which harv will not use. ` +
        `Delete the Lockfile and run \`harv sync\`.`,
    );
  }
  const where = `${path} tool \`${tool}\``;

  const spec = text(entry.spec, "spec", where);
  if (!isToolSpec(spec)) throw new LockfileError(`${where} has a \`spec\` harv will not pass on: ${spec}`);

  if (entry.version === undefined) {
    // No version means the Sync that wrote this could not scope the tool. The
    // hint is the whole content of such an entry, so it has to be there.
    return { tool, spec, hint: text(entry.hint, "hint", where) };
  }

  const version = text(entry.version, "version", where);
  if (!isToolSpec(version)) {
    throw new LockfileError(
      `${where} has a \`version\` that is not a plain version string: ${version}. ` +
        `Delete the Lockfile and run \`harv sync\`.`,
    );
  }

  const bins = entry.bins;
  if (!Array.isArray(bins) || bins.length === 0) {
    throw new LockfileError(`${where} is missing \`bins\`. Delete the Lockfile and run \`harv sync\`.`);
  }
  return { tool, spec, version, bins: bins.map((bin) => readBin(bin, where)) };
}

function readBin(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new LockfileError(`${where} has a \`bins\` entry that is not a path: ${JSON.stringify(value)}`);
  }
  const escapes =
    isAbsolute(value) ||
    // Checked on both separators, because a Lockfile written on Windows is read
    // on machines where `\` is an ordinary character in a name.
    value.split(/[\\/]/).some((segment) => segment === "..") ||
    /^[A-Za-z]:/.test(value);
  if (escapes) {
    throw new LockfileError(
      `${where} has a \`bins\` entry pointing outside harv's Store: ${value}. ` +
        `Those paths go on a session's PATH, so harv will not follow this one. ` +
        `Delete the Lockfile and run \`harv sync\`.`,
    );
  }
  return value;
}

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

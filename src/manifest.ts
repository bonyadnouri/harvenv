/**
 * The Manifest: the committed file that declares what a project's Harvenv
 * contains. Discovery walks up from the working directory, so "switching
 * environments is just `cd`" (ADR 0001).
 *
 * Two of ADR 0004's Sources are readable here: git coordinates (repository,
 * optional ref, optional subdirectory) and local paths, which are allowed but
 * non-portable and flagged as such at Sync. Marketplace plugin pins parse far
 * enough to be rejected by name rather than ignored.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";

export const MANIFEST_FILENAME = "harvenv.toml";

/** Sources ADR 0004 defines but this slice cannot yet fetch. */
const DEFERRED_SOURCE_KEYS = ["marketplace", "version"];

/** Keys that only mean something alongside `git`. */
const GIT_MODIFIERS = ["ref", "subdir"] as const;

/**
 * A Component name is one path segment, and a conservative one.
 *
 * The name is not just a label: materialization joins it onto `.claude/skills`,
 * so `..` or an embedded separator would place a symlink outside the directory
 * harv manages — and, once recorded as owned, would hand a later run a path
 * outside it to remove. A Manifest is committed content that teammates and CI
 * run without reading, so its keys are validated rather than trusted.
 */
const COMPONENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const isComponentName = (name: string): boolean => COMPONENT_NAME.test(name);

/** Shared so the rule reads the same wherever it is enforced. */
export const COMPONENT_NAME_RULE =
  "a name must be a single path segment starting with a letter or digit and made of letters, digits, " +
  "`.`, `-` and `_` — no `/`, `\\` or `..`";

/**
 * A local directory. Allowed, but it describes only this machine — nothing in
 * a clone can reproduce it, which is why Sync flags every one of these.
 */
export interface PathSource {
  kind: "path";
  /** As written in the Manifest, so messages and the Lockfile stay portable. */
  declared: string;
  /** Resolved against the project root, so callers never re-resolve it. */
  path: string;
}

/** A git repository, optionally at a ref and narrowed to a subdirectory. */
export interface GitSource {
  kind: "git";
  repo: string;
  ref?: string;
  subdir?: string;
}

export type Source = PathSource | GitSource;

export interface SkillEntry {
  /** The Manifest key — and, per ADR 0008, the name the session answers to. */
  name: string;
  source: Source;
}

/** A git coordinate as one line, for messages and Lockfile-drift reports. */
export function describeSource(source: Source): string {
  if (source.kind === "path") return source.declared;
  return source.repo + (source.ref ? `@${source.ref}` : "") + (source.subdir ? `#${source.subdir}` : "");
}

export interface Manifest {
  /** Absolute path to `harvenv.toml`. */
  path: string;
  /** The project root: the directory holding the Manifest. */
  root: string;
  skills: SkillEntry[];
  /** The Manifest's settings table, injected via `--settings` at launch. */
  settings: Record<string, unknown>;
}

/** A Manifest that cannot be understood. Always actionable, always user-facing. */
export class ManifestError extends Error {
  override name = "ManifestError";
}

/** Path to the nearest `harvenv.toml` at or above `startDir`, or null. */
export function findManifest(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, MANIFEST_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadManifest(manifestPath: string): Manifest {
  const root = dirname(manifestPath);
  const raw = readTable(manifestPath);

  return {
    path: manifestPath,
    root,
    skills: parseSkills(raw.skills, root, manifestPath),
    settings: asTable(raw.settings, "settings", manifestPath) ?? {},
  };
}

function readTable(manifestPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new ManifestError(`Cannot read ${manifestPath}: ${(err as Error).message}`);
  }
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (err) {
    const where = err instanceof TomlError ? ` (line ${err.line}, column ${err.column})` : "";
    throw new ManifestError(`${manifestPath} is not valid TOML${where}: ${(err as Error).message}`);
  }
}

function parseSkills(value: unknown, root: string, manifestPath: string): SkillEntry[] {
  const skills = asTable(value, "skills", manifestPath);
  if (!skills) return [];

  return Object.entries(skills).map(([name, entry]) => {
    const where = `[skills] entry \`${name}\` in ${manifestPath}`;
    if (!isComponentName(name)) {
      throw new ManifestError(`${where} is not a usable skill name: ${COMPONENT_NAME_RULE}.`);
    }
    if (!isTable(entry)) {
      throw new ManifestError(`${where} must be a table, e.g. ${name} = { git = "https://…" }`);
    }

    const deferred = DEFERRED_SOURCE_KEYS.filter((key) => key in entry);
    if (deferred.length > 0) {
      throw new ManifestError(
        `${where} declares \`${deferred.join("`, `")}\`, which this version of harv cannot fetch yet. ` +
          `Declare a git repository or a local path instead: ${name} = { git = "https://…" }`,
      );
    }

    return { name, source: parseSource(entry, name, where, root) };
  });
}

function parseSource(
  entry: Record<string, unknown>,
  name: string,
  where: string,
  root: string,
): Source {
  const hasGit = "git" in entry;
  const hasPath = "path" in entry;

  if (hasGit && hasPath) {
    throw new ManifestError(
      `${where} declares both \`git\` and \`path\`, so there is no telling which one a Sync should fetch. ` +
        `Keep one.`,
    );
  }
  if (!hasGit && !hasPath) {
    throw new ManifestError(
      `${where} needs a Source: \`git\` for a repository (with optional \`ref\` and \`subdir\`), ` +
        `or \`path\` for a local directory, e.g. ${name} = { git = "https://example.com/skills.git", subdir = "${name}" }`,
    );
  }

  if (hasPath) {
    const stray = GIT_MODIFIERS.filter((key) => key in entry);
    if (stray.length > 0) {
      throw new ManifestError(
        `${where} declares \`${stray.join("`, `")}\` alongside \`path\`, but a local directory has no ` +
          `repository to apply them to. Remove them, or declare a \`git\` Source.`,
      );
    }
    const declared = requireString(entry.path, "path", where, name);
    return { kind: "path", declared, path: isAbsolute(declared) ? declared : join(root, declared) };
  }

  const source: GitSource = { kind: "git", repo: requireString(entry.git, "git", where, name) };
  if ("ref" in entry) source.ref = requireString(entry.ref, "ref", where, name);
  if ("subdir" in entry) source.subdir = parseSubdir(requireString(entry.subdir, "subdir", where, name), where);
  return source;
}

/**
 * A subdirectory selects part of a fetched repository, so it is joined onto a
 * directory harv created and then read from. A Manifest arrives from a clone,
 * so `..` or an absolute path — which would reach outside the checkout — is
 * refused rather than normalized into something that happens to work.
 */
function parseSubdir(subdir: string, where: string): string {
  const normalized = normalize(subdir);
  const escapes =
    isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`);
  if (escapes) {
    throw new ManifestError(
      `${where} has a \`subdir\` that points outside the repository: ${subdir}. ` +
        `A subdir is a path within the fetched repository, e.g. subdir = "skills/example".`,
    );
  }
  return subdir;
}

function requireString(value: unknown, key: string, where: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(
      `${where} has a \`${key}\` that is not a non-empty string. ` +
        `Example: ${name} = { git = "https://example.com/skills.git", subdir = "${name}" }`,
    );
  }
  return value;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asTable(
  value: unknown,
  key: string,
  manifestPath: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isTable(value)) throw new ManifestError(`[${key}] in ${manifestPath} must be a table`);
  return value;
}

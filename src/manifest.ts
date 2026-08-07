/**
 * The Manifest: the committed file that declares what a project's Harvenv
 * contains. Discovery walks up from the working directory, so "switching
 * environments is just `cd`" (ADR 0001).
 *
 * This slice reads the walking-skeleton subset — skills from local paths, plus
 * a settings table. ADR 0004's other Sources (git coordinates, marketplace
 * plugin pins) parse far enough to be rejected by name rather than ignored.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";

export const MANIFEST_FILENAME = "harvenv.toml";

/** Sources ADR 0004 defines but this slice cannot yet fetch. */
const DEFERRED_SOURCE_KEYS = ["git", "ref", "subdir", "marketplace", "version"];

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

export interface SkillEntry {
  /** The Manifest key — and, per ADR 0008, the name the session answers to. */
  name: string;
  /** Absolute path to the skill directory. */
  path: string;
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
      throw new ManifestError(`${where} must be a table, e.g. ${name} = { path = "vendor/${name}" }`);
    }

    const deferred = DEFERRED_SOURCE_KEYS.filter((key) => key in entry);
    if (deferred.length > 0) {
      throw new ManifestError(
        `${where} declares \`${deferred.join("`, `")}\`, which this version of harv cannot fetch yet. ` +
          `Only local paths are supported so far: ${name} = { path = "vendor/${name}" }`,
      );
    }

    const path = entry.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new ManifestError(`${where} needs a \`path\`, e.g. ${name} = { path = "vendor/${name}" }`);
    }

    return { name, path: isAbsolute(path) ? path : join(root, path) };
  });
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

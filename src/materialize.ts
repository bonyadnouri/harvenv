/**
 * Materialization (ADR 0008): declared Components land in the project's
 * `.claude/` tree as symlinks, and `--setting-sources project` picks them up.
 * `--plugin-dir` is deliberately not used — it renames what it serves, so the
 * name a Manifest declares would stop being the name the session answers to.
 *
 * Writing into someone's project demands care, so every materialized entry is
 * recorded. harv only ever removes paths it recorded creating; anything else
 * in `.claude/skills/` is a hand-written Component and is left untouched.
 *
 * What arrives here is already resolved: a name and the directory that holds
 * it, which for a git Source is a Store entry and for a path Source is the
 * directory the Manifest pointed at. Deciding which is Sync's job, not this
 * one's — this step only has to link it safely and be able to undo itself.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COMPONENT_NAME_RULE, isComponentName } from "./manifest.ts";

/** harv's ownership record, kept beside the Components it materialized. */
export const MATERIALIZED_STATE_FILE = ".harv-materialized.json";

const STATE_VERSION = 1;

export class MaterializeError extends Error {
  override name = "MaterializeError";
}

/** Resolved Components: where each declared name's content actually is. */
export interface MaterializePlan {
  /** The project root — `.claude/` is created beneath it. */
  root: string;
  skills: Array<{ name: string; path: string }>;
}

export interface MaterializeResult {
  /** Manifest names now linked into project scope. */
  linked: string[];
  /** Names harv had materialized before and has now removed. */
  removed: string[];
}

interface State {
  version: number;
  skills: string[];
}

export function materialize(plan: MaterializePlan): MaterializeResult {
  const claudeDir = join(plan.root, ".claude");
  const skillsDir = join(claudeDir, "skills");
  const previous = readState(claudeDir);

  for (const skill of plan.skills) validateSkill(skill.name, skill.path);

  const declared = plan.skills.map((s) => s.name);
  const removed = previous.skills.filter((name) => !declared.includes(name));
  for (const name of removed) removeOwned(join(skillsDir, name));

  if (plan.skills.length > 0) mkdirSync(skillsDir, { recursive: true });
  for (const skill of plan.skills) {
    link(join(skillsDir, skill.name), skill.path, previous.skills.includes(skill.name));
  }

  writeState(claudeDir, { version: STATE_VERSION, skills: declared });
  return { linked: declared, removed };
}

/**
 * A skill must exist, be a skill, and answer to the name the Manifest gave it.
 * The last check is ADR 0008's whole point: the Manifest entry, the invocation
 * and the skill's published name have to be one string, and a silent mismatch
 * would leave the session answering to a name the Manifest never mentions.
 */
function validateSkill(name: string, path: string): void {
  // Enforced here as well as at parse time, because this is where a name turns
  // into a path that gets written to and later removed. Sync will call this
  // with names resolved from git subdirectories, not only from Manifest keys.
  if (!isComponentName(name)) {
    throw new MaterializeError(`\`${name}\` cannot be materialized: ${COMPONENT_NAME_RULE}.`);
  }
  if (!existsSync(path)) {
    throw new MaterializeError(`Skill \`${name}\` declares a path that does not exist: ${path}`);
  }
  // `statSync` follows links, so a skill reached through a symlinked tree counts.
  if (!statSync(path).isDirectory()) {
    throw new MaterializeError(`Skill \`${name}\` must point at a directory, but ${path} is a file`);
  }

  const skillFile = join(path, "SKILL.md");
  if (!existsSync(skillFile)) {
    throw new MaterializeError(`Skill \`${name}\` has no SKILL.md: ${skillFile} is missing`);
  }

  const published = frontmatterName(readFileSync(skillFile, "utf8"));
  if (published !== undefined && published !== name) {
    throw new MaterializeError(
      `Skill \`${name}\` is published as \`${published}\` in ${skillFile}. ` +
        `Rename the [skills] key to \`${published}\` so the Manifest, the invocation and the skill agree.`,
    );
  }
}

/**
 * `name:` from a SKILL.md YAML frontmatter block, if it has one. YAML scalars
 * may be quoted, and a skill that writes `name: "foo"` means `foo` — carrying
 * the quotes through would reject a skill whose name is in fact correct.
 */
function frontmatterName(source: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match?.[1]) return undefined;
  const value = /^name:[ \t]*(.+?)[ \t]*$/m.exec(match[1])?.[1];
  return value === undefined ? undefined : value.replace(/^(['"])(.*)\1$/, "$2");
}

function link(linkPath: string, target: string, owned: boolean): void {
  // `existsSync` is false for a dangling link, and a link whose target moved is
  // exactly the case a re-run has to repair — so occupancy is both tests.
  if (existsSync(linkPath) || isSymlink(linkPath)) {
    if (!owned) {
      throw new MaterializeError(
        `${linkPath} already exists and harv did not create it. ` +
          `Remove it, or drop the skill from the Manifest, so harv never clobbers work it does not own.`,
      );
    }
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(target, linkPath, "dir");
}

/** Only ever called for paths recorded in harv's own state file. */
function removeOwned(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function readState(claudeDir: string): State {
  try {
    const parsed = JSON.parse(readFileSync(join(claudeDir, MATERIALIZED_STATE_FILE), "utf8"));
    // This file lives in the project tree, so it is input, not memory. Removal
    // walks it rather than the Manifest, and every entry becomes a recursive
    // delete — so a name harv would never have written is one it will not act on.
    const skills = Array.isArray(parsed?.skills)
      ? parsed.skills.filter((s: unknown): s is string => typeof s === "string" && isComponentName(s))
      : [];
    return { version: STATE_VERSION, skills };
  } catch {
    return { version: STATE_VERSION, skills: [] };
  }
}

function writeState(claudeDir: string, state: State): void {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, MATERIALIZED_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Materialization (ADR 0008): declared Components land in the project's
 * `.claude/` tree as symlinks, and `--setting-sources project` picks them up.
 * For skills `--plugin-dir` is deliberately not used — it renames what it
 * serves, so the name a Manifest declares would stop being the name the session
 * answers to.
 *
 * Pinned plugins are the case that flag is reserved for, and they are linked
 * here too, for a different reason. A plugin served with `--plugin-dir` is
 * named by its `.claude-plugin/plugin.json`, and — measured on Claude Code
 * 2.1.223 — by the *directory's own name* when it has no such file. Pointing
 * the flag straight at a Store entry would therefore name a plugin after a hash
 * digest. So each plugin is linked under its own name and the flag is pointed
 * at the link: the directory a session sees is called what the Manifest calls
 * it, whichever of the two rules Claude Code applies.
 *
 * Writing into someone's project demands care, so every materialized entry is
 * recorded. harv only ever removes paths it recorded creating; anything else in
 * `.claude/skills/` or `.claude/harv-plugins/` is someone's own work and is
 * left untouched.
 *
 * What arrives here is already resolved: a name and the directory that holds
 * it, which for a git Source is a Store entry and for a path Source is the
 * directory the Manifest pointed at. Deciding which is Sync's job, not this
 * one's — this step only has to link it safely and be able to undo itself.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COMPONENT_NAME_RULE, isComponentName } from "./manifest.ts";
import { declaredPluginName, MARKETPLACE_FILE } from "./marketplace.ts";

/** harv's ownership record, kept beside the Components it materialized. */
export const MATERIALIZED_STATE_FILE = ".harv-materialized.json";

/**
 * Where pinned plugins are linked. Not `.claude/plugins`: that name belongs to
 * Claude Code's own plugin storage, and these links are harv's.
 */
export const PLUGINS_DIRNAME = "harv-plugins";

const STATE_VERSION = 1;

export class MaterializeError extends Error {
  override name = "MaterializeError";
}

/** One resolved Component: a declared name and the directory holding it. */
export interface Resolved {
  name: string;
  path: string;
}

/** Resolved Components: where each declared name's content actually is. */
export interface MaterializePlan {
  /** The project root — `.claude/` is created beneath it. */
  root: string;
  skills: Resolved[];
  plugins?: Resolved[];
}

export interface MaterializeResult {
  /** Manifest names now linked into project scope. */
  linked: string[];
  /** Pinned plugins now linked, ready to be served with `--plugin-dir`. */
  plugins: string[];
  /** Names harv had materialized before and has now removed. */
  removed: string[];
}

interface State {
  version: number;
  skills: string[];
  plugins: string[];
}

/** The directory `--plugin-dir` is pointed at for a pinned plugin. */
export const pluginDir = (root: string, name: string): string =>
  join(root, ".claude", PLUGINS_DIRNAME, name);

export function materialize(plan: MaterializePlan): MaterializeResult {
  const claudeDir = join(plan.root, ".claude");
  const skillsDir = join(claudeDir, "skills");
  const pluginsDir = join(claudeDir, PLUGINS_DIRNAME);
  const plugins = plan.plugins ?? [];
  const previous = readState(claudeDir);

  // Every check that can fail runs before the first write, so a plan that
  // cannot be satisfied leaves the project tree as it found it.
  for (const skill of plan.skills) validateSkill(skill.name, skill.path);
  for (const plugin of plugins) validatePlugin(plugin.name, plugin.path);

  const declared = plan.skills.map((s) => s.name);
  const pinned = plugins.map((p) => p.name);

  // Dropped by kind, not by name: an entry that moved from `[skills]` to
  // `[plugins]` keeps its name while its old link stops being harv's business.
  const droppedSkills = previous.skills.filter((name) => !declared.includes(name));
  const droppedPlugins = previous.plugins.filter((name) => !pinned.includes(name));
  for (const name of droppedSkills) removeOwned(join(skillsDir, name));
  for (const name of droppedPlugins) removeOwned(join(pluginsDir, name));

  if (plan.skills.length > 0) mkdirSync(skillsDir, { recursive: true });
  for (const skill of plan.skills) {
    link(join(skillsDir, skill.name), skill.path, previous.skills.includes(skill.name));
  }

  if (plugins.length > 0) mkdirSync(pluginsDir, { recursive: true });
  for (const plugin of plugins) {
    link(pluginDir(plan.root, plugin.name), plugin.path, previous.plugins.includes(plugin.name));
  }

  writeState(claudeDir, { version: STATE_VERSION, skills: declared, plugins: pinned });
  return { linked: declared, plugins: pinned, removed: [...droppedSkills, ...droppedPlugins] };
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
 * A pinned plugin must exist, be a directory, and — if it declares a name —
 * declare the one it is pinned under.
 *
 * The name check is ADR 0008's rule where it bites hardest. A plugin's name is
 * not just a label: it is the prefix on every skill, command and subagent it
 * carries, so a plugin pinned as `superpowers` that publishes itself as
 * `superpowers-dev` would answer to `superpowers-dev:brainstorming` — a name
 * nothing in the Manifest mentions and nothing in the project can predict.
 *
 * A plugin with no `plugin.json` is not rejected: Claude Code falls back to the
 * directory name, and materialization has already made that the pinned name.
 */
function validatePlugin(name: string, path: string): void {
  if (!isComponentName(name)) {
    throw new MaterializeError(`plugin \`${name}\` cannot be materialized: ${COMPONENT_NAME_RULE}.`);
  }
  if (!existsSync(path)) {
    throw new MaterializeError(`Plugin \`${name}\` resolves to a path that does not exist: ${path}`);
  }
  if (!statSync(path).isDirectory()) {
    throw new MaterializeError(`Plugin \`${name}\` must point at a directory, but ${path} is a file`);
  }
  // A marketplace's own checkout is not a plugin, and staging one by mistake
  // would serve a whole catalogue as a single plugin.
  if (existsSync(join(path, MARKETPLACE_FILE))) {
    throw new MaterializeError(
      `Plugin \`${name}\` resolves to a marketplace rather than to a plugin: ${path} carries ${MARKETPLACE_FILE}.`,
    );
  }

  const published = declaredPluginName(path);
  if (published !== undefined && published !== name) {
    throw new MaterializeError(
      `Plugin \`${name}\` is published as \`${published}\`, and a plugin names every skill and command it ` +
        `carries after itself. Pin it as \`${published}\` so the Manifest and the session agree.`,
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
    return { version: STATE_VERSION, skills: names(parsed?.skills), plugins: names(parsed?.plugins) };
  } catch {
    return { version: STATE_VERSION, skills: [], plugins: [] };
  }
}

/**
 * This file lives in the project tree, so it is input, not memory. Removal
 * walks it rather than the Manifest, and every entry becomes a recursive
 * delete — so a name harv would never have written is one it will not act on.
 */
const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((n: unknown): n is string => typeof n === "string" && isComponentName(n)) : [];

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

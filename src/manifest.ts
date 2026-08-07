/**
 * The Manifest: the committed file that declares what a project's Harvenv
 * contains. Discovery walks up from the working directory, so "switching
 * environments is just `cd`" (ADR 0001).
 *
 * All three of ADR 0004's Sources are readable here: git coordinates
 * (repository, optional ref, optional subdirectory) and local paths under
 * `[skills]`, which are allowed but non-portable and flagged as such at Sync,
 * and marketplace coordinates under `[plugins]`. Alongside the Components are
 * the two tables that configure the session itself: `[settings]` and `[mcp]`.
 *
 * `[skills]` and `[plugins]` are separate because the Components they declare
 * load by different mechanisms and answer to different names. A skill is
 * materialized into project scope and keeps its bare name; a plugin is served
 * through `--plugin-dir` and prefixes everything it carries with its own name
 * (ADR 0008). Which table an entry sits in is therefore not a filing detail —
 * it is the difference between `brainstorming` and `superpowers:brainstorming`.
 *
 * The reader is shared: an Overlay file declares the same tables in the same
 * vocabulary, because a personal staple is the same kind of thing as a project's
 * own Component and there is no reason to learn it twice (ADR 0002). What
 * differs between the two is policy, not shape — who may set which settings key,
 * and whether an entry may *remove* a name rather than declare one — so it
 * arrives as options rather than as a second parser.
 *
 * Parsing stops at shape: what a table has to *be* to be read at all. What its
 * contents have to *mean* — that a settings key is one a Manifest may bind, that
 * a server declares a transport Claude Code runs, that a marketplace really
 * publishes the plugin — belongs to the modules that act on them, next to the
 * measurements those rules come from.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";

import type { McpServerEntry } from "./mcp.ts";

export const MANIFEST_FILENAME = "harvenv.toml";

/** Keys a `[skills]` entry cannot carry, and where each of them belongs. */
const MISPLACED_SKILL_KEYS: Record<string, string> = {
  marketplace: "a marketplace coordinate declares a plugin, so it belongs in `[plugins]`",
  version: "harv pins by commit and content hash, not by version — use `ref` to name a tag",
};

/** Keys that only mean something alongside `git`. */
const GIT_MODIFIERS = ["ref", "subdir"] as const;

/** Keys a `[plugins]` entry cannot carry, and why. */
const MISPLACED_PLUGIN_KEYS: Record<string, string> = {
  git: "a plugin is named inside a marketplace, so declare the marketplace repository as `marketplace`",
  path: "a plugin pin is a marketplace coordinate; a local directory is a `[skills]` Source",
  subdir:
    "where a plugin lives inside its marketplace is a fact of the marketplace, not of the Manifest — " +
    "harv reads it from `.claude-plugin/marketplace.json`",
  version: "harv pins the marketplace commit and the plugin's content hash, not a version — use `ref`",
};

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

/**
 * A Toolchain tool name, in the engine's vocabulary: `node`, but also a
 * backend-qualified one like `npm:prettier` or `cargo:ripgrep` (ADR 0006).
 *
 * Wider than a Component name, and checked for different reasons. It becomes an
 * argument to the install engine — hence the leading character, which keeps a
 * requirement from arriving as a flag — and a path segment under the Store,
 * hence the refusal of `..`. `@` is in because a package-backed tool carries a
 * scope (`npm:@scope/pkg`); it cannot lead, so it never reads as a version.
 */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+:/@-]*$/;

/** A version spec: an exact version, a prefix, or an alias like `lts`. */
const TOOL_SPEC = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export const isToolName = (name: string): boolean => TOOL_NAME.test(name) && !name.includes("..");

export const isToolSpec = (spec: string): boolean => TOOL_SPEC.test(spec);

export const TOOL_NAME_RULE =
  "a tool name must start with a letter or digit and may contain letters, digits, `.`, `-`, `_`, `+`, `:`, `/` and `@`";

export const TOOL_SPEC_RULE =
  "a version must start with a letter or digit and may contain letters, digits, `.`, `-`, `_` and `+` — " +
  'e.g. "22", "22.18.0" or "lts"';

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

/**
 * A plugin marketplace: a repository carrying `.claude-plugin/marketplace.json`,
 * optionally at a ref. There is no registry (ADR 0004), so a marketplace is
 * addressed the only way a Manifest can address anything — as a repository you
 * can already clone. Which plugin to take out of it is the entry's key.
 *
 * There is no `subdir`: where a plugin sits inside its marketplace is declared
 * by the marketplace, and reading it from there is what makes `name@marketplace`
 * the whole coordinate.
 */
export interface MarketplaceSource {
  kind: "marketplace";
  repo: string;
  ref?: string;
}

export type Source = PathSource | GitSource;

export interface SkillEntry {
  /** The Manifest key — and, per ADR 0008, the name the session answers to. */
  name: string;
  source: Source;
}

export interface PluginEntry {
  /**
   * The plugin's name in its marketplace — and the prefix every Component it
   * carries answers to, so `superpowers` here means `superpowers:brainstorming`
   * in the session.
   */
  name: string;
  source: MarketplaceSource;
}

/** A coordinate as one line, for messages and Lockfile-drift reports. */
export function describeSource(source: Source | MarketplaceSource): string {
  if (source.kind === "path") return source.declared;
  if (source.kind === "marketplace") return source.repo + (source.ref ? `@${source.ref}` : "");
  return source.repo + (source.ref ? `@${source.ref}` : "") + (source.subdir ? `#${source.subdir}` : "");
}

/** The native `name@marketplace` identity of a pin, for messages. */
export const describePlugin = (entry: PluginEntry): string => `${entry.name}@${describeSource(entry.source)}`;

/** A system tool the Harvenv needs, at the version spec that was asked for. */
export interface ToolEntry {
  tool: string;
  spec: string;
}

/** What one declaration file — a Manifest or an Overlay file — says. */
export interface Declarations {
  skills: SkillEntry[];
  plugins: PluginEntry[];
  /** The `[tools]` table: the Toolchain this file pins directly (ADR 0006). */
  tools: ToolEntry[];
  /** The settings table, injected via `--settings` at launch. */
  settings: Record<string, unknown>;
  /** The MCP servers, injected via `--mcp-config` at launch. */
  mcpServers: McpServerEntry[];
  /** Names this file removes rather than declares. Only an Overlay may. */
  disabled: { skills: string[]; mcpServers: string[] };
}

export interface DeclarationOptions {
  /** Where a relative `path` Source resolves against. */
  root: string;
  /**
   * Why `{ disable = true }` may not appear in this file, or null if it may.
   * The reason is the caller's because only the caller knows where the entry
   * would have belonged — this reader knows the shape, not the policy.
   */
  disable: string | null;
  /**
   * Why `[plugins]` may not appear in this file, or null if it may. An Overlay
   * cannot carry one yet: a plugin pin goes through a marketplace catalogue and
   * a Lockfile table this slice did not extend, and a table that parsed and then
   * loaded nothing would be exactly the silence harv exists to remove.
   */
  plugins: string | null;
  /**
   * Why `[tools]` may not appear in this file, or null if it may. An Overlay
   * cannot carry one: a tool is pinned into the committed Lockfile, and a
   * personal staple has no business putting a version there for the whole team
   * (ADR 0006, ADR 0013).
   */
  tools: string | null;
}

/** A Manifest may not disable anything, so it carries no such list. */
export interface Manifest extends Omit<Declarations, "disabled"> {
  /** Absolute path to `harvenv.toml`. */
  path: string;
  /** The project root: the directory holding the Manifest. */
  root: string;
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
  const { disabled: _unused, ...declarations } = parseDeclarations(manifestPath, {
    root,
    disable:
      "a Manifest declares what a project's Harvenv contains, and only an Overlay can take something back out",
    plugins: null,
    tools: null,
  });
  return { path: manifestPath, root, ...declarations };
}

/**
 * Read one declaration file. Shared by the Manifest and by both Overlay files,
 * so the two speak the same TOML and a staple is written exactly the way the
 * project's own entry would be.
 */
export function parseDeclarations(path: string, options: DeclarationOptions): Declarations {
  const raw = readTable(path);
  const skills = parseSkills(raw.skills, path, options);
  const mcpServers = parseMcpServers(raw.mcp, path, options);

  if (options.plugins !== null && raw.plugins !== undefined) {
    throw new ManifestError(`[plugins] in ${path} ${options.plugins}.`);
  }
  if (options.tools !== null && raw.tools !== undefined) {
    throw new ManifestError(`[tools] in ${path} ${options.tools}.`);
  }

  return {
    skills: skills.declared,
    plugins: parsePlugins(raw.plugins, path),
    tools: parseTools(raw.tools, path),
    settings: asTable(raw.settings, "settings", path) ?? {},
    mcpServers: mcpServers.declared,
    disabled: { skills: skills.disabled, mcpServers: mcpServers.disabled },
  };
}

/**
 * Whether this entry removes its name instead of declaring it.
 *
 * A disabled entry is a whole entry, not a modifier: `disable` next to a Source
 * would say "fetch this and also do not" at once, and `disable = false` is a
 * value that reads like an instruction and means nothing — the way to stop
 * disabling a name is to delete the entry, not to negate it.
 */
function isDisabled(entry: Record<string, unknown>, where: string, options: DeclarationOptions): boolean {
  if (!("disable" in entry)) return false;
  if (options.disable !== null) {
    throw new ManifestError(`${where} declares \`disable\`, but ${options.disable}.`);
  }
  if (entry.disable !== true) {
    throw new ManifestError(
      `${where} has \`disable = ${JSON.stringify(entry.disable)}\`, and \`true\` is the only value that means ` +
        `anything. Delete the entry to stop disabling the name.`,
    );
  }
  const alongside = Object.keys(entry).filter((key) => key !== "disable");
  if (alongside.length > 0) {
    throw new ManifestError(
      `${where} declares \`disable\` alongside \`${alongside.join("\`, \`")}\`, so it both removes the name and ` +
        `declares it. Keep one.`,
    );
  }
  return true;
}

/**
 * `[tools]` is a flat table of tool to version spec, because that is the whole
 * declaration: `node = "22.18"`. A Component may ask for the same tool through
 * its own `requires`, and when the two disagree this one wins — Manifest
 * declarations are binding (ADR 0005).
 */
function parseTools(value: unknown, manifestPath: string): ToolEntry[] {
  const tools = asTable(value, "tools", manifestPath);
  if (!tools) return [];

  return Object.entries(tools).map(([tool, spec]) => {
    const where = `[tools] entry \`${tool}\` in ${manifestPath}`;
    if (!isToolName(tool)) throw new ManifestError(`${where} is not a usable tool name: ${TOOL_NAME_RULE}.`);
    if (typeof spec !== "string" || spec === "") {
      throw new ManifestError(
        `${where} must be a version string, e.g. ${tool} = "22.18". ` +
          `Use "latest" to follow the newest release.`,
      );
    }
    if (!isToolSpec(spec)) throw new ManifestError(`${where} has a version harv will not pass on: ${TOOL_SPEC_RULE}.`);
    return { tool, spec };
  });
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

function parseSkills(
  value: unknown,
  manifestPath: string,
  options: DeclarationOptions,
): { declared: SkillEntry[]; disabled: string[] } {
  const skills = asTable(value, "skills", manifestPath);
  const declared: SkillEntry[] = [];
  const disabled: string[] = [];
  if (!skills) return { declared, disabled };

  for (const [name, entry] of Object.entries(skills)) {
    const where = `[skills] entry \`${name}\` in ${manifestPath}`;
    if (!isComponentName(name)) {
      throw new ManifestError(`${where} is not a usable skill name: ${COMPONENT_NAME_RULE}.`);
    }
    if (!isTable(entry)) {
      throw new ManifestError(`${where} must be a table, e.g. ${name} = { git = "https://…" }`);
    }
    if (isDisabled(entry, where, options)) {
      disabled.push(name);
      continue;
    }

    const misplaced = Object.keys(MISPLACED_SKILL_KEYS).find((key) => key in entry);
    if (misplaced !== undefined) {
      throw new ManifestError(
        `${where} declares \`${misplaced}\`, which a skill entry cannot carry: ${MISPLACED_SKILL_KEYS[misplaced]}.`,
      );
    }

    declared.push({ name, source: parseSource(entry, name, where, options.root) });
  }
  return { declared, disabled };
}

/**
 * `[plugins]` — one entry per pinned plugin, keyed by the plugin's own name.
 *
 * A plugin arrives whole: harv can pin one, and cannot take part of one. That
 * is a property of the mechanism rather than a limitation of this parser — a
 * plugin is one directory that Claude Code loads entire — so there is nothing
 * here to select skills, hooks or servers out of it, and the Manifest reference
 * says so.
 */
function parsePlugins(value: unknown, manifestPath: string): PluginEntry[] {
  const plugins = asTable(value, "plugins", manifestPath);
  if (!plugins) return [];

  return Object.entries(plugins).map(([name, entry]) => {
    const where = `[plugins] entry \`${name}\` in ${manifestPath}`;
    if (!isComponentName(name)) {
      throw new ManifestError(
        `${where} is not a usable plugin name: ${COMPONENT_NAME_RULE}. ` +
          `The key is the plugin's name in its marketplace, and the prefix its skills and commands answer to.`,
      );
    }
    if (!isTable(entry)) {
      throw new ManifestError(
        `${where} must be a table, e.g. ${name} = { marketplace = "https://example.com/marketplace.git" }`,
      );
    }

    const misplaced = Object.keys(MISPLACED_PLUGIN_KEYS).find((key) => key in entry);
    if (misplaced !== undefined) {
      throw new ManifestError(
        `${where} declares \`${misplaced}\`, which a plugin entry cannot carry: ${MISPLACED_PLUGIN_KEYS[misplaced]}.`,
      );
    }
    if (!("marketplace" in entry)) {
      throw new ManifestError(
        `${where} needs a \`marketplace\`: the repository whose \`.claude-plugin/marketplace.json\` lists ` +
          `\`${name}\`, e.g. ${pluginExample(name)}`,
      );
    }

    const source: MarketplaceSource = {
      kind: "marketplace",
      repo: requireString(entry.marketplace, "marketplace", where, pluginExample(name)),
    };
    if ("ref" in entry) source.ref = requireString(entry.ref, "ref", where, pluginExample(name));
    return { name, source };
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
    const declared = requireString(entry.path, "path", where, skillExample(name));
    return { kind: "path", declared, path: isAbsolute(declared) ? declared : join(root, declared) };
  }

  const source: GitSource = { kind: "git", repo: requireString(entry.git, "git", where, skillExample(name)) };
  if ("ref" in entry) source.ref = requireString(entry.ref, "ref", where, skillExample(name));
  if ("subdir" in entry) {
    source.subdir = parseSubdir(requireString(entry.subdir, "subdir", where, skillExample(name)), where);
  }
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

/**
 * The example is passed in rather than derived, because `ref` means something
 * in both tables and the way out of a bad one differs by which table it is in.
 */
function requireString(value: unknown, key: string, where: string, example: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`${where} has a \`${key}\` that is not a non-empty string. Example: ${example}`);
  }
  return value;
}

const skillExample = (name: string): string => `${name} = { git = "https://example.com/skills.git", subdir = "${name}" }`;

const pluginExample = (name: string): string =>
  `${name} = { marketplace = "https://example.com/marketplace.git", ref = "v1" }`;

/**
 * `[mcp]` entries are named for the same reason skills are: the key becomes the
 * `mcp__<server>__<tool>` prefix every one of that server's tools carries into
 * the session, so it is vocabulary a teammate reads and types. The Component
 * name rule keeps it to one conservative segment.
 */
function parseMcpServers(
  value: unknown,
  manifestPath: string,
  options: DeclarationOptions,
): { declared: McpServerEntry[]; disabled: string[] } {
  const servers = asTable(value, "mcp", manifestPath);
  const declared: McpServerEntry[] = [];
  const disabled: string[] = [];
  if (!servers) return { declared, disabled };

  for (const [name, definition] of Object.entries(servers)) {
    const where = `[mcp.${name}] in ${manifestPath}`;
    if (!isComponentName(name)) {
      throw new ManifestError(`${where} is not a usable MCP server name: ${COMPONENT_NAME_RULE}.`);
    }
    if (!isTable(definition)) {
      throw new ManifestError(
        `${where} must be a table of server settings, e.g. [mcp.${name}] with command = "npx"`,
      );
    }
    if (isDisabled(definition, where, options)) disabled.push(name);
    else declared.push({ name, definition });
  }
  return { declared, disabled };
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

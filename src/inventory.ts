/**
 * Reading the machine's user scope — the pile a harvenv is the cure for.
 *
 * `~/.claude` is where a Claude Code user accumulates skills, plugins and MCP
 * servers over months, one `/plugin install` at a time, until nobody can say
 * what a session actually loads. ADR 0002 stops that pile loading inside a
 * harvenv session; this module is how it gets *out* of the pile and into a
 * Manifest or an Overlay, which is the only migration path that does not start
 * with "declare all of it again by hand".
 *
 * ## It reads, and only reads
 *
 * Nothing here opens a file for writing, and nothing here is reachable from a
 * command that writes to the user scope. That is not tidiness: the wizard's
 * whole proposition is that adopting harvenv costs you nothing if you change
 * your mind, and a scan that edited `~/.claude` on the way past would make that
 * false. `CLAUDE_CONFIG_DIR` moves the whole scan, because Claude Code itself
 * honours it — so a fixture tree is scanned by the same code path a real
 * machine is, rather than by a test-only branch.
 *
 * ## Deriving a Source is a question about git, not about harv
 *
 * ADR 0004 gives a Component exactly three kinds of Source, and two of them are
 * derivable from what is on disk: a plugin's `name@marketplace` coordinate is
 * recorded by Claude Code in `installed_plugins.json`, and a skill that was
 * installed by cloning a repository still has that repository as its origin.
 * Everything else is a directory somebody made, and the honest answer for one
 * of those is not a coordinate but a flag — ADR 0004's own consequence, that a
 * skill on one laptop is not handoff-able until it is pushed somewhere a
 * teammate's `git` can reach.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { isComponentName, loadManifest, MANIFEST_FILENAME } from "./manifest.ts";
import type { MarketplaceSource, Source } from "./manifest.ts";
import { frontmatterName } from "./materialize.ts";
import { loadOverlay } from "./overlay.ts";
import type { Env } from "./store.ts";

/** Where this machine's user scope lives, and whether it is there at all. */
export interface UserScope {
  /** The `.claude` directory: skills, the plugin registry, user settings. */
  dir: string;
  /**
   * `.claude.json` — where MCP servers live. Deliberately not inside `dir` by
   * default: Claude Code keeps it beside the directory rather than in it, and
   * it is not a settings source (ADR 0003's second MCP flag exists because of
   * that).
   */
  config: string;
  exists: boolean;
}

export type ItemKind = "skill" | "plugin" | "mcp";

/** Where a name is already spoken for, so the wizard does not offer it twice. */
export type Declared = "manifest" | "overlay";

/** One thing the user scope carries, and everything a choice about it needs. */
export interface InventoryItem {
  kind: ItemKind;
  /** The name a Manifest or Overlay would key it by — and the session answers to. */
  name: string;
  /** The heading it files under, so a wizard groups rather than lists. */
  group: string;
  /** One line: what it is and where it came from, for the prompt. */
  detail: string;
  /** The coordinate harv derived, or null when there is nothing to derive. */
  source: Source | MarketplaceSource | null;
  /** An MCP server's definition, as `[mcp.<name>]` would carry it. */
  definition?: Record<string, unknown>;
  /**
   * Why nothing that reaches a teammate can resolve this, and what to do about
   * it — or null when a Source was derived. ADR 0004's consequence, stated at
   * the moment somebody is deciding where to put the thing.
   */
  local: string | null;
  /** Where the name is already declared, or null. */
  declared: Declared | null;
}

export interface Inventory {
  scope: UserScope;
  /** Grouped in the order a wizard should walk them: skills, plugins, servers. */
  items: InventoryItem[];
  /** What the scan could not read, one line each. Never fatal. */
  warnings: string[];
}

export const GROUPS = {
  skillsFromGit: "skills from a git repository",
  skillsLocal: "skills that exist only on this machine",
  mcpGlobal: "MCP servers this machine runs everywhere",
  mcpProject: "MCP servers this machine runs in this project",
} as const;

/** Plugins group by where they came from — the only grouping that reads. */
export const pluginGroup = (marketplace: string): string => `plugins from the \`${marketplace}\` marketplace`;

export function userScope(env: Env = process.env): UserScope {
  const home = env.HOME ?? homedir();
  const configured = env.CLAUDE_CONFIG_DIR;
  const dir = configured ?? join(home, ".claude");
  // The config file follows the directory when one is named, because Claude
  // Code puts it there — a scan that kept reading `$HOME/.claude.json` would
  // report the real machine's servers while claiming to read a fixture.
  const config = configured === undefined ? join(home, ".claude.json") : join(configured, ".claude.json");
  return { dir, config, exists: existsSync(dir) || existsSync(config) };
}

/**
 * Everything in the user scope worth a decision, for a wizard running in
 * `root`.
 *
 * The project is a parameter because two of the answers depend on it: which
 * per-project MCP servers are *this* project's, and which names are already
 * declared here and so must not be offered again.
 */
export function inventory(root: string, env: Env = process.env): Inventory {
  const scope = userScope(env);
  const warnings: string[] = [];
  const items = [
    ...skills(scope, warnings),
    ...plugins(scope, warnings),
    ...mcpServers(scope, root, warnings),
  ];

  const spoken = declaredNames(root, env);
  for (const item of items) item.declared = spoken.get(key(item)) ?? null;

  return { scope, items, warnings };
}

/** Kind and name together: `[skills]` and `[mcp]` are separate namespaces. */
const key = (item: { kind: ItemKind; name: string }): string =>
  `${item.kind === "mcp" ? "mcp" : "component"}:${item.name}`;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function skills(scope: UserScope, warnings: string[]): InventoryItem[] {
  const dir = join(scope.dir, "skills");
  const entries = list(dir, warnings);
  const items: InventoryItem[] = [];

  for (const entry of entries) {
    const path = join(dir, entry);
    const skillFile = join(path, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    let published: string | undefined;
    try {
      published = frontmatterName(readFileSync(skillFile, "utf8"));
    } catch (err) {
      warnings.push(`could not read ${skillFile}: ${(err as Error).message}`);
      continue;
    }

    // ADR 0008: the key has to be the name the skill publishes, or the entry
    // the wizard writes declares a name that never answers.
    const name = published ?? entry;
    if (!isComponentName(name)) {
      warnings.push(
        `the skill in ${path} is called \`${name}\`, which is not a name a Manifest key can carry — skipped.`,
      );
      continue;
    }

    const derived = gitSourceOf(path);
    items.push({
      kind: "skill",
      name,
      group: derived.source === null ? GROUPS.skillsLocal : GROUPS.skillsFromGit,
      detail: derived.source === null ? path : describeGit(derived.source),
      source: derived.source,
      local: derived.reason,
      declared: null,
    });
  }
  // Portable first: a group of skills a teammate can already fetch is a
  // decision about the project, and a group that cannot be fetched is a
  // decision about what to do next. Interleaving them alphabetically would put
  // those two questions in one list.
  return items.sort((a, b) => (a.group === b.group ? byName(a, b) : a.group === GROUPS.skillsFromGit ? -1 : 1));
}

const describeGit = (source: Source): string =>
  source.kind === "path"
    ? source.declared
    : `${source.repo}${source.subdir === undefined ? "" : `#${source.subdir}`}`;

/**
 * The git coordinate a directory sits at, or why it has none.
 *
 * Three things have to hold before a teammate can fetch this skill, and all
 * three fail routinely: the directory is in a repository, that repository has
 * somewhere to fetch *from*, and the skill is actually committed rather than
 * sitting untracked inside an unrelated checkout — which is exactly what
 * happens when somebody's `$HOME` is itself a dotfiles repo.
 */
function gitSourceOf(path: string): { source: Source | null; reason: string | null } {
  const real = resolveLink(path);
  const toplevel = git(["rev-parse", "--show-toplevel"], real);
  if (toplevel === null) {
    return {
      source: null,
      reason:
        `it is a directory on this machine and nothing else — no clone of this project can resolve it. ` +
        `Put it in a git repository and push it, then declare that repository as its Source (ADR 0004).`,
    };
  }

  if (git(["ls-files", "--"], real) === "") {
    return {
      source: null,
      reason:
        `it sits inside the git repository at ${toplevel} but is not committed to it, so a fetch of that ` +
        `repository would not contain it. Commit and push it, then declare it by coordinate.`,
    };
  }

  const repo = git(["remote", "get-url", "origin"], real);
  if (repo === null) {
    return {
      source: null,
      reason:
        `its git repository at ${toplevel} has no \`origin\` remote, so there is nowhere for a teammate to ` +
        `fetch it from. Push it to a repository and declare that as its Source (ADR 0004).`,
    };
  }

  const commit = git(["rev-parse", "HEAD"], real);
  const subdir = relative(resolveLink(toplevel), real).split(sep).join("/");
  return {
    source: {
      kind: "git",
      repo,
      // Pinned at the commit that is checked out, because the import's promise
      // is the environment you are running *now*. A ref is one edit away for
      // anyone who would rather follow a branch.
      ...(commit === null ? {} : { ref: commit }),
      ...(subdir === "" ? {} : { subdir }),
    },
    reason: null,
  };
}

/** git's answer, or null when git says no. Never throws: this is a scan. */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const resolveLink = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/** Claude Code's own registry files, and the settings key that switches one on. */
const INSTALLED_PLUGINS = join("plugins", "installed_plugins.json");
const KNOWN_MARKETPLACES = join("plugins", "known_marketplaces.json");
const USER_SETTINGS = "settings.json";

function plugins(scope: UserScope, warnings: string[]): InventoryItem[] {
  const settings = readJson(join(scope.dir, USER_SETTINGS), warnings) ?? {};
  const enabled = table(settings.enabledPlugins);
  if (enabled === undefined) return [];

  const known = {
    ...table(readJson(join(scope.dir, KNOWN_MARKETPLACES), warnings)),
    // A marketplace a user added by hand is recorded in their settings rather
    // than in the registry, and both are equally real.
    ...table(settings.extraKnownMarketplaces),
  };
  const installed = table(table(readJson(join(scope.dir, INSTALLED_PLUGINS), warnings))?.plugins) ?? {};

  const items: InventoryItem[] = [];
  for (const [coordinate, on] of Object.entries(enabled)) {
    // A plugin the user switched off is a decision they already made. Importing
    // it would quietly reverse it.
    if (on !== true) continue;

    const at = coordinate.lastIndexOf("@");
    const name = at === -1 ? coordinate : coordinate.slice(0, at);
    const marketplace = at === -1 ? "" : coordinate.slice(at + 1);
    if (!isComponentName(name)) {
      warnings.push(`the plugin \`${coordinate}\` has a name a Manifest key cannot carry — skipped.`);
      continue;
    }

    const repo = marketplaceRepo(known[marketplace]);
    const ref = commitOf(installed[coordinate]);
    items.push({
      kind: "plugin",
      name,
      group: pluginGroup(marketplace === "" ? "(unnamed)" : marketplace),
      detail: repo ?? `${marketplace}, which is not a repository harv can fetch`,
      source: repo === null ? null : { kind: "marketplace", repo, ...(ref === null ? {} : { ref }) },
      local:
        repo === null
          ? `its marketplace \`${marketplace}\` is a directory on this machine rather than a repository, so a ` +
            `teammate has nothing to fetch it from. Declare a marketplace repository that publishes it (ADR 0004).`
          : null,
      declared: null,
    });
  }
  return items.sort(byName);
}

/**
 * A marketplace entry turned into a repository URL.
 *
 * Claude Code records a marketplace as its own tagged union, and only the forms
 * that name a *remote* repository convert: a `directory` marketplace is a path
 * on one machine, which is precisely what a Manifest cannot hand over.
 */
function marketplaceRepo(entry: unknown): string | null {
  const source: unknown = table(entry)?.source ?? entry;
  if (typeof source === "string") return repoFromString(source);

  const fields = table(source);
  if (fields === undefined) return null;
  if (fields.source === "github" && typeof fields.repo === "string") {
    return `https://github.com/${fields.repo}.git`;
  }
  if (fields.source === "git" && typeof fields.url === "string") return fields.url;
  return null;
}

/** `owner/repo` is GitHub shorthand; anything with a transport is already a URL. */
const repoFromString = (source: string): string | null =>
  /^[\w.-]+\/[\w.-]+$/.test(source)
    ? `https://github.com/${source}.git`
    : /^(https?|ssh|git|file):\/\/|^git@/.test(source)
      ? source
      : null;

/** The commit Claude Code recorded for an installed plugin, if it recorded one. */
function commitOf(installs: unknown): string | null {
  if (!Array.isArray(installs)) return null;
  const entries = installs.filter((entry): entry is Record<string, unknown> => table(entry) !== undefined);
  const chosen = entries.find((entry) => entry.scope === "user") ?? entries[0];
  const sha = chosen?.gitCommitSha;
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function mcpServers(scope: UserScope, root: string, warnings: string[]): InventoryItem[] {
  const config = readJson(scope.config, warnings);
  if (config === undefined) return [];

  const here = table(table(table(config.projects)?.[projectKey(config, root)])?.mcpServers) ?? {};
  const everywhere = table(config.mcpServers) ?? {};

  const item = (name: string, definition: unknown, group: string): InventoryItem | null => {
    const fields = table(definition);
    if (fields === undefined || !isComponentName(name)) {
      warnings.push(`the MCP server \`${name}\` in ${scope.config} is not a definition harv can read — skipped.`);
      return null;
    }
    return {
      kind: "mcp",
      name,
      group,
      detail: transportOf(fields),
      // A server is a definition, not a fetch: there is no Source to derive and
      // nothing non-portable about one, because what a Manifest hands over is
      // the definition itself.
      source: null,
      definition: fields,
      local: null,
      declared: null,
    };
  };

  return [
    ...Object.entries(everywhere).map(([name, d]) => item(name, d, GROUPS.mcpGlobal)),
    ...Object.entries(here).map(([name, d]) => item(name, d, GROUPS.mcpProject)),
  ].filter((entry): entry is InventoryItem => entry !== null);
}

/**
 * The `projects` key this project is filed under.
 *
 * Compared through `realpath` because macOS hands out `/var/...` paths that are
 * really `/private/var/...`, and Claude Code records whichever one the session
 * was started from.
 */
function projectKey(config: Record<string, unknown>, root: string): string {
  const projects = table(config.projects);
  if (projects === undefined) return root;
  const wanted = resolveLink(resolve(root));
  return Object.keys(projects).find((path) => resolveLink(resolve(path)) === wanted) ?? root;
}

const transportOf = (definition: Record<string, unknown>): string =>
  typeof definition.url === "string"
    ? definition.url
    : [definition.command, ...(Array.isArray(definition.args) ? definition.args : [])]
        .filter((part) => typeof part === "string")
        .join(" ") || "no transport";

// ---------------------------------------------------------------------------
// What is already declared
// ---------------------------------------------------------------------------

/**
 * Every name this project already speaks for, and which file speaks for it.
 *
 * This is what makes re-running the wizard idempotent: an item that is already
 * declared is never offered, so there is no path from a second run to a second
 * entry. Both Overlay files count — a staple and a project extra are equally a
 * declaration — even though only the global one is ever written to.
 */
function declaredNames(root: string, env: Env): Map<string, Declared> {
  const spoken = new Map<string, Declared>();

  const overlay = loadOverlay(root, env);
  for (const entry of [...overlay.skills, ...overlay.plugins]) spoken.set(`component:${entry.name}`, "overlay");
  for (const server of overlay.mcpServers) spoken.set(`mcp:${server.name}`, "overlay");

  const manifestPath = join(root, MANIFEST_FILENAME);
  if (existsSync(manifestPath)) {
    const manifest = loadManifest(manifestPath);
    for (const entry of [...manifest.skills, ...manifest.plugins]) spoken.set(`component:${entry.name}`, "manifest");
    for (const server of manifest.mcpServers) spoken.set(`mcp:${server.name}`, "manifest");
  }
  return spoken;
}

// ---------------------------------------------------------------------------
// Reading what is there
// ---------------------------------------------------------------------------

const byName = (a: InventoryItem, b: InventoryItem): number => a.name.localeCompare(b.name);

/**
 * A user-scope JSON file, or `undefined` with a warning.
 *
 * Never fatal. The pile this reads is not harv's to validate — a
 * `settings.json` somebody broke last week should cost them the plugins half
 * of one wizard run, not the wizard.
 */
function readJson(path: string, warnings: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (table(parsed) === undefined) {
      warnings.push(`${path} does not contain a JSON object, so nothing was read from it.`);
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    warnings.push(`${path} could not be read (${(err as Error).message}), so nothing was imported from it.`);
    return undefined;
  }
}

/** A directory's entries, or none — with anything unexpected reported. */
function list(dir: string, warnings: string[]): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith(".") && isDirectory(join(dir, entry)));
  } catch (err) {
    warnings.push(`${dir} could not be listed (${(err as Error).message}), so no skills were imported.`);
    return [];
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const table = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

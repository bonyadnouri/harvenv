/**
 * Resolving a plugin out of a marketplace (ADR 0004's `name@marketplace`).
 *
 * A marketplace is a repository carrying `.claude-plugin/marketplace.json`, a
 * catalogue that maps a plugin's name to where its directory sits inside that
 * repository. So a pin is answered in two steps: fetch the marketplace at a
 * commit, then read the catalogue *at that commit* to learn where the plugin
 * is. The second step is deliberately not something the Manifest can state —
 * a marketplace that reorganizes its own layout must not break every Manifest
 * that pinned a plugin out of it, and the commit already makes the answer
 * deterministic.
 *
 * What comes back is one directory, and a session loads it whole: its skills,
 * commands, subagents and hooks all arrive together, under the plugin's name.
 * There is nothing here that could take part of one, because the mechanism has
 * no such seam — which is the caveat the Manifest reference documents.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, posix, sep } from "node:path";

export const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");
export const PLUGIN_FILE = join(".claude-plugin", "plugin.json");

export class MarketplaceError extends Error {
  override name = "MarketplaceError";
}

/** Where a plugin lives inside its marketplace, and what the catalogue calls the marketplace. */
export interface ResolvedPlugin {
  /** Relative to the marketplace checkout. `""` when the repository is the plugin. */
  subdir: string;
  /** The marketplace's own declared name — the `@marketplace` half of the coordinate. */
  marketplace: string;
}

/**
 * The plugin `name` in the marketplace checked out at `checkout`.
 *
 * Everything that could differ between two marketplaces is read here rather
 * than assumed, and everything that cannot be served by fetching one commit of
 * one repository is refused by name. A catalogue entry may point at another
 * repository entirely — that is a second Source with a second pin, so it is
 * rejected rather than followed halfway.
 */
export function resolvePlugin(checkout: string, name: string): ResolvedPlugin {
  const catalogue = readCatalogue(checkout);
  const entries = Array.isArray(catalogue.plugins) ? catalogue.plugins : [];

  const entry = entries.find(
    (candidate): candidate is Record<string, unknown> => isTable(candidate) && candidate.name === name,
  );
  if (entry === undefined) {
    const offered = entries
      .filter(isTable)
      .map((candidate) => candidate.name)
      .filter((candidate): candidate is string => typeof candidate === "string");
    throw new MarketplaceError(
      `this marketplace does not offer a plugin called \`${name}\`. ` +
        (offered.length > 0
          ? `It offers: ${offered.join(", ")}.`
          : `Its ${MARKETPLACE_FILE} lists no plugins at all.`),
    );
  }

  const source = entry.source;
  if (typeof source !== "string") {
    throw new MarketplaceError(
      `plugin \`${name}\` is published from somewhere other than this marketplace's own repository, ` +
        `which harv cannot pin yet: one pin resolves one commit of one repository. ` +
        `Declare the repository that actually holds the plugin as its marketplace, if it publishes one.`,
    );
  }

  return { subdir: withinRepository(source, name), marketplace: declaredName(catalogue) };
}

/**
 * The plugin's own declared name, if it declares one.
 *
 * Measured on Claude Code 2.1.223: a plugin served with `--plugin-dir` is named
 * by `.claude-plugin/plugin.json`, and by the directory's own name only when
 * that file is absent. So this is the name the session will actually use, and
 * a pin whose key disagrees with it would answer to a name the Manifest never
 * mentions — the same failure ADR 0008 rejects for skills.
 */
export function declaredPluginName(pluginDir: string): string | undefined {
  const path = join(pluginDir, PLUGIN_FILE);
  if (!existsSync(path)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new MarketplaceError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const name = isTable(parsed) ? parsed.name : undefined;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * The MCP servers a plugin brings with it, by name.
 *
 * They are read only to be reported. The launch recipe passes
 * `--strict-mcp-config`, which is what keeps the user's own servers out of the
 * session (ADR 0003), and measurement shows it keeps a plugin's servers out
 * too. A plugin that ships one is therefore not arriving entirely whole yet,
 * and Sync says so by name rather than letting the gap be discovered inside a
 * session.
 */
export function declaredMcpServers(pluginDir: string): string[] {
  const names = new Set<string>();
  // Two places, because both are real: a plugin may ship a `.mcp.json` beside
  // its skills, or declare `mcpServers` inline in its manifest.
  for (const path of [join(pluginDir, ".mcp.json"), join(pluginDir, PLUGIN_FILE)]) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // A plugin harv only reports on is not a plugin harv refuses to serve.
      continue;
    }
    const servers = isTable(parsed) ? parsed.mcpServers : undefined;
    if (isTable(servers)) for (const key of Object.keys(servers)) names.add(key);
  }
  return [...names].sort();
}

function readCatalogue(checkout: string): Record<string, unknown> {
  const path = join(checkout, MARKETPLACE_FILE);
  if (!existsSync(path)) {
    throw new MarketplaceError(
      `this repository is not a plugin marketplace: it has no ${MARKETPLACE_FILE}. ` +
        `A marketplace is a repository whose ${MARKETPLACE_FILE} lists the plugins it publishes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new MarketplaceError(`${MARKETPLACE_FILE} in this marketplace is not valid JSON: ${(err as Error).message}`);
  }
  if (!isTable(parsed)) throw new MarketplaceError(`${MARKETPLACE_FILE} in this marketplace is not an object.`);
  return parsed;
}

const declaredName = (catalogue: Record<string, unknown>): string =>
  typeof catalogue.name === "string" && catalogue.name.length > 0 ? catalogue.name : "(unnamed marketplace)";

/**
 * A catalogue's `source` as a path inside the marketplace.
 *
 * The catalogue is fetched content, so its paths are checked before one of them
 * is joined onto a directory harv created: `..` or an absolute path would stage
 * a tree from outside the checkout. `./` — which most marketplaces use to say
 * "the repository is the plugin" — normalizes to the checkout itself.
 */
function withinRepository(source: string, name: string): string {
  const normalized = normalize(source.split(posix.sep).join(sep));
  const relative = normalized === "." || normalized === `.${sep}` ? "" : normalized.replace(/[\\/]+$/, "");

  if (isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`)) {
    throw new MarketplaceError(
      `plugin \`${name}\` is listed at \`${source}\`, which points outside the marketplace repository. ` +
        `harv will not stage a tree from outside the commit it fetched.`,
    );
  }
  return relative;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

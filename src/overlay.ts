/**
 * The Overlay (ADR 0002): the personal, uncommitted Components a user layers on
 * top of a project's Harvenv.
 *
 * ADR 0002 suppresses the machine's user scope inside a harvenv session, which
 * is what makes "same config → same quality" true — and would make personal
 * staples vanish everywhere if nothing replaced them. The Overlay is that
 * replacement, and it is deliberately *declared* rather than ambient: a global
 * staples file for what you want everywhere, plus an optional per-project extras
 * file for what you want here. The extras file wins inside the Overlay and may
 * disable a staple, so "not in this repo" is one line rather than a fork of the
 * global file.
 *
 * ## Adds, never overrides
 *
 * ADR 0005 makes Manifest settings binding, and the Overlay is the layer that
 * rule is about: it may set keys the Manifest left unset and may add Components
 * the Manifest does not declare, but a value for something the Manifest already
 * bound is rejected — the Manifest's stands, and the conflict is named.
 *
 * That rejection has to happen *here*, in harv's own merge, because the flag
 * stack cannot express it. `--settings` outranks both settings files, but the
 * merge Claude Code performs is per key: two injected layers would silently
 * resolve a conflict by precedence rather than reporting it (spike 0001,
 * finding 2). So Sync merges the Manifest and the Overlay into one payload
 * itself, and conflicts are warnings rather than silence.
 *
 * The conflict granularity is a leaf, matching the merge it replaces: a Manifest
 * that binds `permissions.deny` has not bound `permissions.allow`, so an Overlay
 * may still add one. What it may not do is set `permissions.deny` to something
 * else.
 *
 * ## Warnings, not errors
 *
 * A conflict is reported and dropped rather than fatal. The Overlay is personal
 * and uncommitted, so a hard failure would let one person's staples file stop
 * them working in a project whose Manifest they may not control — and the
 * outcome that matters, that the session runs what the Manifest says, is already
 * guaranteed by dropping the value. What must not happen is silence, and does
 * not: every rejection names the key or the Component and the file it came from.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LockfileKind } from "./lockfile.ts";
import { ManifestError, parseDeclarations } from "./manifest.ts";
import type { Declarations, Manifest, SkillEntry } from "./manifest.ts";
import { McpError, validateMcpServers } from "./mcp.ts";
import type { McpServerEntry } from "./mcp.ts";
import { SettingsError, validateSettings } from "./settings.ts";
import { harvHome } from "./store.ts";
import type { Env } from "./store.ts";

/** The per-project extras file. Gitignored: it describes one person's checkout. */
export const OVERLAY_FILENAME = "harvenv.local.toml";

/** The global staples file, beside the Store in harv's own home. */
export const GLOBAL_OVERLAY_FILENAME = "overlay.toml";

/**
 * Where the Overlay's own Components are pinned, relative to the project root.
 *
 * Not in `harvenv.lock`: that file is committed, and one person's staples are
 * not part of what a repository hands over. But pinned somewhere, because the
 * Launcher never fetches (ADR 0009) and would otherwise have to resolve a
 * staple's ref itself to know which bytes to serve (ADR 0013).
 */
export const OVERLAY_LOCKFILE: LockfileKind = {
  filename: join(".harv", "overlay.lock"),
  header:
    `# .harv/overlay.lock — written by \`harv sync\`. Do not commit it: it pins\n` +
    `# your own Overlay, which is personal and never handed over (ADR 0013).\n` +
    `# Gitignore \`.harv/\`. Change your staples or ${OVERLAY_FILENAME} and re-run\n` +
    `# \`harv sync\` rather than editing this file.\n\n`,
};

export class OverlayError extends Error {
  override name = "OverlayError";
}

/** A Component that came from the Overlay, and which of its files declared it. */
export type OverlaySkill = SkillEntry & { origin: string };
export type OverlayMcpServer = McpServerEntry & { origin: string };

export interface OverlayLayer {
  path: string;
  /** `staples` applies everywhere; `extras` applies to one project and wins. */
  scope: "staples" | "extras";
}

export interface Overlay {
  /** The files that contributed, in precedence order: staples first. */
  layers: OverlayLayer[];
  skills: OverlaySkill[];
  settings: Record<string, unknown>;
  mcpServers: OverlayMcpServer[];
  /** Which file set each settings leaf, keyed by its dotted path. */
  settingsOrigin: Map<string, string>;
  /** Ready to print; one line each, naming what it is about. */
  warnings: string[];
}

/** What a session runs with once the Overlay is off: the Manifest, unchanged. */
export const NO_OVERLAY: Overlay = {
  layers: [],
  skills: [],
  settings: {},
  mcpServers: [],
  settingsOrigin: new Map(),
  warnings: [],
};

/** The Manifest and the Overlay as one thing: what a session actually loads. */
export interface Session {
  manifest: Manifest;
  /** Overlay skills the Manifest did not already claim. Locked separately. */
  overlaySkills: OverlaySkill[];
  settings: Record<string, unknown>;
  mcpServers: McpServerEntry[];
  /** One line each: an Overlay entry the Manifest locked, or a stray disable. */
  warnings: string[];
}

/** Every Component the session loads, the Manifest's first. */
export const sessionSkills = (session: Session): SkillEntry[] => [
  ...session.manifest.skills,
  ...session.overlaySkills,
];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export const globalOverlayPath = (env: Env = process.env): string =>
  join(harvHome(env), GLOBAL_OVERLAY_FILENAME);

export const projectOverlayPath = (root: string): string => join(root, OVERLAY_FILENAME);

/**
 * The user's Overlay for one project: staples, then this project's extras.
 *
 * Both files are validated here, by the same rules a Manifest is judged by minus
 * ADR 0005's personal split — a settings value Claude Code would silently
 * discard is no more acceptable in an Overlay than in a Manifest, but the
 * personal-ergonomics keys a Manifest is refused are exactly what this file is
 * for.
 */
export function loadOverlay(root: string, env: Env = process.env): Overlay {
  const staples = read(globalOverlayPath(env), "staples");
  const extras = read(projectOverlayPath(root), "extras");

  const layers = [staples, extras].filter((layer) => layer !== null);
  if (layers.length === 0) return NO_OVERLAY;

  const warnings: string[] = [];
  const skills = combine(
    layers.map((layer) => ({ path: layer.path, entries: layer.declarations.skills })),
    extras?.declarations.disabled.skills ?? [],
    "skill",
    warnings,
  );
  const mcpServers = combine(
    layers.map((layer) => ({ path: layer.path, entries: layer.declarations.mcpServers })),
    extras?.declarations.disabled.mcpServers ?? [],
    "MCP server",
    warnings,
  );

  // Highest precedence first, so each earlier layer only fills in what a later
  // one left unset: inside the Overlay, the extras file wins.
  let settings: Record<string, unknown> = {};
  for (const layer of [...layers].reverse()) {
    settings = mergeSettings(settings, layer.declarations.settings).merged;
  }

  const settingsOrigin = new Map<string, string>();
  for (const layer of layers) {
    for (const path of leafPaths(layer.declarations.settings)) settingsOrigin.set(path, layer.path);
  }

  for (const layer of layers) {
    guard(layer.path, () => {
      validateSettings(layer.declarations.settings, { allowPersonalKeys: true });
    });
  }
  for (const server of mcpServers) {
    guard(server.origin, () => validateMcpServers([server], env));
  }

  return {
    layers: layers.map((layer) => ({ path: layer.path, scope: layer.scope })),
    skills,
    settings,
    mcpServers,
    settingsOrigin,
    warnings,
  };
}

interface Layer extends OverlayLayer {
  declarations: Declarations;
}

function read(path: string, scope: OverlayLayer["scope"]): Layer | null {
  if (!existsSync(path)) return null;
  const declarations = guard(path, () =>
    parseDeclarations(path, {
      root: dirname(path),
      disable:
        scope === "extras"
          ? null
          : `disabling a staple is something one project does, so it belongs in that project's ${OVERLAY_FILENAME}`,
      // A plugin pin resolves through a marketplace catalogue and a Lockfile
      // table the Overlay does not have yet. Refused by name rather than parsed
      // and then quietly not loaded.
      plugins:
        "cannot be declared in an Overlay yet — pin it in the project's Manifest, where a plugin's " +
        "marketplace coordinate is resolved and locked",
    }),
  );
  return { path, scope, declarations };
}

/**
 * Every error out of an Overlay file names the file. A parse error already
 * does — the reader is given the path — but the settings and MCP rules are
 * written for a table, not for a file, so the path is added on the way past.
 */
function guard<T>(path: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof ManifestError) throw new OverlayError(err.message);
    if (err instanceof SettingsError || err instanceof McpError) {
      throw new OverlayError(`${path}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * The layers' Components as one set: later layers win by name, and the extras
 * file's disable list removes what it names.
 *
 * A disable that matches nothing is reported. It is a line written with intent —
 * the name is almost always a staple that has been renamed or dropped — and
 * quietly doing nothing is how it would stay wrong.
 */
function combine<T extends { name: string }>(
  layers: Array<{ path: string; entries: T[] }>,
  disabled: string[],
  kind: string,
  warnings: string[],
): Array<T & { origin: string }> {
  const byName = new Map<string, T & { origin: string }>();
  for (const layer of layers) {
    for (const entry of layer.entries) byName.set(entry.name, { ...entry, origin: layer.path });
  }
  for (const name of disabled) {
    if (!byName.delete(name)) {
      warnings.push(
        `the Overlay disables the ${kind} \`${name}\`, which no staple declares — the entry does nothing. ` +
          `Check the name, or delete it.`,
      );
    }
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Manifest ∪ Overlay
// ---------------------------------------------------------------------------

export function composeSession(manifest: Manifest, overlay: Overlay): Session {
  const warnings = [...overlay.warnings];

  const declared = new Set(manifest.skills.map((skill) => skill.name));
  const overlaySkills = overlay.skills.filter((skill) => {
    if (!declared.has(skill.name)) return true;
    warnings.push(locked(`the skill \`${skill.name}\``, manifest, skill.origin));
    return false;
  });

  const servers = new Set(manifest.mcpServers.map((server) => server.name));
  const overlayServers = overlay.mcpServers.filter((server) => {
    if (!servers.has(server.name)) return true;
    warnings.push(locked(`the MCP server \`${server.name}\``, manifest, server.origin));
    return false;
  });

  const settings = mergeSettings(manifest.settings, overlay.settings);
  for (const key of settings.conflicts) {
    warnings.push(locked(`\`${key}\``, manifest, overlay.settingsOrigin.get(key) ?? overlayFiles(overlay)));
  }

  return {
    manifest,
    overlaySkills,
    settings: settings.merged,
    mcpServers: [...manifest.mcpServers, ...overlayServers],
    warnings,
  };
}

const locked = (what: string, manifest: Manifest, origin: string): string =>
  `${origin} sets ${what}, which ${manifest.path} already declares. An Overlay adds, it never overrides ` +
  `(ADR 0005), so the Manifest's stands and the Overlay's is ignored.`;

const overlayFiles = (overlay: Overlay): string => overlay.layers.map((layer) => layer.path).join(" and ");

/**
 * `addition` merged under `base`, per key and recursing into nested tables —
 * the same shape as the merge Claude Code performs across settings layers
 * (spike 0001, finding 2), so that replacing it here changes who wins and not
 * what the result looks like.
 *
 * Conflicts are the leaves both sides set, reported by dotted path. An array is
 * a leaf: unioning two `permissions.deny` lists would be a third semantics that
 * neither Claude Code nor ADR 0005 defines.
 */
function mergeSettings(
  base: Record<string, unknown>,
  addition: Record<string, unknown>,
  prefix = "",
): { merged: Record<string, unknown>; conflicts: string[] } {
  const merged: Record<string, unknown> = { ...base };
  const conflicts: string[] = [];

  for (const [key, value] of Object.entries(addition)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const held = base[key];
    if (!(key in base)) {
      merged[key] = value;
    } else if (isTable(held) && isTable(value)) {
      const nested = mergeSettings(held, value, path);
      merged[key] = nested.merged;
      conflicts.push(...nested.conflicts);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

/** Every leaf of a settings table, as the dotted paths a conflict is named by. */
function leafPaths(table: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(table).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return isTable(value) ? leafPaths(value, path) : [path];
  });
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

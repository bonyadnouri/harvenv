/**
 * The Toolchain (ADR 0006): the system tools a Harvenv's Components depend on,
 * installed by Sync into the Store, pinned in the Lockfile, and visible only on
 * the PATH of Launcher-started sessions.
 *
 * A requirement reaches harv two ways, and the difference between them is the
 * point. A Component says what it *needs* — `requires: node@22` in its
 * SKILL.md, travelling with the skill so a project that adds it does not also
 * have to learn what it runs on. The Manifest says what the project *pins* —
 * `[tools] node = "22.18"`, which wins whenever the two disagree, because
 * Manifest declarations are binding (ADR 0005) and a project that has decided
 * on a version should not have a dependency quietly move it.
 *
 * Resolution mirrors Sync's, for the same reason:
 *
 *   1. Does the Lockfile already pin an exact version for this spec? If not,
 *      the spec is resolved against the engine — the only step that asks what
 *      "22" means today.
 *   2. Does the Store already hold that exact version? If so the Toolchain is
 *      finished with it, having run no installer at all. This is what makes the
 *      second project on a machine free, and it is why the Lockfile pins the
 *      resolved version rather than the spec.
 *   3. Otherwise install it, and read back where its binaries landed.
 *
 * A requirement the engine has no installer for — or any requirement at all on
 * a machine with no engine — is not an error. It becomes a recorded hint,
 * carried in the Lockfile for Doctor to surface, and Sync goes on. That is the
 * honest degradation path ADR 0006 chose over a second install regime; the
 * alternative is a Sync that fails on a machine harv cannot fully serve.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isToolName, isToolSpec, TOOL_NAME_RULE, TOOL_SPEC_RULE } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { frontmatter, unquote } from "./materialize.ts";
import { binPaths, findMise, hasBins, install, isKnown, resolveVersion } from "./mise.ts";
import type { Engine } from "./mise.ts";
import type { Env } from "./store.ts";

export class ToolchainError extends Error {
  override name = "ToolchainError";
}

/** One tool the Harvenv needs, and who asked for it. */
export interface Requirement {
  tool: string;
  spec: string;
  /** `the Manifest` or `skill \`x\``. Every message about a tool names it. */
  from: string;
}

/**
 * A resolved requirement. Either it is pinned — an exact version in the Store,
 * with the bin directories a session's PATH gets — or it is unscopeable, and
 * carries the hint that says so.
 */
export interface ResolvedTool {
  tool: string;
  spec: string;
  /** The exact version the Store holds. Absent when the tool is unscopeable. */
  version?: string;
  /** Bin directories, relative to the tools Store root. Absent when unscopeable. */
  bins?: string[];
  /** Why this tool could not be scoped, phrased for the person who has to act. */
  hint?: string;
}

export interface ToolchainResult {
  tools: ResolvedTool[];
  /** Tools installed on this run. */
  installed: string[];
  /** Tools the Store already held, at the version the Lockfile pins. */
  reused: string[];
  /** Tools that degraded to a hint. Named, so nothing degrades silently. */
  unscopeable: string[];
  /** One line each, ready to print. */
  warnings: string[];
}

/** Injectable so tests can drive the whole Toolchain without an engine on disk. */
export interface ToolchainDeps {
  env: Env;
  findMise: (env: Env) => Engine;
  resolveVersion: (mise: string, tool: string, spec: string, env: Env) => string | null;
  isKnown: (mise: string, tool: string, env: Env) => boolean;
  install: (mise: string, tool: string, version: string, env: Env) => void;
  binPaths: (mise: string, tool: string, version: string, env: Env) => string[];
  hasBins: (bins: string[], env: Env) => boolean;
}

// ---------------------------------------------------------------------------
// Gathering what the Harvenv needs
// ---------------------------------------------------------------------------

/**
 * Every tool this Harvenv needs: what its Components require, overridden by
 * what the Manifest pins.
 *
 * `skills` are the resolved Component directories — Store entries or local
 * paths — because a `requires` line travels inside the skill, not in the
 * Manifest that names it.
 */
export function requirements(manifest: Manifest, skills: Array<{ name: string; path: string }>): Requirement[] {
  // The Manifest goes in first, so a tool it pins is already decided by the
  // time the Components are read (ADR 0005). That ordering is what makes the
  // pin a *settlement*: two skills disagreeing about `node` is a question the
  // Manifest can answer, and it should not have to answer it twice.
  const byTool = new Map<string, Requirement>(
    manifest.tools.map((entry) => [entry.tool, { tool: entry.tool, spec: entry.spec, from: "the Manifest" }]),
  );
  const pinned = new Set(byTool.keys());

  for (const skill of skills) {
    for (const required of readRequires(skill.path, skill.name)) {
      if (pinned.has(required.tool)) continue;

      const already = byTool.get(required.tool);
      if (already === undefined) {
        byTool.set(required.tool, required);
        continue;
      }
      if (already.spec !== required.spec) {
        // Two Components asking for different versions is a decision, not a
        // resolution problem: intersecting version ranges is a solver, and the
        // Manifest already has the last word on what this project runs.
        throw new ToolchainError(
          `${already.from} needs ${already.tool}@${already.spec} and ${required.from} needs ` +
            `${required.tool}@${required.spec}. Pin the version this project uses in the Manifest — ` +
            `[tools] ${required.tool} = "${required.spec}" — and it will settle it for both.`,
        );
      }
    }
  }

  return [...byTool.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * A Component's `requires:` declaration, from its SKILL.md frontmatter. Three
 * shapes, because all three are what people write:
 *
 *     requires: node@22, ripgrep
 *     requires: [node@22, ripgrep]
 *     requires:
 *       - node@22
 *       - ripgrep
 *
 * A tool with no `@spec` means "any version" and resolves to `latest`, so a
 * skill that just needs `ripgrep` does not have to invent a version to pin.
 */
export function readRequires(skillDir: string, name: string): Requirement[] {
  let source: string;
  try {
    source = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  } catch {
    // Materialization is what insists a skill has a SKILL.md; a Toolchain that
    // also insisted would report the same problem twice, in the wrong words.
    return [];
  }

  const block = frontmatter(source);
  if (block === undefined) return [];

  const from = `skill \`${name}\``;
  return listRequires(block)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => parseRequirement(item, from));
}

/** The raw items of a frontmatter block's `requires:`, in any of its shapes. */
function listRequires(block: string): string[] {
  const lines = block.split("\n");
  const start = lines.findIndex((line) => /^requires:/.test(line));
  if (start === -1) return [];

  const inline = lines[start]!.slice("requires:".length).trim();
  if (inline !== "") {
    // One YAML scalar or flow sequence on the key's own line.
    return unquote(inline).replace(/^\[(.*)\]$/, "$1").split(",").map(unquote);
  }

  // A block sequence beneath the key. The first line that is neither an item
  // nor blank is the next key, and ends the list.
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(line)?.[1];
    if (item !== undefined) items.push(unquote(item));
    else if (line.trim() !== "") break;
  }
  return items;
}

/** `node@22`, or `node` for whatever the engine calls latest. */
function parseRequirement(item: string, from: string): Requirement {
  const at = item.lastIndexOf("@");
  // A leading `@` is part of a scoped npm name (`npm:@scope/pkg`), not a spec.
  const tool = at > 0 ? item.slice(0, at) : item;
  const spec = at > 0 ? item.slice(at + 1) : "latest";

  if (!isToolName(tool)) {
    throw new ToolchainError(`${from} requires \`${item}\`, which is not a usable tool name: ${TOOL_NAME_RULE}.`);
  }
  if (!isToolSpec(spec)) {
    throw new ToolchainError(`${from} requires \`${item}\`, whose version harv will not pass on: ${TOOL_SPEC_RULE}.`);
  }
  return { tool, spec, from };
}

// ---------------------------------------------------------------------------
// Resolving them into the Store
// ---------------------------------------------------------------------------

/**
 * Install every requirement, reusing what the Store and the Lockfile already
 * settled. `locked` is what a previous Sync pinned, keyed by tool.
 */
export function resolveToolchain(
  required: Requirement[],
  locked: Map<string, ResolvedTool>,
  deps: Partial<ToolchainDeps> = {},
): ToolchainResult {
  const d = withDefaults(deps);
  const result: ToolchainResult = { tools: [], installed: [], reused: [], unscopeable: [], warnings: [] };

  // The Store first, and the engine only if the Store came up short. A project
  // whose tools are already locked and already installed is finished here — no
  // resolution, no install, and no engine to look for. That is what makes the
  // second project on a machine free, and it is also why a machine that has
  // lost its installer can still Sync a Harvenv it has already built once.
  const outstanding: Requirement[] = [];
  for (const requirement of required) {
    const pin = pinFor(requirement, locked.get(requirement.tool));
    if (pin?.version !== undefined && pin.bins !== undefined && d.hasBins(pin.bins, d.env)) {
      result.reused.push(`${requirement.tool}@${pin.version}`);
      result.tools.push({ tool: requirement.tool, spec: requirement.spec, version: pin.version, bins: pin.bins });
    } else {
      outstanding.push(requirement);
    }
  }
  if (outstanding.length === 0) return result;

  const engine = d.findMise(d.env);
  if (engine.bin === undefined) {
    // No engine on this machine: what is left degrades at once, and says so
    // once rather than once per tool.
    for (const requirement of outstanding) {
      result.tools.push({ tool: requirement.tool, spec: requirement.spec, hint: noEngineHint(requirement) });
      result.unscopeable.push(requirement.tool);
    }
    result.warnings.push(
      `harv has no install engine, so ${plural(outstanding.length, "tool")} stayed unscoped: ` +
        `${outstanding.map((r) => r.tool).join(", ")}. Sessions will use whatever is already on your PATH.\n` +
        `  ${engine.unavailable.split("\n").join("\n  ")}`,
    );
    return result;
  }

  for (const requirement of outstanding) {
    // The Lockfile's version if it still pins this spec — so a teammate
    // installs what was locked, not what the spec resolves to today.
    const pinned = pinFor(requirement, locked.get(requirement.tool))?.version;
    const version = pinned ?? d.resolveVersion(engine.bin, requirement.tool, requirement.spec, d.env);
    if (version === null) {
      const hint = unscopeableHint(requirement, d.isKnown(engine.bin, requirement.tool, d.env));
      result.tools.push({ tool: requirement.tool, spec: requirement.spec, hint });
      result.unscopeable.push(requirement.tool);
      result.warnings.push(hint);
      continue;
    }

    d.install(engine.bin, requirement.tool, version, d.env);
    result.installed.push(`${requirement.tool}@${version}`);
    result.tools.push({
      tool: requirement.tool,
      spec: requirement.spec,
      version,
      bins: d.binPaths(engine.bin, requirement.tool, version, d.env),
    });
  }

  return result;
}

/**
 * The version a Lockfile entry pins for this requirement — but only if it still
 * pins the same spec. A Manifest that moved from `22` to `24` has nothing to
 * reuse, and reusing it anyway would silently ignore the edit.
 */
function pinFor(requirement: Requirement, entry: ResolvedTool | undefined): ResolvedTool | undefined {
  if (entry === undefined || entry.spec !== requirement.spec) return undefined;
  return entry;
}

const unscopeableHint = (requirement: Requirement, known: boolean): string =>
  known
    ? `${requirement.from} needs ${requirement.tool}@${requirement.spec}, and harv's install engine knows ` +
      `${requirement.tool} but has no version matching \`${requirement.spec}\`. Sessions will use whatever ` +
      `${requirement.tool} is already on your PATH. Check the version spec, or install it yourself.`
    : `${requirement.from} needs ${requirement.tool}@${requirement.spec}, which harv has no scoped installer for. ` +
      `Sessions will use whatever ${requirement.tool} is already on your PATH — install it the way your ` +
      `machine normally would.`;

const noEngineHint = (requirement: Requirement): string =>
  `${requirement.from} needs ${requirement.tool}@${requirement.spec}, and this machine has no install engine ` +
  `for harv to scope it with. Sessions will use whatever ${requirement.tool} is already on your PATH.`;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const withDefaults = (deps: Partial<ToolchainDeps>): ToolchainDeps => ({
  env: deps.env ?? process.env,
  findMise: deps.findMise ?? findMise,
  resolveVersion: deps.resolveVersion ?? resolveVersion,
  isKnown: deps.isKnown ?? isKnown,
  install: deps.install ?? install,
  binPaths: deps.binPaths ?? binPaths,
  hasBins: deps.hasBins ?? hasBins,
});

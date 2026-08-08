#!/usr/bin/env bun
/**
 * Launch-recipe verification spike.
 *
 * ADR 0003 builds the Launcher out of native Claude Code flags. Three of the
 * behaviours it leans on are observed, not documented — so they can regress
 * silently on any Claude Code release. This script re-measures all three
 * headlessly and exits non-zero when one no longer holds. It is the seed of
 * Doctor's version smoke test.
 *
 *   1. `--setting-sources project,local` suppresses user scope: skills,
 *      plugins, agents, settings and SessionStart hooks.
 *   2. Where `--settings` sits in precedence against project and local
 *      settings files, and whether it merges or replaces.
 *   3. Whether skills served through `--plugin-dir` keep bare invocation names
 *      or acquire a `<plugin>:<skill>` namespace prefix — this decides whether
 *      the Launcher serves Components from the Store as plugin directories or
 *      materializes them into project scope.
 *
 * Every measurement comes from the `system/init` event Claude Code emits on
 * stdout in `--output-format stream-json` mode: it carries the fully resolved
 * skill, command, agent, plugin and MCP inventory plus the resolved settings.
 * The probe kills the session the moment that event arrives, so no model turn
 * is ever completed.
 *
 * Run:  bun scripts/verify-launch-recipe.ts [--json] [--keep]
 *       node scripts/verify-launch-recipe.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

interface InitEvent {
  claude_code_version: string;
  model: string;
  permissionMode: string;
  output_style: string;
  skills: string[];
  slash_commands: string[];
  agents: string[];
  plugins: Array<{ name: string; path: string; source?: string; version?: string }>;
  mcp_servers: Array<{ name: string; status: string }>;
  tools: string[];
}

interface Probe {
  init: InitEvent;
  /** Names of SessionStart hooks that fired before the session initialized. */
  sessionStartHooks: string[];
}

const PROBE_TIMEOUT_MS = 120_000;

/** Start a headless session, capture its `init` event, kill it immediately. */
function probe(cwd: string, args: string[]): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", "probe", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...args],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );

    const hooks: string[] = [];
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`))),
      PROBE_TIMEOUT_MS,
    );

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "system") return;
      if (event.subtype === "hook_started" && event.hook_event === "SessionStart") {
        hooks.push(String(event.hook_name ?? "unnamed"));
      }
      if (event.subtype === "init") {
        finish(() => resolve({ init: event as unknown as InitEvent, sessionStartHooks: hooks }));
      }
    });

    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) =>
      finish(() => reject(new Error(`claude exited (code ${code}) before emitting init.\n${stderr.trim().slice(-800)}`))),
    );
  });
}

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

/** `null` means "could not be observed on this machine" — reported, never fatal. */
type Outcome = boolean | null;

interface Expectation {
  label: string;
  ok: Outcome;
  detail: string;
}

interface Check {
  id: string;
  title: string;
  expectations: Expectation[];
  measurements: Record<string, unknown>;
  error?: string;
}

const expect = (label: string, ok: Outcome, detail: string): Expectation => ({ label, ok, detail });
const isNamespaced = (name: string) => name.includes(":");
const only = <T,>(a: T[], b: T[]) => a.filter((x) => !b.includes(x));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The recipe's MCP half: an empty server set that nothing may leak past. */
const NO_MCP = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

const MARKER_PREFIX = "harvenv-spike";

const skillFile = (name: string) =>
  `---\nname: ${name}\ndescription: Marker component for the harvenv launch-recipe spike. Never invoke it.\n---\n\nMarker only.\n`;

const agentFile = (name: string) =>
  `---\nname: ${name}\ndescription: Marker agent for the harvenv launch-recipe spike. Never dispatch it.\n---\n\nMarker only.\n`;

const commandFile = () =>
  `---\ndescription: Marker command for the harvenv launch-recipe spike. Never run it.\n---\n\nMarker only.\n`;

interface Fixtures {
  root: string;
  /** No project configuration at all — isolates user scope as the only variable. */
  clean: string;
  precedence: { workspace: string; injectBoth: string; injectModelOnly: string; injectSiblingKey: string };
  serving: { pluginWorkspace: string; pluginDir: string; materializedWorkspace: string; symlinkedWorkspace: string };
}

function buildFixtures(): Fixtures {
  const root = mkdtempSync(join(tmpdir(), "harvenv-launch-recipe-"));
  const dir = (...parts: string[]) => {
    const p = join(root, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const file = (path: string, contents: string) => {
    writeFileSync(path, contents);
    return path;
  };

  const clean = dir("clean");

  // Check 2 — three settings layers carrying two independently observable keys.
  const precWorkspace = dir("precedence");
  const precClaude = dir("precedence", ".claude");
  file(
    join(precClaude, "settings.json"),
    JSON.stringify({ model: "haiku", permissions: { defaultMode: "acceptEdits" } }, null, 2),
  );
  file(
    join(precClaude, "settings.local.json"),
    JSON.stringify({ model: "sonnet", permissions: { defaultMode: "plan" } }, null, 2),
  );
  const injectBoth = file(
    join(precWorkspace, "injected-both.json"),
    JSON.stringify({ model: "opus", permissions: { defaultMode: "auto" } }, null, 2),
  );
  const injectModelOnly = file(
    join(precWorkspace, "injected-model-only.json"),
    JSON.stringify({ model: "opus" }, null, 2),
  );
  // Sets a sibling of `permissions.defaultMode` but not the key itself: reveals
  // whether the merge is per top-level key or recurses into nested objects.
  const injectSiblingKey = file(
    join(precWorkspace, "injected-sibling-key.json"),
    JSON.stringify({ permissions: { allow: ["Bash(echo *)"] } }, null, 2),
  );

  // Check 3 — the same marker Components, served two ways.
  const pluginWorkspace = dir("serving-plugin-dir");
  const pluginDir = dir("store", MARKER_PREFIX);
  file(
    join(dir("store", MARKER_PREFIX, ".claude-plugin"), "plugin.json"),
    JSON.stringify({ name: MARKER_PREFIX, version: "0.0.0", description: "harvenv launch-recipe spike marker" }, null, 2),
  );
  file(join(dir("store", MARKER_PREFIX, "skills", `${MARKER_PREFIX}-skill`), "SKILL.md"), skillFile(`${MARKER_PREFIX}-skill`));
  file(join(dir("store", MARKER_PREFIX, "agents"), `${MARKER_PREFIX}-agent.md`), agentFile(`${MARKER_PREFIX}-agent`));
  file(join(dir("store", MARKER_PREFIX, "commands"), `${MARKER_PREFIX}-command.md`), commandFile());

  const materializedWorkspace = dir("serving-materialized");
  file(
    join(dir("serving-materialized", ".claude", "skills", `${MARKER_PREFIX}-skill`), "SKILL.md"),
    skillFile(`${MARKER_PREFIX}-skill`),
  );
  file(join(dir("serving-materialized", ".claude", "agents"), `${MARKER_PREFIX}-agent.md`), agentFile(`${MARKER_PREFIX}-agent`));
  file(join(dir("serving-materialized", ".claude", "commands"), `${MARKER_PREFIX}-command.md`), commandFile());

  // The same Components again, but linked back to the one Store copy instead of
  // copied — the shape Sync would actually write if it materializes.
  const symlinkedWorkspace = dir("serving-symlinked");
  dir("serving-symlinked", ".claude", "skills");
  dir("serving-symlinked", ".claude", "agents");
  dir("serving-symlinked", ".claude", "commands");
  symlinkSync(
    join(pluginDir, "skills", `${MARKER_PREFIX}-skill`),
    join(symlinkedWorkspace, ".claude", "skills", `${MARKER_PREFIX}-skill`),
    "dir",
  );
  symlinkSync(
    join(pluginDir, "agents", `${MARKER_PREFIX}-agent.md`),
    join(symlinkedWorkspace, ".claude", "agents", `${MARKER_PREFIX}-agent.md`),
    "file",
  );
  symlinkSync(
    join(pluginDir, "commands", `${MARKER_PREFIX}-command.md`),
    join(symlinkedWorkspace, ".claude", "commands", `${MARKER_PREFIX}-command.md`),
    "file",
  );

  return {
    root,
    clean,
    precedence: { workspace: precWorkspace, injectBoth, injectModelOnly, injectSiblingKey },
    serving: { pluginWorkspace, pluginDir, materializedWorkspace, symlinkedWorkspace },
  };
}

/** Read-only look at what the machine's user scope actually contributes. */
function userScopeSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Check 1 — user-scope suppression breadth
// ---------------------------------------------------------------------------

async function checkSuppression(fx: Fixtures): Promise<Check> {
  const withUser = await probe(fx.clean, []);
  const suppressed = await probe(fx.clean, ["--setting-sources", "project,local"]);
  const suppressedNoMcp = await probe(fx.clean, ["--setting-sources", "project,local", ...NO_MCP]);

  const a = withUser.init;
  const b = suppressed.init;
  const userSettings = userScopeSettings();

  // A vacuous pass is worse than a failure: if this machine's user scope is
  // empty there is nothing to suppress, and the marker expectations below say
  // so instead of quietly going green.
  const userScopeIsPopulated = a.plugins.length > 0 || a.skills.length > b.skills.length;

  const droppedSkills = only(a.skills, b.skills);
  const addedSkills = only(b.skills, a.skills);
  const namespaced = [
    ...b.skills.filter(isNamespaced),
    ...b.slash_commands.filter(isNamespaced),
    ...b.agents.filter(isNamespaced),
  ];

  // Settings keys the user scope sets that surface in the init event.
  const settingMarkers: Array<[string, unknown, unknown]> = [];
  if (typeof userSettings.model === "string") settingMarkers.push(["model", a.model, b.model]);
  const userMode = (userSettings.permissions as { defaultMode?: string } | undefined)?.defaultMode;
  if (typeof userMode === "string") settingMarkers.push(["permissions.defaultMode", a.permissionMode, b.permissionMode]);
  if (typeof userSettings.outputStyle === "string") settingMarkers.push(["outputStyle", a.output_style, b.output_style]);
  const settingsDiffer = settingMarkers.every(([, def, sup]) => def !== sup);

  return {
    id: "suppression",
    title: "`--setting-sources project,local` suppresses user scope",
    measurements: {
      claudeCodeVersion: a.claude_code_version,
      default: {
        skills: a.skills.length,
        slashCommands: a.slash_commands.length,
        agents: a.agents.length,
        plugins: a.plugins.length,
        mcpServers: a.mcp_servers.length,
        tools: a.tools.length,
        sessionStartHooks: withUser.sessionStartHooks.length,
        model: a.model,
        permissionMode: a.permissionMode,
      },
      settingSourcesProjectLocal: {
        skills: b.skills.length,
        slashCommands: b.slash_commands.length,
        agents: b.agents.length,
        plugins: b.plugins.length,
        mcpServers: b.mcp_servers.length,
        tools: b.tools.length,
        sessionStartHooks: suppressed.sessionStartHooks.length,
        model: b.model,
        permissionMode: b.permissionMode,
      },
      fullRecipeMcpServers: suppressedNoMcp.init.mcp_servers.length,
      builtinSkills: b.skills,
      userScopeSettingKeysObserved: settingMarkers.map(([k]) => k),
    },
    expectations: [
      expect(
        "user scope contributes something to suppress",
        userScopeIsPopulated,
        `default session: ${a.skills.length} skills, ${a.plugins.length} plugins`,
      ),
      expect("no plugins load", b.plugins.length === 0, `${b.plugins.length} plugin(s) under the flag`),
      expect(
        "no namespaced components survive",
        namespaced.length === 0,
        namespaced.length ? `leaked: ${namespaced.slice(0, 5).join(", ")}` : "no `<plugin>:<name>` entries",
      ),
      expect(
        "the flag only removes, never adds",
        addedSkills.length === 0,
        addedSkills.length ? `unexpectedly added: ${addedSkills.join(", ")}` : `removed ${droppedSkills.length} skill(s)`,
      ),
      expect(
        "skills fall to the built-in set",
        userScopeIsPopulated ? b.skills.length < a.skills.length : null,
        `${a.skills.length} -> ${b.skills.length} skills, ${a.slash_commands.length} -> ${b.slash_commands.length} commands`,
      ),
      expect(
        "user SessionStart hooks stop firing",
        withUser.sessionStartHooks.length > 0 ? suppressed.sessionStartHooks.length === 0 : null,
        `${withUser.sessionStartHooks.length} hook(s) by default, ${suppressed.sessionStartHooks.length} under the flag`,
      ),
      expect(
        "user settings.json stops applying",
        settingMarkers.length > 0 ? settingsDiffer : null,
        settingMarkers.length
          ? settingMarkers.map(([k, def, sup]) => `${k}: ${String(def)} -> ${String(sup)}`).join("; ")
          : "user settings.json sets none of model/permissions.defaultMode/outputStyle",
      ),
      // MCP servers live in ~/.claude.json, which is not a setting source, so
      // --setting-sources alone does not govern them — hence --strict-mcp-config
      // in the recipe. Only the strict number is asserted: servers register
      // asynchronously, so the flag-alone count races the init event and varies
      // run to run. It is reported, not trusted.
      expect(
        "the full recipe leaves no MCP servers",
        suppressedNoMcp.init.mcp_servers.length === 0,
        `${suppressedNoMcp.init.mcp_servers.length} with --strict-mcp-config (observational: ${b.mcp_servers.length} with --setting-sources alone)`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Check 2 — `--settings` precedence
// ---------------------------------------------------------------------------

async function checkSettingsPrecedence(fx: Fixtures): Promise<Check> {
  const { workspace, injectBoth, injectModelOnly, injectSiblingKey } = fx.precedence;
  const run = (args: string[]) => probe(workspace, ["--setting-sources", ...args, ...NO_MCP]);

  const project = await run(["project"]);
  const projectLocal = await run(["project,local"]);
  const projectInjected = await run(["project", "--settings", injectBoth]);
  const projectLocalInjected = await run(["project,local", "--settings", injectBoth]);
  const inlineJson = await run(["project,local", "--settings", readFileSync(injectBoth, "utf8")]);
  const partial = await run(["project,local", "--settings", injectModelOnly]);
  const sibling = await run(["project,local", "--settings", injectSiblingKey]);

  const at = (p: Probe) => ({ model: p.init.model, mode: p.init.permissionMode });
  const m = {
    project: at(project),
    projectLocal: at(projectLocal),
    projectPlusInjected: at(projectInjected),
    projectLocalPlusInjected: at(projectLocalInjected),
    injectedAsInlineJson: at(inlineJson),
    injectedModelKeyOnly: at(partial),
    injectedSiblingKeyOnly: at(sibling),
  };

  // haiku/acceptEdits = project, sonnet/plan = local, opus/auto = --settings.
  const isProject = (v: { model: string; mode: string }) => v.model.includes("haiku") && v.mode === "acceptEdits";
  const isLocal = (v: { model: string; mode: string }) => v.model.includes("sonnet") && v.mode === "plan";
  const isInjected = (v: { model: string; mode: string }) => v.model.includes("opus") && v.mode === "auto";

  return {
    id: "settings-precedence",
    title: "`--settings` precedence against project and local settings files",
    measurements: {
      ...m,
      order: "--settings > .claude/settings.local.json > .claude/settings.json",
    },
    expectations: [
      expect("project settings apply on their own", isProject(m.project), `model=${m.project.model}, mode=${m.project.mode}`),
      expect("local overrides project", isLocal(m.projectLocal), `model=${m.projectLocal.model}, mode=${m.projectLocal.mode}`),
      expect(
        "--settings overrides project",
        isInjected(m.projectPlusInjected),
        `model=${m.projectPlusInjected.model}, mode=${m.projectPlusInjected.mode}`,
      ),
      expect(
        "--settings overrides local (highest precedence)",
        isInjected(m.projectLocalPlusInjected),
        `model=${m.projectLocalPlusInjected.model}, mode=${m.projectLocalPlusInjected.mode}`,
      ),
      expect(
        "inline JSON behaves like a file path",
        isInjected(m.injectedAsInlineJson),
        `model=${m.injectedAsInlineJson.model}, mode=${m.injectedAsInlineJson.mode}`,
      ),
      expect(
        "--settings merges per key, it does not replace the layer",
        m.injectedModelKeyOnly.model.includes("opus") && m.injectedModelKeyOnly.mode === "plan",
        `model=${m.injectedModelKeyOnly.model} (from --settings), mode=${m.injectedModelKeyOnly.mode} (from local)`,
      ),
      expect(
        "the merge recurses into nested objects",
        m.injectedSiblingKeyOnly.mode === "plan",
        `--settings set only permissions.allow; permissions.defaultMode survived from local as ${m.injectedSiblingKeyOnly.mode}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Check 3 — how `--plugin-dir` names the Components it serves
// ---------------------------------------------------------------------------

async function checkComponentNaming(fx: Fixtures): Promise<Check> {
  const { pluginWorkspace, pluginDir, materializedWorkspace, symlinkedWorkspace } = fx.serving;

  const served = await probe(pluginWorkspace, ["--setting-sources", "project,local", "--plugin-dir", pluginDir, ...NO_MCP]);
  const materialized = await probe(materializedWorkspace, ["--setting-sources", "project,local", ...NO_MCP]);
  const symlinked = await probe(symlinkedWorkspace, ["--setting-sources", "project,local", ...NO_MCP]);

  const bare = `${MARKER_PREFIX}-skill`;
  const prefixed = `${MARKER_PREFIX}:${MARKER_PREFIX}-skill`;

  const markers = (p: Probe) => ({
    skills: p.init.skills.filter((s) => s.includes(MARKER_PREFIX)),
    commands: p.init.slash_commands.filter((s) => s.includes(MARKER_PREFIX)),
    agents: p.init.agents.filter((s) => s.includes(MARKER_PREFIX)),
  });
  const servedMarkers = markers(served);
  const materializedMarkers = markers(materialized);
  const symlinkedMarkers = markers(symlinked);

  const servedIsPrefixed = servedMarkers.skills.includes(prefixed);
  const servedIsBare = servedMarkers.skills.includes(bare);
  const allBare = (m: { skills: string[]; commands: string[]; agents: string[] }) =>
    m.skills.includes(bare) &&
    m.agents.includes(`${MARKER_PREFIX}-agent`) &&
    m.commands.includes(`${MARKER_PREFIX}-command`);

  return {
    id: "component-naming",
    title: "Skills served via `--plugin-dir` keep bare names or gain a plugin prefix",
    measurements: {
      pluginDir: servedMarkers,
      projectMaterialized: materializedMarkers,
      projectSymlinkedToStore: symlinkedMarkers,
      pluginsLoaded: served.init.plugins.map((p) => p.name),
      verdict: servedIsPrefixed ? "namespaced" : servedIsBare ? "bare" : "not loaded",
    },
    expectations: [
      expect(
        "--plugin-dir loads the plugin at all",
        served.init.plugins.some((p) => p.name === MARKER_PREFIX),
        `plugins: ${served.init.plugins.map((p) => p.name).join(", ") || "none"}`,
      ),
      expect(
        "the served skill is namespaced `<plugin>:<skill>`",
        servedIsPrefixed,
        `skills: ${servedMarkers.skills.join(", ") || "none"}`,
      ),
      expect(
        "the served skill is NOT invocable under its bare name",
        !servedIsBare,
        servedIsBare ? "bare name also present" : `bare \`${bare}\` absent`,
      ),
      expect(
        "the whole plugin namespaces: skills, agents and commands alike",
        servedMarkers.agents.every(isNamespaced) && servedMarkers.commands.every(isNamespaced),
        `agents: ${servedMarkers.agents.join(", ") || "none"}; commands: ${servedMarkers.commands.join(", ") || "none"}`,
      ),
      expect(
        "project materialization keeps every Component's bare name",
        allBare(materializedMarkers),
        `skills: ${materializedMarkers.skills.join(", ") || "none"}; agents: ${materializedMarkers.agents.join(", ") || "none"}; commands: ${materializedMarkers.commands.join(", ") || "none"}`,
      ),
      // ADR 0008 materializes by symlinking into the Store rather than copying,
      // so link-following is a load-bearing behaviour, not an optimization.
      expect(
        "materializing as symlinks into the Store works identically",
        allBare(symlinkedMarkers),
        `skills: ${symlinkedMarkers.skills.join(", ") || "none"}; agents: ${symlinkedMarkers.agents.join(", ") || "none"}; commands: ${symlinkedMarkers.commands.join(", ") || "none"}`,
      ),
      expect(
        "the two mechanisms are not interchangeable",
        servedIsPrefixed !== materializedMarkers.skills.includes(prefixed),
        `--plugin-dir: ${servedMarkers.skills.join(", ") || "none"} vs project: ${materializedMarkers.skills.join(", ") || "none"}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";
const RESET = "[0m";

const failed = (c: Check) => Boolean(c.error) || c.expectations.some((e) => e.ok === false);

function report(checks: Check[]): void {
  for (const check of checks) {
    console.log(`\n[${failed(check) ? `${RED}FAIL${RESET}` : `${GREEN}PASS${RESET}`}] ${check.id} — ${check.title}`);
    if (check.error) {
      console.log(`  ${RED}x${RESET} ${check.error}`);
      continue;
    }
    for (const e of check.expectations) {
      const glyph = e.ok === true ? `${GREEN}ok${RESET}` : e.ok === false ? `${RED}x ${RESET}` : `${YELLOW}n/a${RESET}`;
      console.log(`  ${glyph} ${e.label}`);
      console.log(`      ${DIM}${e.detail}${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const asJson = process.argv.includes("--json");
  const keep = process.argv.includes("--keep");
  const log = asJson ? () => {} : console.log;

  const fx = buildFixtures();
  log(`harvenv launch-recipe verification`);
  log(`${DIM}fixtures: ${fx.root}${RESET}`);

  const checks: Check[] = [];
  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["suppression", "`--setting-sources project,local` suppresses user scope", () => checkSuppression(fx)],
    ["settings-precedence", "`--settings` precedence against project and local settings files", () => checkSettingsPrecedence(fx)],
    ["component-naming", "Skills served via `--plugin-dir` keep bare names or gain a plugin prefix", () => checkComponentNaming(fx)],
  ];

  for (const [id, title, run] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ id, title, expectations: [], measurements: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (keep) log(`\n${DIM}fixtures kept at ${fx.root}${RESET}`);
  else rmSync(fx.root, { recursive: true, force: true });

  const version = (checks[0]?.measurements as { claudeCodeVersion?: string })?.claudeCodeVersion ?? "unknown";
  const failures = checks.filter(failed);

  if (asJson) {
    console.log(JSON.stringify({ claudeCodeVersion: version, ok: failures.length === 0, fixtures: keep ? fx.root : null, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\nClaude Code ${version}: ${checks.length - failures.length}/${checks.length} checks passed` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();

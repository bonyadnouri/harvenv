/**
 * The launch-recipe smoke test: ADR 0003's observed behaviours, re-measured
 * against the Claude Code that is actually installed.
 *
 * ADR 0003 builds the Launcher out of native flags rather than a config-dir
 * swap, and closes with the consequence that pays for it: the breadth of what
 * `--setting-sources project,local` suppresses is *observed*, not documented, so
 * any Claude Code release can retire it in silence. The remedy it names is this
 * one — "harvenv must smoke-test it against each Claude Code version (e.g. a
 * `harv doctor` check) and pin known-good versions."
 *
 * Both halves live here. `VERIFIED_CLAUDE_CODE` is the pin: the versions the
 * recipe has actually been measured against. `smokeTest` is the measurement,
 * and it is the one that decides — a version harv has never seen is only a
 * remark if the behaviours still hold, and a version harv has verified is still
 * a failure if they do not.
 *
 * `scripts/verify-launch-recipe.ts` is the same measurement at full width: 13
 * probes across three checks, including the questions that decided ADR 0008.
 * This is deliberately the short form — two probes — because it runs inside a
 * command a person is waiting on. What it keeps is everything the Launcher
 * would be wrong about if it changed:
 *
 *   1. user scope stops loading            — ADR 0002's whole promise
 *   2. `--settings` outranks the settings files it merges with — ADR 0005
 *   3. `--strict-mcp-config` empties the session's servers      — ADR 0003
 *   4. a project-scope skill keeps its bare name                — ADR 0008
 *
 * Every fact comes from the `system`/`init` event Claude Code emits on stdout
 * under `--output-format stream-json --verbose`: it carries the fully resolved
 * skill, command, agent, plugin and MCP inventory plus the resolved model and
 * permission mode. The probe kills the session the moment that event arrives,
 * so no model turn is ever completed and nothing is billed for a thinking turn.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { Env } from "./store.ts";

/**
 * The Claude Code versions the recipe has been measured against — spikes 0001,
 * 0002 and 0003, and `scripts/verify-launch-recipe.ts` on every run since.
 *
 * A list rather than a floor: "verified" is a fact about a measurement that was
 * taken, and a range would claim measurements nobody performed. Newer is not an
 * error — the smoke test is what decides — but it is worth saying out loud,
 * because a version nobody has measured is exactly when the smoke test stops
 * being ceremony.
 */
export const VERIFIED_CLAUDE_CODE: readonly string[] = ["2.1.223"];

/**
 * The fields of `system`/`init` this module reads. Claude Code emits many more;
 * naming only these keeps a schema addition from looking like a change.
 */
export interface InitEvent {
  claude_code_version: string;
  model: string;
  permissionMode: string;
  skills: string[];
  slash_commands: string[];
  agents: string[];
  plugins: Array<{ name: string }>;
  mcp_servers: Array<{ name: string; status: string }>;
  tools: string[];
}

/**
 * What one probe produced: an init event, or the reason there is none.
 *
 * There is no third case. A probe that cannot start a session is a *fact about
 * this machine* — no credentials, no binary, a stand-in on PATH — and Doctor
 * has to be able to say so without failing, or every CI runner without an API
 * key would read as a broken Harvenv.
 */
export type Probe = { init: InitEvent; unobservable?: undefined } | { init?: undefined; unobservable: string };

export interface ProbeRequest {
  /** An absolute path: with a Shim installed, `claude` on PATH is harv. */
  binary: string;
  cwd: string;
  /** Flags under test. The stream-json plumbing is added here. */
  args: string[];
  env: Env;
  timeoutMs?: number;
}

/** Injected wherever a probe is run, so no test ever starts a real session. */
export type ProbeFn = (request: ProbeRequest) => Promise<Probe>;

/**
 * Long enough for a cold start on a loaded CI runner, short enough that a
 * person running `harv doctor` on a machine where sessions hang is told so
 * rather than left watching. A timeout reports `unobservable`, never a
 * regression: the one verdict this must never produce is a false one.
 */
export const PROBE_TIMEOUT_MS = 60_000;

/**
 * Start a headless session, capture its `init` event, kill it immediately.
 *
 * Never rejects. Every failure — a binary that is not Claude Code, a missing
 * credential, a hang — comes back as `unobservable` carrying the reason,
 * because Doctor's job is to report what it found and a diagnosis command that
 * threw would be reporting on itself instead.
 */
export function probeSession({ binary, cwd, args, env, timeoutMs = PROBE_TIMEOUT_MS }: ProbeRequest): Promise<Probe> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        binary,
        ["-p", "probe", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...args],
        { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      resolve({ unobservable: `${binary} could not be started: ${(err as Error).message}` });
      return;
    }

    let stderr = "";
    let settled = false;
    const finish = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(probe);
    };

    const timer = setTimeout(
      () => finish({ unobservable: `claude did not report a session within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Anything that is not one of the stream's own events — a banner, a
          // stand-in's canned answer — is not an error, it is just not an init.
          return;
        }
        if (event.type === "system" && event.subtype === "init") {
          finish({ init: event as unknown as InitEvent });
        }
      });
    }

    child.on("error", (err) => finish({ unobservable: `${binary} could not be started: ${err.message}` }));
    child.on("exit", (code) =>
      finish({
        unobservable:
          `claude exited (code ${code}) before reporting a session` +
          (stderr.trim() === "" ? "" : `: ${lastLine(stderr)}`),
      }),
    );
  });
}

/** The most recent thing a failing process had to say, trimmed for one line. */
const lastLine = (text: string): string => {
  const line =
    text
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .pop() ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
};

/**
 * The installed Claude Code's version, without starting a session.
 *
 * This is the half of the check that still works on a machine with no
 * credentials, so it is asked separately rather than read out of an init event
 * that may never arrive.
 */
export function claudeCodeVersion(binary: string, env: Env = process.env): string | null {
  try {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      env: env as NodeJS.ProcessEnv,
      timeout: 15_000,
    });
    return version(`${result.stdout ?? ""}`);
  } catch {
    return null;
  }
}

/** `2.1.223 (Claude Code)` — and nothing at all from something that is not it. */
export const version = (output: string): string | null => /\b(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\b/.exec(output)?.[1] ?? null;

// ---------------------------------------------------------------------------
// The smoke test
// ---------------------------------------------------------------------------

/**
 * One measured claim. `ok: null` is "could not be observed here" — the same
 * three-valued outcome the verification scripts report, and for the same
 * reason: a machine whose user scope is empty has nothing to suppress, and a
 * check that went green on it would be green for the wrong reason.
 */
export interface Observation {
  label: string;
  ok: boolean | null;
  detail: string;
}

export interface SmokeResult {
  /** From the session itself, which is the version that was actually measured. */
  version: string | null;
  /** Set when the recipe probe produced nothing: the reason, ready to print. */
  unobservable: string | null;
  observations: Observation[];
  measurements: Record<string, unknown>;
}

/** The name the probe fixture's project-scope skill is published under. */
export const MARKER_SKILL = "harv-doctor-probe";

/**
 * The settings the fixture project commits, and the ones the recipe injects
 * over them. Two independently observable keys, so "the injected layer won" is
 * distinguishable from "the file never applied".
 */
const PROJECT_SETTINGS = { model: "haiku", permissions: { defaultMode: "acceptEdits" } };
const INJECTED_SETTINGS = { model: "opus", permissions: { defaultMode: "plan" } };

/** The recipe's MCP half: an empty server set that nothing may leak past. */
const NO_MCP = ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

/**
 * Measure the recipe against this machine's Claude Code.
 *
 * Two probes of the same fixture project: one bare, which is what the machine
 * contributes, and one under the full recipe, which is what a Harvenv session
 * gets. Every claim below is a difference between them or a fact about the
 * second, and the bare probe is allowed to fail on its own — a machine whose
 * user scope cannot be enumerated still answers questions 2, 3 and 4.
 */
export async function smokeTest(binary: string, env: Env, probe: ProbeFn): Promise<SmokeResult> {
  const fixture = buildFixture();
  try {
    const bare = await probe({ binary, cwd: fixture, args: [], env });
    const recipe = await probe({
      binary,
      cwd: fixture,
      args: [
        "--setting-sources",
        "project,local",
        "--settings",
        JSON.stringify(INJECTED_SETTINGS),
        ...NO_MCP,
      ],
      env,
    });

    if (recipe.init === undefined) {
      return {
        version: bare.init?.claude_code_version ?? null,
        unobservable: recipe.unobservable,
        observations: [],
        measurements: { bare: summarize(bare), recipe: { unobservable: recipe.unobservable } },
      };
    }

    return {
      version: recipe.init.claude_code_version,
      unobservable: null,
      observations: observe(bare.init ?? null, recipe.init, bare.unobservable ?? null),
      measurements: { bare: summarize(bare), recipe: summarize(recipe) },
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * A throwaway project to measure in.
 *
 * Never the user's own: their Manifest's settings, skills and MCP servers would
 * all become variables in a measurement about flags, and a bare probe there
 * would load whatever the project declares. `mkdtemp` also salts the path per
 * run, so two `harv doctor` invocations on one machine cannot collide.
 */
function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harv-doctor-probe-"));
  const claude = join(root, ".claude");
  mkdirSync(join(claude, "skills", MARKER_SKILL), { recursive: true });
  writeFileSync(join(claude, "settings.json"), `${JSON.stringify(PROJECT_SETTINGS, null, 2)}\n`);
  writeFileSync(
    join(claude, "skills", MARKER_SKILL, "SKILL.md"),
    `---\nname: ${MARKER_SKILL}\ndescription: Marker skill for harv doctor's launch-recipe smoke test. Never invoke it.\n---\n\nMarker only.\n`,
  );
  return root;
}

const summarize = (probe: Probe): Record<string, unknown> =>
  probe.init === undefined
    ? { unobservable: probe.unobservable }
    : {
        skills: probe.init.skills.length,
        slashCommands: probe.init.slash_commands.length,
        agents: probe.init.agents.length,
        plugins: probe.init.plugins.map((plugin) => plugin.name),
        mcpServers: probe.init.mcp_servers.length,
        tools: probe.init.tools.length,
        model: probe.init.model,
        permissionMode: probe.init.permissionMode,
      };

const namespaced = (name: string): boolean => name.includes(":");

function observe(bare: InitEvent | null, recipe: InitEvent, bareFailed: string | null): Observation[] {
  // Whether this machine has anything for the recipe to take away. Without it
  // the suppression claims would pass on an empty user scope, which is the one
  // way for a check about removal to be green while removing nothing.
  const contributes = bare !== null && (bare.plugins.length > 0 || bare.skills.length > recipe.skills.length);
  const why = bareFailed ?? "this machine's user scope contributes no skills or plugins to suppress";

  const leaked = [...recipe.skills, ...recipe.slash_commands, ...recipe.agents].filter(namespaced);

  return [
    {
      label: "`--setting-sources project,local` stops the user's skills loading",
      ok: contributes ? recipe.skills.length < (bare as InitEvent).skills.length : null,
      detail:
        bare === null
          ? why
          : `${bare.skills.length} skills bare, ${recipe.skills.length} under the recipe` +
            (contributes ? "" : ` — ${why}`),
    },
    {
      label: "no plugin from the machine's user scope reaches the session",
      // Unconditional: an empty plugin list is the required outcome whether or
      // not this machine had plugins to lose.
      ok: recipe.plugins.length === 0,
      detail:
        recipe.plugins.length === 0
          ? `none under the recipe${bare === null ? "" : ` (${bare.plugins.length} bare)`}`
          : `still loaded: ${recipe.plugins.map((plugin) => plugin.name).join(", ")}`,
    },
    {
      label: "no `<plugin>:<name>` Component survives the recipe",
      ok: leaked.length === 0,
      detail: leaked.length === 0 ? "no namespaced skills, commands or agents" : `leaked: ${leaked.slice(0, 5).join(", ")}`,
    },
    {
      label: "`--settings` outranks the project's own settings file (ADR 0005)",
      ok: recipe.model.includes("opus") && recipe.permissionMode === "plan",
      detail:
        `model=${recipe.model}, permissionMode=${recipe.permissionMode} ` +
        `(injected opus/plan over the file's haiku/acceptEdits)`,
    },
    {
      label: "`--strict-mcp-config` leaves the session no MCP servers",
      ok: recipe.mcp_servers.length === 0,
      detail:
        recipe.mcp_servers.length === 0
          ? `none under the recipe${bare === null ? "" : ` (${bare.mcp_servers.length} bare)`}`
          : `still connected: ${recipe.mcp_servers.map((server) => server.name).join(", ")}`,
    },
    {
      label: "a skill materialized into project scope keeps its bare name (ADR 0008)",
      ok: recipe.skills.includes(MARKER_SKILL),
      detail: recipe.skills.includes(MARKER_SKILL)
        ? `\`${MARKER_SKILL}\` is in the session under its own name`
        : `\`${MARKER_SKILL}\` is absent from ${recipe.skills.length} loaded skills`,
    },
  ];
}

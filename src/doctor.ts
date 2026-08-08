/**
 * Doctor: the diagnosis that verifies a synced Harvenv is actually runnable.
 *
 * Everything else in harv answers one question and stops at the first bad
 * answer — `harv sync` refuses a Manifest it cannot resolve, `harv claude`
 * refuses a Lockfile that has drifted. That is right for a command that is
 * about to *do* something, and wrong for one whose entire output is the list of
 * what is wrong. So Doctor inverts it: nothing here throws, every check runs
 * even when an earlier one failed, and a problem becomes a line in a report
 * rather than an exit.
 *
 * Seven checks, always all seven, always in this order:
 *
 *   claude-code   Claude Code is here, and ADR 0003's flags still isolate it
 *   settings      the Manifest's settings would bind, and the Overlay loads
 *   drift         the Manifest, the Overlay and the Lockfiles agree
 *   components    every locked Component is on this machine
 *   toolchain     every pinned tool is, and every unscopeable one is reachable
 *   mcp           declared servers can start, and are not waiting on auth
 *   tripwire      a bare `claude` here would still announce itself
 *
 * The fixed set is the point of `--json`: a CI gate should be able to ask for
 * `.checks[] | select(.id == "mcp")` without first finding out whether this
 * project has any MCP servers. A check with nothing to do reports `ok` and says
 * so, and a check that could not be performed reports `unknown` rather than
 * passing — this command's whole value is that its green means something.
 *
 * ## Three statuses, two exit codes
 *
 * `problem` is something that will bite: a session that cannot start, a
 * Component that is not on disk, a server waiting on a browser. `unknown` is
 * something Doctor could not measure here — no credentials to start a probe
 * session with, an MCP server still registering when the session reported in.
 * Only `problem` fails the command. An honest "I could not check this" must not
 * be able to fail a build, or the first CI runner without an API key would
 * teach everyone to stop running Doctor.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { driftAgainst, LOCKFILE_FILENAME, LockfileError, readLockfile, toolDrift } from "./lockfile.ts";
import type { DriftEntry, Lockfile } from "./lockfile.ts";
import type { Manifest } from "./manifest.ts";
import { generateMcpConfig, McpError } from "./mcp.ts";
import type { McpServerEntry } from "./mcp.ts";
import { hasBins, resolveBinPath } from "./mise.ts";
import { composeSession, loadOverlay, NO_OVERLAY, overlayDrift, OVERLAY_LOCKFILE, OverlayError } from "./overlay.ts";
import type { Session } from "./overlay.ts";
import { currentPlatform } from "./platform.ts";
import { claudeCodeVersion, smokeTest, VERIFIED_CLAUDE_CODE } from "./recipe.ts";
import type { ProbeFn } from "./recipe.ts";
import { SettingsError, validateSettings } from "./settings.ts";
import { resolveRealClaude } from "./shim.ts";
import { isStored, storePath } from "./store.ts";
import type { Env } from "./store.ts";
import { requirements, ToolchainError } from "./tools.ts";
import { hasTripwire } from "./tripwire.ts";
import { VERSION } from "./version.ts";

/** The format version of a `--json` report. Bumped if the shape changes. */
export const REPORT_VERSION = 1;

export type Status = "ok" | "problem" | "unknown";

/**
 * One thing worth saying. `problem` fails the command, `unknown` says the
 * question could not be answered here, and `note` is context that changes
 * nothing — a degraded tool that still resolves, an Overlay value the Manifest
 * outranked.
 */
export interface Finding {
  level: "problem" | "unknown" | "note";
  message: string;
  /** What to do about it. Present on every problem; that is what makes it one. */
  hint?: string;
}

export interface Check {
  id: string;
  title: string;
  status: Status;
  /** One line, true whether or not anything is wrong. */
  summary: string;
  findings: Finding[];
  /** Per-check detail. Free-form and additive; the fields above are the contract. */
  measurements: Record<string, unknown>;
}

export interface Report {
  version: number;
  ok: boolean;
  harv: { version: string; platform: string };
  project: { root: string; manifest: string; lockfile: string };
  claudeCode: { path: string | null; version: string | null; verified: boolean };
  checks: Check[];
  counts: Record<Status, number>;
}

export interface DoctorDeps {
  manifest: Manifest;
  env: Env;
  /** Whether the Overlay is part of what is being diagnosed (`--no-overlay`). */
  overlay: boolean;
  /** Whether Doctor may start Claude Code sessions to measure with. */
  session: boolean;
  probe: ProbeFn;
}

const SYNC_HINT = "Run `harv sync` to reconcile them.";

export async function diagnose(deps: DoctorDeps): Promise<Report> {
  const { manifest, env } = deps;

  // Read once, in the order the rest of the checks depend on. Each of these can
  // fail on its own, and each failure is a finding somebody else reports —
  // which is why they are collected here rather than thrown from here.
  const locks = readLocks(manifest.root);
  const composed = compose(deps);
  const claude = findClaude(env);

  const components = checkComponents(manifest, composed.session, locks, env);

  const checks: Check[] = [
    await checkClaudeCode(claude, deps),
    checkSettings(manifest, composed),
    checkDrift(manifest, composed.session, locks, components.resolved),
    components.check,
    checkToolchain(locks.manifest, components.resolved, manifest, env),
    await checkMcp(composed.session, claude, deps),
    checkTripwire(manifest.root),
  ];

  const counts: Record<Status, number> = { ok: 0, problem: 0, unknown: 0 };
  for (const check of checks) counts[check.status] += 1;

  return {
    version: REPORT_VERSION,
    ok: counts.problem === 0,
    harv: { version: VERSION, platform: currentPlatform() },
    project: {
      root: manifest.root,
      manifest: manifest.path,
      lockfile: join(manifest.root, LOCKFILE_FILENAME),
    },
    claudeCode: {
      path: claude.path,
      version: claude.version,
      verified: claude.version !== null && VERIFIED_CLAUDE_CODE.includes(claude.version),
    },
    checks,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Reading the project without refusing to
// ---------------------------------------------------------------------------

interface Locks {
  manifest: Lockfile | null;
  overlay: Lockfile | null;
  /** Why a Lockfile could not be read at all, if that is what happened. */
  error: string | null;
}

/**
 * Both Lockfiles, or the reason there are none.
 *
 * `readLockfile` refuses a file it cannot trust — a malformed pin becomes a
 * Store path and a session's PATH, so that refusal is correct everywhere else.
 * Here it is the diagnosis: an unreadable Lockfile is reported by name and the
 * checks that depend on it say they could not run.
 */
function readLocks(root: string): Locks {
  try {
    return { manifest: readLockfile(root), overlay: readLockfile(root, OVERLAY_LOCKFILE), error: null };
  } catch (err) {
    if (err instanceof LockfileError) return { manifest: null, overlay: null, error: err.message };
    throw err;
  }
}

interface Composed {
  session: Session;
  /** A settings or Overlay failure, phrased for whoever has to fix the file. */
  error: string | null;
}

/**
 * The Manifest and the Overlay as one session — or the Manifest alone, plus the
 * reason the Overlay was left out.
 *
 * `harv claude` validates the same things and stops. Doctor cannot: a Manifest
 * with one bad settings key would otherwise hide a missing Component, a pending
 * MCP auth and an absent Tripwire behind one message.
 */
function compose(deps: DoctorDeps): Composed {
  const { manifest, env } = deps;
  try {
    validateSettings(manifest.settings);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    return { session: composeSession(manifest, NO_OVERLAY), error: err.message };
  }

  if (!deps.overlay) return { session: composeSession(manifest, NO_OVERLAY), error: null };

  try {
    return { session: composeSession(manifest, loadOverlay(manifest.root, env)), error: null };
  } catch (err) {
    if (!(err instanceof OverlayError || err instanceof SettingsError || err instanceof McpError)) throw err;
    return { session: composeSession(manifest, NO_OVERLAY), error: err.message };
  }
}

interface Claude {
  path: string | null;
  version: string | null;
}

/**
 * Claude Code itself, resolved the way the Launcher resolves it: past every
 * shim directory, so a machine with `harv shim install` does not report harv's
 * own lookalike as the binary a session would run.
 */
function findClaude(env: Env): Claude {
  const path = resolveRealClaude(env.PATH ?? "");
  return { path, version: path === null ? null : claudeCodeVersion(path, env) };
}

// ---------------------------------------------------------------------------
// claude-code — Claude Code is here, and the recipe still isolates it
// ---------------------------------------------------------------------------

async function checkClaudeCode(claude: Claude, deps: DoctorDeps): Promise<Check> {
  const id = "claude-code";
  const title = "Claude Code, and the launch recipe ADR 0003 measures";

  if (claude.path === null) {
    return check(id, title, "claude was not found on PATH", { path: null }, [
      {
        level: "problem",
        message: "`claude` is not on this machine's PATH, so `harv claude` has nothing to start.",
        hint: "Install Claude Code — https://claude.com/claude-code — or add the binary to PATH.",
      },
    ]);
  }

  const verified = claude.version !== null && VERIFIED_CLAUDE_CODE.includes(claude.version);
  const named = claude.version === null ? "an unreadable version" : claude.version;
  const findings: Finding[] = [];

  if (!deps.session) {
    return check(
      id,
      title,
      `Claude Code ${named}; the smoke test was skipped`,
      { path: claude.path, version: claude.version, verified, smokeTest: "skipped" },
      [
        verified
          ? {
              level: "note",
              message:
                `The launch recipe was not re-measured (\`--no-session\`), but ${named} is a version harv has ` +
                `verified it against.`,
            }
          : {
              level: "unknown",
              message:
                `The launch recipe was not re-measured (\`--no-session\`), and ${named} is not one of the versions ` +
                `harv has verified it against (${VERIFIED_CLAUDE_CODE.join(", ")}). Nothing here has checked that ` +
                `\`--setting-sources project,local\` still suppresses user scope on it.`,
              hint: "Re-run `harv doctor` without `--no-session` on a machine that can start a session.",
            },
      ],
    );
  }

  const smoke = await smokeTest(claude.path, deps.env, deps.probe);
  const version = smoke.version ?? claude.version;
  const measured = version !== null && VERIFIED_CLAUDE_CODE.includes(version);

  if (smoke.unobservable !== null) {
    findings.push({
      level: "unknown",
      message: `The launch recipe could not be measured on this machine: ${smoke.unobservable}`,
      hint:
        "A probe session needs a working Claude Code login or ANTHROPIC_API_KEY. " +
        "Pass `--no-session` to skip it deliberately.",
    });
    if (!measured) {
      findings.push({
        level: "unknown",
        message:
          `Claude Code ${version ?? "of an unreadable version"} is not one of the versions harv has verified the ` +
          `recipe against (${VERIFIED_CLAUDE_CODE.join(", ")}), and nothing measured it here.`,
      });
    }
  } else {
    for (const observation of smoke.observations) {
      if (observation.ok === true) continue;
      findings.push(
        observation.ok === false
          ? {
              level: "problem",
              message: `${observation.label} — no longer true on Claude Code ${version}: ${observation.detail}`,
              hint:
                "This is the regression ADR 0003 says can arrive on any release. Pin a Claude Code version this " +
                "harv has verified, and report it — the Launcher is built on this behaviour.",
            }
          : { level: "unknown", message: `${observation.label}: ${observation.detail}` },
      );
    }
    if (!measured && !findings.some((finding) => finding.level === "problem")) {
      findings.push({
        level: "note",
        message:
          `Claude Code ${version} is newer than the versions harv has on record (${VERIFIED_CLAUDE_CODE.join(", ")}), ` +
          `and the recipe still behaves as ADR 0003 describes on it.`,
      });
    }
  }

  const held = smoke.observations.filter((observation) => observation.ok === true).length;
  return check(
    id,
    title,
    smoke.unobservable !== null
      ? `Claude Code ${version ?? "(unreadable version)"}; the recipe could not be measured here`
      : `Claude Code ${version}; ${held}/${smoke.observations.length} of the recipe's behaviours still hold`,
    {
      path: claude.path,
      version,
      verified: measured,
      smokeTest: smoke.unobservable === null ? "measured" : "unobservable",
      observations: smoke.observations,
      ...smoke.measurements,
    },
    findings,
  );
}

// ---------------------------------------------------------------------------
// settings — the Manifest binds what it declares, and the Overlay loads
// ---------------------------------------------------------------------------

function checkSettings(manifest: Manifest, composed: Composed): Check {
  const id = "settings";
  const title = "The Manifest's settings, and the Overlay layered on them";

  const findings: Finding[] = [];
  if (composed.error !== null) {
    findings.push({
      level: "problem",
      message: composed.error,
      hint: `\`harv claude\` refuses to start on this, so fix it in ${manifest.path} — or in the Overlay file it names.`,
    });
  }
  // The merge's own report: an Overlay value for a key the Manifest already
  // bound is dropped rather than applied (ADR 0005). Not a problem — the
  // outcome is already correct — but the whole point is that it is not silent.
  for (const warning of composed.session.warnings) findings.push({ level: "note", message: warning });

  const keys = Object.keys(composed.session.settings).length;
  return check(
    id,
    title,
    composed.error !== null
      ? "the settings this Harvenv would launch with cannot be built"
      : `${keys} settings key${keys === 1 ? "" : "s"} would reach the session`,
    { keys: Object.keys(composed.session.settings), overlayWarnings: composed.session.warnings.length },
    findings,
  );
}

// ---------------------------------------------------------------------------
// drift — the Manifest, the Overlay and the Lockfiles agree
// ---------------------------------------------------------------------------

function checkDrift(
  manifest: Manifest,
  session: Session,
  locks: Locks,
  resolved: Array<{ name: string; path: string }>,
): Check {
  const id = "drift";
  const title = "The Manifest, the Overlay and their Lockfiles";

  if (locks.error !== null) {
    return check(id, title, "a Lockfile could not be read", { lockfile: "unreadable" }, [
      { level: "problem", message: locks.error, hint: SYNC_HINT },
    ]);
  }

  const entries: DriftEntry[] = [
    ...driftAgainst(manifest, locks.manifest),
    ...overlayDrift(session, locks.overlay),
  ];

  // The Toolchain's half needs the fetched skills, because a `requires:` line
  // travels inside the skill rather than in the Manifest that names it. Two
  // skills that contradict each other is a decision, not drift — it is reported
  // by the toolchain check, which is where the version to pin belongs.
  let toolchainReadable = true;
  try {
    entries.push(...toolDrift(requirements(manifest, resolved), locks.manifest));
  } catch (err) {
    if (!(err instanceof ToolchainError)) throw err;
    toolchainReadable = false;
  }

  const findings: Finding[] = entries.map((entry) => ({
    level: "problem" as const,
    message: `${entry.name}: ${entry.reason}`,
    hint: SYNC_HINT,
  }));

  // A Manifest that declares nothing needs no Lockfile (ADR 0009), so the
  // absence of one is the correct state rather than a missing step. Guarded on
  // there being nothing to say, because an Overlay staple can drift under a
  // Manifest that declares nothing at all.
  const declares = manifest.skills.length + manifest.plugins.length + manifest.tools.length;
  if (locks.manifest === null && declares === 0 && findings.length === 0) {
    return check(id, title, "this Manifest declares no Components, so it needs no Lockfile", { drifted: [] }, []);
  }

  return check(
    id,
    title,
    findings.length === 0
      ? `${LOCKFILE_FILENAME} pins what the Manifest declares`
      : `${findings.length} entr${findings.length === 1 ? "y has" : "ies have"} drifted`,
    {
      drifted: entries.map((entry) => entry.name),
      locked: (locks.manifest?.skills.length ?? 0) + (locks.manifest?.plugins.length ?? 0),
      toolchainReadable,
    },
    findings,
  );
}

// ---------------------------------------------------------------------------
// components — every locked Component is on this machine
// ---------------------------------------------------------------------------

/**
 * Where each locked Component actually is — and, when it is nowhere, the fact
 * that a session would be missing it.
 *
 * Only entries the Manifest still declares are looked at: one the Lockfile
 * holds and nothing declares is drift, reported once, by the check whose remedy
 * fixes it. The resolved paths come back with the check because the Toolchain
 * reads its requirements out of them.
 */
function checkComponents(
  manifest: Manifest,
  session: Session,
  locks: Locks,
  env: Env,
): { check: Check; resolved: Array<{ name: string; path: string }> } {
  const id = "components";
  const title = "Every declared Component, on this machine";

  const findings: Finding[] = [];
  const resolved: Array<{ name: string; path: string }> = [];
  const missing: string[] = [];

  const locate = (what: string, name: string, hash: string | undefined, path: string | undefined): void => {
    if (path !== undefined) {
      // A path Source is live rather than stored, so the only question is
      // whether the directory is still there.
      if (existsSync(path)) resolved.push({ name, path });
      else {
        missing.push(name);
        findings.push({
          level: "problem",
          message: `${what} \`${name}\` comes from the local path \`${path}\`, which does not exist.`,
          hint: "Restore the directory, or declare a Source a clone could resolve and run `harv sync`.",
        });
      }
      return;
    }
    // Not locked at all is drift, and drift already said so.
    if (hash === undefined) return;
    if (isStored(hash, env)) resolved.push({ name, path: storePath(hash, env) });
    else {
      missing.push(name);
      findings.push({
        level: "problem",
        message: `${what} \`${name}\` is locked at ${hash}, but the Store does not hold those bytes.`,
        hint: "Run `harv sync` to fetch it. `harv claude` refuses to start a session without it.",
      });
    }
  };

  if (locks.error === null) {
    const skills = new Map((locks.manifest?.skills ?? []).map((entry) => [entry.name, entry]));
    for (const skill of manifest.skills) {
      locate("skill", skill.name, skills.get(skill.name)?.hash, localPath(skill));
    }

    const plugins = new Map((locks.manifest?.plugins ?? []).map((entry) => [entry.name, entry]));
    for (const plugin of manifest.plugins) {
      locate("plugin", plugin.name, plugins.get(plugin.name)?.hash, undefined);
    }

    const staples = new Map((locks.overlay?.skills ?? []).map((entry) => [entry.name, entry]));
    for (const skill of session.overlaySkills) {
      locate("Overlay skill", skill.name, staples.get(skill.name)?.hash, localPath(skill));
    }

    const stapledPlugins = new Map((locks.overlay?.plugins ?? []).map((entry) => [entry.name, entry]));
    for (const plugin of session.overlayPlugins) {
      locate("Overlay plugin", plugin.name, stapledPlugins.get(plugin.name)?.hash, undefined);
    }
  }

  const declared =
    manifest.skills.length +
    manifest.plugins.length +
    session.overlaySkills.length +
    session.overlayPlugins.length;
  return {
    resolved,
    check: check(
      id,
      title,
      locks.error !== null
        ? "not checked: a Lockfile could not be read"
        : declared === 0
          ? "this Harvenv declares no Components"
          : `${declared - missing.length}/${declared} declared Components resolve on this machine`,
      { declared, missing },
      locks.error === null
        ? findings
        : [{ level: "unknown", message: "The Lockfile could not be read, so no Component was located." }],
    ),
  };
}

/** A local Source's directory, or undefined for anything the Store holds. */
const localPath = (skill: { source: { kind: string; path?: string } }): string | undefined =>
  skill.source.kind === "path" ? skill.source.path : undefined;

// ---------------------------------------------------------------------------
// toolchain — pinned tools present, unscopeable ones reachable
// ---------------------------------------------------------------------------

function checkToolchain(
  lock: Lockfile | null,
  resolved: Array<{ name: string; path: string }>,
  manifest: Manifest,
  env: Env,
): Check {
  const id = "toolchain";
  const title = "The system tools this Harvenv's skills run on";

  const findings: Finding[] = [];

  // Two Components asking for different versions of one tool is settled by the
  // Manifest, never guessed at (ADR 0005) — and until it is, there is no
  // Toolchain to check.
  try {
    requirements(manifest, resolved);
  } catch (err) {
    if (!(err instanceof ToolchainError)) throw err;
    findings.push({
      level: "problem",
      message: err.message,
      hint: `Pin the version in ${manifest.path}, then run \`harv sync\`.`,
    });
  }

  const tools = lock?.tools ?? [];
  const search = sessionPath(lock, env);
  const scoped: string[] = [];
  const degraded: string[] = [];
  const absent: string[] = [];

  for (const tool of tools) {
    if (tool.version !== undefined && tool.bins !== undefined) {
      if (safeHasBins(tool.bins, env)) {
        scoped.push(`${tool.tool}@${tool.version}`);
        continue;
      }
      absent.push(tool.tool);
      findings.push({
        level: "problem",
        message:
          `\`${tool.tool}\` is locked at ${tool.version}, but the Store does not hold it — a session would fall ` +
          `back to whatever ${tool.tool} is on your PATH, or to none.`,
        hint: "Run `harv sync` to install the pinned version.",
      });
      continue;
    }

    // ADR 0006's honest degradation path: harv could not scope this one, so the
    // machine's own copy is what a session gets. That is only survivable if the
    // machine has one.
    const command = binaryFor(tool.tool);
    // Named when it differs from the tool, because then it is a guess and the
    // reader is the one who can tell whether harv guessed right.
    const looked = command === tool.tool ? "" : ` (harv looked for \`${command}\`)`;
    const found = findOnPath(command, search);
    if (found !== null) {
      degraded.push(tool.tool);
      findings.push({
        level: "note",
        message:
          `\`${tool.tool}\` could not be scoped to this project, so sessions will use the machine's own: ` +
          `${found}${looked}. ${sentence(tool.hint)}`.trimEnd(),
      });
      continue;
    }
    absent.push(tool.tool);
    findings.push({
      level: "problem",
      message:
        `\`${tool.tool}\` could not be scoped to this project and is not on your PATH either${looked}, so the skill ` +
        `that needs it will fail at the moment it runs. ${sentence(tool.hint)}`.trimEnd(),
      hint: `Install ${tool.tool} the way this machine normally would, or pin a version harv can install in [tools].`,
    });
  }

  return check(
    id,
    title,
    tools.length === 0
      ? "this Harvenv needs no system tools"
      : `${scoped.length} pinned, ${degraded.length} on the machine's own copy, ${absent.length} unavailable`,
    { scoped, degraded, absent },
    findings,
  );
}

/**
 * A recorded hint as a sentence of its own. Sync writes them to follow "harv:
 * warning: ", where lowercase is right; here they follow a full stop.
 */
const sentence = (text: string | undefined): string =>
  text === undefined ? "" : `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

/**
 * `bins` arrives from a clone, and `hasBins` refuses one that climbs out of the
 * Store. Here that refusal is a finding elsewhere — the Lockfile check makes
 * the same objection — so it degrades to "not present" rather than throwing out
 * of a diagnosis.
 */
function safeHasBins(bins: string[], env: Env): boolean {
  try {
    return hasBins(bins, env);
  } catch {
    return false;
  }
}

/**
 * What a session would search for a tool: the Store's pinned bin directories in
 * front, then the machine's PATH — the same order `harv claude` builds.
 *
 * Only the pinned half is joined here; the unpinned tools are exactly the ones
 * this is used to look for.
 */
function sessionPath(lock: Lockfile | null, env: Env): string {
  const pinned: string[] = [];
  for (const tool of lock?.tools ?? []) {
    if (tool.bins === undefined) continue;
    for (const bin of tool.bins) {
      try {
        pinned.push(resolveBinPath(bin, env));
      } catch {
        // A bin path harv refuses to put on a session's PATH. Left out rather
        // than searched, which is the safe direction: it only ever removes a
        // candidate directory.
      }
    }
  }
  return [...pinned, env.PATH ?? ""].filter((entry) => entry !== "").join(delimiter);
}

/**
 * A mise tool name as the command it puts on PATH: `npm:prettier` installs
 * `prettier`, `node` installs `node`. A guess, and labelled as one wherever it
 * is reported — the alternative is not reporting the honest degradation path at
 * all, which is the case ADR 0006 most wants surfaced.
 */
const binaryFor = (tool: string): string => tool.slice(tool.lastIndexOf(":") + 1);

/** The first executable of that name on `pathString`, or null. */
function findOnPath(name: string, pathString: string): string | null {
  for (const dir of pathString.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// mcp — declared servers can start, and are not waiting on auth
// ---------------------------------------------------------------------------

/**
 * The statuses `init` reports for a declared server, measured on Claude Code
 * 2.1.223 (spike 0004). `needs-auth` is the one this check exists for: an
 * OAuth server that nobody has authorized yet is invisible from the Manifest,
 * personal to the machine, and cannot be fixed by anything harv does.
 */
const CONNECTED = "connected";
const NEEDS_AUTH = "needs-auth";
const REGISTERING = new Set(["pending", "connecting"]);

async function checkMcp(session: Session, claude: Claude, deps: DoctorDeps): Promise<Check> {
  const id = "mcp";
  const title = "The MCP servers this Harvenv declares";

  const servers = session.mcpServers;
  if (servers.length === 0) {
    return check(id, title, "this Harvenv declares no MCP servers", { declared: [] }, []);
  }

  const findings: Finding[] = [];
  const search = deps.env.PATH ?? "";
  let payload: string | null = null;

  // Everything that can be decided without starting anything: a `${VAR}` this
  // environment cannot satisfy, a transport Claude Code would drop in silence,
  // a command that is not installed. These are the failures a probe would only
  // report as `failed`, with the reason one process further away.
  try {
    payload = generateMcpConfig(servers, deps.env);
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    findings.push({
      level: "problem",
      message: err.message,
      hint: "`harv claude` refuses to launch on this, so it has to be fixed before a session can start.",
    });
  }

  for (const server of servers) {
    const command = server.definition.command;
    if (typeof command !== "string" || command.includes("/")) continue;
    if (findOnPath(command, search) !== null) continue;
    findings.push({
      level: "problem",
      message: `[mcp.${server.name}] runs \`${command}\`, which is not on this machine's PATH — the server cannot start.`,
      hint: `Install ${command}, or declare it in [tools] so \`harv sync\` puts it on the session's PATH.`,
    });
  }

  const statuses: Record<string, string> = {};
  let live: string;

  if (payload === null) {
    live = "not attempted: the payload could not be built";
  } else if (!deps.session) {
    live = "skipped";
    findings.push({
      level: "unknown",
      message:
        "Whether these servers connect — and whether any is waiting on first-time authentication — was not " +
        "measured (`--no-session`). It is the only way to find out: OAuth state is personal to this machine and " +
        "nothing in the Manifest records it.",
    });
  } else if (claude.path === null) {
    live = "not attempted: claude was not found";
  } else {
    // The project root, not a fixture: a stdio server's command is launched
    // with the session's working directory, so measuring anywhere else would
    // measure a different server. The resolved payload travels in argv here for
    // the same reason it does at launch, and with the same accepted cost.
    const probed = await deps.probe({
      binary: claude.path,
      cwd: session.manifest.root,
      args: ["--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", payload],
      env: deps.env,
    });

    if (probed.init === undefined) {
      live = "unobservable";
      findings.push({
        level: "unknown",
        message: `The declared servers could not be connected here: ${probed.unobservable}`,
        hint: "A probe session needs a working Claude Code login or ANTHROPIC_API_KEY.",
      });
    } else {
      live = "measured";
      const seen = new Set<string>();
      for (const server of probed.init.mcp_servers) {
        statuses[server.name] = server.status;
        seen.add(server.name);
        findings.push(...judge(server.name, server.status));
      }
      for (const server of servers) {
        if (seen.has(server.name)) continue;
        statuses[server.name] = "absent";
        findings.push({
          level: "problem",
          message:
            `[mcp.${server.name}] did not reach the session at all — Claude Code drops a server it cannot read ` +
            `without a word.`,
          hint: `Check the definition in ${session.manifest.path}.`,
        });
      }
    }
  }

  const connected = Object.values(statuses).filter((status) => status === CONNECTED).length;
  return check(
    id,
    title,
    live === "measured"
      ? `${connected}/${servers.length} declared server${servers.length === 1 ? "" : "s"} connected`
      : `${servers.length} declared server${servers.length === 1 ? "" : "s"}; connection ${live}`,
    { declared: servers.map((server) => server.name), statuses, live },
    findings,
  );
}

/** What one server's reported status means for whoever is reading this. */
function judge(name: string, status: string): Finding[] {
  if (status === CONNECTED) return [];
  if (status === NEEDS_AUTH) {
    return [
      {
        level: "problem",
        message: `[mcp.${name}] is waiting on first-time authentication — its tools are not in a session yet.`,
        hint:
          "Run `harv claude` and complete `/mcp` for it once. The grant is personal to this machine: it is not a " +
          "Component, so it does not travel with the repository and every teammate does it once too.",
      },
    ];
  }
  if (REGISTERING.has(status)) {
    return [
      {
        level: "unknown",
        message:
          `[mcp.${name}] was still registering when the session reported in (status \`${status}\`), so whether it ` +
          `connects was not settled here.`,
        hint: "Re-run `harv doctor`; a server that stays pending is worth opening a session to watch.",
      },
    ];
  }
  return [
    {
      level: "problem",
      message: `[mcp.${name}] did not start: the session reports it as \`${status}\`.`,
      hint: "Run the server's own command by hand to see what it says, and check its credentials.",
    },
  ];
}

// ---------------------------------------------------------------------------
// tripwire — a bare `claude` here still announces itself
// ---------------------------------------------------------------------------

function checkTripwire(root: string): Check {
  const id = "tripwire";
  const title = "The committed warning a bare `claude` session carries";
  const path = join(root, ".claude", "settings.json");
  const hint = "Run `harv init` — it plants the Tripwire beside whatever hooks the project already has.";

  if (!existsSync(path)) {
    return check(id, title, "this project has no committed .claude/settings.json", { path, planted: false }, [
      {
        level: "problem",
        message:
          `${path} does not exist, so a bare \`claude\` in this project starts an un-isolated session that looks ` +
          `exactly like an isolated one and says nothing (ADR 0012).`,
        hint,
      },
    ]);
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return check(id, title, "the committed settings file could not be read", { path, planted: null }, [
      {
        level: "problem",
        message: `${path} is not valid JSON: ${(err as Error).message}`,
        hint: "Fix it by hand — Claude Code reads this file too, and harv will not rewrite settings it cannot read.",
      },
    ]);
  }

  const planted = hasTripwire(settings);
  return check(
    id,
    title,
    planted ? "a bare `claude` here announces that it is not isolated" : "the Tripwire is missing",
    { path, planted },
    planted
      ? []
      : [
          {
            level: "problem",
            message:
              `${path} carries no SessionStart hook marked with HARV_SESSION, so a bare \`claude\` in this project ` +
              `loads your user scope instead of this Harvenv and never says so (ADR 0012).`,
            hint,
          },
        ],
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** A check's status is decided by its worst finding, never asserted separately. */
function check(
  id: string,
  title: string,
  summary: string,
  measurements: Record<string, unknown>,
  findings: Finding[],
): Check {
  const status: Status = findings.some((finding) => finding.level === "problem")
    ? "problem"
    : findings.some((finding) => finding.level === "unknown")
      ? "unknown"
      : "ok";
  return { id, title, status, summary, findings, measurements };
}

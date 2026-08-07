#!/usr/bin/env bun
/**
 * Doctor verification.
 *
 * The unit tests pin the diagnosis against harv's own modules; this script pins
 * the promise the command makes to a user, by running the real `harv` binary
 * against real projects, a real Store and real git repositories. It is the
 * acceptance criteria of issue #9, executed rather than asserted:
 *
 *   1. A healthy synced project reports every check green, and exits 0.
 *   2. Each failure class is detected with an actionable message: a launch
 *      recipe that regressed on this Claude Code, an MCP server waiting on
 *      first-time auth, a tool a session would not have, Manifest/Lockfile
 *      drift, and a missing Tripwire.
 *   3. `--json` is stable and machine-checkable.
 *
 * ## The stand-in `claude`
 *
 * Two of those failure classes are facts about a *session*, and one of them —
 * a launch recipe that stopped isolating — is a regression nobody can produce
 * on demand. So the checks that need one put a `claude` first on PATH that
 * emits a scripted `system`/`init` event: the same stream Doctor reads from the
 * real binary, saying whatever the scenario file names. A regression is then a
 * fixture rather than a wait, and "Doctor would catch it" stops being a claim.
 *
 * The last check removes the stand-in and runs Doctor against the machine's own
 * Claude Code, which is the measurement ADR 0003 actually asks for. It needs
 * credentials, so it reports `n/a` with the reason rather than failing on a
 * machine — or a runner — that has none.
 *
 * Nothing here touches the machine's Store, `~/.claude`, or its Overlay:
 * HARV_HOME points into the fixture tree, and every project is scratch. The
 * fixture root is salted per process, so two runs of this script — or a run
 * beside any other verifier — cannot delete each other's trees (issue #22).
 *
 * Run:  bun scripts/verify-doctor.ts [--json] [--keep]
 *       node scripts/verify-doctor.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MARKER_SKILL, VERIFIED_CLAUDE_CODE } from "../src/recipe.ts";
import { resolveRealClaude } from "../src/shim.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

/**
 * Salted per process, and cleaned up on the way out.
 *
 * The other verifiers build at a fixed path, which is why two of them running
 * at once destroy each other's fixtures (issue #22). `mkdtemp` is the whole
 * fix here: this script can run beside anything, including a second copy of
 * itself.
 */
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-doctor-verify-"));

const SKILL_NAME = "harv-doctor-skill";
const MISSING_TOOL = "harv-doctor-absent-tool";

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Completed {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Identity and signing forced, so the fixtures build on any machine. */
const GIT_FIXTURE = [
  "-c", "user.name=harvenv verification",
  "-c", "user.email=verify@harvenv.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

function git(args: string[], cwd: string): string {
  const result = runCommand("git", [...GIT_FIXTURE, ...args], cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

interface HarvOptions {
  /** Which scripted session the stand-in `claude` answers with. */
  scenario?: Scenario;
  /** Leave the stand-in off PATH, so the machine's own Claude Code is found. */
  realClaude?: boolean;
}

const harv = (args: string[], cwd: string, fx: Fixtures, options: HarvOptions = {}): Completed => {
  if (options.scenario !== undefined) writeFileSync(fx.scenarioFile, JSON.stringify(options.scenario));
  return runCommand(process.execPath, [HARV, ...args], cwd, {
    HARV_HOME: fx.store,
    HARV_DOCTOR_SCENARIO: fx.scenarioFile,
    ...(options.realClaude === true ? {} : { PATH: `${fx.claudeStub}${delimiter}${process.env.PATH ?? ""}` }),
  });
};

// ---------------------------------------------------------------------------
// The scripted session
// ---------------------------------------------------------------------------

interface Init {
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
 * What the stand-in answers, per probe. `bare` is the session Doctor starts
 * with no flags — the machine as it is — and `recipe` is the one under ADR
 * 0003's flags. `mcp` answers the third probe, the one that carries the
 * project's own `--mcp-config` payload.
 */
interface Scenario {
  version: string;
  bare: Init;
  recipe: Init;
  mcp?: Init;
}

const VERSION = VERIFIED_CLAUDE_CODE[0] ?? "2.1.223";

const init = (overrides: Partial<Init> = {}): Init => ({
  claude_code_version: VERSION,
  model: "claude-opus-5",
  permissionMode: "plan",
  skills: [MARKER_SKILL, "brainstorming"],
  slash_commands: [],
  agents: [],
  plugins: [],
  mcp_servers: [],
  tools: ["Read", "Edit"],
  ...overrides,
});

/** A machine with a personal pile: skills, a plugin and a server of its own. */
const populated = (overrides: Partial<Init> = {}): Init =>
  init({
    model: "claude-haiku-4-5",
    permissionMode: "acceptEdits",
    skills: ["someones-skill", "someones-plugin:namespaced", MARKER_SKILL, "brainstorming"],
    plugins: [{ name: "someones-plugin" }],
    mcp_servers: [{ name: "the-machines-own", status: "connected" }],
    ...overrides,
  });

/** Everything ADR 0003 promises, holding. */
const HEALTHY: Scenario = { version: VERSION, bare: populated(), recipe: init() };

/** The regression ADR 0003 says can arrive on any Claude Code release. */
const REGRESSED: Scenario = {
  version: VERSION,
  bare: populated(),
  recipe: init({
    plugins: [{ name: "someones-plugin" }],
    skills: ["someones-skill", "someones-plugin:namespaced", MARKER_SKILL, "brainstorming"],
  }),
};

const withServers = (scenario: Scenario, servers: Array<{ name: string; status: string }>): Scenario => ({
  ...scenario,
  mcp: init({ mcp_servers: servers }),
});

/**
 * A `claude` that reads its answer out of a file.
 *
 * It speaks exactly the two things Doctor asks a real one for: a version, and
 * the `system`/`init` line of a `--output-format stream-json` session. Anything
 * else it is handed it ignores, which is also what a probe expects — the real
 * binary emits banners and other events on the same stream.
 */
function writeClaudeStub(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.HARV_DOCTOR_SCENARIO, "utf8"));

if (argv.includes("--version")) {
  console.log(scenario.version + " (Claude Code)");
  process.exit(0);
}

// Which probe this is, told from the flags harv passed: the recipe carries an
// injected settings payload, and only the MCP probe carries a project's own.
const which = argv.includes("--settings") ? "recipe" : argv.includes("--mcp-config") ? "mcp" : "bare";
const event = scenario[which];
if (!event) {
  console.error("this scenario scripts no " + which + " session");
  process.exit(1);
}

console.log(JSON.stringify({ type: "system", subtype: "init", ...event }));
// The probe kills the session the moment init arrives, exactly as it does with
// a real one. Staying alive is what makes that the thing that ends this.
setTimeout(() => process.exit(0), 10_000);
`,
    { mode: 0o755 },
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** The repository the declared skill comes from. */
  repoUrl: string;
  /** A machine-global Store shared by every project in the run. */
  store: string;
  claudeStub: string;
  scenarioFile: string;
}

function buildFixtures(): Fixtures {
  const dir = (...parts: string[]): string => {
    const path = join(FIXTURE_ROOT, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };

  const repo = dir("source-repo");
  git(["init", "--quiet"], repo);
  const skill = join(repo, "skills", SKILL_NAME);
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: Marker skill for the harvenv doctor check. Never invoke it.\n---\n\nMarker only.\n`,
  );
  git(["add", "--all"], repo);
  git(["commit", "--quiet", "--message", "the skill harv doctor diagnoses"], repo);

  const claudeStub = dir("stubs", "claude");
  writeClaudeStub(claudeStub);

  return {
    repoUrl: `file://${repo}`,
    store: dir("store-home"),
    claudeStub,
    scenarioFile: join(FIXTURE_ROOT, "scenario.json"),
  };
}

/**
 * A project as a user would have it: `harv init`, one declared skill, and a
 * Sync that resolved it. Extra Manifest tables are appended before the Sync, so
 * the Lockfile they produce is the one a real `harv sync` writes.
 */
function syncedProject(fx: Fixtures, name: string, extraTables = ""): string {
  const root = join(FIXTURE_ROOT, name);
  mkdirSync(root, { recursive: true });

  const initialized = harv(["init"], root, fx);
  if (initialized.code !== 0) throw new Error(`harv init failed: ${initialized.stderr.trim()}`);

  const added = harv(["add", SKILL_NAME, "--git", `${fx.repoUrl}#skills/${SKILL_NAME}`], root, fx);
  if (added.code !== 0) throw new Error(`harv add failed: ${added.stderr.trim()}`);

  if (extraTables !== "") {
    appendFileSync(join(root, "harvenv.toml"), `\n${extraTables}`);
    const synced = harv(["sync"], root, fx);
    if (synced.code !== 0) throw new Error(`harv sync failed: ${synced.stderr.trim()}`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Reading a report
// ---------------------------------------------------------------------------

interface Finding {
  level: string;
  message: string;
  hint?: string;
}

interface ReportCheck {
  id: string;
  title: string;
  status: string;
  summary: string;
  findings: Finding[];
  measurements: Record<string, unknown>;
}

interface Report {
  version: number;
  ok: boolean;
  harv: { version: string; platform: string };
  project: { root: string; manifest: string; lockfile: string };
  claudeCode: { path: string | null; version: string | null; verified: boolean };
  checks: ReportCheck[];
  counts: Record<string, number>;
}

/** Every check id, in the order `--json` promises them. */
const CHECK_IDS = ["claude-code", "settings", "drift", "components", "toolchain", "mcp", "tripwire"];

const STATUSES = new Set(["ok", "problem", "unknown"]);
const LEVELS = new Set(["problem", "unknown", "note"]);

interface Diagnosis {
  exit: number | null;
  report: Report;
  stdout: string;
  stderr: string;
}

function doctor(cwd: string, fx: Fixtures, options: HarvOptions & { args?: string[] } = {}): Diagnosis {
  const result = harv(["doctor", "--json", ...(options.args ?? [])], cwd, fx, options);
  let report: Report;
  try {
    report = JSON.parse(result.stdout) as Report;
  } catch (err) {
    throw new Error(
      `harv doctor --json did not print a report (exit ${result.code}): ${(err as Error).message}\n` +
        `stdout: ${result.stdout.slice(0, 400)}\nstderr: ${result.stderr.slice(0, 400)}`,
    );
  }
  return { exit: result.code, report, stdout: result.stdout, stderr: result.stderr };
}

const checkOf = (report: Report, id: string): ReportCheck => {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check \`${id}\` in the report`);
  return found;
};

/** Everything one check said, as one string — message and hint alike. */
const said = (report: Report, id: string): string =>
  checkOf(report, id)
    .findings.map((finding) => `${finding.message}\n${finding.hint ?? ""}`)
    .join("\n");

const notOk = (report: Report): string[] =>
  report.checks.filter((check) => check.status !== "ok").map((check) => `${check.id}=${check.status}`);

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

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

/** One line of a message, for a detail column that has to stay one line. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 150 ? `${flat.slice(0, 150)}…` : flat || "(said nothing)";
};

// ---------------------------------------------------------------------------
// Criterion 1 — a healthy synced project reports all green
// ---------------------------------------------------------------------------

function checkHealthy(fx: Fixtures): Check {
  const root = syncedProject(fx, "healthy");
  const { exit, report, stderr } = doctor(root, fx, { scenario: HEALTHY });

  const recipe = checkOf(report, "claude-code");
  const measured = recipe.measurements.observations as Array<{ ok: boolean | null }> | undefined;

  return {
    id: "healthy",
    title: "A healthy synced project reports every check green",
    measurements: {
      exit,
      statuses: Object.fromEntries(report.checks.map((check) => [check.id, check.status])),
      summaries: Object.fromEntries(report.checks.map((check) => [check.id, check.summary])),
      counts: report.counts,
    },
    expectations: [
      expect("every check is green", notOk(report).length === 0, notOk(report).join(", ") || "all seven are `ok`"),
      expect("the report says so", report.ok === true && report.counts.problem === 0, `ok=${report.ok}`),
      expect("and exits 0", exit === 0, `exit ${exit}`),
      expect("nothing is written to stderr", stderr === "", stderr.trim().slice(0, 120) || "(empty)"),
      expect(
        "the launch recipe was measured, not assumed",
        recipe.measurements.smokeTest === "measured" && (measured?.length ?? 0) > 0,
        `${measured?.filter((o) => o.ok === true).length ?? 0}/${measured?.length ?? 0} behaviours held on ` +
          `Claude Code ${report.claudeCode.version}`,
      ),
      expect(
        "the Lockfile's Components were found in the Store",
        checkOf(report, "components").summary.includes("1/1"),
        checkOf(report, "components").summary,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2a — a launch recipe that regressed on this Claude Code
// ---------------------------------------------------------------------------

function checkVersionRegression(fx: Fixtures): Check {
  const root = join(FIXTURE_ROOT, "healthy");
  const { exit, report } = doctor(root, fx, { scenario: REGRESSED });
  const recipe = checkOf(report, "claude-code");
  const message = said(report, "claude-code");

  return {
    id: "version-regression",
    title: "A Claude Code whose flags stopped isolating is caught and named",
    measurements: { exit, status: recipe.status, findings: recipe.findings, summary: recipe.summary },
    expectations: [
      expect("the smoke test fails the check", recipe.status === "problem", `claude-code=${recipe.status}`),
      expect("and the command", exit === 1 && report.ok === false, `exit ${exit}, ok=${report.ok}`),
      expect(
        "the message names the behaviour that stopped holding",
        /user scope reaches the session/.test(message) && /someones-plugin/.test(message),
        oneLine(recipe.findings[0]?.message ?? ""),
      ),
      expect(
        "the leaked namespaced Component is named too",
        /someones-plugin:namespaced/.test(message),
        oneLine(recipe.findings[1]?.message ?? ""),
      ),
      expect(
        "the hint says what to do about a version regression",
        /Pin a Claude Code version/.test(message),
        oneLine(recipe.findings[0]?.hint ?? ""),
      ),
      expect(
        "the version it regressed on is in the report",
        report.claudeCode.version === VERSION,
        `Claude Code ${report.claudeCode.version}`,
      ),
      expect(
        "one failing check does not hide the others",
        notOk(report).length === 1,
        `not ok: ${notOk(report).join(", ")}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2b — an MCP server waiting on first-time auth
// ---------------------------------------------------------------------------

function checkPendingAuth(fx: Fixtures): Check {
  const root = syncedProject(
    fx,
    "with-mcp",
    '[mcp.tickets]\ntype = "http"\nurl = "https://tickets.invalid/mcp"\n',
  );

  const waiting = doctor(root, fx, { scenario: withServers(HEALTHY, [{ name: "tickets", status: "needs-auth" }]) });
  const message = said(waiting.report, "mcp");
  const granted = doctor(root, fx, { scenario: withServers(HEALTHY, [{ name: "tickets", status: "connected" }]) });
  const registering = doctor(root, fx, { scenario: withServers(HEALTHY, [{ name: "tickets", status: "pending" }]) });

  return {
    id: "pending-auth",
    title: "An MCP server still needing first-time auth is reported, with what to do",
    measurements: {
      needsAuth: { exit: waiting.exit, status: checkOf(waiting.report, "mcp").status },
      connected: { exit: granted.exit, status: checkOf(granted.report, "mcp").status },
      pending: { exit: registering.exit, status: checkOf(registering.report, "mcp").status },
      findings: checkOf(waiting.report, "mcp").findings,
    },
    expectations: [
      expect(
        "a server waiting on auth fails the check",
        checkOf(waiting.report, "mcp").status === "problem" && waiting.exit === 1,
        `mcp=${checkOf(waiting.report, "mcp").status}, exit ${waiting.exit}`,
      ),
      expect(
        "the message names the server and the state it is in",
        /tickets/.test(message) && /first-time authentication/.test(message),
        oneLine(checkOf(waiting.report, "mcp").findings[0]?.message ?? ""),
      ),
      expect(
        "the hint is the flow that fixes it, and says it is personal",
        /`\/mcp`/.test(message) && /not a Component/.test(message),
        oneLine(checkOf(waiting.report, "mcp").findings[0]?.hint ?? ""),
      ),
      expect(
        "the same server, authorized, is green",
        checkOf(granted.report, "mcp").status === "ok" && granted.exit === 0,
        `mcp=${checkOf(granted.report, "mcp").status}, exit ${granted.exit}`,
      ),
      expect(
        "a server still registering is unverified rather than failed",
        checkOf(registering.report, "mcp").status === "unknown" && registering.exit === 0,
        `mcp=${checkOf(registering.report, "mcp").status}, exit ${registering.exit} — ` +
          "init races MCP registration (spike 0001), so a pending server must not become a verdict",
      ),
      expect(
        "the measured status is in the report either way",
        JSON.stringify(checkOf(waiting.report, "mcp").measurements.statuses) === '{"tickets":"needs-auth"}',
        JSON.stringify(checkOf(waiting.report, "mcp").measurements.statuses),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2c — a tool a session would not have
// ---------------------------------------------------------------------------

function checkMissingTool(fx: Fixtures): Check {
  // No install engine reachable, so `harv sync` records the requirement as the
  // hint ADR 0006 degrades to rather than failing — which is exactly the state
  // Doctor exists to surface.
  const root = syncedProject(fx, "with-tool", `[tools]\n${MISSING_TOOL} = "1"\n`);
  // `[[tools]]` is the last table `harv sync` writes, so this is the Toolchain's
  // half of the Lockfile and not the file's own `version = 2` header.
  const lockfile = readFileSync(join(root, "harvenv.lock"), "utf8");
  const locked = lockfile.slice(lockfile.indexOf("[[tools]]"));

  const { exit, report } = doctor(root, fx, { scenario: HEALTHY });
  const toolchain = checkOf(report, "toolchain");
  const message = said(report, "toolchain");

  return {
    id: "missing-tool",
    title: "A tool that could not be scoped and is nowhere on PATH is reported",
    measurements: {
      exit,
      status: toolchain.status,
      summary: toolchain.summary,
      findings: toolchain.findings,
      lockedAsHint: locked.trim(),
    },
    expectations: [
      expect(
        "`harv sync` recorded it as a hint rather than failing",
        locked.includes(MISSING_TOOL) && locked.includes("hint =") && !locked.includes("version ="),
        `harvenv.lock carries ${MISSING_TOOL} with a hint and no version`,
      ),
      expect(
        "Doctor turns that recorded hint into a problem",
        toolchain.status === "problem" && exit === 1,
        `toolchain=${toolchain.status}, exit ${exit}`,
      ),
      expect(
        "the message names the tool and says a skill will fail on it",
        new RegExp(MISSING_TOOL).test(message) && /will fail at the moment it runs/.test(message),
        oneLine(toolchain.findings[0]?.message ?? ""),
      ),
      expect(
        "the hint carries the reason harv could not scope it",
        /no scoped installer|no install engine/.test(message),
        oneLine(toolchain.findings[0]?.message ?? ""),
      ),
      expect(
        "and what to do instead",
        new RegExp(`Install ${MISSING_TOOL}`).test(message),
        oneLine(toolchain.findings[0]?.hint ?? ""),
      ),
      expect(
        "a tool the machine does have is a note, not a failure",
        (() => {
          const withGit = syncedProject(fx, "with-present-tool", '[tools]\ngit = "2"\n');
          const present = doctor(withGit, fx, { scenario: HEALTHY });
          return checkOf(present.report, "toolchain").status === "ok" && present.exit === 0;
        })(),
        "ADR 0006's degradation path is only a problem when the machine cannot cover it",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2d — Manifest/Lockfile drift
// ---------------------------------------------------------------------------

function checkDrift(fx: Fixtures): Check {
  const root = syncedProject(fx, "drifted");
  const manifest = join(root, "harvenv.toml");
  const before = readFileSync(manifest, "utf8");

  writeFileSync(
    manifest,
    before.replace(
      `${SKILL_NAME} = { git = "${fx.repoUrl}", subdir = "skills/${SKILL_NAME}" }`,
      `${SKILL_NAME} = { git = "${fx.repoUrl}", ref = "main", subdir = "skills/${SKILL_NAME}" }`,
    ),
  );

  const { exit, report } = doctor(root, fx, { scenario: HEALTHY });
  const drift = checkOf(report, "drift");
  const message = said(report, "drift");

  // Drift is reconcilable, and saying so is half of the message being
  // actionable: the remedy Doctor names has to be one that works.
  const synced = harv(["sync"], root, fx);
  const after = doctor(root, fx, { scenario: HEALTHY });

  return {
    id: "drift",
    title: "Manifest/Lockfile drift is detected, named, and reconcilable",
    measurements: { exit, status: drift.status, findings: drift.findings, resyncExit: synced.code },
    expectations: [
      expect("drift fails the check", drift.status === "problem" && exit === 1, `drift=${drift.status}, exit ${exit}`),
      expect(
        "the message names the entry",
        new RegExp(SKILL_NAME).test(message),
        oneLine(drift.findings[0]?.message ?? ""),
      ),
      expect(
        "and quotes both coordinates, so the difference is visible",
        /locked .*Manifest says/s.test(message) && /ref|main/.test(message),
        oneLine(drift.findings[0]?.message ?? ""),
      ),
      expect("the hint is the remedy", /harv sync/.test(message), oneLine(drift.findings[0]?.hint ?? "")),
      expect(
        "and that remedy works: after `harv sync` the project is green again",
        synced.code === 0 && after.exit === 0 && notOk(after.report).length === 0,
        `sync exit ${synced.code}, doctor exit ${after.exit}`,
      ),
      expect(
        "a Component the Store no longer holds is caught too",
        (() => {
          const store = join(fx.store, "store", "sha256");
          rmSync(store, { recursive: true, force: true });
          const emptied = doctor(root, fx, { scenario: HEALTHY });
          return (
            checkOf(emptied.report, "components").status === "problem" &&
            /the Store does not hold those bytes/.test(said(emptied.report, "components")) &&
            emptied.exit === 1
          );
        })(),
        "a pruned Store is a different failure from drift, and reported as one",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2e — a missing Tripwire
// ---------------------------------------------------------------------------

function checkMissingTripwire(fx: Fixtures): Check {
  const root = syncedProject(fx, "no-tripwire");
  const settings = join(root, ".claude", "settings.json");
  rmSync(settings, { force: true });

  const { exit, report } = doctor(root, fx, { scenario: HEALTHY });
  const tripwire = checkOf(report, "tripwire");
  const message = said(report, "tripwire");

  // The same project once the hook is back — `harv init` is the remedy Doctor
  // names, so it has to be the one that clears the finding.
  const reinit = harv(["init"], root, fx);
  const after = doctor(root, fx, { scenario: HEALTHY });

  // And a settings file that exists but carries somebody else's hooks: the
  // Tripwire is recognized by the marker, not by the file being present.
  const other = syncedProject(fx, "other-hooks");
  writeFileSync(
    join(other, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }] } }, null, 2),
  );
  const unmarked = doctor(other, fx, { scenario: HEALTHY });

  return {
    id: "missing-tripwire",
    title: "A project whose bare `claude` would say nothing is reported",
    measurements: {
      exit,
      status: tripwire.status,
      findings: tripwire.findings,
      afterInit: checkOf(after.report, "tripwire").status,
      unmarkedHooks: checkOf(unmarked.report, "tripwire").status,
    },
    expectations: [
      expect(
        "a missing settings file fails the check",
        tripwire.status === "problem" && exit === 1,
        `tripwire=${tripwire.status}, exit ${exit}`,
      ),
      expect(
        "the message says what a bare `claude` would silently do",
        /un-isolated session/.test(message) && /ADR 0012/.test(message),
        oneLine(tripwire.findings[0]?.message ?? ""),
      ),
      expect("the hint is `harv init`", /harv init/.test(message), oneLine(tripwire.findings[0]?.hint ?? "")),
      expect(
        "and `harv init` clears it",
        reinit.code === 0 &&
          checkOf(after.report, "tripwire").status === "ok" &&
          existsSync(settings) &&
          after.exit === 0,
        `init exit ${reinit.code}, tripwire=${checkOf(after.report, "tripwire").status}`,
      ),
      expect(
        "a settings file carrying somebody else's SessionStart hooks is still a missing Tripwire",
        checkOf(unmarked.report, "tripwire").status === "problem" &&
          /HARV_SESSION/.test(said(unmarked.report, "tripwire")),
        oneLine(checkOf(unmarked.report, "tripwire").findings[0]?.message ?? ""),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — `--json` is stable and machine-checkable
// ---------------------------------------------------------------------------

function checkJsonIsStable(fx: Fixtures): Check {
  const healthy = doctor(join(FIXTURE_ROOT, "healthy"), fx, { scenario: HEALTHY });

  // A synced project with as many things wrong at once as this slice can
  // produce: a Claude Code whose flags stopped isolating, a Manifest that moved
  // past its Lockfile, a tool nothing can install, a server waiting on auth,
  // and a Tripwire somebody deleted.
  const broken = syncedProject(
    fx,
    "broken",
    `[tools]\n${MISSING_TOOL} = "1"\n\n[mcp.tickets]\ntype = "http"\nurl = "https://tickets.invalid/mcp"\n`,
  );
  const manifest = join(broken, "harvenv.toml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(`subdir = "skills/${SKILL_NAME}"`, `ref = "main", subdir = "skills/${SKILL_NAME}"`),
  );
  rmSync(join(broken, ".claude", "settings.json"), { force: true });

  const sick = doctor(broken, fx, {
    scenario: withServers(REGRESSED, [{ name: "tickets", status: "needs-auth" }]),
  });

  const reports = [healthy.report, sick.report];
  const ids = reports.map((report) => report.checks.map((check) => check.id));
  const findings = reports.flatMap((report) => report.checks.flatMap((check) => check.findings));
  const problems = findings.filter((finding) => finding.level === "problem");

  return {
    id: "json",
    title: "`--json` is stable and machine-checkable",
    measurements: {
      ids: ids[0],
      healthy: { exit: healthy.exit, ok: healthy.report.ok, counts: healthy.report.counts },
      broken: {
        exit: sick.exit,
        ok: sick.report.ok,
        counts: sick.report.counts,
        statuses: Object.fromEntries(sick.report.checks.map((check) => [check.id, check.status])),
      },
    },
    expectations: [
      expect(
        "stdout is the report and nothing else, in both states",
        healthy.stdout.trimStart().startsWith("{") && sick.stdout.trimStart().startsWith("{"),
        "parsed as JSON without stripping anything",
      ),
      expect(
        "the report carries its own format version",
        reports.every((report) => report.version === 1),
        `version ${healthy.report.version}`,
      ),
      expect(
        "every check is present, in the same order, whatever is wrong",
        ids.every((list) => JSON.stringify(list) === JSON.stringify(CHECK_IDS)),
        (ids[0] ?? []).join(", "),
      ),
      expect(
        "every status is one of ok/problem/unknown",
        reports.every((report) => report.checks.every((check) => STATUSES.has(check.status))),
        [...STATUSES].join(", "),
      ),
      expect(
        "every finding level is one of problem/unknown/note",
        findings.every((finding) => LEVELS.has(finding.level)),
        `${findings.length} findings across both reports`,
      ),
      expect(
        "every problem carries a hint, so a report is never a dead end",
        problems.length > 0 && problems.every((finding) => typeof finding.hint === "string" && finding.hint !== ""),
        `${problems.length} problems, all with a hint`,
      ),
      expect(
        "`ok` agrees with the counts and with the exit code",
        reports.every((report) => report.ok === (report.counts.problem === 0)) &&
          healthy.report.ok === (healthy.exit === 0) &&
          sick.report.ok === (sick.exit === 0),
        `healthy: ok=${healthy.report.ok} exit=${healthy.exit}; broken: ok=${sick.report.ok} exit=${sick.exit}`,
      ),
      expect(
        "a CI gate can read the version it ran against",
        typeof sick.report.claudeCode.version === "string" && typeof sick.report.claudeCode.verified === "boolean",
        `claudeCode ${sick.report.claudeCode.version}, verified=${sick.report.claudeCode.verified}`,
      ),
      expect(
        "several failure classes are reported at once rather than one at a time",
        ["claude-code", "drift", "toolchain", "mcp", "tripwire"].every(
          (id) => checkOf(sick.report, id).status === "problem",
        ),
        Object.entries(Object.fromEntries(sick.report.checks.map((c) => [c.id, c.status])))
          .map(([id, status]) => `${id}=${status}`)
          .join(", "),
      ),
      expect(
        "`--no-session` starts nothing, and says which checks it therefore could not make",
        (() => {
          const offline = doctor(join(FIXTURE_ROOT, "with-mcp"), fx, {
            scenario: HEALTHY,
            args: ["--no-session"],
          });
          return (
            checkOf(offline.report, "claude-code").measurements.smokeTest === "skipped" &&
            checkOf(offline.report, "mcp").measurements.live === "skipped" &&
            offline.exit === 0
          );
        })(),
        "a machine with no credentials still gets a report, and knows what is missing from it",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// The measurement ADR 0003 actually asks for: this machine's own Claude Code
// ---------------------------------------------------------------------------

function checkLiveRecipe(fx: Fixtures): Check {
  const found = resolveRealClaude(process.env.PATH ?? "");
  if (found === null) {
    return {
      id: "live-recipe",
      title: "The launch recipe, measured against the Claude Code on this machine",
      measurements: { claude: null },
      expectations: [
        expect("Claude Code is installed here", null, "no `claude` on PATH — nothing to measure the recipe against"),
      ],
    };
  }

  const { exit, report } = doctor(join(FIXTURE_ROOT, "healthy"), fx, { realClaude: true });
  const recipe = checkOf(report, "claude-code");
  const observations = (recipe.measurements.observations ?? []) as Array<{ label: string; ok: boolean | null; detail: string }>;
  const measured = recipe.measurements.smokeTest === "measured";

  return {
    id: "live-recipe",
    title: "The launch recipe, measured against the Claude Code on this machine",
    measurements: {
      claude: report.claudeCode,
      smokeTest: recipe.measurements.smokeTest,
      observations,
      bare: recipe.measurements.bare,
      recipe: recipe.measurements.recipe,
      exit,
    },
    expectations: [
      expect(
        "a session could be started to measure with",
        measured ? true : null,
        measured ? `Claude Code ${report.claudeCode.version}` : oneLine(said(report, "claude-code")),
      ),
      ...(measured
        ? observations.map((observation) => expect(observation.label, observation.ok, observation.detail))
        : []),
      expect(
        "an unmeasurable session is unverified, never a regression",
        measured ? true : recipe.status === "unknown" && exit === 0,
        measured ? "measured, so this case did not arise" : `claude-code=${recipe.status}, exit ${exit}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const failed = (c: Check): boolean => Boolean(c.error) || c.expectations.some((e) => e.ok === false);

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
  log("harvenv doctor verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  // Ordered, not independent: the first check builds the healthy project the
  // regression and JSON checks then diagnose, exactly as a user would have it.
  const runners: Array<[string, string, () => Check]> = [
    ["healthy", "A healthy synced project reports every check green", () => checkHealthy(fx)],
    ["version-regression", "A Claude Code whose flags stopped isolating is caught and named", () => checkVersionRegression(fx)],
    ["pending-auth", "An MCP server still needing first-time auth is reported", () => checkPendingAuth(fx)],
    ["missing-tool", "A tool that could not be scoped and is nowhere on PATH is reported", () => checkMissingTool(fx)],
    ["drift", "Manifest/Lockfile drift is detected, named, and reconcilable", () => checkDrift(fx)],
    ["missing-tripwire", "A project whose bare `claude` would say nothing is reported", () => checkMissingTripwire(fx)],
    ["json", "`--json` is stable and machine-checkable", () => checkJsonIsStable(fx)],
    ["live-recipe", "The launch recipe, measured against this machine's Claude Code", () => checkLiveRecipe(fx)],
  ];

  const checks: Check[] = [];
  for (const [id, title, runCheck] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(runCheck());
    } catch (err) {
      checks.push({ id, title, expectations: [], measurements: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (keep) log(`\n${DIM}fixtures kept at ${FIXTURE_ROOT}${RESET}`);
  else rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const failures = checks.filter(failed);
  if (asJson) {
    console.log(JSON.stringify({ ok: failures.length === 0, fixtures: keep ? FIXTURE_ROOT : null, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\n${checks.length - failures.length}/${checks.length} criteria verified` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

if (!existsSync(HARV)) throw new Error(`harv entry point not found at ${HARV}`);
process.exitCode = await main();

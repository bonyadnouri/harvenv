import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { diagnose, REPORT_VERSION } from "../src/doctor.ts";
import type { Check, DoctorDeps, Report, Status } from "../src/doctor.ts";
import { writeLockfile } from "../src/lockfile.ts";
import { loadManifest } from "../src/manifest.ts";
import type { Manifest } from "../src/manifest.ts";
import { OVERLAY_LOCKFILE } from "../src/overlay.ts";
import type { InitEvent, Probe, ProbeRequest } from "../src/recipe.ts";
import { MARKER_SKILL, VERIFIED_CLAUDE_CODE } from "../src/recipe.ts";
import { hashTree, insert, storeRoot } from "../src/store.ts";
import type { Env } from "../src/store.ts";
import { tripwireHook } from "../src/tripwire.ts";
import { skillFile, tempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A directory holding a `claude` that answers `--version` and nothing else.
 *
 * Doctor resolves the binary off PATH before it decides whether a session can
 * be started at all, so a fixture with no `claude` would report "not on PATH"
 * and never reach the checks these tests are about. Built once: the version
 * string is the only thing that varies, and nothing here ever runs it twice.
 */
let claudeBin: string | undefined;
function claudeOnPath(): string {
  if (claudeBin !== undefined) return claudeBin;
  claudeBin = tempDir();
  writeFileSync(join(claudeBin, "claude"), `#!/bin/sh\necho "${VERIFIED_CLAUDE_CODE[0] ?? "2.1.223"} (Claude Code)"\n`, {
    mode: 0o755,
  });
  return claudeBin;
}

/**
 * A project with a Manifest, a committed Tripwire, and a Store of its own.
 *
 * The Tripwire is planted by default because its absence is one of the failure
 * classes under test — a fixture that omitted it would put a problem into every
 * other test's report and make "reports all green" impossible to check.
 */
function project(body = "", options: { tripwire?: boolean } = {}): { manifest: Manifest; env: Env } {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), body);
  if (options.tripwire !== false) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({ hooks: { SessionStart: [tripwireHook()] } }, null, 2)}\n`,
    );
  }
  return { manifest: loadManifest(join(root, "harvenv.toml")), env: { HARV_HOME: tempDir(), PATH: claudeOnPath() } };
}

/** A skill directory in the Store, and the content hash that addresses it. */
function stored(name: string, env: Env): string {
  const staged = join(tempDir(), name);
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, "SKILL.md"), skillFile(name));
  const hash = hashTree(staged);
  mkdirSync(storeRoot(env), { recursive: true });
  insert(staged, hash, env);
  return hash;
}

const COMMIT = "a".repeat(40);

/** An `init` event in which every ADR 0003 behaviour still holds. */
function isolatedInit(overrides: Partial<InitEvent> = {}): InitEvent {
  return {
    claude_code_version: VERIFIED_CLAUDE_CODE[0] ?? "2.1.223",
    model: "claude-opus-5",
    permissionMode: "plan",
    skills: [MARKER_SKILL, "brainstorming-builtin"],
    slash_commands: [],
    agents: [],
    plugins: [],
    mcp_servers: [],
    tools: ["Read"],
    ...overrides,
  };
}

/** What a bare session on a machine with a populated user scope looks like. */
const bareInit = (overrides: Partial<InitEvent> = {}): InitEvent =>
  isolatedInit({
    model: "claude-haiku-4-5",
    permissionMode: "acceptEdits",
    skills: ["personal-a", "personal-b", "personal-c", MARKER_SKILL, "brainstorming-builtin"],
    plugins: [{ name: "someones-plugin" }],
    mcp_servers: [{ name: "the-machines-own", status: "connected" }],
    ...overrides,
  });

/**
 * A probe that answers the bare call and the recipe call differently, so a test
 * can describe a machine rather than a single session.
 */
function probes(answers: { bare?: Probe; recipe?: Probe; mcp?: Probe }): {
  probe: DoctorDeps["probe"];
  requests: ProbeRequest[];
} {
  const requests: ProbeRequest[] = [];
  return {
    requests,
    probe: async (request) => {
      requests.push(request);
      if (request.args.length === 0) return answers.bare ?? { init: bareInit() };
      if (request.args.includes("--settings")) return answers.recipe ?? { init: isolatedInit() };
      return answers.mcp ?? { unobservable: "no MCP probe was arranged in this test" };
    },
  };
}

const run = (fixture: { manifest: Manifest; env: Env }, overrides: Partial<DoctorDeps> = {}): Promise<Report> =>
  diagnose({
    manifest: fixture.manifest,
    env: fixture.env,
    overlay: true,
    session: false,
    probe: async () => ({ unobservable: "no session in this test" }),
    ...overrides,
  });

const of = (report: Report, id: string): Check => {
  const check = report.checks.find((entry) => entry.id === id);
  assert.ok(check !== undefined, `no check \`${id}\` in the report`);
  return check;
};

const statusOf = (report: Report, id: string): Status => of(report, id).status;

const said = (report: Report, id: string): string =>
  of(report, id)
    .findings.map((finding) => `${finding.message} ${finding.hint ?? ""}`)
    .join("\n");

// ---------------------------------------------------------------------------
// The shape of a report
// ---------------------------------------------------------------------------

/** The `--json` contract: a CI gate reads these without asking what a project has. */
const CHECKS = ["claude-code", "settings", "drift", "components", "toolchain", "mcp", "tripwire"];

test("every check is present, in a fixed order, whatever the project contains", async () => {
  const empty = await run(project());
  const full = await run(project('[skills]\nghost = { git = "https://example.invalid/x.git" }\n'));

  assert.deepEqual(
    empty.checks.map((check) => check.id),
    CHECKS,
  );
  assert.deepEqual(
    full.checks.map((check) => check.id),
    CHECKS,
  );
});

test("the report carries its format version, and every check a summary", async () => {
  const report = await run(project());

  assert.equal(report.version, REPORT_VERSION);
  for (const check of report.checks) {
    assert.notEqual(check.summary, "", `check \`${check.id}\` has no summary`);
    assert.ok(["ok", "problem", "unknown"].includes(check.status));
  }
});

test("a problem sets ok false; an unverified check does not", async () => {
  const healthy = await run(project(), { session: true, probe: probes({}).probe });
  assert.equal(healthy.ok, true);

  const unmeasurable = await run(project(), {
    session: true,
    probe: async () => ({ unobservable: "no credentials on this machine" }),
  });
  assert.equal(statusOf(unmeasurable, "claude-code"), "unknown");
  assert.equal(unmeasurable.ok, true, "an honest `could not check` must not fail the command");

  const broken = await run(project("", { tripwire: false }));
  assert.equal(broken.ok, false);
});

test("every problem carries a hint, so a report is never a dead end", async () => {
  const fixture = project('[skills]\nghost = { git = "https://example.invalid/ghost.git" }\n', { tripwire: false });

  const report = await run(fixture);

  const problems = report.checks.flatMap((check) => check.findings).filter((f) => f.level === "problem");
  assert.ok(problems.length > 0);
  for (const problem of problems) assert.ok(problem.hint !== undefined, `no hint on: ${problem.message}`);
});

// ---------------------------------------------------------------------------
// A healthy project
// ---------------------------------------------------------------------------

test("a healthy synced project reports every check green", async () => {
  const fixture = project('[skills]\nalpha = { git = "https://example.invalid/alpha.git" }\n');
  const hash = stored("alpha", fixture.env);
  writeLockfile(fixture.manifest.root, [
    { name: "alpha", source: { kind: "git", repo: "https://example.invalid/alpha.git" }, commit: COMMIT, hash },
  ]);

  const report = await run(fixture, { session: true, probe: probes({}).probe });

  assert.deepEqual(
    report.checks.filter((check) => check.status !== "ok").map((check) => check.id),
    [],
    JSON.stringify(report.checks.flatMap((c) => c.findings)),
  );
  assert.equal(report.ok, true);
});

// ---------------------------------------------------------------------------
// Failure class: the launch recipe regressed on this Claude Code
// ---------------------------------------------------------------------------

test("a recipe that stopped suppressing user scope is a problem naming the behaviour", async () => {
  const regressed = probes({
    recipe: { init: isolatedInit({ plugins: [{ name: "someones-plugin" }], skills: ["someones-plugin:leaked"] }) },
  });

  const report = await run(project(), { session: true, probe: regressed.probe });

  assert.equal(statusOf(report, "claude-code"), "problem");
  assert.match(said(report, "claude-code"), /no plugin from the machine's user scope reaches the session/);
  assert.match(said(report, "claude-code"), /someones-plugin/);
  assert.match(said(report, "claude-code"), /Pin a Claude Code version/);
  assert.equal(report.ok, false);
});

test("a recipe whose --settings stopped winning is a problem too", async () => {
  const regressed = probes({ recipe: { init: isolatedInit({ model: "claude-haiku-4-5", permissionMode: "acceptEdits" }) } });

  const report = await run(project(), { session: true, probe: regressed.probe });

  assert.equal(statusOf(report, "claude-code"), "problem");
  assert.match(said(report, "claude-code"), /`--settings` outranks/);
});

test("a session that cannot be started is unverified, not a regression", async () => {
  const report = await run(project(), {
    session: true,
    probe: async () => ({ unobservable: "claude exited (code 1) before reporting a session: Invalid API key" }),
  });

  assert.equal(statusOf(report, "claude-code"), "unknown");
  assert.match(said(report, "claude-code"), /Invalid API key/);
  assert.equal(report.ok, true);
});

test("--no-session on a verified Claude Code is a note; on an unverified one it is unverified", async () => {
  const verified = await run(project(), { session: false });
  assert.equal(statusOf(verified, "claude-code"), "ok");
  assert.match(said(verified, "claude-code"), /a version harv has verified it against/);
});

test("a machine with no claude at all cannot run this Harvenv, and says so", async () => {
  const fixture = project();
  const report = await run({ ...fixture, env: { ...fixture.env, PATH: join(tempDir(), "empty") } });

  assert.equal(statusOf(report, "claude-code"), "problem");
  assert.match(said(report, "claude-code"), /not on this machine's PATH/);
  assert.equal(report.claudeCode.path, null);
});

test("an empty user scope makes suppression unverifiable rather than green", async () => {
  // Nothing to take away: the bare session is already the built-ins, so a
  // suppression check that passed here would be passing for the wrong reason.
  const barren = probes({ bare: { init: isolatedInit() } });

  const report = await run(project(), { session: true, probe: barren.probe });

  assert.equal(statusOf(report, "claude-code"), "unknown");
  assert.match(said(report, "claude-code"), /contributes no skills or plugins to suppress/);
  assert.equal(report.ok, true);
});

// ---------------------------------------------------------------------------
// Failure class: Manifest/Lockfile drift
// ---------------------------------------------------------------------------

test("a Manifest entry that is not in the Lockfile is drift, with `harv sync` as the remedy", async () => {
  const fixture = project('[skills]\nalpha = { git = "https://example.invalid/alpha.git" }\n');

  const report = await run(fixture);

  assert.equal(statusOf(report, "drift"), "problem");
  assert.match(said(report, "drift"), /alpha: declared in the Manifest but not locked/);
  assert.match(said(report, "drift"), /harv sync/);
});

test("a Source that moved under its pin is drift naming both coordinates", async () => {
  const fixture = project('[skills]\nalpha = { git = "https://example.invalid/alpha.git", ref = "v2" }\n');
  const hash = stored("alpha", fixture.env);
  writeLockfile(fixture.manifest.root, [
    {
      name: "alpha",
      source: { kind: "git", repo: "https://example.invalid/alpha.git", ref: "v1" },
      commit: COMMIT,
      hash,
    },
  ]);

  const report = await run(fixture);

  assert.equal(statusOf(report, "drift"), "problem");
  assert.match(said(report, "drift"), /locked https:\/\/example\.invalid\/alpha\.git@v1/);
  assert.match(said(report, "drift"), /the Manifest says https:\/\/example\.invalid\/alpha\.git@v2/);
});

test("a tool the Lockfile does not pin is drift naming who needs it", async () => {
  const fixture = project('[tools]\nnode = "22"\n');

  const report = await run(fixture);

  assert.equal(statusOf(report, "drift"), "problem");
  assert.match(said(report, "drift"), /node: needed by the Manifest but not locked/);
});

test("a Manifest that declares nothing needs no Lockfile", async () => {
  const report = await run(project());

  assert.equal(statusOf(report, "drift"), "ok");
  assert.match(of(report, "drift").summary, /needs no Lockfile/);
});

test("an unreadable Lockfile is one problem, not a wall of missing entries", async () => {
  const fixture = project('[skills]\nalpha = { git = "https://example.invalid/alpha.git" }\n');
  writeFileSync(join(fixture.manifest.root, "harvenv.lock"), "version = 99\n");

  const report = await run(fixture);

  assert.equal(statusOf(report, "drift"), "problem");
  assert.equal(of(report, "drift").findings.length, 1);
  assert.match(said(report, "drift"), /version 99/);
  assert.equal(statusOf(report, "components"), "unknown");
});

// ---------------------------------------------------------------------------
// Failure class: a Component the machine does not have
// ---------------------------------------------------------------------------

test("a locked Component the Store does not hold is a problem naming the hash", async () => {
  const fixture = project('[skills]\nalpha = { git = "https://example.invalid/alpha.git" }\n');
  const hash = `sha256:${"b".repeat(64)}`;
  writeLockfile(fixture.manifest.root, [
    { name: "alpha", source: { kind: "git", repo: "https://example.invalid/alpha.git" }, commit: COMMIT, hash },
  ]);

  const report = await run(fixture);

  assert.equal(statusOf(report, "components"), "problem");
  assert.match(said(report, "components"), new RegExp(hash));
  assert.match(said(report, "components"), /harv sync/);
});

test("a path Source whose directory is gone is a problem naming the directory", async () => {
  const gone = join(tempDir(), "vendor", "scratch");
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, "SKILL.md"), skillFile("scratch"));
  const fixture = project(`[skills]\nscratch = { path = ${JSON.stringify(gone)} }\n`);
  writeLockfile(fixture.manifest.root, [
    { name: "scratch", source: { kind: "path", declared: gone, path: gone } },
  ]);
  rmSync(gone, { recursive: true, force: true });

  const report = await run(fixture);

  assert.equal(statusOf(report, "components"), "problem");
  assert.match(said(report, "components"), /which does not exist/);
});

test("an Overlay staple the Store does not hold is a problem too", async () => {
  const fixture = project();
  const overlay = join(fixture.manifest.root, "harvenv.local.toml");
  writeFileSync(overlay, '[skills]\nstaple = { git = "https://example.invalid/staple.git" }\n');
  writeLockfile(
    fixture.manifest.root,
    [
      {
        name: "staple",
        source: { kind: "git", repo: "https://example.invalid/staple.git" },
        commit: COMMIT,
        hash: `sha256:${"c".repeat(64)}`,
      },
    ],
    [],
    [],
    OVERLAY_LOCKFILE,
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "components"), "problem");
  assert.match(said(report, "components"), /Overlay skill `staple`/);
});

test("an Overlay plugin the Store does not hold is a problem too", async () => {
  const fixture = project();
  writeFileSync(
    join(fixture.manifest.root, "harvenv.local.toml"),
    '[plugins]\nstaple-pack = { marketplace = "https://example.invalid/m.git" }\n',
  );
  writeLockfile(
    fixture.manifest.root,
    [],
    [
      {
        name: "staple-pack",
        source: { kind: "marketplace", repo: "https://example.invalid/m.git" },
        commit: COMMIT,
        hash: `sha256:${"d".repeat(64)}`,
      },
    ],
    [],
    OVERLAY_LOCKFILE,
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "components"), "problem");
  assert.match(said(report, "components"), /Overlay plugin `staple-pack`/);
});

test("an Overlay plugin nothing has locked yet is reported as Overlay drift", async () => {
  const fixture = project();
  writeFileSync(
    join(fixture.manifest.root, "harvenv.local.toml"),
    '[plugins]\nstaple-pack = { marketplace = "https://example.invalid/m.git" }\n',
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "drift"), "problem");
  assert.match(said(report, "drift"), /staple-pack/);
  assert.match(said(report, "drift"), /the Overlay/);
});

test("--no-overlay leaves the Overlay's Components out of the diagnosis", async () => {
  const fixture = project();
  writeFileSync(
    join(fixture.manifest.root, "harvenv.local.toml"),
    '[skills]\nstaple = { git = "https://example.invalid/staple.git" }\n',
  );

  const report = await run(fixture, { overlay: false });

  assert.equal(statusOf(report, "drift"), "ok");
  assert.equal(statusOf(report, "components"), "ok");
});

// ---------------------------------------------------------------------------
// Failure class: a tool a session would not have
// ---------------------------------------------------------------------------

test("an unscopeable tool that is nowhere on PATH is a problem carrying its hint", async () => {
  const fixture = project('[tools]\nsomething-exotic = "1"\n');
  writeLockfile(
    fixture.manifest.root,
    [],
    [],
    [
      {
        tool: "something-exotic",
        spec: "1",
        hint: "the Manifest needs something-exotic@1, which harv has no scoped installer for.",
      },
    ],
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "toolchain"), "problem");
  assert.match(said(report, "toolchain"), /is not on your PATH either/);
  assert.match(said(report, "toolchain"), /no scoped installer/);
  assert.match(said(report, "toolchain"), /Install something-exotic the way this machine normally would/);
});

test("an unscopeable tool the machine does have is a note, not a failure", async () => {
  const bin = tempDir();
  writeFileSync(join(bin, "something-exotic"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const fixture = project('[tools]\nsomething-exotic = "1"\n');
  fixture.env.PATH = `${bin}${delimiter}${fixture.env.PATH}`;
  writeLockfile(
    fixture.manifest.root,
    [],
    [],
    [{ tool: "something-exotic", spec: "1", hint: "harv has no scoped installer for it." }],
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "toolchain"), "ok");
  assert.match(said(report, "toolchain"), /sessions will use the machine's own/);
});

test("a pinned tool the Store no longer holds is a problem naming the version", async () => {
  const fixture = project('[tools]\nnode = "22"\n');
  writeLockfile(
    fixture.manifest.root,
    [],
    [],
    [{ tool: "node", spec: "22", version: "22.18.0", bins: ["installs/node/22.18.0/bin"] }],
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "toolchain"), "problem");
  assert.match(said(report, "toolchain"), /locked at 22\.18\.0, but the Store does not hold it/);
  assert.match(said(report, "toolchain"), /harv sync/);
});

// ---------------------------------------------------------------------------
// Failure class: an MCP server waiting on first-time auth
// ---------------------------------------------------------------------------

test("a server the session reports as needs-auth is a problem naming the /mcp flow", async () => {
  const fixture = project('[mcp.tickets]\ntype = "http"\nurl = "https://tickets.invalid/mcp"\n');
  const answers = probes({ mcp: { init: isolatedInit({ mcp_servers: [{ name: "tickets", status: "needs-auth" }] }) } });

  const report = await run(fixture, { session: true, probe: answers.probe });

  assert.equal(statusOf(report, "mcp"), "problem");
  assert.match(said(report, "mcp"), /waiting on first-time authentication/);
  assert.match(said(report, "mcp"), /`\/mcp`/);
  assert.equal(report.ok, false);
});

test("a server that connects is green, and its status is in the report", async () => {
  const fixture = project('[mcp.tickets]\ntype = "http"\nurl = "https://tickets.invalid/mcp"\n');
  const answers = probes({ mcp: { init: isolatedInit({ mcp_servers: [{ name: "tickets", status: "connected" }] }) } });

  const report = await run(fixture, { session: true, probe: answers.probe });

  assert.equal(statusOf(report, "mcp"), "ok");
  assert.deepEqual(of(report, "mcp").measurements.statuses, { tickets: "connected" });
});

test("a server still registering when the session reported in is unverified, not failed", async () => {
  const fixture = project('[mcp.tickets]\ntype = "http"\nurl = "https://tickets.invalid/mcp"\n');
  const answers = probes({ mcp: { init: isolatedInit({ mcp_servers: [{ name: "tickets", status: "pending" }] }) } });

  const report = await run(fixture, { session: true, probe: answers.probe });

  assert.equal(statusOf(report, "mcp"), "unknown");
  assert.equal(report.ok, true);
});

test("a `${VAR}` this environment cannot satisfy is a problem before anything starts", async () => {
  const fixture = project('[mcp.tickets]\ncommand = "npx"\nenv = { TOKEN = "${HARV_DOCTOR_UNSET_TOKEN}" }\n');

  const report = await run(fixture);

  assert.equal(statusOf(report, "mcp"), "problem");
  assert.match(said(report, "mcp"), /HARV_DOCTOR_UNSET_TOKEN is not set/);
  assert.equal(of(report, "mcp").measurements.live, "not attempted: the payload could not be built");
});

test("a server whose command is not installed is a problem, without starting a session", async () => {
  const fixture = project('[mcp.tickets]\ncommand = "definitely-not-installed"\n');

  const report = await run(fixture, { session: true, probe: probes({}).probe });

  assert.equal(statusOf(report, "mcp"), "problem");
  assert.match(said(report, "mcp"), /is not on this machine's PATH/);
});

test("a declared server the session dropped without a word is reported by name", async () => {
  const fixture = project('[mcp.tickets]\ntype = "http"\nurl = "https://tickets.invalid/mcp"\n');
  const answers = probes({ mcp: { init: isolatedInit({ mcp_servers: [] }) } });

  const report = await run(fixture, { session: true, probe: answers.probe });

  assert.equal(statusOf(report, "mcp"), "problem");
  assert.match(said(report, "mcp"), /did not reach the session at all/);
});

test("with no servers declared the check is green and starts nothing", async () => {
  const answers = probes({});

  const report = await run(project(), { session: true, probe: answers.probe });

  assert.equal(statusOf(report, "mcp"), "ok");
  // Two probes for the launch recipe, and not a third for servers that do not exist.
  assert.equal(answers.requests.length, 2);
});

// ---------------------------------------------------------------------------
// Failure class: a missing Tripwire
// ---------------------------------------------------------------------------

test("a project with no committed settings file has no Tripwire, and is told so", async () => {
  const report = await run(project("", { tripwire: false }));

  assert.equal(statusOf(report, "tripwire"), "problem");
  assert.match(said(report, "tripwire"), /un-isolated session/);
  assert.match(said(report, "tripwire"), /harv init/);
});

test("a settings file whose SessionStart hooks carry no marker has no Tripwire", async () => {
  const fixture = project("", { tripwire: false });
  mkdirSync(join(fixture.manifest.root, ".claude"), { recursive: true });
  writeFileSync(
    join(fixture.manifest.root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "tripwire"), "problem");
  assert.match(said(report, "tripwire"), /no SessionStart hook marked with HARV_SESSION/);
});

test("a reworded Tripwire still counts as planted", async () => {
  const fixture = project("", { tripwire: false });
  mkdirSync(join(fixture.manifest.root, ".claude"), { recursive: true });
  writeFileSync(
    join(fixture.manifest.root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: '[ -n "$HARV_SESSION" ] || echo mine' }] }] },
    }),
  );

  const report = await run(fixture);

  assert.equal(statusOf(report, "tripwire"), "ok");
});

test("a settings file that is not JSON is a problem harv refuses to repair", async () => {
  const fixture = project("", { tripwire: false });
  mkdirSync(join(fixture.manifest.root, ".claude"), { recursive: true });
  writeFileSync(join(fixture.manifest.root, ".claude", "settings.json"), "{ not json");

  const report = await run(fixture);

  assert.equal(statusOf(report, "tripwire"), "problem");
  assert.match(said(report, "tripwire"), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// Settings and the Overlay
// ---------------------------------------------------------------------------

test("a settings key a Manifest may not bind is a problem, and the rest still runs", async () => {
  const fixture = project('[settings]\nstatusLine = { type = "command", command = "x" }\n', { tripwire: false });

  const report = await run(fixture);

  assert.equal(statusOf(report, "settings"), "problem");
  assert.match(said(report, "settings"), /statusLine/);
  // The point of collecting rather than throwing: one bad key does not hide
  // the missing Tripwire underneath it.
  assert.equal(statusOf(report, "tripwire"), "problem");
});

test("an Overlay value the Manifest already binds is reported as dropped, not as broken", async () => {
  const fixture = project('[settings]\nmodel = "opus"\n');
  writeFileSync(join(fixture.manifest.root, "harvenv.local.toml"), '[settings]\nmodel = "haiku"\n');

  const report = await run(fixture);

  assert.equal(statusOf(report, "settings"), "ok");
  assert.match(said(report, "settings"), /An Overlay adds, it never overrides/);
});

test("an Overlay file that cannot be read is a problem naming the file", async () => {
  const fixture = project();
  writeFileSync(join(fixture.manifest.root, "harvenv.local.toml"), "[skills\nbroken = 1\n");

  const report = await run(fixture);

  assert.equal(statusOf(report, "settings"), "problem");
  assert.match(said(report, "settings"), /harvenv\.local\.toml/);
});

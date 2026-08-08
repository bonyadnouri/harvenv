#!/usr/bin/env bun
/**
 * Shim verification.
 *
 * The unit tests pin the shim's logic against stand-ins. This script pins the
 * thing the logic exists to produce: a real `claude`, typed bare into a real
 * shell, reaching a real Claude Code session. It is the acceptance criteria of
 * issue #11, executed rather than asserted:
 *
 *   1. With the shim installed, a bare `claude` is hermetic inside a harvenv
 *      project and indistinguishable from an unshimmed one outside it.
 *   2. Uninstall restores the previous state cleanly, and status reports
 *      accurately at every stage.
 *   3. Claude Code upgrades keep working: the real binary is resolved on every
 *      invocation rather than recorded, and arguments pass through untouched.
 *
 * As in the walking-skeleton check, session facts come from the `system`/`init`
 * event Claude Code emits under `--output-format stream-json --verbose`, so no
 * model is in the loop. Every `claude` here is invoked through `sh -c`, because
 * the claim under test is about PATH resolution — spawning the shim by its path
 * would be assuming the thing to be proved.
 *
 * Nothing outside the fixture tree is written. The two installs this performs
 * go to a scratch HARV_HOME, and the one that exercises shell startup files
 * runs against a scratch HOME — the real `~/.zshrc`, the real `~/.harv` and the
 * real `claude` on PATH are hashed before and after and asserted unchanged.
 *
 * Run:  bun scripts/verify-shim.ts [--json] [--keep]
 *       node scripts/verify-shim.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

/**
 * Salted per process, and cleaned up on the way out.
 *
 * Every verifier used to build at one fixed path, which is why two of them
 * running at once deleted each other's fixtures mid-run (issue #22). `mkdtemp`
 * is the whole fix: this script can run beside anything, including a second
 * copy of itself.
 *
 * The cost is a fresh `~/.claude/projects` entry per run rather than one
 * reused forever — the cheaper of the two, since Claude Code ages its own
 * history out and a wiped fixture tree fails a run that was never wrong.
 */
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-shim-verify-"));

const DECLARED_SKILLS = ["harvenv-shim-alpha", "harvenv-shim-beta"];
const PROBE_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

interface InitEvent {
  claude_code_version: string;
  skills: string[];
  slash_commands: string[];
  agents: string[];
  plugins: Array<{ name: string }>;
  mcp_servers: Array<{ name: string; status: string }>;
}

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A command as a shell would run it, so PATH resolution is the shell's and not
 * this script's. `exec` keeps the exit code and the terminal-less stdio honest.
 */
const shellArgs = (command: string, args: string[]): string[] => [
  "-c",
  `exec ${command} "$@"`,
  command,
  ...args,
];

function runToCompletion(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<Completed> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`${file} ${args.join(" ")}\` timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `claude ...`, resolved by a shell from the PATH it is handed. */
const bareClaude = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  runToCompletion("/bin/sh", shellArgs("claude", args), { cwd, env });

const harv = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  runToCompletion(process.execPath, [HARV, ...args], { cwd, env });

/** `harv shim status --json`, parsed. */
async function status(cwd: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const result = await harv(["shim", "status", "--json"], cwd, env);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Start a session, capture its `init` event, kill it before the turn completes. */
function probeInit(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<InitEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

    child.stderr.on("data", (c) => (stderr += String(c)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "system" && event.subtype === "init") finish(() => resolve(event as unknown as InitEvent));
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) =>
      finish(() =>
        reject(new Error(`session exited (code ${code}) before emitting init.\n${stderr.trim().slice(-800)}`)),
      ),
    );
  });
}

/** The flags a headless probe needs, passed through the shim to prove they survive it. */
const STREAM_JSON = ["-p", "probe", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];

const probeBare = (cwd: string, env: NodeJS.ProcessEnv) =>
  probeInit("/bin/sh", shellArgs("claude", STREAM_JSON), cwd, env);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** HARV_HOME for the installs that get exercised against real sessions. */
  harvHome: string;
  shimDir: string;
  shimPath: string;
  /** A harvenv project declaring DECLARED_SKILLS from local paths. */
  project: string;
  /** No Manifest anywhere above it. */
  bare: string;
  /** Holds a stand-in `claude` that records how it was invoked. */
  fakeDir: string;
  fakeDump: string;
  /** A second directory on PATH, for the "the upgrade moved the binary" case. */
  fakeDirB: string;
  /** A scratch HOME, so the startup-file round trip never touches the real one. */
  scratchHome: string;
  /** HARV_HOME for the startup-file round trip, kept apart from the sessions'. */
  scratchHarvHome: string;
}

async function buildFixtures(): Promise<Fixtures> {
  const dir = (...parts: string[]) => {
    const p = join(FIXTURE_ROOT, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };

  const project = dir("project");
  for (const name of DECLARED_SKILLS) {
    writeFileSync(
      join(dir("project", "vendor", name), "SKILL.md"),
      `---\nname: ${name}\ndescription: Marker skill for the harvenv shim check. Never invoke it.\n---\n\nMarker only.\n`,
    );
  }
  writeFileSync(
    join(project, "harvenv.toml"),
    `[skills]\n${DECLARED_SKILLS.map((n) => `${n} = { path = "vendor/${n}" }`).join("\n")}\n`,
  );

  const harvHome = dir("harv-home");
  const fakeDump = join(FIXTURE_ROOT, "handover.json");
  const fakeDir = dir("fake-bin");
  dir("fake-bin-b");

  // The Launcher reads a Lockfile and refuses to start a drifted Harvenv, so
  // the fixture is synced before anything launches it. The Store lands under
  // the same scratch HARV_HOME the shim is installed into, which is exactly the
  // layout a real install has.
  const synced = await harv(["sync"], project, { ...process.env, HARV_HOME: harvHome });
  if (synced.code !== 0) throw new Error(`\`harv sync\` failed on the fixture: ${synced.stderr.trim()}`);

  return {
    harvHome,
    shimDir: join(harvHome, "bin"),
    shimPath: join(harvHome, "bin", "claude"),
    project,
    bare: dir("bare"),
    fakeDir,
    fakeDump,
    fakeDirB: join(FIXTURE_ROOT, "fake-bin-b"),
    scratchHome: dir("scratch-home"),
    scratchHarvHome: join(FIXTURE_ROOT, "scratch-home", ".harv"),
  };
}

/** A stand-in `claude` that records argv, cwd and environment, then exits. */
function writeStandIn(dir: string, dump: string, label: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!/usr/bin/env node\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify({\n` +
      `  label: ${JSON.stringify(label)}, argv: process.argv.slice(2), cwd: process.cwd(), self: __filename,\n` +
      `  harvSession: process.env.HARV_SESSION ?? null\n` +
      `}));\n`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}

const readDump = (dump: string) =>
  JSON.parse(readFileSync(dump, "utf8")) as {
    label: string;
    argv: string[];
    cwd: string;
    self: string;
    /** The Tripwire's marker: set only by a Launcher session. */
    harvSession: string | null;
  };

/** The environment a shimmed shell has: the shim directory first on PATH. */
const shimmed = (fx: Fixtures, ...extra: string[]): NodeJS.ProcessEnv => ({
  ...process.env,
  HARV_HOME: fx.harvHome,
  PATH: [fx.shimDir, ...extra, process.env.PATH ?? ""].join(":"),
});

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
const only = <T,>(a: T[], b: T[]) => a.filter((x) => !b.includes(x));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const summarize = (names: string[], limit = 8): string =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;
const hash = (path: string): string => {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return "absent";
  }
};

// ---------------------------------------------------------------------------
// Criterion 1 — bare `claude` is hermetic inside, unchanged outside
// ---------------------------------------------------------------------------

async function checkInterception(fx: Fixtures): Promise<Check> {
  await harv(["shim", "install", "--shell", "none"], fx.project, { ...process.env, HARV_HOME: fx.harvHome });

  const env = shimmed(fx);
  // Built-ins, measured the same way the walking-skeleton check measures them:
  // the recipe's own flags in a directory with nothing declared. Whatever
  // survives here is Claude Code's, not the Harvenv's.
  const builtins = await probeInit(
    "/bin/sh",
    shellArgs("claude", [
      ...STREAM_JSON,
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ]),
    fx.bare,
    { ...env, HARV_NO_SHIM: "1" },
  );

  const inside = await probeBare(fx.project, env);
  const outsideShimmed = await probeBare(fx.bare, env);
  // The same directory without the shim on PATH at all: the control.
  const outsideDirect = await probeBare(fx.bare, { ...process.env, HARV_NO_SHIM: "" });

  const added = only(inside.skills, builtins.skills);
  const inventory = (e: InitEvent) => ({
    skills: e.skills.length,
    slashCommands: e.slash_commands.length,
    agents: e.agents.length,
    plugins: e.plugins.map((p) => p.name).sort(),
  });

  return {
    id: "interception",
    title: "A bare `claude` is hermetic inside a harvenv project and unchanged outside",
    measurements: {
      claudeCodeVersion: inside.claude_code_version,
      declared: DECLARED_SKILLS,
      builtinSkillCount: builtins.skills.length,
      insideSkillCount: inside.skills.length,
      skillsBeyondBuiltins: added,
      outsideShimmed: inventory(outsideShimmed),
      outsideDirect: inventory(outsideDirect),
    },
    expectations: [
      expect(
        "inside a harvenv project, every declared skill loads under its bare name",
        DECLARED_SKILLS.every((n) => inside.skills.includes(n)),
        `declared ${DECLARED_SKILLS.join(", ")}; ${
          only(DECLARED_SKILLS, inside.skills).length === 0
            ? "both present"
            : `missing ${summarize(only(DECLARED_SKILLS, inside.skills))}`
        }`,
      ),
      expect(
        "inside, nothing loads beyond the built-ins and what the Manifest declared",
        added.length === DECLARED_SKILLS.length && added.every((s) => DECLARED_SKILLS.includes(s)),
        added.length === DECLARED_SKILLS.length
          ? `${inside.skills.length} skills = ${builtins.skills.length} built-in + ${added.length} declared`
          : `${only(added, DECLARED_SKILLS).length} undeclared skill(s) leaked: ${summarize(only(added, DECLARED_SKILLS))}`,
      ),
      expect(
        "inside, no plugins and no MCP servers survive",
        inside.plugins.length === 0 && inside.mcp_servers.length === 0,
        `${inside.plugins.length} plugin(s), ${inside.mcp_servers.length} MCP server(s)`,
      ),
      // Interception has to be invisible where it does not apply. The control
      // probe is what makes "normal" a measurement rather than an impression.
      expect(
        "outside, the shimmed session is identical to an unshimmed one",
        same(inventory(outsideShimmed), inventory(outsideDirect)),
        `shimmed ${JSON.stringify(inventory(outsideShimmed))} vs direct ${JSON.stringify(inventory(outsideDirect))}`,
      ),
      expect(
        "outside, user scope really is loading — the comparison is not two empty sessions",
        outsideShimmed.skills.length > builtins.skills.length,
        `${outsideShimmed.skills.length} skills outside vs ${builtins.skills.length} built-ins`,
      ),
      expect(
        "HARV_NO_SHIM keeps ADR 0005's un-isolated session reachable inside the project",
        (await probeBare(fx.project, { ...env, HARV_NO_SHIM: "1" })).skills.length > builtins.skills.length,
        "a bypassed session inside the project loads user scope",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — uninstall restores state, status reports accurately
// ---------------------------------------------------------------------------

async function checkLifecycle(fx: Fixtures): Promise<Check> {
  // A scratch HOME, so this is the real startup-file round trip and still
  // cannot reach the real one.
  const zshrc = join(fx.scratchHome, ".zshrc");
  const before = "# a shell people actually use\nexport EDITOR=vim\nalias ll='ls -la'\n";
  writeFileSync(zshrc, before);
  const beforeHash = hash(zshrc);

  const shimDir = join(fx.scratchHarvHome, "bin");
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fx.scratchHome,
    HARV_HOME: fx.scratchHarvHome,
    SHELL: "/bin/zsh",
  };
  const active: NodeJS.ProcessEnv = { ...base, PATH: `${shimDir}:${process.env.PATH ?? ""}` };

  const shimFile = join(shimDir, "claude");
  const clean = await status(fx.bare, base);
  const install = await harv(["shim", "install"], fx.bare, base);
  // Read while it is true: every fact about the installed state has to be
  // captured here, because the uninstall below is what the rest of this
  // check is about.
  const shimIsExecutable = existsSync(shimFile) && (statSync(shimFile).mode & 0o111) === 0o111;
  const installed = await status(fx.bare, active);
  const notYetOnPath = await status(fx.bare, base);
  const afterInstall = readFileSync(zshrc, "utf8");

  // Installing again must be a no-op on disk, not a second PATH entry.
  await harv(["shim", "install"], fx.bare, base);
  const afterTwice = readFileSync(zshrc, "utf8");

  const uninstall = await harv(["shim", "uninstall"], fx.bare, active);
  const gone = await status(fx.bare, base);
  const repeat = await harv(["shim", "uninstall"], fx.bare, base);

  return {
    id: "lifecycle",
    title: "Uninstall restores the previous state cleanly, and status reports accurately",
    measurements: {
      installExit: install.code,
      uninstallExit: uninstall.code,
      zshrcBefore: beforeHash,
      zshrcAfterInstall: hash(zshrc),
      blockLines: afterInstall.split("\n").filter((l) => l.includes("harv shim")).length,
      statusClean: clean,
      statusInstalled: installed,
      statusGone: gone,
      repeatedUninstall: repeat.stdout.trim(),
    },
    expectations: [
      expect("install succeeds", install.code === 0, `exit ${install.code}: ${install.stdout.trim().split("\n")[0]}`),
      expect(
        "the shim lands where status says it does, and is executable",
        shimIsExecutable && installed.shimPath === shimFile,
        `${shimFile}${shimIsExecutable ? " (0755)" : " — missing or not executable"}`,
      ),
      expect(
        "install adds one marked PATH block to the shell's startup file",
        afterInstall.startsWith(before) &&
          (afterInstall.match(/# >>> harv shim >>>/g) ?? []).length === 1 &&
          afterInstall.includes(shimDir),
        `${afterInstall.length - before.length} bytes added, ${(afterInstall.match(/# >>> harv shim >>>/g) ?? []).length} block(s)`,
      ),
      expect(
        "installing twice changes nothing further",
        afterTwice === afterInstall,
        afterTwice === afterInstall ? "byte-identical" : "the second install changed the file",
      ),
      expect(
        "status distinguishes not-installed, installed-but-not-yet-on-PATH, and active",
        clean.installed === false &&
          installed.installed === true &&
          installed.active === true &&
          notYetOnPath.installed === true &&
          notYetOnPath.active === false,
        `clean=${clean.installed}/${clean.active}, on PATH=${installed.installed}/${installed.active}, not yet=${notYetOnPath.installed}/${notYetOnPath.active}`,
      ),
      expect(
        "status names the real claude behind the shim, not the shim itself",
        installed.realClaude !== installed.shimPath && typeof installed.realClaude === "string",
        `claude=${installed.resolvedClaude} real=${installed.realClaude}`,
      ),
      expect(
        "status names the harv the installed shim routes to, and confirms it is reachable",
        Array.isArray(installed.harvCommand) &&
          (installed.harvCommand as string[]).includes(HARV) &&
          installed.harvReachable === true,
        `routes through ${(installed.harvCommand as string[] | null)?.join(" ") ?? "nothing"}`,
      ),
      expect("uninstall succeeds", uninstall.code === 0, `exit ${uninstall.code}: ${uninstall.stdout.trim().split("\n")[0]}`),
      expect(
        "the startup file is byte-for-byte what it was before install",
        hash(zshrc) === beforeHash && readFileSync(zshrc, "utf8") === before,
        `${beforeHash} -> ${hash(zshrc)}`,
      ),
      expect(
        "the shim and the directories harv created are gone",
        !existsSync(join(shimDir, "claude")) && !existsSync(shimDir) && !existsSync(fx.scratchHarvHome),
        `${fx.scratchHarvHome} removed`,
      ),
      expect(
        "status agrees the shim is gone, and names what claude runs instead",
        gone.installed === false && gone.active === false && typeof gone.realClaude === "string",
        `installed=${gone.installed}, claude=${gone.resolvedClaude}`,
      ),
      expect(
        "uninstalling again is a no-op rather than an error",
        repeat.code === 0 && /nothing to remove/.test(repeat.stdout),
        `exit ${repeat.code}: ${repeat.stdout.trim().split("\n")[0]}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — dynamic resolution and argument pass-through
// ---------------------------------------------------------------------------

async function checkUpgradesAndPassthrough(fx: Fixtures): Promise<Check> {
  const env = shimmed(fx, fx.fakeDir, fx.fakeDirB);
  const extras = ["-p", "hi", "--resume", "--", "--settings", "not-a-flag-to-harv"];

  // v1 of the "installed" Claude Code, reached through the shim from outside a
  // harvenv project: the pure pass-through path.
  writeStandIn(fx.fakeDir, fx.fakeDump, "v1");
  await bareClaude(extras, fx.bare, env);
  const outside = readDump(fx.fakeDump);

  // The upgrade Claude Code actually performs: the same path, new contents.
  writeStandIn(fx.fakeDir, fx.fakeDump, "v2");
  await bareClaude(["--version"], fx.bare, env);
  const upgradedInPlace = readDump(fx.fakeDump);

  // The upgrade that moves the binary to another PATH entry.
  rmSync(join(fx.fakeDir, "claude"));
  writeStandIn(fx.fakeDirB, fx.fakeDump, "v3-relocated");
  await bareClaude(["--version"], fx.bare, env);
  const relocated = readDump(fx.fakeDump);

  // Inside a project the arguments travel shim -> harv -> claude. They have to
  // arrive after the ADR 0003 recipe, and unchanged.
  await bareClaude(extras, fx.project, env);
  const inside = readDump(fx.fakeDump);
  const tail = inside.argv.slice(-extras.length);
  const recipe = inside.argv.slice(0, inside.argv.length - extras.length);

  // The bypass, from the same project: un-isolated, and the Tripwire's marker
  // absent to say so.
  await bareClaude(["--version"], fx.project, { ...env, HARV_NO_SHIM: "1" });
  const bypassed = readDump(fx.fakeDump);

  // `harv claude` typed directly, with the shim first on PATH: the loop that
  // must not happen. If harv resolved `claude` by bare name it would re-enter
  // its own shim, forever.
  writeStandIn(fx.fakeDir, fx.fakeDump, "direct");
  const direct = await harv(["claude", "-p", "hi"], fx.project, env);
  const afterDirect = readDump(fx.fakeDump);

  // And the whole chain against real Claude Code, whose `claude` on PATH is a
  // symlink the installer repoints at each new version.
  const real = await status(fx.bare, shimmed(fx));
  const answered = await bareClaude(["-p", "reply with the single word: ok"], fx.project, shimmed(fx));

  return {
    id: "upgrades-and-passthrough",
    title: "The real claude is resolved on every run, and arguments pass through untouched",
    measurements: {
      outsideArgv: outside.argv,
      recipe,
      tail,
      tripwireMarker: { inside: inside.harvSession, outside: outside.harvSession, bypassed: bypassed.harvSession },
      resolvedLabels: {
        outside: outside.label,
        afterInPlaceUpgrade: upgradedInPlace.label,
        afterRelocation: relocated.label,
      },
      realClaudeOnPath: real.realClaude,
      realClaudeTarget: typeof real.realClaude === "string" ? realpathSync(real.realClaude) : null,
      directHarvClaudeExit: direct.code,
      realRunExit: answered.code,
      realRunOutput: answered.stdout.trim().slice(0, 200),
    },
    expectations: [
      expect(
        "outside a project, arguments reach claude verbatim and nothing is added",
        same(outside.argv, extras),
        outside.argv.join(" "),
      ),
      expect(
        "a Claude Code upgrade in place is picked up with no reinstall",
        upgradedInPlace.label === "v2",
        `resolved ${upgradedInPlace.label} at ${upgradedInPlace.self}`,
      ),
      expect(
        "an upgrade that moves the binary to another PATH entry is picked up too",
        relocated.label === "v3-relocated",
        `resolved ${relocated.label} at ${relocated.self}`,
      ),
      expect(
        "inside a project, extra arguments arrive verbatim, in order",
        same(tail, extras),
        tail.join(" "),
      ),
      expect(
        "they land after the ADR 0003 recipe, so harv's flags cannot be shadowed",
        recipe.includes("--setting-sources") && recipe.includes("--strict-mcp-config"),
        recipe.join(" "),
      ),
      // ADR 0012's Tripwire warns whenever a session is not a Launcher session.
      // Routing through the shim has to silence it — and only where it should.
      expect(
        "a shimmed session carries the Launcher marker, so the Tripwire stays quiet",
        inside.harvSession === "1" && outside.harvSession === null && bypassed.harvSession === null,
        `inside=${inside.harvSession}, outside=${outside.harvSession}, HARV_NO_SHIM=${bypassed.harvSession}`,
      ),
      expect(
        "`harv claude` under an installed shim starts Claude Code, not the shim again",
        direct.code === 0 && afterDirect.label === "direct",
        `exit ${direct.code}, reached ${afterDirect.self}`,
      ),
      // A recorded path would have pinned the version directory. Resolution
      // stops at the PATH entry, which is what the installer keeps current.
      expect(
        "the shim resolves the launcher on PATH, not the version it points at",
        typeof real.realClaude === "string" && !existsSync(join(fx.shimDir, "claude.real")),
        typeof real.realClaude === "string"
          ? `${real.realClaude} -> ${realpathSync(real.realClaude)}`
          : "no real claude on PATH",
      ),
      expect(
        "a bare `claude` inside the project really answers, through the whole chain",
        answered.code === 0 && answered.stdout.trim().length > 0,
        `exit ${answered.code}: ${answered.stdout.trim().slice(0, 80)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// The machine this ran on is left exactly as it was found
// ---------------------------------------------------------------------------

const MACHINE_PATHS = [
  join(homedir(), ".zshrc"),
  join(homedir(), ".bashrc"),
  join(homedir(), ".bash_profile"),
  join(homedir(), ".profile"),
];

interface MachineState {
  files: Record<string, string>;
  claude: string;
  claudeTarget: string;
  harvHome: boolean;
}

function readMachine(): MachineState {
  const which = spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
  return {
    files: Object.fromEntries(MACHINE_PATHS.map((p) => [p, hash(p)])),
    claude: which,
    claudeTarget: which && existsSync(which) ? realpathSync(which) : "absent",
    harvHome: existsSync(join(homedir(), ".harv")),
  };
}

function checkMachineUntouched(before: MachineState, after: MachineState): Check {
  const changed = MACHINE_PATHS.filter((p) => before.files[p] !== after.files[p]);
  return {
    id: "machine-untouched",
    title: "Verifying the shim left the machine's own claude and dotfiles alone",
    measurements: { before, after },
    expectations: [
      expect(
        "no shell startup file was written",
        changed.length === 0,
        changed.length ? `rewritten: ${changed.join(", ")}` : `${MACHINE_PATHS.length} files unchanged`,
      ),
      expect(
        "`claude` still resolves to the same binary it did before",
        before.claude === after.claude && before.claudeTarget === after.claudeTarget && after.claude !== "",
        `${after.claude || "not found"} -> ${after.claudeTarget}`,
      ),
      expect(
        "no shim was installed into the real HARV_HOME",
        before.harvHome === after.harvHome,
        after.harvHome ? `~/.harv exists (and did before)` : "~/.harv absent, as before",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

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

  const machineBefore = readMachine();
  const fx = await buildFixtures();
  log("harvenv shim verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["interception", "A bare `claude` is hermetic inside a harvenv project and unchanged outside", () => checkInterception(fx)],
    ["lifecycle", "Uninstall restores the previous state cleanly, and status reports accurately", () => checkLifecycle(fx)],
    [
      "upgrades-and-passthrough",
      "The real claude is resolved on every run, and arguments pass through untouched",
      () => checkUpgradesAndPassthrough(fx),
    ],
  ];

  const checks: Check[] = [];
  for (const [id, title, run] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ id, title, expectations: [], measurements: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }
  checks.push(checkMachineUntouched(machineBefore, readMachine()));

  if (keep) log(`\n${DIM}fixtures kept at ${FIXTURE_ROOT}${RESET}`);
  else rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const version = (checks[0]?.measurements as { claudeCodeVersion?: string })?.claudeCodeVersion ?? "unknown";
  const failures = checks.filter(failed);

  if (asJson) {
    console.log(JSON.stringify({ claudeCodeVersion: version, ok: failures.length === 0, fixtures: keep ? FIXTURE_ROOT : null, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\nClaude Code ${version}: ${checks.length - failures.length}/${checks.length} checks passed` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

if (!existsSync(HARV)) throw new Error(`harv entry point not found at ${HARV}`);
process.exitCode = await main();

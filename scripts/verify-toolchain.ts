#!/usr/bin/env bun
/**
 * Toolchain verification.
 *
 * The unit tests pin harv's logic against a faked install engine; this script
 * pins the promises the slice makes to a user, by running the real `harv`
 * against a real mise, installing a real Node into a real Store, and reading
 * back what a session would actually see. It is the acceptance criteria of
 * issue #8, executed rather than asserted:
 *
 *   1. A Manifest node pin yields that node version inside the session, while
 *      the parent shell keeps its own.
 *   2. Tools are shared across projects via the Store — no duplicate installs.
 *   3. The Lockfile pins tool versions, and a sync on a second machine
 *      converges on the pin rather than on what the spec resolves to today.
 *   4. It works without admin rights, and nothing global is mutated.
 *   5. An unscopeable requirement degrades to a recorded hint, not a failure.
 *
 * Two of the claims are about things *not* happening, so they are proved by
 * removing the possibility rather than by reading output. Criterion 2 runs the
 * second project's Sync with a `mise` that records being run and then fails: if
 * that Sync succeeds, no installer was invoked. Criterion 4 puts a recording
 * stand-in for `sudo` and every system package manager on PATH for the whole
 * run, and snapshots the machine's own tool directories before and after.
 *
 * Nothing here touches the machine's Store, `~/.claude`, or its mise setup:
 * `HARV_HOME` points into the fixture tree, and no real Claude Code session is
 * ever started. It needs the network — two Node versions are downloaded, and
 * the pinned mise too unless this checkout has already vendored it.
 *
 * Run:  bun scripts/verify-toolchain.ts [--json] [--keep]
 *       node scripts/verify-toolchain.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
 */
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-toolchain-verify-"));

/**
 * The engine comes from harv's own pin — `vendor/mise.lock.json` — rather than
 * from a version this script chose. A check that verified a different mise than
 * the one harv ships would be verifying something nobody runs.
 */
const MISE_LOCK = join(REPO_ROOT, "vendor", "mise.lock.json");

/**
 * The spec a Manifest declares, and the older exact version a Lockfile pins.
 * They have to differ: criterion 3 is only meaningful if re-resolving the spec
 * would produce something other than the pin.
 */
const NODE_SPEC = "22";
const LOCKED_NODE = "22.18.0";

/** Anything that would mean harv had mutated the machine instead of the Store. */
const FORBIDDEN = ["sudo", "brew", "apt", "apt-get", "dnf", "yum", "pacman", "zypper", "port", "winget", "choco"];

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Completed {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

interface HarvOptions {
  /** A `mise` for this call only. Defaults to the real one. */
  mise?: string;
  /** Prepended to PATH ahead of the always-on stand-ins. */
  stubs?: string;
}

/**
 * The real `harv`, always with the forbidden-command stand-ins in front of it.
 * There is no variant of this that can reach `sudo` or a system package
 * manager without being recorded.
 */
const harv = (args: string[], cwd: string, store: string, options: HarvOptions = {}): Completed =>
  runCommand(process.execPath, [HARV, ...args], cwd, {
    HARV_HOME: store,
    // `HARV_MISE_BIN` is how harv lets a caller name the engine explicitly, and
    // it is what makes criterion 2's poisoned mise possible at all.
    HARV_MISE_BIN: options.mise ?? realMise,
    PATH: [options.stubs, guardDir, process.env.PATH ?? ""].filter(Boolean).join(":"),
  });

/**
 * An executable that records the fact it ran and then fails. Standing in for a
 * command harv must not need, it turns "no installer ran" and "nothing global
 * was touched" into things a check can observe rather than infer.
 */
function stub(dir: string, name: string, receipt: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> ${JSON.stringify(receipt)}\nexit 97\n`,
    { mode: 0o755 },
  );
}

const receiptLines = (receipt: string): string[] =>
  existsSync(receipt) ? readFileSync(receipt, "utf8").trim().split("\n").filter((line) => line !== "") : [];

// ---------------------------------------------------------------------------
// The engine under test
// ---------------------------------------------------------------------------

/**
 * The real, pinned mise — the same one a released harv carries.
 *
 * Three ways to get it, cheapest first: an explicit `HARV_MISE_BIN`, the copy a
 * source checkout already vendored, or a download of the exact asset
 * `vendor/mise.lock.json` names, checked against the checksum beside it. The
 * download lands in the fixture tree and never on the machine's PATH.
 */
function obtainMise(): string {
  const provided = process.env.HARV_MISE_BIN;
  if (provided !== undefined && provided !== "" && existsSync(provided)) return provided;

  const platform = `${process.platform}-${process.arch}`;
  const vendored = join(REPO_ROOT, "vendor", "mise", platform, "mise");
  if (existsSync(vendored)) return vendored;

  const lock = JSON.parse(readFileSync(MISE_LOCK, "utf8")) as {
    version: string;
    platforms: Record<string, { asset: string; sha256: string } | undefined>;
  };
  const pin = lock.platforms[platform];
  if (pin === undefined) throw new Error(`${MISE_LOCK} pins no mise for ${platform}`);

  const into = join(FIXTURE_ROOT, "engine");
  mkdirSync(into, { recursive: true });
  const binary = join(into, "mise");
  const url = `https://github.com/jdx/mise/releases/download/v${lock.version}/${pin.asset}`;

  const fetched = runCommand(
    "curl",
    ["--silent", "--show-error", "--location", "--fail", "--output", binary, url],
    into,
  );
  if (fetched.code !== 0) throw new Error(`Could not download the pinned mise from ${url}: ${fetched.stderr.trim()}`);

  // The same check `scripts/vendor-mise.ts` makes. A verification run that
  // silently accepted a different binary would be verifying a different tool.
  const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (actual !== pin.sha256) {
    throw new Error(`Checksum mismatch for ${pin.asset}\n  expected ${pin.sha256}\n  actual   ${actual}`);
  }
  chmodSync(binary, 0o755);
  return binary;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILL_NAME = "harvenv-toolchain-alpha";

let realMise = "";
let guardDir = "";

interface Fixtures {
  /** A machine-global Store shared by the first two projects. */
  store: string;
  /** A second machine's Store: empty, and fed only by the committed Lockfile. */
  otherStore: string;
  project: string;
  second: string;
  otherMachine: string;
  unscopeable: string;
  /** Where a `claude` stand-in reports what the session's PATH resolved to. */
  sessionDir: string;
  sessionReceipt: string;
  /** Where a poisoned `mise` records having been needed. */
  engineStub: string;
  engineReceipt: string;
  /** Where `sudo` and the system package managers record having been called. */
  guardReceipt: string;
}

function buildFixtures(): Fixtures {
  const dir = (...parts: string[]): string => {
    const path = join(FIXTURE_ROOT, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };

  const guardReceipt = join(FIXTURE_ROOT, "forbidden-was-run.txt");
  guardDir = dir("stubs", "guard");
  for (const name of FORBIDDEN) stub(guardDir, name, guardReceipt);

  realMise = obtainMise();

  const engineReceipt = join(FIXTURE_ROOT, "engine-was-run.txt");
  const engineStub = dir("stubs", "engine");
  stub(engineStub, "mise", engineReceipt);

  const sessionDir = dir("stubs", "session");
  const sessionReceipt = join(FIXTURE_ROOT, "session.txt");
  // The stand-in for Claude Code. `/bin/sh` on purpose: a stub run by `node`
  // would resolve its own interpreter through the PATH under test, which would
  // confuse what is being measured with what is doing the measuring.
  writeFileSync(
    join(sessionDir, "claude"),
    `#!/bin/sh\n` +
      `{\n` +
      `  printf 'node-path=%s\\n' "$(command -v node)"\n` +
      `  printf 'node-version=%s\\n' "$(node --version 2>&1)"\n` +
      `  printf 'PATH=%s\\n' "$PATH"\n` +
      `} > ${JSON.stringify(sessionReceipt)}\n`,
    { mode: 0o755 },
  );

  // The project everything else is a copy of: a loose spec, so resolution has
  // something to do, and a skill that carries its own requirement.
  const project = dir("project");
  writeFileSync(join(project, "harvenv.toml"), `[tools]\nnode = "${NODE_SPEC}"\n`);

  return {
    store: dir("store-home"),
    otherStore: dir("other-machine-store"),
    project,
    second: dir("second-project"),
    otherMachine: dir("other-machine"),
    unscopeable: dir("unscopeable-project"),
    sessionDir,
    sessionReceipt,
    engineStub,
    engineReceipt,
    guardReceipt,
  };
}

/** A skill on disk whose SKILL.md declares what it needs (ADR 0006). */
function skillDir(root: string, requires: string): string {
  const path = join(root, "vendor", SKILL_NAME);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: Marker skill for the harvenv Toolchain check. Never invoke it.\n` +
      `requires: ${requires}\n---\n\nMarker.\n`,
  );
  return path;
}

// ---------------------------------------------------------------------------
// Reading what landed on disk
// ---------------------------------------------------------------------------

/** What the `claude` stand-in saw. */
function session(receipt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of receiptLines(receipt)) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

const lockText = (project: string): string => readFileSync(join(project, "harvenv.lock"), "utf8");

/** Every installed version of a tool in a Store, so duplicates are countable. */
const installedVersions = (store: string, tool = "node"): string[] => {
  const dir = join(store, "store", "tools", "installs", tool);
  if (!existsSync(dir)) return [];
  // mise records prefix aliases (`22`, `22.18`) beside the real directory; only
  // a full x.y.z is an install.
  return readdirSync(dir)
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .filter((name) => !statSync(join(dir, name)).isSymbolicLink())
    .sort();
};

/**
 * A recursive listing of the directories the machine keeps its own tools in.
 * Compared before and after the run, this is what "nothing global is mutated"
 * means concretely.
 */
function machineToolState(): Record<string, string> {
  const home = process.env.HOME ?? "";
  const watched = [
    join(home, ".local", "share", "mise"),
    join(home, ".config", "mise"),
    join(home, ".cache", "mise"),
    join(home, ".local", "state", "mise"),
    join(home, ".asdf"),
    join(home, ".nvm", "versions"),
    join(home, ".harv"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];

  const state: Record<string, string> = {};
  for (const path of watched) state[path] = listing(path);
  return state;
}

function listing(path: string): string {
  if (!existsSync(path)) return "(absent)";
  const found: string[] = [];
  const descend = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      found.push(`${dir} (unreadable)`);
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      found.push(join(dir, entry.name));
      // Deep enough to catch an install landing somewhere it should not,
      // shallow enough that a machine with a large Homebrew stays quick.
      if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 3) descend(join(dir, entry.name), depth + 1);
    }
  };
  descend(path, 0);
  return found.join("\n");
}

const differences = (a: Record<string, string>, b: Record<string, string>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]);

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

// ---------------------------------------------------------------------------
// Criterion 1 — a Manifest pin is what the session runs, and only the session
// ---------------------------------------------------------------------------

/** Filled in by the first check; the rest are about what it produced. */
let resolvedNode = "";

function checkSessionPath(fx: Fixtures): Check {
  // What the machine has, measured before anything is installed.
  const before = runCommand("node", ["--version"], fx.project);
  const beforePath = runCommand("/bin/sh", ["-c", "command -v node"], fx.project);

  const synced = harv(["sync"], fx.project, fx.store);
  if (synced.code !== 0) throw new Error(`harv sync failed: ${synced.stderr.trim()}`);
  resolvedNode = /version = "([^"]+)"/.exec(lockText(fx.project))?.[1] ?? "";

  const launched = harv(["claude"], fx.project, fx.store, { stubs: fx.sessionDir });
  const inSession = session(fx.sessionReceipt);

  // And what the machine has afterwards, measured the same way.
  const after = runCommand("node", ["--version"], fx.project);
  const afterPath = runCommand("/bin/sh", ["-c", "command -v node"], fx.project);

  const storeInstalls = join(fx.store, "store", "tools", "installs");
  return {
    id: "session-path",
    title: "A Manifest node pin yields that node version inside the session; the parent shell keeps its own",
    measurements: {
      manifestSpec: NODE_SPEC,
      resolvedVersion: resolvedNode,
      sessionNode: inSession["node-version"],
      sessionNodePath: inSession["node-path"],
      parentNodeBefore: before.stdout.trim(),
      parentNodeAfter: after.stdout.trim(),
      parentNodePath: beforePath.stdout.trim(),
      syncStdout: synced.stdout.trim(),
    },
    expectations: [
      expect("`harv sync` installs the pinned tool", synced.code === 0 && resolvedNode !== "", `exit ${synced.code}`),
      expect(
        "the Lockfile pins an exact version, not the spec",
        /^\d+\.\d+\.\d+$/.test(resolvedNode) && resolvedNode.startsWith(`${NODE_SPEC}.`),
        `spec "${NODE_SPEC}" resolved to ${resolvedNode}`,
      ),
      expect("`harv claude` starts a session", launched.code === 0, `exit ${launched.code}`),
      expect(
        "the session's node is the pinned one",
        inSession["node-version"] === `v${resolvedNode}`,
        `session saw ${inSession["node-version"]}, Lockfile pins ${resolvedNode}`,
      ),
      expect(
        "the session's node comes out of the Store",
        inSession["node-path"]?.startsWith(storeInstalls) === true,
        `${inSession["node-path"]}`,
      ),
      expect(
        "the tool paths are in front of the machine's own",
        inSession["PATH"]?.startsWith(storeInstalls) === true,
        `PATH begins ${inSession["PATH"]?.split(":").slice(0, 2).join(":")}`,
      ),
      expect(
        "the parent shell's node is a different version, and unchanged by the run",
        before.stdout.trim() !== `v${resolvedNode}` && before.stdout.trim() === after.stdout.trim(),
        `parent has ${before.stdout.trim()} before and ${after.stdout.trim()} after; session had v${resolvedNode}`,
      ),
      expect(
        "the parent shell's node is still the same binary",
        beforePath.stdout.trim() === afterPath.stdout.trim() && beforePath.stdout.trim() !== "",
        `${beforePath.stdout.trim()}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — the Store shares tools across projects, with no re-install
// ---------------------------------------------------------------------------

function checkStoreShared(fx: Fixtures): Check {
  // A second project that needs the same tool — and asks for it the other way,
  // through a Component's own `requires` rather than through `[tools]`.
  const skill = skillDir(fx.second, `node@${NODE_SPEC}`);
  writeFileSync(
    join(fx.second, "harvenv.toml"),
    `[skills]\n${SKILL_NAME} = { path = "vendor/${SKILL_NAME}" }\n`,
  );
  // Locked from the first project: same tool, same spec, same resolved version.
  writeFileSync(join(fx.second, "harvenv.lock"), lockText(fx.project));

  // A `mise` that records being run and then fails. If this Sync succeeds, no
  // installer was invoked — which is the only way to observe a re-install that
  // did not happen.
  const synced = harv(["sync"], fx.second, fx.store, { mise: join(fx.engineStub, "mise") });
  const launched = harv(["claude"], fx.second, fx.store, {
    mise: join(fx.engineStub, "mise"),
    stubs: fx.sessionDir,
  });
  const inSession = session(fx.sessionReceipt);
  const versions = installedVersions(fx.store);

  return {
    id: "store-shared",
    title: "Tools are shared across projects via the Store — no duplicate installs",
    measurements: {
      skill,
      installedVersions: versions,
      engineInvocations: receiptLines(fx.engineReceipt),
      sessionNode: inSession["node-version"],
      syncStdout: synced.stdout.trim(),
      syncStderr: synced.stderr.trim(),
    },
    expectations: [
      expect(
        "a Component's own `requires` reaches the Toolchain",
        synced.code === 0 && /node/.test(lockText(fx.second)),
        `exit ${synced.code}; the second project locks node without declaring [tools]`,
      ),
      expect(
        "the second project ran no installer at all",
        receiptLines(fx.engineReceipt).length === 0,
        receiptLines(fx.engineReceipt).length === 0
          ? "the poisoned mise was never invoked"
          : `invoked: ${receiptLines(fx.engineReceipt).join(" | ")}`,
      ),
      expect("`harv sync` reports the reuse", /reused node@/.test(synced.stdout), synced.stdout.trim()),
      expect(
        "the Store holds exactly one copy of the tool",
        versions.length === 1,
        `installs/node holds: ${versions.join(", ") || "(none)"}`,
      ),
      expect(
        "the second project's session gets the same pinned node",
        inSession["node-version"] === `v${resolvedNode}`,
        `${inSession["node-version"]}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — the Lockfile pins, and a second machine converges on the pin
// ---------------------------------------------------------------------------

function checkLockfileConverges(fx: Fixtures): Check {
  // A teammate's clone: the same Manifest, and a Lockfile pinning an *older*
  // exact version than the spec would resolve to today. A Sync that re-resolved
  // instead of converging would install the newer one, and say so.
  writeFileSync(join(fx.otherMachine, "harvenv.toml"), readFileSync(join(fx.project, "harvenv.toml")));
  const committed = lockText(fx.project).replace(
    /version = "[^"]+"/,
    `version = "${LOCKED_NODE}"`,
  ).replace(/installs\/node\/[^/]+\/bin/, `installs/node/${LOCKED_NODE}/bin`);
  writeFileSync(join(fx.otherMachine, "harvenv.lock"), committed);

  // A different machine is an empty Store, not an empty project.
  const synced = harv(["sync"], fx.otherMachine, fx.otherStore);
  const launched = harv(["claude"], fx.otherMachine, fx.otherStore, { stubs: fx.sessionDir });
  const inSession = session(fx.sessionReceipt);
  const versions = installedVersions(fx.otherStore);

  return {
    id: "lockfile-converges",
    title: "The Lockfile pins tool versions, and a sync on a second machine converges on the pin",
    measurements: {
      manifestSpec: NODE_SPEC,
      lockedVersion: LOCKED_NODE,
      versionTheSpecResolvesToToday: resolvedNode,
      installedOnSecondMachine: versions,
      sessionNode: inSession["node-version"],
      syncStdout: synced.stdout.trim(),
    },
    expectations: [
      expect("the second machine syncs from the Lockfile alone", synced.code === 0, `exit ${synced.code}`),
      expect(
        "it installs the locked version, not what the spec resolves to today",
        versions.length === 1 && versions[0] === LOCKED_NODE && LOCKED_NODE !== resolvedNode,
        `spec "${NODE_SPEC}" resolves to ${resolvedNode} today; the Lockfile pins ${LOCKED_NODE}; ` +
          `the second machine installed ${versions.join(", ") || "(nothing)"}`,
      ),
      expect(
        "the session on the second machine runs the locked version",
        inSession["node-version"] === `v${LOCKED_NODE}`,
        `${inSession["node-version"]}`,
      ),
      expect(
        "the Lockfile itself is unchanged by the second machine's Sync",
        lockText(fx.otherMachine) === committed,
        lockText(fx.otherMachine) === committed ? "identical" : "the second machine rewrote the Lockfile",
      ),
      expect(
        "the first machine's Store is untouched by the second's Sync",
        installedVersions(fx.store).length === 1,
        `the shared Store still holds: ${installedVersions(fx.store).join(", ")}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 5 — an unscopeable requirement degrades to a hint
// ---------------------------------------------------------------------------

function checkUnscopeableHint(fx: Fixtures): Check {
  // Both routes into the Toolchain, so neither can fail loudly: one tool the
  // Manifest pins, one a Component requires.
  skillDir(fx.unscopeable, "harvenv-no-such-tool-b@1");
  writeFileSync(
    join(fx.unscopeable, "harvenv.toml"),
    `[skills]\n${SKILL_NAME} = { path = "vendor/${SKILL_NAME}" }\n\n` +
      `[tools]\n"harvenv-no-such-tool-a" = "1"\n`,
  );

  const synced = harv(["sync"], fx.unscopeable, fx.store);
  const lock = synced.code === 0 ? lockText(fx.unscopeable) : "";
  const launched = harv(["claude"], fx.unscopeable, fx.store, { stubs: fx.sessionDir });
  const inSession = session(fx.sessionReceipt);

  // The warning about the local path Source is a different check's subject;
  // what matters here is the lines that name the tools.
  const hints = synced.stderr
    .trim()
    .split("\n")
    .filter((line) => /harvenv-no-such-tool/.test(line));

  return {
    id: "unscopeable-hint",
    title: "An unscopeable requirement degrades to a recorded hint, not a failure",
    measurements: {
      syncExit: synced.code,
      hints,
      lockfile: lock,
      sessionNode: inSession["node-version"],
    },
    expectations: [
      expect("`harv sync` succeeds anyway", synced.code === 0, `exit ${synced.code}`),
      expect(
        "it warns by name about both unscopeable requirements",
        hints.some((line) => line.includes("harvenv-no-such-tool-a")) &&
          hints.some((line) => line.includes("harvenv-no-such-tool-b")),
        hints.join("\n      ") || "(no hint reached stderr)",
      ),
      expect(
        "the hint names who needs the tool, so Doctor can act on it",
        hints.some((line) => line.includes("the Manifest")) && hints.some((line) => line.includes(SKILL_NAME)),
        "the Manifest and the skill are both named",
      ),
      expect(
        "the hint is recorded in the Lockfile, and neither tool is pinned to a version",
        (lock.match(/hint = /g) ?? []).length === 2 &&
          /harvenv-no-such-tool-a/.test(lock) &&
          /harvenv-no-such-tool-b/.test(lock) &&
          // A pinned tool writes `version = "1.2.3"`; the Lockfile's own format
          // number is unquoted (`version = 3`), so this catches only real pins.
          !/version = "/.test(lock),
        `${(lock.match(/hint = /g) ?? []).length} hints recorded, no version pinned for either`,
      ),
      expect("`harv claude` still starts a session", launched.code === 0, `exit ${launched.code}`),
      expect(
        "the session falls back to the machine's own tools",
        inSession["node-version"]?.startsWith("v") === true,
        `the session's node is ${inSession["node-version"]}, from the machine`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — no admin rights, nothing global mutated
// ---------------------------------------------------------------------------

/**
 * Runs last on purpose: it compares the machine's tool directories against the
 * snapshot taken before any of the other checks, so what it is really checking
 * is the whole run — four Syncs, two real Node installs, three sessions.
 */
function checkNoGlobalMutation(fx: Fixtures, before: Record<string, string>): Check {
  const after = machineToolState();
  const changed = differences(before, after);
  const forbidden = receiptLines(fx.guardReceipt);

  return {
    id: "no-global-mutation",
    title: "It works without admin rights, and nothing global is mutated",
    measurements: {
      watched: Object.keys(before),
      changed,
      forbiddenInvocations: forbidden,
      installedIntoFixtureStore: installedVersions(fx.store).concat(installedVersions(fx.otherStore)),
      uid: process.getuid?.() ?? null,
    },
    expectations: [
      expect(
        "no elevation and no system package manager was invoked, all run long",
        forbidden.length === 0,
        forbidden.length === 0
          ? `${FORBIDDEN.join(", ")} were on PATH ahead of the real ones and none was called`
          : `called: ${forbidden.join(" | ")}`,
      ),
      expect(
        "the machine's own tool directories are byte-for-byte what they were",
        changed.length === 0,
        changed.length === 0 ? `${Object.keys(before).length} directories unchanged` : `changed: ${changed.join(", ")}`,
      ),
      expect(
        "the user's own mise setup was never created or written to",
        before[join(process.env.HOME ?? "", ".local", "share", "mise")] ===
          after[join(process.env.HOME ?? "", ".local", "share", "mise")],
        `~/.local/share/mise is ${after[join(process.env.HOME ?? "", ".local", "share", "mise")] === "(absent)" ? "still absent" : "unchanged"}`,
      ),
      expect(
        "everything installed went into the Store harv was given",
        installedVersions(fx.store).length > 0 && installedVersions(fx.otherStore).length > 0,
        `${installedVersions(fx.store).join(", ")} and ${installedVersions(fx.otherStore).join(", ")} under HARV_HOME`,
      ),
      expect(
        "the run never needed root",
        process.getuid === undefined || process.getuid() !== 0,
        `uid ${process.getuid?.() ?? "n/a"}`,
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

  // Taken before anything runs, so the last check can compare against a machine
  // that has not yet met harv.
  const machineBefore = machineToolState();

  const fx = buildFixtures();
  log("harvenv Toolchain verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);
  log(`${DIM}engine:   ${realMise}${RESET}`);

  // Ordered, not independent: the first check is what installs the tool the
  // rest are about, exactly as a user would install it.
  const runners: Array<[string, string, () => Check]> = [
    ["session-path", "A Manifest node pin yields that node inside the session only", () => checkSessionPath(fx)],
    ["store-shared", "Tools are shared across projects via the Store", () => checkStoreShared(fx)],
    ["lockfile-converges", "The Lockfile pins versions and a second machine converges", () => checkLockfileConverges(fx)],
    ["unscopeable-hint", "An unscopeable requirement degrades to a recorded hint", () => checkUnscopeableHint(fx)],
    ["no-global-mutation", "No admin rights, nothing global mutated", () => checkNoGlobalMutation(fx, machineBefore)],
  ];

  const checks: Check[] = [];
  for (const [id, title, runCheck] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(runCheck());
    } catch (err) {
      checks.push({
        id,
        title,
        expectations: [],
        measurements: {},
        error: err instanceof Error ? err.message : String(err),
      });
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

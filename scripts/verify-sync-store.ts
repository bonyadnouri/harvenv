#!/usr/bin/env bun
/**
 * Sync/Store/Lockfile verification.
 *
 * The unit tests pin harv's logic against its own modules; this script pins the
 * promises the slice makes to a user, by running the real `harv` binary against
 * real git repositories and a real Store on disk. It is the acceptance criteria
 * of issue #3, executed rather than asserted:
 *
 *   1. A clean clone plus `harv sync` reproduces byte-identical Components from
 *      the Lockfile — checked after the source repository has moved on, so
 *      "reproduced" cannot be confused with "re-resolved".
 *   2. The Store dedupes across projects: a second project syncing an
 *      already-locked Source performs no re-fetch.
 *   3. The Lockfile pins commit SHA and content hash, and a hash mismatch on
 *      fetch fails loudly.
 *   4. A non-portable path Source produces a warning naming the entry.
 *   5. Manifest/Lockfile drift is detected and reported at launch and at sync.
 *
 * Criterion 2 is the one that cannot be checked by reading output, because
 * "did not re-fetch" is the absence of an event. So it is checked by removing
 * the possibility: the second Sync runs with a `git` on PATH that records its
 * invocation and exits non-zero. If that Sync succeeds, no fetch was attempted.
 * Criterion 5 uses the same trick for the Launcher, with a stand-in `claude`.
 *
 * Nothing here touches the machine's Store or `~/.claude`: HARV_HOME points
 * into the fixture tree, and no real Claude Code session is ever started.
 *
 * Run:  bun scripts/verify-sync-store.ts [--json] [--keep]
 *       node scripts/verify-sync-store.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
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
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-sync-verify-"));

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
  });
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
  /** Prepended to PATH, so a stub can stand in for `git` or `claude`. */
  stubs?: string;
}

const harv = (args: string[], cwd: string, store: string, options: HarvOptions = {}): Completed =>
  runCommand(process.execPath, [HARV, ...args], cwd, {
    HARV_HOME: store,
    ...(options.stubs ? { PATH: `${options.stubs}:${process.env.PATH ?? ""}` } : {}),
  });

/**
 * An executable that records the fact it ran and then fails. Standing in for a
 * command harv must not need, it turns "no network access" and "did not launch"
 * into things a check can observe rather than infer.
 */
function stub(dir: string, name: string, receipt: string, exitCode = 1): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    `#!/usr/bin/env node\n` +
      `const fs = require("node:fs");\n` +
      `fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd()\n` +
      `}) + "\\n");\n` +
      `process.exit(${exitCode});\n`,
    { mode: 0o755 },
  );
}

const wasRun = (receipt: string): boolean => existsSync(receipt);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILL_NAME = "harvenv-sync-alpha";
const LOCAL_SKILL = "harvenv-sync-local";

/**
 * A skill with a nested directory and an executable script — so "byte-identical"
 * is checked over something with structure, not over a single file.
 */
function skillFiles(marker: string): Record<string, string> {
  return {
    [`skills/${SKILL_NAME}/SKILL.md`]:
      `---\nname: ${SKILL_NAME}\ndescription: Marker skill for the harvenv sync check. Never invoke it.\n---\n\n${marker}\n`,
    [`skills/${SKILL_NAME}/reference/notes.md`]: `Reference notes. ${marker}\n`,
    [`skills/${SKILL_NAME}/scripts/run.sh`]: `#!/bin/sh\necho "${marker}"\n`,
    "README.md": "The rest of the repository, which a subdir must leave behind.\n",
  };
}

interface Fixtures {
  /** The repository Sources point at. */
  repo: string;
  repoUrl: string;
  /** The commit `harv sync` should lock. */
  pinned: string;
  /** A later commit, so reproduction can be told apart from re-resolution. */
  moved: string;
  /** The first project: declares the git Source. */
  project: string;
  /** A machine-global Store shared by every project in the run. */
  store: string;
  /**
   * The stand-ins live in separate directories on purpose: a check that needs
   * to prove `git` was not called must not also disable the real `claude`, and
   * a check that must reach a real remote must not inherit a poisoned `git`.
   */
  gitStub: string;
  claudeStub: string;
  gitReceipt: string;
  claudeReceipt: string;
}

function buildFixtures(): Fixtures {
  const dir = (...parts: string[]): string => {
    const path = join(FIXTURE_ROOT, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };

  const repo = dir("source-repo");
  git(["init", "--quiet"], repo);
  const pinned = commit(repo, skillFiles("Pinned revision."), "the revision harv will lock");

  const project = dir("project");
  writeFileSync(join(project, "harvenv.toml"), "");

  return {
    repo,
    repoUrl: `file://${repo}`,
    pinned,
    moved: "",
    project,
    store: dir("store-home"),
    gitStub: dir("stubs", "git"),
    claudeStub: dir("stubs", "claude"),
    gitReceipt: join(FIXTURE_ROOT, "git-was-run.jsonl"),
    claudeReceipt: join(FIXTURE_ROOT, "claude-was-run.jsonl"),
  };
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [rel, body] of Object.entries(files)) {
    const target = join(repo, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
  }
  git(["add", "--all"], repo);
  git(["commit", "--quiet", "--message", message], repo);
  return git(["rev-parse", "HEAD"], repo);
}

// ---------------------------------------------------------------------------
// Reading what landed on disk
// ---------------------------------------------------------------------------

/** Every file under `root`, as `path -> kind:sha256`. Follows the entry link. */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const descend = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}${posix.sep}${entry.name}`;
      if (entry.isDirectory()) {
        descend(full, rel);
      } else if (entry.isSymbolicLink()) {
        out[rel] = `link:${readlinkSync(full)}`;
      } else {
        const stats = lstatSync(full);
        const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
        out[rel] = `${stats.mode & 0o111 ? "exec" : "file"}:${digest}`;
      }
    }
  };
  descend(realpathSync(root), "");
  return out;
}

const lockText = (project: string): string => readFileSync(join(project, "harvenv.lock"), "utf8");

const skillLink = (project: string, name = SKILL_NAME): string => join(project, ".claude", "skills", name);

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
// Criterion 1 — a clean clone reproduces byte-identical Components
// ---------------------------------------------------------------------------

function checkCleanClone(fx: Fixtures): Check {
  const added = harv(
    ["add", SKILL_NAME, "--git", `${fx.repoUrl}#skills/${SKILL_NAME}`],
    fx.project,
    fx.store,
  );
  if (added.code !== 0) throw new Error(`harv add failed: ${added.stderr.trim()}`);
  const original = fingerprint(skillLink(fx.project));

  // The world moves under the Lockfile: a new commit lands on the branch the
  // Source names. A Sync that re-resolved instead of reproducing would take it.
  fx.moved = commit(fx.repo, skillFiles("Moved on."), "a later revision harv must not take");

  // What a teammate has after `git clone`: the two committed files, no Store,
  // no `.claude/`.
  const clone = join(FIXTURE_ROOT, "clone");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "harvenv.toml"), readFileSync(join(fx.project, "harvenv.toml")));
  writeFileSync(join(clone, "harvenv.lock"), lockText(fx.project));
  const freshStore = join(FIXTURE_ROOT, "clone-store");

  const synced = harv(["sync"], clone, freshStore);
  const reproduced = synced.code === 0 ? fingerprint(skillLink(clone)) : {};
  const diff = differences(original, reproduced);

  return {
    id: "clean-clone",
    title: "A clean clone plus `harv sync` reproduces byte-identical Components from the Lockfile",
    measurements: {
      pinnedCommit: fx.pinned,
      commitAfterMoving: fx.moved,
      files: Object.keys(original).length,
      fingerprint: original,
      differences: diff,
      syncStderr: synced.stderr.trim(),
    },
    expectations: [
      expect("the clone syncs from the Lockfile alone", synced.code === 0, `exit ${synced.code}`),
      expect(
        "every file matches byte for byte, mode included",
        synced.code === 0 && diff.length === 0 && Object.keys(reproduced).length > 0,
        diff.length === 0
          ? `${Object.keys(original).length} files identical: ${Object.keys(original).join(", ")}`
          : `differs at ${diff.join(", ")}`,
      ),
      expect(
        "the locked commit is reproduced, not the newer one the branch now points at",
        reproduced[`SKILL.md`]?.includes(
          createHash("sha256").update(skillFiles("Pinned revision.")[`skills/${SKILL_NAME}/SKILL.md`]!).digest("hex"),
        ) === true,
        `branch moved ${fx.pinned.slice(0, 8)} -> ${fx.moved.slice(0, 8)}; the clone took ${fx.pinned.slice(0, 8)}`,
      ),
      expect(
        "the Lockfile itself is unchanged by the clone's Sync",
        lockText(clone) === lockText(fx.project),
        lockText(clone) === lockText(fx.project) ? "identical" : "the clone rewrote the Lockfile",
      ),
      expect(
        "the subdirectory is applied — the rest of the repository stays behind",
        !existsSync(join(skillLink(clone), "README.md")),
        existsSync(join(skillLink(clone), "README.md")) ? "README.md leaked in" : "only the subdir's files",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — the Store dedupes across projects, with no re-fetch
// ---------------------------------------------------------------------------

function checkStoreDedupe(fx: Fixtures): Check {
  const second = join(FIXTURE_ROOT, "second-project");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "harvenv.toml"), readFileSync(join(fx.project, "harvenv.toml")));
  writeFileSync(join(second, "harvenv.lock"), lockText(fx.project));

  // `git` on this PATH records that it ran and fails. A Sync that needs it
  // cannot succeed, so a zero exit is proof that none was needed.
  stub(fx.gitStub, "git", fx.gitReceipt);
  const synced = harv(["sync"], second, fx.store, { stubs: fx.gitStub });

  const storeEntries = countStoreEntries(fx.store);
  const sameTarget =
    existsSync(skillLink(second)) &&
    existsSync(skillLink(fx.project)) &&
    readlinkSync(skillLink(second)) === readlinkSync(skillLink(fx.project));

  return {
    id: "store-dedupe",
    title: "A second project syncing an already-locked Source performs no re-fetch",
    measurements: {
      exit: synced.code,
      stdout: synced.stdout.trim(),
      gitInvocations: wasRun(fx.gitReceipt) ? readFileSync(fx.gitReceipt, "utf8").trim().split("\n") : [],
      storeEntries,
      target: existsSync(skillLink(second)) ? readlinkSync(skillLink(second)) : null,
    },
    expectations: [
      expect(
        "the second Sync succeeds with a `git` that cannot fetch",
        synced.code === 0,
        synced.code === 0 ? "exit 0" : `exit ${synced.code}: ${synced.stderr.trim().slice(0, 200)}`,
      ),
      expect(
        "git was never invoked",
        !wasRun(fx.gitReceipt),
        wasRun(fx.gitReceipt)
          ? `git ran: ${readFileSync(fx.gitReceipt, "utf8").trim()}`
          : "no invocation recorded",
      ),
      expect("the Sync reports the Source as reused", /reused/.test(synced.stdout), synced.stdout.trim()),
      expect(
        "both projects point at the same Store entry",
        sameTarget,
        sameTarget ? readlinkSync(skillLink(second)) : "the two projects link to different places",
      ),
      expect(
        "the Store holds one copy of the content",
        storeEntries === 1,
        `${storeEntries} entr${storeEntries === 1 ? "y" : "ies"} under the Store`,
      ),
    ],
  };
}

/** Content addresses under the Store: `store/sha256/<shard>/<digest>`. */
function countStoreEntries(store: string): number {
  const algorithm = join(store, "store", "sha256");
  if (!existsSync(algorithm)) return 0;
  return readdirSync(algorithm).reduce((total, shard) => total + readdirSync(join(algorithm, shard)).length, 0);
}

// ---------------------------------------------------------------------------
// Criterion 3 — the pins, and what happens when content does not match them
// ---------------------------------------------------------------------------

function checkPinsAndMismatch(fx: Fixtures): Check {
  const lock = lockText(fx.project);
  const pinnedCommit = /commit = "([0-9a-f]{40})"/.exec(lock)?.[1];
  const pinnedHash = /hash = "(sha256:[0-9a-f]{64})"/.exec(lock)?.[1];

  // A Lockfile promising content this commit does not produce: what a rewritten
  // tag, a tampered remote or a corrupted Store entry looks like from here.
  const tampered = join(FIXTURE_ROOT, "tampered-project");
  mkdirSync(tampered, { recursive: true });
  writeFileSync(join(tampered, "harvenv.toml"), readFileSync(join(fx.project, "harvenv.toml")));
  const wrongHash = `sha256:${"c".repeat(64)}`;
  writeFileSync(join(tampered, "harvenv.lock"), lock.replace(/hash = "sha256:[0-9a-f]{64}"/, `hash = "${wrongHash}"`));

  const synced = harv(["sync"], tampered, join(FIXTURE_ROOT, "tampered-store"));
  const message = `${synced.stderr}${synced.stdout}`;

  return {
    id: "lockfile-pins",
    title: "The Lockfile pins commit SHA and content hash, and a mismatch fails loudly",
    measurements: { pinnedCommit, pinnedHash, exit: synced.code, message: message.trim() },
    expectations: [
      expect(
        "the Lockfile pins the commit the Source resolved to",
        pinnedCommit === fx.pinned,
        `locked ${pinnedCommit ?? "nothing"}; the repository's commit is ${fx.pinned}`,
      ),
      expect(
        "the Lockfile pins a content hash of what that commit produced",
        pinnedHash !== undefined,
        pinnedHash ?? "no hash in the Lockfile",
      ),
      expect("a hash mismatch fails the Sync", synced.code !== 0, `exit ${synced.code}`),
      expect(
        "the failure names the entry and quotes both hashes",
        message.includes(SKILL_NAME) && message.includes(wrongHash) && (pinnedHash ? message.includes(pinnedHash) : false),
        message.trim().split("\n").slice(0, 5).join(" / ") || "(no output)",
      ),
      expect(
        "no stack trace reaches the user",
        !/\bat .*\.ts:\d+/.test(message),
        /\bat .*\.ts:\d+/.test(message) ? "a stack trace leaked" : "message only",
      ),
      expect(
        "nothing is materialized from content that failed its pin",
        !existsSync(skillLink(tampered)),
        existsSync(skillLink(tampered)) ? "the skill was linked anyway" : "the project tree is clean",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — a path Source is allowed, and flagged
// ---------------------------------------------------------------------------

function checkPathWarning(fx: Fixtures): Check {
  const local = join(FIXTURE_ROOT, "local-project");
  mkdirSync(join(local, "vendor", LOCAL_SKILL), { recursive: true });
  writeFileSync(
    join(local, "vendor", LOCAL_SKILL, "SKILL.md"),
    `---\nname: ${LOCAL_SKILL}\ndescription: Marker skill for the harvenv sync check. Never invoke it.\n---\n\nLocal.\n`,
  );
  writeFileSync(join(local, "harvenv.toml"), `[skills]\n${LOCAL_SKILL} = { path = "vendor/${LOCAL_SKILL}" }\n`);

  const synced = harv(["sync"], local, join(FIXTURE_ROOT, "local-store"));
  const linked = existsSync(join(local, ".claude", "skills", LOCAL_SKILL, "SKILL.md"));

  return {
    id: "path-warning",
    title: "A non-portable path Source is allowed, and warned about by name",
    measurements: { exit: synced.code, stderr: synced.stderr.trim(), stdout: synced.stdout.trim() },
    expectations: [
      expect("the Sync succeeds — a path Source is allowed", synced.code === 0, `exit ${synced.code}`),
      expect("the skill is materialized", linked, linked ? "linked into project scope" : "nothing linked"),
      expect(
        "the warning names the entry",
        synced.stderr.includes(LOCAL_SKILL),
        synced.stderr.trim() || "(nothing on stderr)",
      ),
      expect(
        "the warning names the path it will not carry",
        synced.stderr.includes(`vendor/${LOCAL_SKILL}`),
        synced.stderr.includes(`vendor/${LOCAL_SKILL}`) ? "the declared path is quoted" : "the path is not named",
      ),
      expect(
        "the warning says it is a warning, on stderr, not on stdout",
        /warning/i.test(synced.stderr) && !/warning/i.test(synced.stdout),
        /warning/i.test(synced.stderr) ? "on stderr" : "not marked as a warning",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 5 — drift is detected and reported at launch and at sync
// ---------------------------------------------------------------------------

function checkDrift(fx: Fixtures): Check {
  const drifted = join(FIXTURE_ROOT, "drifted-project");
  mkdirSync(drifted, { recursive: true });
  writeFileSync(join(drifted, "harvenv.toml"), readFileSync(join(fx.project, "harvenv.toml")));
  writeFileSync(join(drifted, "harvenv.lock"), lockText(fx.project));

  // A `claude` that records being started. The Launcher must not reach it.
  stub(fx.claudeStub, "claude", fx.claudeReceipt, 0);

  // Before drift: the Launcher starts a session, which is what makes the
  // refusal below a decision rather than a permanent state.
  const beforeDrift = harv(["claude"], drifted, fx.store, { stubs: fx.claudeStub });
  const launchedWhenAgreed = wasRun(fx.claudeReceipt);
  rmSync(fx.claudeReceipt, { force: true });

  // The Manifest moves past the Lockfile: the same Source, a different ref.
  const manifest = readFileSync(join(drifted, "harvenv.toml"), "utf8");
  writeFileSync(join(drifted, "harvenv.toml"), manifest.replace(" }", ', ref = "main" }'));

  const atLaunch = harv(["claude"], drifted, fx.store, { stubs: fx.claudeStub });
  const launchedWhenDrifted = wasRun(fx.claudeReceipt);
  const launchMessage = `${atLaunch.stderr}${atLaunch.stdout}`;

  const atSync = harv(["sync"], drifted, fx.store);
  const syncMessage = `${atSync.stdout}${atSync.stderr}`;

  return {
    id: "drift",
    title: "Manifest/Lockfile drift is detected and reported at launch and at sync",
    measurements: {
      launchedWhenAgreed,
      launchWhenDrifted: { exit: atLaunch.code, message: launchMessage.trim() },
      syncWhenDrifted: { exit: atSync.code, message: syncMessage.trim() },
    },
    expectations: [
      expect(
        "with no drift, the Launcher starts a session",
        beforeDrift.code === 0 && launchedWhenAgreed,
        launchedWhenAgreed ? "claude was started" : `exit ${beforeDrift.code}: ${beforeDrift.stderr.trim().slice(0, 200)}`,
      ),
      expect("drift at launch is a failure, not a warning", atLaunch.code !== 0, `exit ${atLaunch.code}`),
      expect(
        "no session is started while the Harvenv is drifted",
        !launchedWhenDrifted,
        launchedWhenDrifted ? "claude was started anyway" : "claude was never invoked",
      ),
      expect(
        "the launch message names the entry and what to run",
        launchMessage.includes(SKILL_NAME) && /harv sync/.test(launchMessage),
        launchMessage.trim().split("\n").slice(0, 4).join(" / ") || "(no output)",
      ),
      expect(
        "sync reports the same drift as the work it is doing",
        syncMessage.includes(SKILL_NAME) && atSync.code === 0,
        syncMessage.trim().split("\n").slice(0, 4).join(" / ") || "(no output)",
      ),
      expect(
        "after that Sync the Launcher starts a session again",
        (() => {
          rmSync(fx.claudeReceipt, { force: true });
          const after = harv(["claude"], drifted, fx.store, { stubs: fx.claudeStub });
          return after.code === 0 && wasRun(fx.claudeReceipt);
        })(),
        "drift is reconcilable, not terminal",
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
  log("harvenv sync/store/lockfile verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  // Ordered, not independent: the first check is what produces the Lockfile the
  // rest are about, exactly as a user would produce it.
  const runners: Array<[string, string, () => Check]> = [
    ["clean-clone", "A clean clone plus `harv sync` reproduces byte-identical Components", () => checkCleanClone(fx)],
    ["store-dedupe", "A second project syncing an already-locked Source performs no re-fetch", () => checkStoreDedupe(fx)],
    ["lockfile-pins", "The Lockfile pins commit SHA and content hash; a mismatch fails loudly", () => checkPinsAndMismatch(fx)],
    ["path-warning", "A non-portable path Source is allowed, and warned about by name", () => checkPathWarning(fx)],
    ["drift", "Manifest/Lockfile drift is detected and reported at launch and at sync", () => checkDrift(fx)],
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

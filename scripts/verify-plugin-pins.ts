#!/usr/bin/env bun
/**
 * Plugin-pin verification.
 *
 * The unit tests pin harv's logic; this script pins what that logic exists to
 * produce — a real Claude Code session, started by a real `harv claude`,
 * carrying a plugin pinned out of a real git marketplace. It is the acceptance
 * criteria of issue #7, executed rather than asserted:
 *
 *   1. A pinned plugin's skills and commands are available in the hermetic
 *      session, under the plugin's own name.
 *   2. The Lockfile pins the marketplace commit, and a Sync on a second machine
 *      converges to identical bytes — checked after the marketplace has moved
 *      on, so "converged" cannot be confused with "re-resolved".
 *   3. The user's own enabled plugins are absent from that session.
 *   4. The wholesale-plugin caveat is documented in the Manifest reference.
 *
 * Two of these are claims about absence — the user's plugins are *not* there,
 * the second machine did *not* fetch — so they are checked by removing the
 * possibility rather than by reading output: the second Sync runs with a `git`
 * on PATH that records being run and then fails, and the user's plugins are
 * measured in a default session first so that "absent" is known to be a
 * suppression rather than an empty machine.
 *
 * Session facts come from the `system`/`init` event Claude Code emits under
 * `--output-format stream-json --verbose`, which carries the fully resolved
 * inventory the session will run with — the same instrument spikes 0001 and 0003 used, so
 * there is no model in the loop.
 *
 * Three behaviours the design leans on are measured here rather than assumed,
 * because none of them is documented and any release can retire them:
 *
 *   - a plugin served with `--plugin-dir` is named by its
 *     `.claude-plugin/plugin.json`, and by its *directory* when it has none;
 *   - a plugin's hooks fire in the session, which is why "a plugin arrives
 *     whole" is a caveat and not a feature;
 *   - a plugin's MCP servers do *not* survive `--strict-mcp-config`, which is
 *     the one part of "whole" this slice cannot yet deliver.
 *
 * Nothing here touches the machine's Store: HARV_HOME points into the fixture
 * tree. `~/.claude` is read, never written.
 *
 * Run:  bun scripts/verify-plugin-pins.ts [--json] [--keep]
 *       node scripts/verify-plugin-pins.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  existsSync,
  lstatSync,
  mkdirSync,
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

const FIXTURE_ROOT = join(realpathSync(tmpdir()), "harvenv-plugin-verify");
const PROBE_TIMEOUT_MS = 180_000;

/** Pinned from a marketplace subdirectory, and declaring its own name. */
const PLUGIN = "harvenv-verify-pack";
/** Pinned from the same marketplace, declaring no name at all. */
const NAMELESS = "harvenv-verify-nameless";
const MARKETPLACE = "harvenv-verify-marketplace";

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

const harv = (args: string[], cwd: string, store: string, stubs?: string): Completed =>
  runCommand(process.execPath, [HARV, ...args], cwd, {
    HARV_HOME: store,
    ...(stubs ? { PATH: `${stubs}:${process.env.PATH ?? ""}` } : {}),
  });

/** An executable that records that it ran and then fails. Absence, made observable. */
function stub(dir: string, name: string, receipt: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    `#!/usr/bin/env node\n` +
      `require("node:fs").appendFileSync(${JSON.stringify(receipt)}, process.argv.slice(2).join(" ") + "\\n");\n` +
      `process.exit(1);\n`,
    { mode: 0o755 },
  );
}

interface InitEvent {
  claude_code_version?: string;
  skills?: string[];
  slash_commands?: string[];
  agents?: string[];
  plugins?: Array<{ name: string; path?: string }>;
  mcp_servers?: Array<{ name: string; status: string }>;
}

/** Start a session, capture its `init` event, kill it before the turn completes. */
function probeInit(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<InitEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

/** Headless probe flags, passed through `harv claude` so pass-through is exercised too. */
const STREAM_JSON = ["-p", "probe", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];

// ---------------------------------------------------------------------------
// Fixtures — a marketplace repository, and a project that pins out of it
// ---------------------------------------------------------------------------

/** A hook that leaves a file behind, so "it fired" is a fact and not an inference. */
const hookReceipt = join(FIXTURE_ROOT, "plugin-hook-fired.txt");

function marketplaceFiles(marker: string): Record<string, string> {
  const catalogue = {
    name: MARKETPLACE,
    owner: { name: "harvenv verification" },
    plugins: [
      { name: PLUGIN, source: `./plugins/${PLUGIN}`, description: "Marker plugin for the harvenv plugin check." },
      { name: NAMELESS, source: `./plugins/${NAMELESS}`, description: "Marker plugin that declares no name." },
    ],
  };

  return {
    ".claude-plugin/marketplace.json": `${JSON.stringify(catalogue, null, 2)}\n`,

    // A plugin that names itself, and carries one of everything a plugin can
    // carry — so "arrives whole" is checked over structure, not over one file.
    [`plugins/${PLUGIN}/.claude-plugin/plugin.json`]: `${JSON.stringify(
      { name: PLUGIN, version: "1.0.0", description: "Marker plugin for the harvenv plugin check." },
      null,
      2,
    )}\n`,
    [`plugins/${PLUGIN}/skills/${PLUGIN}-skill/SKILL.md`]:
      `---\nname: ${PLUGIN}-skill\ndescription: Marker skill for the harvenv plugin check. Never invoke it.\n---\n\n${marker}\n`,
    [`plugins/${PLUGIN}/skills/${PLUGIN}-skill/reference/notes.md`]: `Reference notes. ${marker}\n`,
    [`plugins/${PLUGIN}/commands/${PLUGIN}-command.md`]:
      `---\ndescription: Marker command for the harvenv plugin check.\n---\n\n${marker}\n`,
    [`plugins/${PLUGIN}/agents/${PLUGIN}-agent.md`]:
      `---\nname: ${PLUGIN}-agent\ndescription: Marker subagent for the harvenv plugin check.\n---\n\n${marker}\n`,
    [`plugins/${PLUGIN}/hooks/hooks.json`]: `${JSON.stringify(
      {
        description: "Marker hook for the harvenv plugin check.",
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: `bash "\${CLAUDE_PLUGIN_ROOT}/hooks/receipt.sh"` }] }],
        },
      },
      null,
      2,
    )}\n`,
    [`plugins/${PLUGIN}/hooks/receipt.sh`]: `#!/bin/sh\necho "${marker}" >> ${JSON.stringify(hookReceipt)}\nexit 0\n`,
    // Declared, and — measured below — not served under the launch recipe.
    [`plugins/${PLUGIN}/.mcp.json`]: `${JSON.stringify({ mcpServers: { "verify-docs": { command: "node" } } }, null, 2)}\n`,

    // A plugin with no `plugin.json`: real marketplaces publish these, and the
    // only name it can answer to is the directory's.
    [`plugins/${NAMELESS}/skills/${NAMELESS}-skill/SKILL.md`]:
      `---\nname: ${NAMELESS}-skill\ndescription: Marker skill for the harvenv plugin check. Never invoke it.\n---\n\n${marker}\n`,

    "README.md": "The rest of the marketplace, which resolving a plugin must leave behind.\n",
  };
}

interface Fixtures {
  marketplace: string;
  marketplaceUrl: string;
  /** The commit `harv sync` should lock. */
  pinned: string;
  /** A later commit, so convergence can be told apart from re-resolution. */
  moved: string;
  project: string;
  store: string;
  gitStub: string;
  gitReceipt: string;
}

function buildFixtures(): Fixtures {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  const dir = (...parts: string[]): string => {
    const path = join(FIXTURE_ROOT, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };

  const marketplace = dir("marketplace");
  git(["init", "--quiet"], marketplace);
  const pinned = commit(marketplace, marketplaceFiles("Pinned revision."), "the revision harv will lock");

  const project = dir("project");
  writeFileSync(join(project, "harvenv.toml"), "");

  return {
    marketplace,
    marketplaceUrl: `file://${marketplace}`,
    pinned,
    moved: "",
    project,
    store: dir("store-home"),
    gitStub: dir("stubs", "git"),
    gitReceipt: join(FIXTURE_ROOT, "git-was-run.txt"),
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
      if (entry.isDirectory()) descend(full, rel);
      else if (entry.isSymbolicLink()) out[rel] = `link:${readlinkSync(full)}`;
      else out[rel] = `${lstatSync(full).mode & 0o111 ? "exec" : "file"}:${sha256(readFileSync(full))}`;
    }
  };
  descend(realpathSync(root), "");
  return out;
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const lockText = (project: string): string => readFileSync(join(project, "harvenv.lock"), "utf8");

const pluginLink = (project: string, name = PLUGIN): string => join(project, ".claude", "harv-plugins", name);

const differences = (a: Record<string, string>, b: Record<string, string>): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]);

/** Entries of the session inventory that belong to this run's fixtures. */
const mine = (entries: string[] | undefined): string[] =>
  (entries ?? []).filter((entry) => entry.includes("harvenv-verify"));

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
// Criterion 1 — a pinned plugin's skills and commands reach the session
// ---------------------------------------------------------------------------

async function checkPluginInSession(fx: Fixtures): Promise<{ check: Check; init: InitEvent }> {
  const added = harv(["add", PLUGIN, "--marketplace", fx.marketplaceUrl], fx.project, fx.store);
  if (added.code !== 0) throw new Error(`harv add failed: ${added.stderr.trim()}`);
  const alsoNameless = harv(["add", NAMELESS, "--marketplace", fx.marketplaceUrl], fx.project, fx.store);
  if (alsoNameless.code !== 0) throw new Error(`harv add failed for ${NAMELESS}: ${alsoNameless.stderr.trim()}`);

  rmSync(hookReceipt, { force: true });
  const init = await probeInit(process.execPath, [HARV, "claude", ...STREAM_JSON], fx.project, {
    HARV_HOME: fx.store,
  });
  // The hook writes from its own process; `init` arrives after SessionStart
  // hooks run, but the write itself is not synchronised with the event.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const plugins = (init.plugins ?? []).map((plugin) => plugin.name);
  const skills = mine(init.skills);
  const commands = mine(init.slash_commands);
  const agents = mine(init.agents);

  return {
    init,
    check: {
      id: "plugin-in-session",
      title: "A pinned plugin's skills and commands are available in the hermetic session",
      measurements: {
        claudeCodeVersion: init.claude_code_version,
        plugins: init.plugins,
        skills,
        commands,
        agents,
        mcpServers: init.mcp_servers,
        hookFired: existsSync(hookReceipt),
      },
      expectations: [
        expect(
          "the pinned plugin is loaded as a plugin",
          plugins.includes(PLUGIN),
          plugins.length > 0 ? plugins.join(", ") : "the session loaded no plugins at all",
        ),
        expect(
          "its skill is invocable, under the plugin's own name",
          skills.includes(`${PLUGIN}:${PLUGIN}-skill`),
          skills.join(", ") || "(no fixture skills in the session)",
        ),
        expect(
          "its command is invocable, under the plugin's own name",
          commands.includes(`${PLUGIN}:${PLUGIN}-command`),
          commands.join(", ") || "(no fixture commands in the session)",
        ),
        expect(
          "its subagent is available too — a plugin arrives whole",
          agents.includes(`${PLUGIN}:${PLUGIN}-agent`),
          agents.join(", ") || "(no fixture subagents in the session)",
        ),
        expect(
          "its hooks fire, which is why the wholesale caveat is documented",
          existsSync(hookReceipt),
          existsSync(hookReceipt) ? readFileSync(hookReceipt, "utf8").trim() : "no hook receipt was written",
        ),
        expect(
          "the name comes from the plugin, not from the hash-named Store entry it is served from",
          skills.every((skill) => !/sha256|^[0-9a-f]{16}/.test(skill)) &&
            readlinkSync(pluginLink(fx.project)).includes("sha256"),
          `${pluginLink(fx.project)} -> ${readlinkSync(pluginLink(fx.project))}`,
        ),
        expect(
          "a plugin that declares no name still answers to the one it is pinned as",
          plugins.includes(NAMELESS) && skills.includes(`${NAMELESS}:${NAMELESS}-skill`),
          skills.filter((skill) => skill.startsWith(NAMELESS)).join(", ") || `${NAMELESS} did not load`,
        ),
        expect(
          "the MCP server the plugin declares is not served — the one part of `whole` this slice defers",
          (init.mcp_servers ?? []).length === 0,
          (init.mcp_servers ?? []).map((server) => server.name).join(", ") || "no MCP servers, as `--strict-mcp-config` requires",
        ),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — the commit is pinned, and a second machine converges on bytes
// ---------------------------------------------------------------------------

function checkSecondMachine(fx: Fixtures): Check {
  const lock = lockText(fx.project);
  const pinnedCommit = /\[\[plugins\]\][\s\S]*?commit = "([0-9a-f]{40})"/.exec(lock)?.[1];
  const pinnedHash = /\[\[plugins\]\][\s\S]*?hash = "(sha256:[0-9a-f]{64})"/.exec(lock)?.[1];
  const original = fingerprint(pluginLink(fx.project));

  // The marketplace moves under the Lockfile — new content, and the plugin
  // relocated inside the repository. A Sync that re-resolved would take both.
  const movedFiles = Object.fromEntries(
    Object.entries(marketplaceFiles("Moved on.")).map(([rel, body]) => [
      rel.replace(`plugins/${PLUGIN}/`, `packs/${PLUGIN}/`),
      rel === ".claude-plugin/marketplace.json" ? body.replace(`./plugins/${PLUGIN}`, `./packs/${PLUGIN}`) : body,
    ]),
  );
  git(["rm", "--quiet", "-r", `plugins/${PLUGIN}`], fx.marketplace);
  fx.moved = commit(fx.marketplace, movedFiles, "a later revision harv must not take");

  // What a teammate has after `git clone`: two committed files, no Store, no
  // `.claude/` — and a `git` that records being run and then fails, so a Sync
  // that needed the network could not finish at all.
  const second = join(FIXTURE_ROOT, "second-machine");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "harvenv.toml"), readFileSync(join(fx.project, "harvenv.toml")));
  writeFileSync(join(second, "harvenv.lock"), lock);

  stub(fx.gitStub, "git", fx.gitReceipt);
  const withStore = harv(["sync"], second, fx.store, fx.gitStub);
  const converged = withStore.code === 0 ? fingerprint(pluginLink(second)) : {};
  const diff = differences(original, converged);

  // And once more from an empty Store, which does have to fetch — the same
  // bytes have to come back from the commit alone.
  const third = join(FIXTURE_ROOT, "third-machine");
  mkdirSync(third, { recursive: true });
  writeFileSync(join(third, "harvenv.toml"), readFileSync(join(fx.project, "harvenv.toml")));
  writeFileSync(join(third, "harvenv.lock"), lock);
  const coldSync = harv(["sync"], third, join(FIXTURE_ROOT, "third-store"));
  const cold = coldSync.code === 0 ? fingerprint(pluginLink(third)) : {};
  const coldDiff = differences(original, cold);

  return {
    id: "second-machine",
    title: "The Lockfile pins the marketplace commit, and a second machine converges to identical bytes",
    measurements: {
      pinnedCommit,
      pinnedHash,
      commitAfterMoving: fx.moved,
      files: Object.keys(original).length,
      fingerprint: original,
      warmDifferences: diff,
      coldDifferences: coldDiff,
      gitInvocations: existsSync(fx.gitReceipt) ? readFileSync(fx.gitReceipt, "utf8").trim().split("\n") : [],
    },
    expectations: [
      expect(
        "the Lockfile pins the marketplace's commit",
        pinnedCommit === fx.pinned,
        `locked ${pinnedCommit ?? "nothing"}; the marketplace's commit was ${fx.pinned}`,
      ),
      expect(
        "the Lockfile pins a content hash of the plugin that commit produced",
        pinnedHash !== undefined,
        pinnedHash ?? "no plugin hash in the Lockfile",
      ),
      expect(
        "a second machine syncs from the Lockfile with a `git` that cannot fetch",
        withStore.code === 0 && !existsSync(fx.gitReceipt),
        withStore.code === 0
          ? existsSync(fx.gitReceipt)
            ? `git ran: ${readFileSync(fx.gitReceipt, "utf8").trim()}`
            : "exit 0, no invocation recorded"
          : `exit ${withStore.code}: ${withStore.stderr.trim().slice(0, 200)}`,
      ),
      expect(
        "every file matches byte for byte, mode included",
        withStore.code === 0 && diff.length === 0 && Object.keys(converged).length > 0,
        diff.length === 0 && Object.keys(converged).length > 0
          ? `${Object.keys(original).length} files identical: ${Object.keys(original).join(", ")}`
          : `differs at ${diff.join(", ") || "(nothing was materialized)"}`,
      ),
      expect(
        "a machine with an empty Store fetches the locked commit and converges on the same bytes",
        coldSync.code === 0 && coldDiff.length === 0 && Object.keys(cold).length > 0,
        coldSync.code === 0
          ? coldDiff.length === 0
            ? "identical after a real fetch"
            : `differs at ${coldDiff.join(", ")}`
          : `exit ${coldSync.code}: ${coldSync.stderr.trim().slice(0, 200)}`,
      ),
      expect(
        "the locked commit is reproduced, not the newer one the marketplace now points at",
        cold[`skills/${PLUGIN}-skill/SKILL.md`] !== undefined &&
          cold[`skills/${PLUGIN}-skill/SKILL.md`]?.includes(
            sha256(marketplaceFiles("Pinned revision.")[`plugins/${PLUGIN}/skills/${PLUGIN}-skill/SKILL.md`]!),
          ) === true,
        `marketplace moved ${fx.pinned.slice(0, 8)} -> ${fx.moved.slice(0, 8)}, and relocated the plugin; ` +
          `the clone took ${fx.pinned.slice(0, 8)}`,
      ),
      expect(
        "the plugin is stored, not the marketplace that published it",
        !existsSync(join(pluginLink(third), "README.md")) &&
          !existsSync(join(pluginLink(third), ".claude-plugin", "marketplace.json")),
        existsSync(join(pluginLink(third), "README.md"))
          ? "the marketplace's own files leaked in"
          : "only the plugin's own files",
      ),
      expect(
        "the Lockfile itself is unchanged by the second machine's Sync",
        lockText(second) === lock,
        lockText(second) === lock ? "identical" : "the second machine rewrote the Lockfile",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — the user's own plugins are absent from the session
// ---------------------------------------------------------------------------

async function checkUserPluginsAbsent(fx: Fixtures, harvSession: InitEvent): Promise<Check> {
  // Measured first in a default session, so "absent" is known to be a
  // suppression rather than a machine that had nothing to suppress.
  const bare = join(FIXTURE_ROOT, "bare");
  mkdirSync(bare, { recursive: true });
  const defaultSession = await probeInit("claude", STREAM_JSON, bare);

  const userPlugins = (defaultSession.plugins ?? []).map((plugin) => plugin.name);
  const inHarv = (harvSession.plugins ?? []).map((plugin) => plugin.name);
  const leaked = inHarv.filter((name) => userPlugins.includes(name));
  const prefixed = (harvSession.skills ?? []).filter(
    (skill) => skill.includes(":") && !skill.startsWith(PLUGIN) && !skill.startsWith(NAMELESS),
  );

  const hasUserPlugins = userPlugins.length > 0;

  return {
    id: "user-plugins-absent",
    title: "The user's own enabled plugins are absent from the session",
    measurements: {
      userPluginCount: userPlugins.length,
      userPlugins,
      pluginsInHarvSession: inHarv,
      userSkillCount: (defaultSession.skills ?? []).length,
      harvSkillCount: (harvSession.skills ?? []).length,
      strayNamespacedSkills: prefixed,
    },
    expectations: [
      expect(
        "the machine has user plugins to suppress",
        hasUserPlugins ? true : null,
        hasUserPlugins
          ? `${userPlugins.length} in a default session: ${userPlugins.slice(0, 6).join(", ")}${userPlugins.length > 6 ? ", …" : ""}`
          : "this machine enables no plugins, so there is nothing to suppress — not a pass",
      ),
      expect(
        "none of them is in the harv session",
        hasUserPlugins ? leaked.length === 0 : null,
        leaked.length === 0 ? "none leaked through" : `leaked: ${leaked.join(", ")}`,
      ),
      expect(
        "the only plugins in the session are the ones the Manifest pins",
        inHarv.length === 2 && inHarv.includes(PLUGIN) && inHarv.includes(NAMELESS),
        inHarv.join(", ") || "(no plugins in the harv session)",
      ),
      expect(
        "no `<plugin>:<name>` Component survives from any other plugin",
        prefixed.length === 0,
        prefixed.length === 0 ? "every namespaced skill belongs to a pinned plugin" : prefixed.join(", "),
      ),
      expect(
        "the session is smaller than a default one — suppression, not addition",
        (harvSession.skills ?? []).length < (defaultSession.skills ?? []).length,
        `${(harvSession.skills ?? []).length} skills with harv, ${(defaultSession.skills ?? []).length} by default`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — the wholesale caveat is documented where a Manifest author reads
// ---------------------------------------------------------------------------

function checkDocumented(): Check {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const section = /##+ .*[Pp]lugin[\s\S]*?(?=\n## |$)/.exec(readme)?.[0] ?? "";

  const says = (pattern: RegExp): boolean => pattern.test(section);

  return {
    id: "documented",
    title: "The wholesale-plugin caveat is documented in the Manifest reference",
    measurements: { sectionFound: section !== "", sectionLength: section.length },
    expectations: [
      expect("the Manifest reference has a section on plugin pins", section !== "", `${section.length} characters`),
      expect(
        "it shows the `[plugins]` syntax a Manifest author has to write",
        says(/\[plugins\]/) && says(/marketplace\s*=/),
        says(/\[plugins\]/) ? "the table and its marketplace key are shown" : "no `[plugins]` example",
      ),
      expect(
        "it says a plugin arrives whole, and names what comes with it",
        says(/whole/i) && says(/hook/i) && says(/skill/i),
        says(/whole/i) ? "the word is there, with hooks and skills named" : "the caveat is not stated",
      ),
      expect(
        "it says there is no way to take part of one",
        says(/no (way|partial)|cannot (take|disable)|there is no seam|wholesale/i),
        says(/no (way|partial)|cannot (take|disable)|there is no seam|wholesale/i)
          ? "partial adoption is ruled out in writing"
          : "nothing rules out partial adoption",
      ),
      expect(
        "it says the plugin's name prefixes what it carries",
        says(/:/) && says(/prefix|namespac/i),
        says(/prefix|namespac/i) ? "the `<plugin>:<name>` form is explained" : "the prefix is not explained",
      ),
      expect(
        "it states the MCP gap this slice leaves",
        says(/MCP/),
        says(/MCP/) ? "the unserved MCP servers are called out" : "the MCP gap is undocumented",
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
  log("harvenv plugin-pin verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  const checks: Check[] = [];
  const record = async (id: string, title: string, run: () => Promise<Check> | Check): Promise<void> => {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ id, title, expectations: [], measurements: {}, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Ordered, not independent: the first check produces the pinned project and
  // the session inventory the rest are about, exactly as a user would.
  let session: InitEvent = {};
  await record("plugin-in-session", "A pinned plugin's skills and commands reach the hermetic session", async () => {
    const { check, init } = await checkPluginInSession(fx);
    session = init;
    return check;
  });
  await record(
    "user-plugins-absent",
    "The user's own enabled plugins are absent from the session",
    () => checkUserPluginsAbsent(fx, session),
  );
  await record(
    "second-machine",
    "The Lockfile pins the marketplace commit; a second machine converges to identical bytes",
    () => checkSecondMachine(fx),
  );
  await record("documented", "The wholesale-plugin caveat is documented in the Manifest reference", checkDocumented);

  if (!keep) rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const failures = checks.filter(failed);
  if (asJson) {
    console.log(JSON.stringify({ ok: failures.length === 0, checks }, null, 2));
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

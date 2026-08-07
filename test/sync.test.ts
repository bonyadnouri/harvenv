import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fetchSource, resolveCommit } from "../src/git.ts";
import { readLockfile } from "../src/lockfile.ts";
import { loadManifest } from "../src/manifest.ts";
import type { Manifest } from "../src/manifest.ts";
import { hashTree, storePath, toolsRoot } from "../src/store.ts";
import type { Env } from "../src/store.ts";
import { composeSession, NO_OVERLAY } from "../src/overlay.ts";
import { plan, readLocks, sync, SyncError, toolPaths } from "../src/sync.ts";
import type { SyncDeps } from "../src/sync.ts";
import { ToolchainError } from "../src/tools.ts";
import type { ToolchainDeps } from "../src/tools.ts";
import {
  commitFiles,
  git,
  gitRepo,
  marketplaceFile,
  marketplaceWith,
  pluginFile,
  skillFile,
  tempDir,
} from "./helpers.ts";

/** A Store of this test's own. Every sync in one test must share it to dedupe. */
const home = (): Env => ({ HARV_HOME: tempDir() });

/** A Session made of this Manifest and nothing else — no Overlay in sight. */
const solo = (manifest: Manifest) => composeSession(manifest, NO_OVERLAY);

/** A project whose Manifest is `body`. */
function project(body: string): Manifest {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), body);
  return loadManifest(join(root, "harvenv.toml"));
}

/**
 * The real git layer, wrapped so a test can count fetches. Nothing is faked:
 * "no re-fetch" is only worth asserting about the code that really fetches.
 */
function counting(env: Env): SyncDeps & { fetches: string[] } {
  const fetches: string[] = [];
  return {
    env,
    resolveCommit,
    fetchSource: (source, commit, forEnv) => {
      fetches.push(commit);
      return fetchSource(source, commit, forEnv);
    },
    // No engine, so a test that declares no tools resolves none — and one that
    // does gets the recorded-hint path without an installer on the machine.
    toolchain: { findMise: () => ({ unavailable: "no engine in this test" }) },
    fetches,
  };
}

/** A Sync that cannot reach a remote — so finishing at all is the assertion. */
const offline = (env: Env): SyncDeps => ({
  env,
  resolveCommit: () => {
    throw new Error("resolveCommit was called, so this Sync reached the network");
  },
  fetchSource: () => {
    throw new Error("fetchSource was called, so this Sync re-fetched");
  },
  toolchain: { findMise: () => ({ unavailable: "no engine in this test" }) },
});

const skillsDir = (root: string) => join(root, ".claude", "skills");

test("sync locks a git Source with the commit it resolved and the hash of what it fetched", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  sync(solo(manifest), counting(home()));

  const locked = readLockfile(manifest.root)?.skills[0];
  assert.equal(locked?.name, "example");
  assert.equal(locked?.commit, repo.commit);
  assert.match(locked?.hash ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("sync materializes a git Source out of the Store, not out of the project", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  sync(solo(manifest), counting(env));

  const link = join(skillsDir(manifest.root), "example");
  assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), skillFile("example"));
  const hash = readLockfile(manifest.root)?.skills[0]?.hash ?? "";
  assert.equal(existsSync(join(storePath(hash, env), "SKILL.md")), true, "the bytes live in the Store");
});

test("sync narrows a git Source to its subdirectory and names the skill by its Manifest key", () => {
  const repo = gitRepo({ "README.md": "repo\n", "skills/example/SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}", subdir = "skills/example" }\n`);

  sync(solo(manifest), counting(home()));

  assert.equal(existsSync(join(skillsDir(manifest.root), "example", "SKILL.md")), true);
  assert.equal(existsSync(join(skillsDir(manifest.root), "example", "README.md")), false);
});

test("sync run twice fetches once and leaves the Lockfile byte-identical", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  const deps = counting(env);

  sync(solo(manifest), deps);
  const first = readFileSync(join(manifest.root, "harvenv.lock"), "utf8");
  const second = sync(solo(manifest), deps);

  assert.equal(deps.fetches.length, 1, "the second Sync fetched nothing");
  assert.deepEqual(second.fetched, []);
  assert.deepEqual(second.reused, ["example"]);
  assert.equal(readFileSync(join(manifest.root, "harvenv.lock"), "utf8"), first);
});

test("a second project declaring an already-fetched Source reaches no network at all", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const declaration = `[skills]\nexample = { git = "${repo.url}" }\n`;
  const first = project(declaration);
  sync(solo(first), counting(env));

  // The same declaration, a different project, and a Sync that cannot fetch.
  const second = project(declaration);
  writeFileSync(join(second.root, "harvenv.lock"), readFileSync(join(first.root, "harvenv.lock"), "utf8"));
  const result = sync(solo(second), offline(env));

  assert.deepEqual(result.reused, ["example"]);
  assert.equal(
    readFileSync(join(skillsDir(second.root), "example", "SKILL.md"), "utf8"),
    skillFile("example"),
  );
});

test("sync reproduces the locked commit even after the branch has moved on", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example", "First.\n") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(solo(manifest), counting(env));
  const locked = readFileSync(join(manifest.root, "harvenv.lock"), "utf8");

  // The world moves: a new commit lands, and this machine loses its Store.
  commitFiles(repo.dir, { "SKILL.md": skillFile("example", "Second.\n") }, "second");
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });
  rmSync(join(manifest.root, ".claude"), { recursive: true, force: true });
  sync(solo(manifest), counting(env));

  assert.match(readFileSync(join(skillsDir(manifest.root), "example", "SKILL.md"), "utf8"), /First\./);
  assert.equal(readFileSync(join(manifest.root, "harvenv.lock"), "utf8"), locked, "the Lockfile did not move");
});

test("sync fails loudly when a fetch does not produce the content the Lockfile pinned", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(solo(manifest), counting(env));

  // A Lockfile that promises content this commit does not produce — what a
  // tampered repository or a corrupted Store entry looks like from here.
  const tampered = readFileSync(join(manifest.root, "harvenv.lock"), "utf8").replace(
    /hash = "sha256:[0-9a-f]{64}"/,
    `hash = "sha256:${"c".repeat(64)}"`,
  );
  writeFileSync(join(manifest.root, "harvenv.lock"), tampered);
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });

  assert.throws(
    () => sync(solo(manifest), counting(env)),
    (err: Error) =>
      err instanceof SyncError &&
      /example/.test(err.message) &&
      /c{64}/.test(err.message) &&
      /hash/i.test(err.message),
  );
});

test("sync warns by name that a path Source will not survive a clone", () => {
  const manifest = project('[skills]\nlocal-thing = { path = "vendor/local-thing" }\n');
  mkdirSync(join(manifest.root, "vendor", "local-thing"), { recursive: true });
  writeFileSync(join(manifest.root, "vendor", "local-thing", "SKILL.md"), skillFile("local-thing"));

  const result = sync(solo(manifest), counting(home()));

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /local-thing/);
  assert.match(result.warnings[0] ?? "", /vendor\/local-thing/);
});

test("sync does not warn about a git Source, which does survive a clone", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  assert.deepEqual(sync(solo(manifest), counting(home())).warnings, []);
});

test("sync locks a path Source without a content hash, because a local directory is live", () => {
  const manifest = project('[skills]\nlocal-thing = { path = "vendor/local-thing" }\n');
  mkdirSync(join(manifest.root, "vendor", "local-thing"), { recursive: true });
  writeFileSync(join(manifest.root, "vendor", "local-thing", "SKILL.md"), skillFile("local-thing"));

  sync(solo(manifest), counting(home()));

  const locked = readLockfile(manifest.root)?.skills[0];
  assert.deepEqual(locked?.source, {
    kind: "path",
    declared: "vendor/local-thing",
    path: join(manifest.root, "vendor", "local-thing"),
  });
  assert.equal(locked?.hash, undefined);
});

test("sync reports the drift it is about to resolve", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  const result = sync(solo(manifest), counting(env));

  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0]?.name, "example");
});

test("sync re-resolves a Source whose ref moved in the Manifest", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example", "On main.\n") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(solo(manifest), counting(env));

  git(["checkout", "--quiet", "-b", "next"], repo.dir);
  const onNext = commitFiles(repo.dir, { "SKILL.md": skillFile("example", "On next.\n") }, "on next");
  writeFileSync(join(manifest.root, "harvenv.toml"), `[skills]\nexample = { git = "${repo.url}", ref = "next" }\n`);
  sync(solo(loadManifest(join(manifest.root, "harvenv.toml"))), counting(env));

  assert.equal(readLockfile(manifest.root)?.skills[0]?.commit, onNext);
  assert.match(readFileSync(join(skillsDir(manifest.root), "example", "SKILL.md"), "utf8"), /On next\./);
});

test("sync drops a skill from project scope once the Manifest stops declaring it", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(solo(manifest), counting(env));

  writeFileSync(join(manifest.root, "harvenv.toml"), "");
  sync(solo(loadManifest(join(manifest.root, "harvenv.toml"))), counting(env));

  assert.equal(existsSync(join(skillsDir(manifest.root), "example")), false);
  assert.deepEqual(readLockfile(manifest.root)?.skills, []);
});

test("sync rejects a fetched Source whose SKILL.md disagrees with its Manifest key", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("published-name") });
  const manifest = project(`[skills]\ndeclared-name = { git = "${repo.url}" }\n`);

  assert.throws(() => sync(solo(manifest), counting(home())), /published-name/);
});

test("the Store holds one copy when two projects declare the same Source", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const declaration = `[skills]\nexample = { git = "${repo.url}" }\n`;

  const first = project(declaration);
  sync(solo(first), counting(env));
  const second = project(declaration);
  sync(solo(second), counting(env));

  const hash = readLockfile(first.root)?.skills[0]?.hash ?? "";
  assert.equal(readLockfile(second.root)?.skills[0]?.hash, hash);
  assert.equal(hashTree(storePath(hash, env)), hash, "the Store entry still hashes to its own address");
});

// ---------------------------------------------------------------------------
// plan — what the Launcher resolves from the Lockfile alone, without fetching
// ---------------------------------------------------------------------------

test("plan resolves every locked git Source to its Store path", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(solo(manifest), counting(env));

  const resolved = plan(solo(manifest), readLocks(manifest.root), env);

  const hash = readLockfile(manifest.root)?.skills[0]?.hash ?? "";
  assert.deepEqual(resolved.skills, [{ name: "example", path: storePath(hash, env) }]);
});

test("plan tells the user to sync when the Store does not hold what the Lockfile pins", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(solo(manifest), counting(env));
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });

  assert.throws(
    () => plan(solo(manifest), readLocks(manifest.root), env),
    (err: Error) => err instanceof SyncError && /example/.test(err.message) && /harv sync/.test(err.message),
  );
});

test("plan resolves a locked path Source to the directory itself", () => {
  const env = home();
  const manifest = project('[skills]\nlocal-thing = { path = "vendor/local-thing" }\n');
  mkdirSync(join(manifest.root, "vendor", "local-thing"), { recursive: true });
  writeFileSync(join(manifest.root, "vendor", "local-thing", "SKILL.md"), skillFile("local-thing"));
  sync(solo(manifest), counting(env));

  const resolved = plan(solo(manifest), readLocks(manifest.root), env);

  assert.deepEqual(resolved.skills, [
    { name: "local-thing", path: join(manifest.root, "vendor", "local-thing") },
  ]);
});

// ---------------------------------------------------------------------------
// Plugin pins — a marketplace commit in, a plugin the session can load out
// ---------------------------------------------------------------------------

const pluginLink = (root: string, name = "alpha-pack") => join(root, ".claude", "harv-plugins", name);

/** A marketplace repository publishing one plugin in a subdirectory. */
const marketplaceRepo = (plugin = "alpha-pack", body = "Marker.\n") => gitRepo(marketplaceWith(plugin, "fixtures", body));

test("sync pins a plugin by the marketplace commit and the plugin's own content hash", () => {
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);

  sync(solo(manifest), counting(home()));

  const locked = readLockfile(manifest.root)?.plugins[0];
  assert.equal(locked?.name, "alpha-pack");
  assert.equal(locked?.commit, marketplace.commit, "the commit pinned is the marketplace's");
  assert.match(locked?.hash ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("sync resolves the plugin out of the marketplace and leaves the rest of it behind", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);

  sync(solo(manifest), counting(env));

  const link = pluginLink(manifest.root);
  assert.equal(existsSync(join(link, ".claude-plugin", "plugin.json")), true, "the plugin's own manifest");
  assert.equal(existsSync(join(link, "skills", "alpha-pack-skill", "SKILL.md")), true);
  assert.equal(existsSync(join(link, "commands", "alpha-pack-command.md")), true);
  assert.equal(existsSync(join(link, "README.md")), false, "the marketplace's own files stay behind");
  assert.equal(existsSync(join(link, ".claude-plugin", "marketplace.json")), false);
});

test("sync serves a plugin from the Store, through a link named after the plugin", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);

  sync(solo(manifest), counting(env));

  const hash = readLockfile(manifest.root)?.plugins[0]?.hash ?? "";
  assert.equal(readlinkSync(pluginLink(manifest.root)), storePath(hash, env));
  assert.equal(existsSync(join(storePath(hash, env), ".claude-plugin", "plugin.json")), true);
});

test("sync run twice fetches a marketplace once and leaves the Lockfile byte-identical", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  const deps = counting(env);

  sync(solo(manifest), deps);
  const first = readFileSync(join(manifest.root, "harvenv.lock"), "utf8");
  const second = sync(solo(manifest), deps);

  assert.equal(deps.fetches.length, 1, "the second Sync fetched nothing");
  assert.deepEqual(second.reused, ["alpha-pack"]);
  assert.equal(readFileSync(join(manifest.root, "harvenv.lock"), "utf8"), first);
});

test("a second machine converges on identical bytes from the Lockfile, with no network", () => {
  const first = home();
  const marketplace = marketplaceRepo();
  const declaration = `[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`;
  const original = project(declaration);
  sync(solo(original), counting(first));

  // What a teammate has after `git clone`: the Manifest and the Lockfile, and a
  // Store that already holds the content — so nothing may be fetched at all.
  const second = project(declaration);
  writeFileSync(join(second.root, "harvenv.lock"), readFileSync(join(original.root, "harvenv.lock"), "utf8"));
  const result = sync(solo(second), offline(first));

  assert.deepEqual(result.reused, ["alpha-pack"]);
  assert.equal(hashTree(realpathSync(pluginLink(second.root))), readLockfile(original.root)?.plugins[0]?.hash);
});

test("sync reproduces the locked marketplace commit even after the marketplace moved on", () => {
  const env = home();
  const marketplace = marketplaceRepo("alpha-pack", "First.\n");
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(manifest), counting(env));
  const locked = readFileSync(join(manifest.root, "harvenv.lock"), "utf8");

  commitFiles(marketplace.dir, marketplaceWith("alpha-pack", "fixtures", "Second.\n"), "second");
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });
  rmSync(join(manifest.root, ".claude"), { recursive: true, force: true });
  sync(solo(manifest), counting(env));

  const skill = join(pluginLink(manifest.root), "skills", "alpha-pack-skill", "SKILL.md");
  assert.match(readFileSync(skill, "utf8"), /First\./);
  assert.equal(readFileSync(join(manifest.root, "harvenv.lock"), "utf8"), locked, "the Lockfile did not move");
});

test("sync follows a plugin that moved inside a marketplace it re-resolves", () => {
  // Where a plugin lives is the marketplace's to state, so a reorganized
  // marketplace at a new ref is followed rather than reported as broken.
  const env = home();
  const marketplace = gitRepo(marketplaceWith("alpha-pack"));
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(manifest), counting(env));

  git(["checkout", "--quiet", "-b", "next"], marketplace.dir);
  git(["rm", "--quiet", "-r", "plugins"], marketplace.dir);
  const moved = commitFiles(
    marketplace.dir,
    {
      ".claude-plugin/marketplace.json": marketplaceFile("fixtures", { "alpha-pack": "./packs/alpha-pack" }),
      "packs/alpha-pack/.claude-plugin/plugin.json": pluginFile("alpha-pack"),
      "packs/alpha-pack/skills/alpha-pack-skill/SKILL.md": skillFile("alpha-pack-skill", "Moved.\n"),
    },
    "reorganized",
  );
  writeFileSync(
    join(manifest.root, "harvenv.toml"),
    `[plugins]\nalpha-pack = { marketplace = "${marketplace.url}", ref = "next" }\n`,
  );
  sync(solo(loadManifest(join(manifest.root, "harvenv.toml"))), counting(env));

  assert.equal(readLockfile(manifest.root)?.plugins[0]?.commit, moved);
  assert.match(
    readFileSync(join(pluginLink(manifest.root), "skills", "alpha-pack-skill", "SKILL.md"), "utf8"),
    /Moved\./,
  );
});

test("sync fails loudly when a marketplace fetch does not produce the pinned content", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(manifest), counting(env));

  const tampered = readFileSync(join(manifest.root, "harvenv.lock"), "utf8").replace(
    /hash = "sha256:[0-9a-f]{64}"/,
    `hash = "sha256:${"c".repeat(64)}"`,
  );
  writeFileSync(join(manifest.root, "harvenv.lock"), tampered);
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });

  assert.throws(
    () => sync(solo(manifest), counting(env)),
    (err: Error) => err instanceof SyncError && /alpha-pack/.test(err.message) && /c{64}/.test(err.message),
  );
});

test("sync names the plugins a marketplace does offer when the pin is not among them", () => {
  const marketplace = marketplaceRepo("alpha-pack");
  const manifest = project(`[plugins]\nbeta-pack = { marketplace = "${marketplace.url}" }\n`);

  assert.throws(
    () => sync(solo(manifest), counting(home())),
    (err: Error) => /beta-pack/.test(err.message) && /alpha-pack/.test(err.message),
  );
});

test("sync warns by name about MCP servers a pinned plugin ships and the recipe suppresses", () => {
  const files = marketplaceWith("alpha-pack");
  files["plugins/alpha-pack/.mcp.json"] = JSON.stringify({ mcpServers: { docs: { command: "node" } } });
  const marketplace = gitRepo(files);
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);

  const result = sync(solo(manifest), counting(home()));

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /alpha-pack/);
  assert.match(result.warnings[0] ?? "", /docs/);
  assert.match(result.warnings[0] ?? "", /strict-mcp-config/);
});

test("sync says nothing about MCP for a plugin that ships no servers", () => {
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);

  assert.deepEqual(sync(solo(manifest), counting(home())).warnings, []);
});

test("sync drops a plugin from project scope once the Manifest stops pinning it", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(manifest), counting(env));

  writeFileSync(join(manifest.root, "harvenv.toml"), "");
  sync(solo(loadManifest(join(manifest.root, "harvenv.toml"))), counting(env));

  assert.equal(existsSync(pluginLink(manifest.root)), false);
  assert.deepEqual(readLockfile(manifest.root)?.plugins, []);
});

test("sync rejects a plugin published under a name other than the one it is pinned as", () => {
  const files = marketplaceWith("alpha-pack");
  files["plugins/alpha-pack/.claude-plugin/plugin.json"] = pluginFile("alpha-pack-dev");
  const marketplace = gitRepo(files);
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);

  assert.throws(() => sync(solo(manifest), counting(home())), /alpha-pack-dev/);
});

test("the Store holds one copy when a skill and a plugin resolve to the same bytes", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const first = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(first), counting(env));
  const second = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(second), counting(env));

  const hash = readLockfile(first.root)?.plugins[0]?.hash ?? "";
  assert.equal(readLockfile(second.root)?.plugins[0]?.hash, hash);
  assert.equal(hashTree(storePath(hash, env)), hash, "the Store entry still hashes to its own address");
});

test("skills and plugins are synced from one Manifest without colliding", () => {
  const env = home();
  const skillRepo = gitRepo({ "SKILL.md": skillFile("shared") });
  const marketplace = marketplaceRepo("shared");
  const manifest = project(
    `[skills]\nshared = { git = "${skillRepo.url}" }\n\n` +
      `[plugins]\nshared = { marketplace = "${marketplace.url}" }\n`,
  );

  const result = sync(solo(manifest), counting(env));

  assert.deepEqual(result.materialized.plugins, ["shared"]);
  assert.equal(existsSync(join(skillsDir(manifest.root), "shared", "SKILL.md")), true);
  assert.equal(existsSync(join(pluginLink(manifest.root, "shared"), ".claude-plugin", "plugin.json")), true);
});

// --- plan: what the Launcher resolves without fetching -----------------------

test("plan resolves a locked plugin to its Store entry", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(manifest), counting(env));

  const resolved = plan(solo(manifest), readLocks(manifest.root), env);

  const hash = readLockfile(manifest.root)?.plugins[0]?.hash ?? "";
  assert.deepEqual(resolved.plugins, [{ name: "alpha-pack", path: storePath(hash, env) }]);
});

test("plan tells the user to sync when the Store does not hold a pinned plugin", () => {
  const env = home();
  const marketplace = marketplaceRepo();
  const manifest = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  sync(solo(manifest), counting(env));
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });

  assert.throws(
    () => plan(solo(manifest), readLocks(manifest.root), env),
    (err: Error) => err instanceof SyncError && /alpha-pack/.test(err.message) && /harv sync/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// The Toolchain (ADR 0006)
// ---------------------------------------------------------------------------

/** Any path will do: every engine call is faked, and only the calls are asserted. */
const MISE = "/fake/mise";

/**
 * An engine that installs into the real Store, so the Store's own answers —
 * "do I already hold this version?" — are the ones under test. Only the
 * downloading is faked; where things land, and who asks for them, is not.
 */
function fakeEngine(env: Env, overrides: Partial<ToolchainDeps> = {}): Partial<ToolchainDeps> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findMise: () => ({ bin: MISE }),
    resolveVersion: (_mise, tool, spec) => {
      calls.push(`resolve ${tool}@${spec}`);
      return `${spec}.99`;
    },
    isKnown: () => true,
    install: (_mise, tool, version) => {
      calls.push(`install ${tool}@${version}`);
      mkdirSync(join(toolsRoot(env), "installs", tool, version, "bin"), { recursive: true });
    },
    binPaths: (_mise, tool, version) => [`installs/${tool}/${version}/bin`],
    ...overrides,
  };
}

test("sync installs a Manifest-declared tool and locks the exact version it resolved", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);
  const engine = fakeEngine(env);

  const result = sync(solo(manifest), { env, toolchain: engine });

  assert.deepEqual(result.toolchain.installed, ["node@22.99"]);
  assert.deepEqual(readLockfile(manifest.root)?.tools, [
    { tool: "node", spec: "22", version: "22.99", bins: ["installs/node/22.99/bin"] },
  ]);
});

test("a tool lands in the Store, not in the project", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);
  sync(solo(manifest), { env, toolchain: fakeEngine(env) });

  assert.ok(existsSync(join(toolsRoot(env), "installs", "node", "22.99")));
  assert.ok(!existsSync(join(manifest.root, "node")));
});

test("a skill's own requires declaration reaches the Toolchain", () => {
  const env = home();
  const repo = gitRepo({
    "SKILL.md": `---\nname: example\ndescription: Fixture.\nrequires: node@22\n---\n\nBody.\n`,
  });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  const result = sync(solo(manifest), { ...counting(env), toolchain: fakeEngine(env) });

  assert.deepEqual(result.toolchain.installed, ["node@22.99"]);
});

test("a second project needing the same version installs nothing and runs no engine at all", () => {
  const env = home();
  const first = project(`[tools]\nnode = "22"\n`);
  sync(solo(first), { env, toolchain: fakeEngine(env) });

  const second = project(`[tools]\nnode = "22"\n`);
  writeFileSync(join(second.root, "harvenv.lock"), readFileSync(join(first.root, "harvenv.lock"), "utf8"));
  const engine = fakeEngine(env, {
    findMise: () => {
      throw new Error("the Toolchain reached for an engine it did not need");
    },
  });

  const result = sync(solo(second), { env, toolchain: engine });

  assert.deepEqual(result.toolchain.reused, ["node@22.99"]);
  assert.deepEqual(result.toolchain.installed, []);
  assert.deepEqual(engine.calls, []);
});

test("a second machine converges on the locked version, not on what the spec resolves to today", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);
  // What a teammate cloned: the Manifest's spec, and a Lockfile pinning an
  // exact version that is not the one a fresh resolve would return.
  writeFileSync(
    join(manifest.root, "harvenv.lock"),
    `version = 1\nskills = []\n\n[[tools]]\nname = "node"\nspec = "22"\nversion = "22.18.0"\nbins = ["installs/node/22.18.0/bin"]\n`,
  );

  const engine = fakeEngine(env);
  const result = sync(solo(manifest), { env, toolchain: engine });

  assert.deepEqual(result.toolchain.installed, ["node@22.18.0"]);
  assert.ok(!engine.calls.some((call) => call.startsWith("resolve")), engine.calls.join(", "));
});

test("an unscopeable requirement is recorded in the Lockfile and the Sync still succeeds", () => {
  const env = home();
  const manifest = project(`[tools]\nobscurity = "1"\n`);
  const engine = fakeEngine(env, { resolveVersion: () => null, isKnown: () => false });

  const result = sync(solo(manifest), { env, toolchain: engine });

  assert.deepEqual(result.toolchain.unscopeable, ["obscurity"]);
  assert.deepEqual(readLockfile(manifest.root)?.tools[0]?.version, undefined);
  assert.match(readLockfile(manifest.root)?.tools[0]?.hint ?? "", /obscurity/);
  assert.deepEqual(result.warnings.length, 1);
});

test("sync reports the Toolchain drift it is about to resolve", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);

  const result = sync(solo(manifest), { env, toolchain: fakeEngine(env) });

  assert.deepEqual(result.drift, [{ name: "node", reason: "needed by the Manifest but not locked" }]);
});

test("a tool the Manifest stopped declaring leaves the Lockfile", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);
  sync(solo(manifest), { env, toolchain: fakeEngine(env) });

  const dropped = loadManifest(manifest.path);
  writeFileSync(manifest.path, "");
  sync(solo(loadManifest(dropped.path)), { env, toolchain: fakeEngine(env) });

  assert.deepEqual(readLockfile(manifest.root)?.tools, []);
});

test("toolPaths resolves every locked tool to a bin directory inside the Store", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);
  sync(solo(manifest), { env, toolchain: fakeEngine(env) });

  assert.deepEqual(toolPaths(readLockfile(manifest.root), env), [
    join(toolsRoot(env), "installs", "node", "22.99", "bin"),
  ]);
});

test("toolPaths contributes nothing for an unscopeable tool — the session falls back to the machine", () => {
  const env = home();
  const manifest = project(`[tools]\nobscurity = "1"\n`);
  sync(solo(manifest), { env, toolchain: fakeEngine(env, { resolveVersion: () => null, isKnown: () => false }) });

  assert.deepEqual(toolPaths(readLockfile(manifest.root), env), []);
});

test("toolPaths tells the user to sync when the Store does not hold what the Lockfile pins", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);
  sync(solo(manifest), { env, toolchain: fakeEngine(env) });
  rmSync(join(toolsRoot(env), "installs", "node", "22.99"), { recursive: true });

  assert.throws(
    () => toolPaths(readLockfile(manifest.root), env),
    (err: Error) => err instanceof SyncError && err.message.includes("harv sync"),
  );
});

test("a clone onto a machine with no engine leaves the committed tool pin intact", () => {
  const env = home();
  const manifest = project(`[tools]\nnode = "22"\n`);
  const committed =
    `version = 1\nskills = []\n\n[[tools]]\nname = "node"\nspec = "22"\nversion = "22.18.0"\n` +
    `bins = ["installs/node/22.18.0/bin"]\n`;
  writeFileSync(join(manifest.root, "harvenv.lock"), committed);

  // An empty Store and nothing to install with: the worst case for a pin.
  sync(solo(manifest), { env, toolchain: { findMise: () => ({ unavailable: "no vendored mise" }) } });

  assert.deepEqual(readLockfile(manifest.root)?.tools, [
    { tool: "node", spec: "22", version: "22.18.0", bins: ["installs/node/22.18.0/bin"] },
  ]);
});

test("two skills that contradict each other stop a Sync before it writes into the project", () => {
  const env = home();
  const alpha = gitRepo({ "SKILL.md": `---\nname: alpha\ndescription: F.\nrequires: node@22\n---\n\nB.\n` });
  const beta = gitRepo({ "SKILL.md": `---\nname: beta\ndescription: F.\nrequires: node@24\n---\n\nB.\n` });
  const manifest = project(
    `[skills]\nalpha = { git = "${alpha.url}" }\nbeta = { git = "${beta.url}" }\n`,
  );

  assert.throws(() => sync(solo(manifest), { ...counting(env), toolchain: fakeEngine(env) }), ToolchainError);
  assert.equal(existsSync(skillsDir(manifest.root)), false, "no Component was linked into a Harvenv that cannot sync");
  assert.equal(existsSync(join(manifest.root, "harvenv.lock")), false);
});

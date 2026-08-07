import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fetchSource, resolveCommit } from "../src/git.ts";
import { readLockfile } from "../src/lockfile.ts";
import { loadManifest } from "../src/manifest.ts";
import type { Manifest } from "../src/manifest.ts";
import { hashTree, storePath } from "../src/store.ts";
import type { Env } from "../src/store.ts";
import { plan, sync, SyncError } from "../src/sync.ts";
import type { SyncDeps } from "../src/sync.ts";
import { commitFiles, git, gitRepo, skillFile, tempDir } from "./helpers.ts";

/** A Store of this test's own. Every sync in one test must share it to dedupe. */
const home = (): Env => ({ HARV_HOME: tempDir() });

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
});

const skillsDir = (root: string) => join(root, ".claude", "skills");

test("sync locks a git Source with the commit it resolved and the hash of what it fetched", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  sync(manifest, counting(home()));

  const locked = readLockfile(manifest.root)?.skills[0];
  assert.equal(locked?.name, "example");
  assert.equal(locked?.commit, repo.commit);
  assert.match(locked?.hash ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("sync materializes a git Source out of the Store, not out of the project", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  sync(manifest, counting(env));

  const link = join(skillsDir(manifest.root), "example");
  assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), skillFile("example"));
  const hash = readLockfile(manifest.root)?.skills[0]?.hash ?? "";
  assert.equal(existsSync(join(storePath(hash, env), "SKILL.md")), true, "the bytes live in the Store");
});

test("sync narrows a git Source to its subdirectory and names the skill by its Manifest key", () => {
  const repo = gitRepo({ "README.md": "repo\n", "skills/example/SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}", subdir = "skills/example" }\n`);

  sync(manifest, counting(home()));

  assert.equal(existsSync(join(skillsDir(manifest.root), "example", "SKILL.md")), true);
  assert.equal(existsSync(join(skillsDir(manifest.root), "example", "README.md")), false);
});

test("sync run twice fetches once and leaves the Lockfile byte-identical", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  const deps = counting(env);

  sync(manifest, deps);
  const first = readFileSync(join(manifest.root, "harvenv.lock"), "utf8");
  const second = sync(manifest, deps);

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
  sync(first, counting(env));

  // The same declaration, a different project, and a Sync that cannot fetch.
  const second = project(declaration);
  writeFileSync(join(second.root, "harvenv.lock"), readFileSync(join(first.root, "harvenv.lock"), "utf8"));
  const result = sync(second, offline(env));

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
  sync(manifest, counting(env));
  const locked = readFileSync(join(manifest.root, "harvenv.lock"), "utf8");

  // The world moves: a new commit lands, and this machine loses its Store.
  commitFiles(repo.dir, { "SKILL.md": skillFile("example", "Second.\n") }, "second");
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });
  rmSync(join(manifest.root, ".claude"), { recursive: true, force: true });
  sync(manifest, counting(env));

  assert.match(readFileSync(join(skillsDir(manifest.root), "example", "SKILL.md"), "utf8"), /First\./);
  assert.equal(readFileSync(join(manifest.root, "harvenv.lock"), "utf8"), locked, "the Lockfile did not move");
});

test("sync fails loudly when a fetch does not produce the content the Lockfile pinned", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(manifest, counting(env));

  // A Lockfile that promises content this commit does not produce — what a
  // tampered repository or a corrupted Store entry looks like from here.
  const tampered = readFileSync(join(manifest.root, "harvenv.lock"), "utf8").replace(
    /hash = "sha256:[0-9a-f]{64}"/,
    `hash = "sha256:${"c".repeat(64)}"`,
  );
  writeFileSync(join(manifest.root, "harvenv.lock"), tampered);
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });

  assert.throws(
    () => sync(manifest, counting(env)),
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

  const result = sync(manifest, counting(home()));

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /local-thing/);
  assert.match(result.warnings[0] ?? "", /vendor\/local-thing/);
});

test("sync does not warn about a git Source, which does survive a clone", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  assert.deepEqual(sync(manifest, counting(home())).warnings, []);
});

test("sync locks a path Source without a content hash, because a local directory is live", () => {
  const manifest = project('[skills]\nlocal-thing = { path = "vendor/local-thing" }\n');
  mkdirSync(join(manifest.root, "vendor", "local-thing"), { recursive: true });
  writeFileSync(join(manifest.root, "vendor", "local-thing", "SKILL.md"), skillFile("local-thing"));

  sync(manifest, counting(home()));

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

  const result = sync(manifest, counting(env));

  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0]?.name, "example");
});

test("sync re-resolves a Source whose ref moved in the Manifest", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example", "On main.\n") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(manifest, counting(env));

  git(["checkout", "--quiet", "-b", "next"], repo.dir);
  const onNext = commitFiles(repo.dir, { "SKILL.md": skillFile("example", "On next.\n") }, "on next");
  writeFileSync(join(manifest.root, "harvenv.toml"), `[skills]\nexample = { git = "${repo.url}", ref = "next" }\n`);
  sync(loadManifest(join(manifest.root, "harvenv.toml")), counting(env));

  assert.equal(readLockfile(manifest.root)?.skills[0]?.commit, onNext);
  assert.match(readFileSync(join(skillsDir(manifest.root), "example", "SKILL.md"), "utf8"), /On next\./);
});

test("sync drops a skill from project scope once the Manifest stops declaring it", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(manifest, counting(env));

  writeFileSync(join(manifest.root, "harvenv.toml"), "");
  sync(loadManifest(join(manifest.root, "harvenv.toml")), counting(env));

  assert.equal(existsSync(join(skillsDir(manifest.root), "example")), false);
  assert.deepEqual(readLockfile(manifest.root)?.skills, []);
});

test("sync rejects a fetched Source whose SKILL.md disagrees with its Manifest key", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("published-name") });
  const manifest = project(`[skills]\ndeclared-name = { git = "${repo.url}" }\n`);

  assert.throws(() => sync(manifest, counting(home())), /published-name/);
});

test("the Store holds one copy when two projects declare the same Source", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const declaration = `[skills]\nexample = { git = "${repo.url}" }\n`;

  const first = project(declaration);
  sync(first, counting(env));
  const second = project(declaration);
  sync(second, counting(env));

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
  sync(manifest, counting(env));

  const resolved = plan(manifest, readLockfile(manifest.root), env);

  const hash = readLockfile(manifest.root)?.skills[0]?.hash ?? "";
  assert.deepEqual(resolved.skills, [{ name: "example", path: storePath(hash, env) }]);
});

test("plan tells the user to sync when the Store does not hold what the Lockfile pins", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const manifest = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  sync(manifest, counting(env));
  rmSync(join(env.HARV_HOME as string, "store"), { recursive: true, force: true });

  assert.throws(
    () => plan(manifest, readLockfile(manifest.root), env),
    (err: Error) => err instanceof SyncError && /example/.test(err.message) && /harv sync/.test(err.message),
  );
});

test("plan resolves a locked path Source to the directory itself", () => {
  const env = home();
  const manifest = project('[skills]\nlocal-thing = { path = "vendor/local-thing" }\n');
  mkdirSync(join(manifest.root, "vendor", "local-thing"), { recursive: true });
  writeFileSync(join(manifest.root, "vendor", "local-thing", "SKILL.md"), skillFile("local-thing"));
  sync(manifest, counting(env));

  const resolved = plan(manifest, readLockfile(manifest.root), env);

  assert.deepEqual(resolved.skills, [
    { name: "local-thing", path: join(manifest.root, "vendor", "local-thing") },
  ]);
});

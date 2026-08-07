import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  driftAgainst,
  LOCKFILE_FILENAME,
  LockfileError,
  lockfilePath,
  readLockfile,
  writeLockfile,
} from "../src/lockfile.ts";
import type { LockedPlugin, LockedSkill } from "../src/lockfile.ts";
import { loadManifest } from "../src/manifest.ts";
import { tempDir } from "./helpers.ts";

const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;
const COMMIT = "0".repeat(39) + "1";

const gitLock = (name: string, extra: Partial<LockedSkill> = {}): LockedSkill => ({
  name,
  source: { kind: "git", repo: "https://example.com/s.git" },
  commit: COMMIT,
  hash: HASH,
  ...extra,
});

const pluginLock = (name: string, source: { ref?: string } = {}): LockedPlugin => ({
  name,
  source: { kind: "marketplace", repo: "https://example.com/m.git", ...source },
  commit: COMMIT,
  hash: HASH,
});

/** A project whose Manifest is `body`, ready for a drift comparison. */
function project(body: string): { root: string; manifest: ReturnType<typeof loadManifest> } {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), body);
  return { root, manifest: loadManifest(join(root, "harvenv.toml")) };
}

test("writeLockfile then readLockfile round-trips a git Source with its pins", () => {
  const root = tempDir();
  const skills = [
    gitLock("example", { source: { kind: "git", repo: "https://example.com/s.git", ref: "v1", subdir: "skills/example" } }),
  ];

  writeLockfile(root, skills);

  assert.deepEqual(readLockfile(root)?.skills, skills);
});

test("writeLockfile then readLockfile round-trips a path Source", () => {
  const root = tempDir();

  writeLockfile(root, [{ name: "local", source: { kind: "path", declared: "vendor/local", path: join(root, "vendor", "local") } }]);

  assert.deepEqual(readLockfile(root)?.skills, [
    { name: "local", source: { kind: "path", declared: "vendor/local", path: join(root, "vendor", "local") } },
  ]);
});

test("the Lockfile records the commit SHA and the content hash of every git Source", () => {
  const root = tempDir();

  writeLockfile(root, [gitLock("example")]);
  const text = readFileSync(lockfilePath(root), "utf8");

  assert.match(text, new RegExp(`commit = "${COMMIT}"`));
  assert.match(text, new RegExp(`hash = "${HASH}"`));
});

test("the Lockfile is written to a stable name beside the Manifest", () => {
  const root = tempDir();

  assert.equal(lockfilePath(root), join(root, LOCKFILE_FILENAME));
  assert.equal(LOCKFILE_FILENAME, "harvenv.lock");
});

test("the Lockfile says in its own text that harv wrote it", () => {
  const root = tempDir();

  writeLockfile(root, [gitLock("example")]);

  assert.match(readFileSync(lockfilePath(root), "utf8"), /^#.*harv sync/m);
});

test("the Lockfile orders entries by name, so two Syncs produce the same file", () => {
  const first = tempDir();
  const second = tempDir();

  writeLockfile(first, [gitLock("beta"), gitLock("alpha")]);
  writeLockfile(second, [gitLock("alpha"), gitLock("beta")]);

  assert.equal(readFileSync(lockfilePath(first), "utf8"), readFileSync(lockfilePath(second), "utf8"));
});

test("readLockfile returns null for a project that has never been synced", () => {
  assert.equal(readLockfile(tempDir()), null);
});

test("readLockfile rejects a Lockfile from a future version of harv", () => {
  const root = tempDir();
  writeFileSync(lockfilePath(root), "version = 99\n");

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /99/.test(err.message),
  );
});

test("readLockfile rejects a content hash that is not one", () => {
  const root = tempDir();
  writeFileSync(
    lockfilePath(root),
    `version = 2\n\n[[skills]]\nname = "example"\nsource = "git"\ngit = "https://example.com/s.git"\ncommit = "${COMMIT}"\nhash = "sha256:../../etc"\n`,
  );

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /hash/.test(err.message),
  );
});

test("readLockfile rejects a locked name that would escape the skills directory", () => {
  const root = tempDir();
  writeFileSync(
    lockfilePath(root),
    `version = 2\n\n[[skills]]\nname = "../agents"\nsource = "git"\ngit = "https://example.com/s.git"\ncommit = "${COMMIT}"\nhash = "${HASH}"\n`,
  );

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /name/i.test(err.message),
  );
});

test("readLockfile rejects a git entry with no commit to reproduce", () => {
  const root = tempDir();
  writeFileSync(
    lockfilePath(root),
    `version = 2\n\n[[skills]]\nname = "example"\nsource = "git"\ngit = "https://example.com/s.git"\nhash = "${HASH}"\n`,
  );

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /commit/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Plugin pins
// ---------------------------------------------------------------------------

test("writeLockfile then readLockfile round-trips a plugin pin", () => {
  const root = tempDir();

  writeLockfile(root, [], [pluginLock("superpowers", { ref: "v6.2.0" })]);

  assert.deepEqual(readLockfile(root)?.plugins, [pluginLock("superpowers", { ref: "v6.2.0" })]);
});

test("a plugin is pinned by the marketplace commit and its own content hash", () => {
  const root = tempDir();

  writeLockfile(root, [], [pluginLock("superpowers")]);
  const text = readFileSync(lockfilePath(root), "utf8");

  assert.match(text, /\[\[plugins\]\]/);
  assert.match(text, new RegExp(`marketplace = "https://example.com/m.git"`));
  assert.match(text, new RegExp(`commit = "${COMMIT}"`));
  assert.match(text, new RegExp(`hash = "${HASH}"`));
});

test("the Lockfile keeps skills and plugins apart, so one name can never be both", () => {
  const root = tempDir();

  writeLockfile(root, [gitLock("shared")], [pluginLock("shared")]);

  assert.deepEqual(readLockfile(root)?.skills.map((s) => s.name), ["shared"]);
  assert.deepEqual(readLockfile(root)?.plugins.map((p) => p.name), ["shared"]);
});

test("a Lockfile that pins plugins is not readable by a harv that predates them", () => {
  // The bump is the point: an older harv would read the skills, ignore the
  // plugins and launch a Harvenv missing them, which is the one failure a
  // Lockfile exists to prevent.
  const root = tempDir();
  writeLockfile(root, [], [pluginLock("superpowers")]);

  assert.match(readFileSync(lockfilePath(root), "utf8"), /^version = 2$/m);
});

test("readLockfile still reads a Lockfile written before plugins existed", () => {
  // The refusal is one-directional. A version-1 file pins no plugins, which is
  // a subset of what this harv understands, so upgrading harv costs nothing —
  // the next Sync rewrites it current.
  const root = tempDir();
  writeFileSync(
    lockfilePath(root),
    `version = 1\n\n[[skills]]\nname = "example"\nsource = "git"\ngit = "https://example.com/s.git"\ncommit = "${COMMIT}"\nhash = "${HASH}"\n`,
  );

  const lock = readLockfile(root);

  assert.deepEqual(lock?.skills.map((s) => s.name), ["example"]);
  assert.deepEqual(lock?.plugins, []);
});

test("readLockfile rejects a `version` that is not a version at all", () => {
  const root = tempDir();
  writeFileSync(lockfilePath(root), 'version = "two"\n');

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /version/.test(err.message),
  );
});

test("readLockfile rejects a plugin pinned without a commit", () => {
  const root = tempDir();
  writeFileSync(
    lockfilePath(root),
    `version = 2\n\n[[plugins]]\nname = "superpowers"\nmarketplace = "https://example.com/m.git"\nhash = "${HASH}"\n`,
  );

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /commit/.test(err.message),
  );
});

test("readLockfile rejects a plugin name that would escape the plugins directory", () => {
  const root = tempDir();
  writeFileSync(
    lockfilePath(root),
    `version = 2\n\n[[plugins]]\nname = "../skills"\nmarketplace = "https://example.com/m.git"\ncommit = "${COMMIT}"\nhash = "${HASH}"\n`,
  );

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /plugin name/.test(err.message),
  );
});

test("readLockfile rejects a plugin hash that is not a content hash", () => {
  const root = tempDir();
  writeFileSync(
    lockfilePath(root),
    `version = 2\n\n[[plugins]]\nname = "superpowers"\nmarketplace = "https://example.com/m.git"\ncommit = "${COMMIT}"\nhash = "sha256:../../etc"\n`,
  );

  assert.throws(
    () => readLockfile(root),
    (err: Error) => err instanceof LockfileError && /hash/.test(err.message),
  );
});

test("driftAgainst names a plugin the Manifest declares and the Lockfile does not", () => {
  const { root, manifest } = project('[plugins]\nsuperpowers = { marketplace = "https://example.com/m.git" }\n');
  writeLockfile(root, []);

  assert.deepEqual(driftAgainst(manifest, readLockfile(root)), [
    { name: "superpowers", reason: "declared in the Manifest but not locked" },
  ]);
});

test("driftAgainst names a plugin whose marketplace ref moved, quoting both", () => {
  const { root, manifest } = project(
    '[plugins]\nsuperpowers = { marketplace = "https://example.com/m.git", ref = "v7" }\n',
  );
  writeLockfile(root, [], [pluginLock("superpowers", { ref: "v6" })]);

  const drift = driftAgainst(manifest, readLockfile(root));

  assert.equal(drift.length, 1);
  assert.match(drift[0]?.reason ?? "", /v6/);
  assert.match(drift[0]?.reason ?? "", /v7/);
});

test("driftAgainst names a plugin the Lockfile holds and the Manifest has dropped", () => {
  const { root, manifest } = project("");
  writeLockfile(root, [], [pluginLock("superpowers")]);

  assert.deepEqual(driftAgainst(manifest, readLockfile(root)), [
    { name: "superpowers", reason: "locked but no longer declared in the Manifest" },
  ]);
});

test("driftAgainst reports nothing when a plugin pin and its Lockfile entry agree", () => {
  const { root, manifest } = project(
    '[plugins]\nsuperpowers = { marketplace = "https://example.com/m.git", ref = "v6" }\n',
  );
  writeLockfile(root, [], [pluginLock("superpowers", { ref: "v6" })]);

  assert.deepEqual(driftAgainst(manifest, readLockfile(root)), []);
});

test("a skill and a plugin of the same name drift independently", () => {
  const { root, manifest } = project(
    '[skills]\nshared = { git = "https://example.com/s.git" }\n\n' +
      '[plugins]\nshared = { marketplace = "https://example.com/m.git" }\n',
  );
  writeLockfile(root, [gitLock("shared")]);

  assert.deepEqual(driftAgainst(manifest, readLockfile(root)), [
    { name: "shared", reason: "declared in the Manifest but not locked" },
  ]);
});

test("driftAgainst reports nothing when the Manifest and the Lockfile agree", () => {
  const { root, manifest } = project('[skills]\nexample = { git = "https://example.com/s.git" }\n');
  writeLockfile(root, [gitLock("example")]);

  assert.deepEqual(driftAgainst(manifest, readLockfile(root)), []);
});

test("driftAgainst names a skill the Manifest declares and the Lockfile does not", () => {
  const { root, manifest } = project('[skills]\nexample = { git = "https://example.com/s.git" }\n');
  writeLockfile(root, []);

  const drift = driftAgainst(manifest, readLockfile(root));

  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.name, "example");
  assert.match(drift[0]?.reason ?? "", /not locked/i);
});

test("driftAgainst names a skill the Lockfile holds and the Manifest has dropped", () => {
  const { root, manifest } = project("");
  writeLockfile(root, [gitLock("gone")]);

  const drift = driftAgainst(manifest, readLockfile(root));

  assert.equal(drift[0]?.name, "gone");
  assert.match(drift[0]?.reason ?? "", /no longer declared/i);
});

test("driftAgainst names a skill whose Source coordinate moved, quoting both", () => {
  const { root, manifest } = project('[skills]\nexample = { git = "https://example.com/s.git", ref = "v2" }\n');
  writeLockfile(root, [gitLock("example", { source: { kind: "git", repo: "https://example.com/s.git", ref: "v1" } })]);

  const drift = driftAgainst(manifest, readLockfile(root));

  assert.equal(drift[0]?.name, "example");
  assert.match(drift[0]?.reason ?? "", /v1/);
  assert.match(drift[0]?.reason ?? "", /v2/);
});

test("driftAgainst treats a never-synced project as drift for everything declared", () => {
  const { manifest } = project(
    '[skills]\nalpha = { git = "https://example.com/a.git" }\nbeta = { git = "https://example.com/b.git" }\n',
  );

  assert.deepEqual(
    driftAgainst(manifest, null).map((d) => d.name),
    ["alpha", "beta"],
  );
});

test("driftAgainst reports nothing for a Manifest that declares nothing and was never synced", () => {
  const { manifest } = project('[settings]\nmodel = "opus"\n');

  assert.deepEqual(driftAgainst(manifest, null), []);
});

test("driftAgainst notices a subdirectory change that leaves the repository alone", () => {
  const { root, manifest } = project('[skills]\nexample = { git = "https://example.com/s.git", subdir = "skills/b" }\n');
  writeLockfile(root, [
    gitLock("example", { source: { kind: "git", repo: "https://example.com/s.git", subdir: "skills/a" }, hash: OTHER_HASH }),
  ]);

  assert.equal(driftAgainst(manifest, readLockfile(root)).length, 1);
});

test("driftAgainst notices a Source that changed kind", () => {
  const { root, manifest } = project('[skills]\nexample = { path = "vendor/example" }\n');
  writeLockfile(root, [gitLock("example")]);

  assert.equal(driftAgainst(manifest, readLockfile(root)).length, 1);
});

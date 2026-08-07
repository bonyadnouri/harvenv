import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hashTree, insert, storePath, storeRoot } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

/** A small tree with a nested file, so ordering and paths both matter. */
function tree(dir: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

test("storeRoot honours HARV_HOME so a machine-global Store is still testable", () => {
  const home = tempDir();

  assert.equal(storeRoot({ HARV_HOME: home }), join(home, "store"));
});

test("storeRoot falls back to ~/.harv when HARV_HOME is unset", () => {
  const root = storeRoot({ HOME: "/home/someone" });

  assert.equal(root, join("/home/someone", ".harv", "store"));
});

test("hashTree gives the same hash to two trees with identical content", () => {
  const a = tree(tempDir(), { "SKILL.md": "# skill\n", "refs/notes.md": "notes\n" });
  const b = tree(tempDir(), { "refs/notes.md": "notes\n", "SKILL.md": "# skill\n" });

  assert.equal(hashTree(a), hashTree(b));
});

test("hashTree changes when a file's contents change", () => {
  const before = tree(tempDir(), { "SKILL.md": "# skill\n" });
  const after = tree(tempDir(), { "SKILL.md": "# skill changed\n" });

  assert.notEqual(hashTree(before), hashTree(after));
});

test("hashTree changes when a file moves, even with identical bytes", () => {
  const here = tree(tempDir(), { "SKILL.md": "same\n" });
  const there = tree(tempDir(), { "docs/SKILL.md": "same\n" });

  assert.notEqual(hashTree(here), hashTree(there));
});

test("hashTree covers the executable bit, which a script depends on", () => {
  const plain = tree(tempDir(), { "run.sh": "#!/bin/sh\n" });
  const executable = tree(tempDir(), { "run.sh": "#!/bin/sh\n" });
  chmodSync(join(executable, "run.sh"), 0o755);

  assert.notEqual(hashTree(plain), hashTree(executable));
});

test("hashTree covers a symlink by its target, not by what it points at", () => {
  const linked = tempDir();
  writeFileSync(join(linked, "real.md"), "body\n");
  symlinkSync("real.md", join(linked, "alias.md"));
  const copied = tree(tempDir(), { "real.md": "body\n", "alias.md": "body\n" });

  assert.notEqual(hashTree(linked), hashTree(copied));
});

test("hashTree is prefixed with its algorithm so the format can change later", () => {
  const hash = hashTree(tree(tempDir(), { "SKILL.md": "x\n" }));

  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});

test("hashTree ignores a .git directory, which is transport, not content", () => {
  const withGit = tree(tempDir(), { "SKILL.md": "x\n", ".git/HEAD": "ref: refs/heads/main\n" });
  const without = tree(tempDir(), { "SKILL.md": "x\n" });

  assert.equal(hashTree(withGit), hashTree(without));
});

test("insert moves a staged tree to the Store path its content addresses", () => {
  const home = tempDir();
  const staged = tree(join(tempDir(), "staged"), { "SKILL.md": "# skill\n" });
  const hash = hashTree(staged);

  const path = insert(staged, hash, { HARV_HOME: home });

  assert.equal(path, storePath(hash, { HARV_HOME: home }));
  assert.equal(readFileSync(join(path, "SKILL.md"), "utf8"), "# skill\n");
  assert.equal(existsSync(staged), false, "the staging tree is consumed, not duplicated");
});

test("insert keeps the copy already in the Store when the same content arrives twice", () => {
  const home = tempDir();
  const first = tree(join(tempDir(), "first"), { "SKILL.md": "# skill\n" });
  const hash = hashTree(first);
  const path = insert(first, hash, { HARV_HOME: home });
  writeFileSync(join(path, "marker"), "the original entry\n");

  const second = tree(join(tempDir(), "second"), { "SKILL.md": "# skill\n" });
  insert(second, hash, { HARV_HOME: home });

  assert.equal(readFileSync(join(path, "marker"), "utf8"), "the original entry\n");
});

test("storePath shards on the hash so the Store does not become one flat directory", () => {
  const home = tempDir();
  const hash = hashTree(tree(tempDir(), { "SKILL.md": "x\n" }));
  const digest = hash.slice("sha256:".length);

  assert.equal(storePath(hash, { HARV_HOME: home }), join(home, "store", "sha256", digest.slice(0, 2), digest));
});

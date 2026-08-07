import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fetchSource, GitError, resolveCommit } from "../src/git.ts";
import type { GitSource } from "../src/manifest.ts";
import { commitFiles, git, gitRepo, skillFile, tempDir } from "./helpers.ts";

/** Every fetch stages into a Store home of its own, so tests never share one. */
const home = () => ({ HARV_HOME: tempDir() });

const source = (repo: string, extra: Partial<GitSource> = {}): GitSource => ({
  kind: "git",
  repo,
  ...extra,
});

test("resolveCommit reads the tip of the default branch when no ref is declared", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  assert.equal(resolveCommit(source(repo.url)), repo.commit);
});

test("resolveCommit reads the commit a branch points at", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  git(["checkout", "--quiet", "-b", "next"], repo.dir);
  const onNext = commitFiles(repo.dir, { "SKILL.md": skillFile("example", "Next.\n") }, "on next");

  assert.equal(resolveCommit(source(repo.url, { ref: "next" })), onNext);
  assert.equal(resolveCommit(source(repo.url, { ref: "main" })), repo.commit);
});

test("resolveCommit reads the commit an annotated tag points at, not the tag object", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  git(["tag", "--annotate", "v1.0.0", "--message", "release"], repo.dir);

  assert.equal(resolveCommit(source(repo.url, { ref: "v1.0.0" })), repo.commit);
});

test("resolveCommit passes a full SHA through without asking the remote", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  assert.equal(resolveCommit(source("file:///nonexistent", { ref: repo.commit })), repo.commit);
});

test("resolveCommit fails by name when the ref does not exist", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  assert.throws(
    () => resolveCommit(source(repo.url, { ref: "no-such-ref" })),
    (err: Error) => err instanceof GitError && /no-such-ref/.test(err.message),
  );
});

test("resolveCommit fails by name when the repository cannot be reached", () => {
  assert.throws(
    () => resolveCommit(source("file:///harvenv/definitely/not/a/repo")),
    (err: Error) => err instanceof GitError && /not\/a\/repo/.test(err.message),
  );
});

test("fetchSource stages the repository's content at the requested commit", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  const fetched = fetchSource(source(repo.url), repo.commit, home());

  assert.equal(fetched.commit, repo.commit);
  assert.equal(readFileSync(join(fetched.staged, "SKILL.md"), "utf8"), skillFile("example"));
});

test("fetchSource stages an older commit, not whatever the branch points at now", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example", "First.\n") });
  const first = repo.commit;
  commitFiles(repo.dir, { "SKILL.md": skillFile("example", "Second.\n") }, "second");

  const fetched = fetchSource(source(repo.url), first, home());

  assert.match(readFileSync(join(fetched.staged, "SKILL.md"), "utf8"), /First\./);
});

test("fetchSource narrows the staged tree to the declared subdirectory", () => {
  const repo = gitRepo({
    "README.md": "repo readme\n",
    "skills/example/SKILL.md": skillFile("example"),
  });

  const fetched = fetchSource(source(repo.url, { subdir: "skills/example" }), repo.commit, home());

  assert.equal(existsSync(join(fetched.staged, "SKILL.md")), true);
  assert.equal(existsSync(join(fetched.staged, "README.md")), false, "the rest of the repo stays behind");
});

test("fetchSource leaves no .git behind, so the Store holds content and not a checkout", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  const fetched = fetchSource(source(repo.url), repo.commit, home());

  assert.equal(existsSync(join(fetched.staged, ".git")), false);
});

test("fetchSource fails by name when the declared subdirectory is not in the repository", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  assert.throws(
    () => fetchSource(source(repo.url, { subdir: "skills/missing" }), repo.commit, home()),
    (err: Error) => err instanceof GitError && /skills\/missing/.test(err.message),
  );
});

test("fetchSource fails when the declared subdirectory is a file", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  assert.throws(
    () => fetchSource(source(repo.url, { subdir: "SKILL.md" }), repo.commit, home()),
    (err: Error) => err instanceof GitError && /SKILL\.md/.test(err.message),
  );
});

test("fetchSource fails by name when the commit is not in the repository", () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const absent = "0".repeat(40);

  assert.throws(
    () => fetchSource(source(repo.url), absent, home()),
    (err: Error) => err instanceof GitError && err.message.includes(absent),
  );
});

test("fetchSource stages inside harv's home, so publishing into the Store is a rename", () => {
  const env = home();
  const repo = gitRepo({ "SKILL.md": skillFile("example") });

  const fetched = fetchSource(source(repo.url), repo.commit, env);

  assert.equal(fetched.staged.startsWith(env.HARV_HOME), true, `${fetched.staged} is outside ${env.HARV_HOME}`);
});

test("fetchSource checks out identical bytes regardless of the machine's line-ending config", () => {
  const repo = gitRepo({ "SKILL.md": "line one\nline two\n" });
  const env = home();

  // The setting that would silently rewrite every checked-out file on Windows,
  // and would make one machine's content hash disagree with another's.
  git(["config", "core.autocrlf", "true"], repo.dir);
  const fetched = fetchSource(source(repo.url), repo.commit, env);

  assert.equal(readFileSync(join(fetched.staged, "SKILL.md"), "utf8"), "line one\nline two\n");
});

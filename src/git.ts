/**
 * Fetching a git Source (ADR 0004). No registry stands between a Manifest and
 * a repository, so this is the whole resolution layer: a coordinate goes in, a
 * commit SHA and a staged tree come out.
 *
 * Two properties are load-bearing and neither is free:
 *
 *   - A fetch is *pinned*. Everything after resolution names a commit, never a
 *     ref, so a branch that moves between two teammates' Syncs cannot change
 *     what the second one gets.
 *   - A fetch is *byte-identical*. The config that would rewrite content on the
 *     way out of git — line-ending translation above all — is overridden per
 *     invocation, so the Lockfile's content hash means the same thing on a
 *     machine whose owner set `core.autocrlf` as on one whose owner did not.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { describeSource } from "./manifest.ts";
import type { GitSource } from "./manifest.ts";
import { harvHome } from "./store.ts";
import type { Env } from "./store.ts";

/**
 * Overrides applied to every invocation. `-c` outranks the user's config
 * files, so these hold whatever the machine is set up to do, while the rest of
 * that config — credential helpers, proxies, insteadOf rules — keeps working,
 * which is what lets a private repository be a Source at all.
 */
const DETERMINISTIC = [
  "-c", "core.autocrlf=false",
  "-c", "core.eol=lf",
  "-c", "core.symlinks=true",
  "-c", "core.fileMode=true",
  "-c", "advice.detachedHead=false",
];

const FULL_SHA = /^[0-9a-f]{40}$/;

export class GitError extends Error {
  override name = "GitError";
}

export interface Fetched {
  commit: string;
  /**
   * A directory holding exactly the Source's content — subdirectory applied,
   * `.git` gone — inside harv's home, so the Store publishes it with a rename.
   */
  staged: string;
}

/**
 * The commit a Source's ref names right now. This is the only step that asks
 * the network what "latest" means; every later step is given a SHA.
 */
export function resolveCommit(source: GitSource): string {
  const ref = source.ref;
  // A Manifest may pin a SHA directly, and a SHA has nothing to resolve — so
  // this stays usable against a repository that is momentarily unreachable.
  if (ref !== undefined && FULL_SHA.test(ref)) return ref;

  const query = ref ?? "HEAD";
  // Every form the ref might take is asked for at once, so the answer can be
  // chosen by exact refname rather than by whatever a loose pattern matched
  // first. `refs/tags/<ref>^{}` is the one that matters most: it is the only
  // way a remote reveals the commit *behind* an annotated tag.
  const result = run([
    "ls-remote",
    "--quiet",
    source.repo,
    query,
    `refs/heads/${query}`,
    `refs/tags/${query}`,
    `refs/tags/${query}^{}`,
  ]);
  if (result.status !== 0) {
    throw new GitError(
      `Cannot reach ${source.repo}: ${firstLine(result.stderr) || `git ls-remote exited ${result.status}`}`,
    );
  }

  const commit = pickCommit(result.stdout, query);
  if (commit === undefined) {
    throw new GitError(
      `${source.repo} has no ref \`${query}\`. ` +
        `Check the branch or tag name, or drop \`ref\` to follow the repository's default branch.`,
    );
  }
  return commit;
}

/**
 * Fetch one commit and stage the Source's content from it.
 *
 * The commit is fetched by SHA where the server allows it — one object graph,
 * one level deep — and by falling back to the full history where it does not,
 * which is the default for a plain `git` server and so cannot be treated as an
 * error. Either way the checkout is verified to be the commit that was asked
 * for, because "the fetch succeeded" and "you have the right tree" are not the
 * same claim.
 */
export function fetchSource(source: GitSource, commit: string, env: Env = process.env): Fetched {
  const scratch = join(harvHome(env), "tmp", randomUUID());
  const work = join(scratch, "work");
  mkdirSync(work, { recursive: true });

  try {
    check(run(["init", "--quiet", work]), `initialize a scratch repository in ${work}`);
    check(run(["remote", "add", "origin", source.repo], work), `add ${source.repo} as a remote`);

    if (run(["fetch", "--quiet", "--depth", "1", "origin", commit], work).status !== 0) {
      // Fetching an arbitrary SHA needs `uploadpack.allowAnySHA1InWant`, which
      // hosted forges set and a stock git daemon does not. Ask for everything
      // instead: slower, but the only way that works against both.
      const all = run(["fetch", "--quiet", "--tags", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"], work);
      check(all, `fetch ${source.repo}`);
    }

    const checkout = run(["checkout", "--quiet", "--detach", commit], work);
    if (checkout.status !== 0) {
      throw new GitError(
        `${source.repo} does not contain commit ${commit}: ` +
          `${firstLine(checkout.stderr) || "git checkout failed"}`,
      );
    }
    // The Lockfile promises this SHA. Reading it back costs one process and
    // turns "git reported success" into "the tree on disk is that commit".
    const head = run(["rev-parse", "HEAD"], work);
    check(head, `read back the checked-out commit in ${work}`);
    const actual = head.stdout.trim();
    if (actual !== commit) {
      throw new GitError(`Asked ${source.repo} for commit ${commit} but the checkout is ${actual}.`);
    }

    // The Store holds content, not a working copy: a repository's own history
    // is transport, it dwarfs most skills, and keeping it would let two clones
    // of one commit occupy two addresses.
    rmSync(join(work, ".git"), { recursive: true, force: true });

    return { commit, staged: stage(source, work, scratch, source.subdir ?? "") };
  } catch (err) {
    rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
}

/** Move the selected subdirectory out of the checkout and drop the rest. */
function stage(source: GitSource, work: string, scratch: string, subdir: string): string {
  const staged = join(scratch, "staged");
  const selected = subdir === "" ? work : join(work, ...subdir.split(/[\\/]/));

  if (!isDirectory(selected)) {
    throw new GitError(
      `${describeSource(source)} has no directory \`${subdir}\`. ` +
        `It names a directory inside the repository at that commit.`,
    );
  }

  renameSync(selected, staged);
  rmSync(work, { recursive: true, force: true });
  return staged;
}

/**
 * The commit from `ls-remote` output, chosen by exact refname.
 *
 * An annotated tag advertises both the tag object and, under `^{}`, the commit
 * it points at — and a checkout produces the commit, so the peeled line wins.
 * Below that, a branch outranks a tag of the same name, which is what git
 * itself does; the bare-name fallback catches an already-qualified ref like
 * `refs/pull/7/head`, and `HEAD`.
 */
function pickCommit(stdout: string, ref: string): string | undefined {
  const rows = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cells) => cells.length === 2 && cells[0] !== "");
  const at = (name: string): string | undefined => rows.find((cells) => cells[1] === name)?.[0];

  return at(`refs/tags/${ref}^{}`) ?? at(`refs/heads/${ref}`) ?? at(`refs/tags/${ref}`) ?? at(ref) ?? rows[0]?.[0];
}

function run(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", [...DETERMINISTIC, ...args], {
    cwd,
    encoding: "utf8",
    // A Source that needs a password must fail rather than block a Sync on a
    // prompt nobody is watching — CI above all.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    throw new GitError(
      missing
        ? "git is not on PATH, and harv fetches Sources with it. Install git and re-run."
        : `Cannot run git: ${result.error.message}`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function check(result: { status: number | null; stderr: string }, what: string): void {
  if (result.status !== 0) {
    throw new GitError(`Could not ${what}: ${firstLine(result.stderr) || `git exited ${result.status}`}`);
  }
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

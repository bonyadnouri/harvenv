import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A fresh scratch directory for one test. `realpathSync` matters: on macOS
 * `tmpdir()` is a symlink (`/var` -> `/private/var`), and manifest discovery
 * compares resolved paths.
 */
export function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "harvenv-test-")));
}

/**
 * Identity and signing are forced, so the suite works on a machine with no git
 * identity configured and on one whose global config signs every commit.
 */
const GIT_FIXTURE_CONFIG = [
  "-c", "user.name=harvenv tests",
  "-c", "user.email=tests@harvenv.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

export const git = (args: string[], cwd: string): string =>
  execFileSync("git", [...GIT_FIXTURE_CONFIG, ...args], { cwd, encoding: "utf8" }).trim();

export interface Repo {
  /** The working directory of the repository. */
  dir: string;
  /** What a Manifest would declare — `file://` so git uses the real transport. */
  url: string;
  /** SHA of the most recent commit made through these helpers. */
  commit: string;
}

/** A git repository holding `files`, with one commit. */
export function gitRepo(files: Record<string, string>): Repo {
  const dir = join(tempDir(), "repo");
  mkdirSync(dir, { recursive: true });
  git(["init", "--quiet"], dir);
  const commit = commitFiles(dir, files, "first commit");
  return { dir, url: `file://${dir}`, commit };
}

/** Add another commit to a repository built by `gitRepo`. */
export function commitFiles(dir: string, files: Record<string, string>, message: string): string {
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  git(["add", "--all"], dir);
  git(["commit", "--quiet", "--message", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

/** The text of a SKILL.md whose published name is `name`, as ADR 0008 requires. */
export const skillFile = (name: string, body = "Marker.\n"): string =>
  `---\nname: ${name}\ndescription: Fixture skill for harvenv tests.\n---\n\n${body}`;

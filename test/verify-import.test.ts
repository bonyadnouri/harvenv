import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { earlyExit, runToCompletion } from "../scripts/verify-import.ts";
import { tempDir } from "./helpers.ts";

/**
 * The verifier's own process driver, pinned where it once fell over.
 *
 * `scripts/verify-import.ts` answers the import wizard by writing into the
 * child's stdin. The child decides when it stops reading, and on a loaded CI
 * runner it did so first: the write hit a pipe with no reader, EPIPE arrived
 * as an `error` event on a socket nobody was listening to, and the whole
 * verification died on a line that was only delivering answers (issue #32).
 * Green on rerun of the same commit, which is what makes a written-down
 * reproduction the only way to keep it fixed.
 */

/** One stand-in wizard per test, so they can run in any order. */
function standIn(body: string): string {
  const path = join(tempDir(), "wizard.mjs");
  writeFileSync(path, body);
  return path;
}

/**
 * A wizard that stops reading at once: it closes stdin, says its piece and
 * exits non-zero — the shape of one that died on its first question.
 *
 * `writeSync` rather than `console.log`, because what it printed is what the
 * driver has to report and `process.exit` does not wait for a pipe.
 */
const CLOSES_STDIN_IMMEDIATELY = `import { closeSync, writeSync } from "node:fs";

closeSync(0);
writeSync(1, "wizard: nothing left to ask\\n");
writeSync(2, "wizard: the user scope could not be read\\n");
process.exit(3);
`;

/**
 * More than a pipe holds — 64 KiB on Linux, less on macOS.
 *
 * The real answers are a dozen bytes and reach the buffer before the wizard
 * has finished starting, which is why the crash needed a busy runner to lose
 * the race at all. Filling the buffer makes the same write pend until the
 * wizard closes the other end, so the broken pipe arrives every time.
 */
const MORE_THAN_A_PIPE_HOLDS = "s\n".repeat(600_000);

test("a wizard that closes stdin first does not take the verifier down with it", async () => {
  const run = await runToCompletion(process.execPath, [standIn(CLOSES_STDIN_IMMEDIATELY)], {
    cwd: tempDir(),
    stdin: MORE_THAN_A_PIPE_HOLDS,
  });

  assert.equal(run.stdinClosedEarly, true, "the broken pipe should have been recorded, not raised");
  assert.equal(run.code, 3, "the child's exit code stays the verdict");
  assert.match(run.stdout, /nothing left to ask/, "and what it printed survives to be reported");
  assert.match(run.stderr, /could not be read/);
});

test("a wizard that reads its answers still gets all of them", async () => {
  const echo = standIn(`import { readFileSync, writeSync } from "node:fs";\n\nwriteSync(1, readFileSync(0, "utf8"));\n`);

  const run = await runToCompletion(process.execPath, [echo], { cwd: tempDir(), stdin: "m\no\ns\n" });

  assert.equal(run.code, 0);
  assert.equal(run.stdout, "m\no\ns\n", "every answer arrived, in order");
  assert.equal(run.stdinClosedEarly, false, "nothing was broken on the way");
});

test("a wizard that failed before reading is reported with what it actually printed", () => {
  const message = earlyExit("`harv init --import`", {
    code: 3,
    stdout: "\x1b[2mskills from a git repository (1)\x1b[0m",
    stderr: "harv: the user scope could not be read",
    stdinClosedEarly: true,
  });

  assert.match(message ?? "", /`harv init --import` exited 3 before reading its answers/);
  assert.match(message ?? "", /skills from a git repository/, "the wizard's own output is the diagnostic");
  assert.match(message ?? "", /the user scope could not be read/);
  assert.doesNotMatch(message ?? "", /\x1b/, "and it reads as words, not as terminal noise");
});

test("but a wizard that simply ran out of questions is not reported at all", () => {
  const ranOut = { code: 0, stdout: "Nothing was imported.", stderr: "", stdinClosedEarly: true };

  assert.equal(earlyExit("`harv init --import`", ranOut), null);
});

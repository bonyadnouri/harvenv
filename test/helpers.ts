import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh scratch directory for one test. `realpathSync` matters: on macOS
 * `tmpdir()` is a symlink (`/var` -> `/private/var`), and manifest discovery
 * compares resolved paths.
 */
export function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "harvenv-test-")));
}

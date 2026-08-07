import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { MiseError, resolveMise } from "../src/mise.ts";
import type { MiseSources } from "../src/mise.ts";
import { tempDir } from "./helpers.ts";

/** A stand-in mise: the resolution rules do not care what the bytes are. */
const PAYLOAD = Buffer.from("#!/bin/sh\necho 2026.8.2\n");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

function sources(overrides: Partial<MiseSources> = {}): MiseSources {
  const dir = tempDir();
  return {
    env: {},
    embedded: undefined,
    vendored: join(dir, "vendor", "mise"),
    target: join(dir, "store", "mise", "2026.8.2", "mise"),
    sha256: PAYLOAD_SHA,
    ...overrides,
  };
}

/** An embedded asset as `scripts/build.ts` writes one: gzipped. */
function embedded(bytes = PAYLOAD): string {
  const path = join(tempDir(), "mise.gz");
  writeFileSync(path, gzipSync(bytes));
  return path;
}

test("HARV_MISE_BIN wins, so a test or a debugging session can pick the engine", () => {
  const explicit = join(tempDir(), "my-mise");
  writeFileSync(explicit, PAYLOAD);

  const resolved = resolveMise(sources({ env: { HARV_MISE_BIN: explicit }, embedded: embedded() }));

  assert.equal(resolved, explicit, "the override is not merely consulted, it wins");
});

test("HARV_MISE_BIN pointing nowhere is an error, not a silent fallback", () => {
  const missing = join(tempDir(), "absent");

  assert.throws(() => resolveMise(sources({ env: { HARV_MISE_BIN: missing }, embedded: embedded() })), (err) => {
    assert.ok(err instanceof MiseError);
    assert.match(err.message, /HARV_MISE_BIN/);
    assert.match(err.message, new RegExp(missing.replaceAll(".", "\\.")));
    return true;
  });
});

test("an embedded mise is unpacked, made executable, and reused after that", () => {
  const src = sources({ embedded: embedded() });

  const first = resolveMise(src);

  assert.equal(first, src.target);
  assert.deepEqual(readFileSync(first), PAYLOAD, "unpacking un-gzips");
  assert.equal(statSync(first).mode & 0o111, 0o111, "and leaves something runnable");

  // The second call must not need the embedded copy at all: on a released harv
  // this is every run after the first.
  const second = resolveMise({ ...src, embedded: join(tempDir(), "gone.gz") });
  assert.equal(second, src.target);
});

test("an embedded mise that fails its pinned checksum is refused", () => {
  const tampered = sources({ embedded: embedded(Buffer.from("not mise at all")) });

  assert.throws(() => resolveMise(tampered), (err) => {
    assert.ok(err instanceof MiseError);
    assert.match(err.message, /damaged/);
    assert.match(err.message, new RegExp(PAYLOAD_SHA), "names the checksum it wanted");
    return true;
  });
});

test("a vendored copy is used when running from source, with nothing embedded", () => {
  const src = sources();
  mkdirSync(dirname(src.vendored), { recursive: true });
  writeFileSync(src.vendored, PAYLOAD);
  chmodSync(src.vendored, 0o755);

  assert.equal(resolveMise(src), src.vendored);
});

test("with no mise anywhere, the error says how to get one", () => {
  assert.throws(() => resolveMise(sources()), (err) => {
    assert.ok(err instanceof MiseError);
    assert.match(err.message, /vendor-mise/, "names the script that fixes it");
    assert.match(err.message, /HARV_MISE_BIN/, "and the escape hatch");
    return true;
  });
});

test("mise is never taken from PATH — an unpinned engine is the drift harv exists to stop", () => {
  const onPath = tempDir();
  writeFileSync(join(onPath, "mise"), PAYLOAD);

  assert.throws(() => resolveMise(sources({ env: { PATH: onPath } })), MiseError);
});

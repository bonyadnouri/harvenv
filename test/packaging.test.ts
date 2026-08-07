import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORMS, bunTarget, isPlatform } from "../src/platform.ts";
import { buildLock, parseShasums, readLock } from "../scripts/vendor-mise.ts";
import { checksumsFile, homebrewFormula } from "../scripts/build.ts";
import type { Artifact } from "../scripts/build.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

test("every platform harv ships for has a pinned mise", () => {
  const lock = readLock();

  assert.match(lock.version, /^\d+\.\d+\.\d+$/);
  for (const platform of PLATFORMS) {
    const pin = lock.platforms[platform];
    assert.ok(pin, `no mise pinned for ${platform}`);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${platform} needs a full SHA-256`);
    assert.ok(pin.asset.includes(lock.version), `${platform} asset ${pin.asset} is not from ${lock.version}`);
  }
});

test("the pinned checksums are distinct — one pasted twice would vendor the wrong binary", () => {
  const sums = PLATFORMS.map((p) => readLock().platforms[p]?.sha256);

  assert.equal(new Set(sums).size, PLATFORMS.length);
});

test("parseShasums reads the format mise publishes", () => {
  const sums = parseShasums(
    ["a".repeat(64) + "  ./mise-v1.2.3-macos-arm64", "b".repeat(64) + "  ./mise-v1.2.3-linux-x64", "", "# noise"].join(
      "\n",
    ),
  );

  assert.equal(sums.get("mise-v1.2.3-macos-arm64"), "a".repeat(64));
  assert.equal(sums.get("mise-v1.2.3-linux-x64"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

test("re-pinning maps harv's platform names onto mise's own", () => {
  const sums = new Map(
    ["macos-arm64", "macos-x64", "linux-arm64", "linux-x64"].map((p, i) => [
      `mise-v9.9.9-${p}`,
      String(i).repeat(64),
    ]),
  );

  const lock = buildLock("9.9.9", sums);

  assert.equal(lock.platforms["darwin-arm64"]?.asset, "mise-v9.9.9-macos-arm64");
  assert.equal(lock.platforms["linux-x64"]?.asset, "mise-v9.9.9-linux-x64");
});

test("re-pinning fails loudly when a platform is missing rather than shipping three of four", () => {
  const partial = new Map([["mise-v9.9.9-macos-arm64", "a".repeat(64)]]);

  assert.throws(() => buildLock("9.9.9", partial), /no checksum for mise-v9\.9\.9-macos-x64/);
});

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

test("platform names are what bun --target and the release assets both use", () => {
  assert.equal(bunTarget("darwin-arm64"), "bun-darwin-arm64");
  assert.equal(isPlatform("darwin-arm64"), true);
  assert.equal(isPlatform("windows-x64"), false, "Windows is deferred, not silently accepted");
  assert.equal(isPlatform("../../etc"), false);
});

// ---------------------------------------------------------------------------
// Release outputs
// ---------------------------------------------------------------------------

const artifact = (platform: (typeof PLATFORMS)[number], sha: string): Artifact => ({
  platform,
  tarball: `/tmp/dist/harv-0.1.0-${platform}.tar.gz`,
  sha256: sha,
  binaryBytes: 91_000_000,
  tarballBytes: 52_000_000,
});

const allArtifacts = () => PLATFORMS.map((p, i) => artifact(p, String(i).repeat(64)));

test("checksums.txt is in the format sha256sum -c and install.sh both read", () => {
  const text = checksumsFile(allArtifacts());

  assert.match(text, /^0{64} {2}harv-0\.1\.0-darwin-arm64\.tar\.gz$/m);
  assert.equal(text.split("\n").filter(Boolean).length, PLATFORMS.length);
  assert.ok(text.endsWith("\n"));
  assert.doesNotMatch(text, /\//, "names files, not paths — it sits beside them in the release");
});

test("the Homebrew formula carries a url and checksum for all four platforms", () => {
  const formula = homebrewFormula("0.1.0", allArtifacts());

  for (const platform of PLATFORMS) {
    assert.match(
      formula,
      new RegExp(`releases/download/v0\\.1\\.0/harv-0\\.1\\.0-${platform}\\.tar\\.gz`),
      `${platform} url`,
    );
  }
  assert.equal(formula.match(/sha256 "/g)?.length, PLATFORMS.length);
  assert.match(formula, /version "0\.1\.0"/);
  assert.match(formula, /bin\.install "harv"/);
  assert.match(formula, /assert_match "harv #\{version\}"/, "the formula's own test proves the binary runs");
});

test("a partial build cannot produce a formula that points at a version it did not build", () => {
  assert.throws(() => homebrewFormula("0.1.0", [artifact("darwin-arm64", "a".repeat(64))]), /--all/);
});

// ---------------------------------------------------------------------------
// The installer
// ---------------------------------------------------------------------------

const installer = (): string => readFileSync(join(REPO_ROOT, "install.sh"), "utf8");

/** What the script does, with what it says about itself removed. */
const installerCode = (): string =>
  installer()
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

test("install.sh asks for the assets the build actually produces", () => {
  const text = installer();

  assert.match(text, /harv-\$version-\$platform\.tar\.gz/, "same name scripts/build.ts writes");
  assert.match(text, /checksums\.txt/);
  assert.match(text, /releases\/download\/v\$version/);
});

test("install.sh refuses to install anything it could not verify", () => {
  const text = installer();

  assert.match(text, /checksum mismatch/i);
  assert.match(text, /Refusing to install unverified/, "a machine with no sha256 tool is a failure, not a shortcut");
});

test("install.sh needs no privileges and no runtime", () => {
  const code = installerCode();

  assert.doesNotMatch(code, /\bsudo\b/);
  assert.doesNotMatch(code, /\bnpm\b|\bnode\b|\bbun\b/, "the binary carries its own runtime (ADR 0007)");
  assert.match(code, /HARV_INSTALL_DIR:-\$HOME\/\.local\/bin/, "user-writable by default");
});

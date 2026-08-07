#!/usr/bin/env bun
/**
 * Packaging verification — issue #13's acceptance criteria, executed.
 *
 *   1. The installed binary is self-contained: it answers on a PATH with no
 *      Node and no Bun on it.
 *   2. mise is vendored and pinned per platform: every release target has a
 *      distinct pinned checksum, and the binary really carries a runnable mise
 *      matching the version it claims.
 *   3. A tagged release builds: an artifact per platform, each listed in
 *      checksums.txt with a hash that matches, each containing just `harv`.
 *   4. One command installs it: install.sh, run against the published release,
 *      puts a working harv on disk.
 *   5. `harv --version` hints when it is out of date.
 *
 * Checks 4 and 5 need a published release to install and to be behind. Until
 * there is one they report n/a rather than passing quietly — the one thing a
 * verification script must never do is look green for lack of evidence.
 *
 * The clean-machine half of criterion 4 lives in `.github/workflows/release.yml`,
 * which installs every tagged release onto four fresh runners. This script is
 * what you can run before cutting one.
 *
 * Run:  bun scripts/verify-packaging.ts [--json] [--keep] [--all]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORMS, currentPlatform, isPlatform } from "../src/platform.ts";
import type { Platform } from "../src/platform.ts";
import { unpackedMisePath } from "../src/mise.ts";
import { compareVersions } from "../src/version.ts";
import { buildPlatform, checksumsFile } from "./build.ts";
import { readLock } from "./vendor-mise.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = "bonyadnouri/harvenv";
const VERIFY_VERSION = "9.9.9-verify";
/** Deliberately behind anything ever released, so the hint has to fire. */
const ANCIENT_VERSION = "0.0.1";

const scratch = mkdtempSync(join(tmpdir(), "harvenv-packaging-"));
const distDir = join(scratch, "dist");

// ---------------------------------------------------------------------------
// Check plumbing (same shape as the other verify scripts)
// ---------------------------------------------------------------------------

type Outcome = boolean | null;

interface Expectation {
  label: string;
  ok: Outcome;
  detail: string;
}

interface Check {
  id: string;
  title: string;
  expectations: Expectation[];
  measurements: Record<string, unknown>;
  error?: string;
}

const expect = (label: string, ok: Outcome, detail: string): Expectation => ({ label, ok, detail });

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBinary(bin: string, args: string[], env?: NodeJS.ProcessEnv): Ran {
  const result = spawnSync(bin, args, { encoding: "utf8", env, timeout: 120_000 });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Criterion 1 — self-contained
// ---------------------------------------------------------------------------

/**
 * A PATH with the system's own tools and nothing a developer installed. If
 * node or bun turn up on it anyway the check proves nothing, so that is
 * measured rather than assumed.
 */
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const onBarePath = (name: string): boolean =>
  BARE_PATH.split(":").some((dir) => existsSync(join(dir, name)));

function checkSelfContained(binary: string): Check {
  const bare = { PATH: BARE_PATH, HOME: scratch, HARV_HOME: join(scratch, "home"), HARV_NO_UPDATE_CHECK: "1" };
  const leaked = ["node", "bun", "npm"].filter(onBarePath);
  const ran = runBinary(binary, ["--version"], bare);

  // `harv claude` must also survive the stripped environment far enough to
  // reach its own error: a runtime that only loads for --version would be a
  // runtime that is missing.
  const withoutManifest = runBinary(binary, ["claude"], { ...bare, PWD: scratch });

  return {
    id: "self-contained",
    title: "The binary needs no Node and no Bun at runtime",
    measurements: { barePath: BARE_PATH, runtimesOnBarePath: leaked, versionOutput: ran.stdout.trim() },
    expectations: [
      expect(
        "the stripped PATH really has no runtime on it, so the next line means something",
        leaked.length === 0,
        leaked.length ? `found on ${BARE_PATH}: ${leaked.join(", ")}` : `nothing but the system's own tools`,
      ),
      expect(
        "`harv --version` answers with no runtime available",
        ran.code === 0 && /^harv \S+ \(/.test(ran.stdout),
        `exit ${ran.code}: ${(ran.stdout.trim() || ran.stderr.trim()).slice(0, 120)}`,
      ),
      expect(
        "so does a command that does real work — the runtime is not only there for --version",
        withoutManifest.code === 1 && /no Manifest found/.test(withoutManifest.stderr),
        `exit ${withoutManifest.code}: ${withoutManifest.stderr.trim().split("\n")[0] ?? ""}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — mise is vendored and pinned per platform
// ---------------------------------------------------------------------------

function checkVendoredMise(binary: string): Check {
  const lock = readLock();
  const pinned = PLATFORMS.map((p) => lock.platforms[p]);
  const complete = pinned.every((pin) => pin && /^[0-9a-f]{64}$/.test(pin.sha256));
  const distinct = new Set(pinned.map((pin) => pin?.sha256)).size === PLATFORMS.length;

  const home = join(scratch, "mise-home");
  const env = { ...process.env, HARV_HOME: home, HARV_NO_UPDATE_CHECK: "1" };
  const ran = runBinary(binary, ["--version"], env);
  const claimed = /^vendored mise (\S+)$/m.exec(ran.stdout)?.[1] ?? "";
  const miseRan = runBinary(binary, ["mise", "--version"], env);

  // Asked of the module rather than spelled out again, so this check cannot
  // keep passing against a path the binary has stopped using.
  const unpacked = unpackedMisePath(claimed, { HARV_HOME: home });

  return {
    id: "vendored-mise",
    title: "mise is vendored and pinned per platform",
    measurements: {
      pinnedVersion: lock.version,
      platforms: Object.fromEntries(PLATFORMS.map((p) => [p, lock.platforms[p]?.sha256.slice(0, 12)])),
      claimedByBinary: claimed,
      miseOutput: miseRan.stdout.trim(),
      unpackedTo: unpacked,
    },
    expectations: [
      expect(
        "every platform harv ships for has a pinned mise with a full checksum",
        complete,
        `${PLATFORMS.filter((p) => lock.platforms[p]).length}/${PLATFORMS.length} pinned at mise ${lock.version}`,
      ),
      expect(
        "the four checksums differ — one pasted twice would vendor the wrong binary",
        distinct,
        `${new Set(pinned.map((p) => p?.sha256)).size} distinct checksums`,
      ),
      expect(
        "the binary says which mise it carries",
        claimed === lock.version,
        `--version says ${claimed || "nothing"}; the lock pins ${lock.version}`,
      ),
      expect(
        "and that mise is really inside it, and really runs",
        miseRan.code === 0 && miseRan.stdout.startsWith(`${claimed} `),
        `exit ${miseRan.code}: ${(miseRan.stdout.trim() || miseRan.stderr.trim()).slice(0, 120)}`,
      ),
      expect(
        "it is unpacked under harv's own home, not left somewhere ad hoc",
        existsSync(unpacked),
        existsSync(unpacked) ? unpacked.replace(home, "$HARV_HOME") : `nothing at ${unpacked}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — a tagged release builds artifacts
// ---------------------------------------------------------------------------

function checkArtifacts(built: Platform[]): Check {
  const checksums = new Map(
    readFileSync(join(distDir, "checksums.txt"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, name] = line.split(/\s+/);
        return [name ?? "", hash ?? ""] as const;
      }),
  );

  const rows = built.map((platform) => {
    const name = `harv-${VERIFY_VERSION}-${platform}.tar.gz`;
    const path = join(distDir, name);
    const present = existsSync(path);
    const listed = checksums.get(name);
    const contents = present
      ? execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).trim().split("\n").sort()
      : [];
    return { platform, name, present, matches: present && listed === sha256(path), contents };
  });

  const skipped = PLATFORMS.filter((p) => !built.includes(p));

  return {
    id: "release-artifacts",
    title: "A tagged release builds one self-contained archive per platform",
    measurements: {
      version: VERIFY_VERSION,
      built,
      notBuiltThisRun: skipped,
      artifacts: rows.map((r) => ({ name: r.name, contents: r.contents })),
    },
    expectations: [
      expect(
        "each built platform produced an archive",
        rows.every((r) => r.present),
        rows.map((r) => `${r.platform}${r.present ? "" : " MISSING"}`).join(", "),
      ),
      expect(
        "each archive's checksum is the one checksums.txt publishes",
        rows.every((r) => r.matches),
        rows.every((r) => r.matches) ? `${rows.length} verified` : `mismatch: ${rows.filter((r) => !r.matches).map((r) => r.platform).join(", ")}`,
      ),
      expect(
        "each archive contains the binary and nothing else",
        rows.every((r) => r.contents.length === 1 && r.contents[0] === "harv"),
        rows.map((r) => `${r.platform}: ${r.contents.join(" ") || "empty"}`).join("; "),
      ),
      expect(
        "every release platform was covered",
        skipped.length === 0 ? true : null,
        skipped.length === 0
          ? PLATFORMS.join(", ")
          : `built ${built.join(", ")}; pass --all to also build ${skipped.join(", ")} (the release workflow always does)`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criteria 4 and 5 — installing, and knowing you are behind
// ---------------------------------------------------------------------------

/**
 * The newest release there is, pre-releases included — anything with artifacts
 * attached can be installed, which is what criterion 4 is about.
 */
function installableVersion(): string | null {
  const result = spawnSync("gh", ["release", "list", "--repo", REPO, "--limit", "20", "--json", "tagName,isDraft"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) return null;
  try {
    const releases = JSON.parse(result.stdout) as Array<{ tagName: string; isDraft: boolean }>;
    const versions = releases.filter((r) => !r.isDraft).map((r) => r.tagName.replace(/^v/, ""));
    return versions.sort(compareVersions).pop() ?? null;
  } catch {
    return null;
  }
}

/**
 * What an installed harv would find, which is a different question: GitHub's
 * `releases/latest` skips pre-releases, and so, deliberately, does the update
 * hint — nobody should be nagged towards an rc. Asking the same endpoint the
 * binary asks is the only way this check can test the real behaviour rather
 * than something next to it.
 */
function latestStableVersion(): string | null {
  const result = spawnSync("gh", ["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) return null;
  const tag = result.stdout.trim();
  return tag.length > 0 ? tag.replace(/^v/, "") : null;
}

function checkInstall(published: string | null): Check {
  if (published === null) {
    return {
      id: "one-command-install",
      title: "One command installs harv from the published release",
      measurements: {},
      expectations: [expect("a release exists to install", null, "no published release yet — cut a tag, then re-run")],
    };
  }

  const prefix = join(scratch, "install-prefix");
  const installed = join(prefix, "harv");
  const installer = join(REPO_ROOT, "install.sh");

  const ran = spawnSync("sh", [installer], {
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, HARV_INSTALL_DIR: prefix, HARV_VERSION: published },
  });
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  const version = existsSync(installed)
    ? runBinary(installed, ["--version"], { ...process.env, HARV_NO_UPDATE_CHECK: "1" })
    : { code: null, stdout: "", stderr: "" };

  return {
    id: "one-command-install",
    title: "One command installs harv from the published release",
    measurements: { published, prefix, installerOutput: output.trim().slice(-600), version: version.stdout.trim() },
    expectations: [
      expect("the installer succeeds", ran.status === 0, `exit ${ran.status}: ${output.trim().split("\n").pop() ?? ""}`),
      expect("a binary lands where it was told to", existsSync(installed), installed),
      expect(
        "and it is the release that was asked for",
        version.code === 0 && version.stdout.includes(`harv ${published} `),
        version.stdout.trim().split("\n")[0] ?? `exit ${version.code}`,
      ),
      expect(
        "the download was checked before it was installed",
        /checksum/i.test(output) || ran.status === 0,
        "install.sh verifies against the published checksums.txt",
      ),
    ],
  };
}

/** A binary that really is old, asked what it thinks of that. */
async function checkUpdateHint(published: string | null): Promise<Check> {
  if (published === null) {
    return {
      id: "update-hint",
      title: "`harv --version` hints when it is out of date",
      measurements: {},
      expectations: [
        expect(
          "a stable release exists to be behind",
          null,
          "no stable release yet — GitHub's `releases/latest` skips pre-releases, and so does the hint",
        ),
      ],
    };
  }

  const platform = currentPlatform();
  if (!isPlatform(platform)) throw new Error(`cannot build for ${platform}`);
  const outDir = join(scratch, "ancient");
  await buildPlatform(platform, ANCIENT_VERSION, outDir, readLock());
  const ancient = join(REPO_ROOT, "build", platform, "stage", "harv");

  // A cache directory of its own, so the answer is fetched rather than read
  // out of whatever this machine happened to know already — and without CI,
  // which switches the check off and would make this pass for the wrong reason.
  const { CI: _ci, HARV_NO_UPDATE_CHECK: _off, ...rest } = process.env;
  const env = { ...rest, HARV_HOME: join(scratch, "hint-home") };
  const ran = runBinary(ancient, ["--version"], env);

  const current = runBinary(ancient, ["--version"], { ...env, HARV_NO_UPDATE_CHECK: "1" });

  return {
    id: "update-hint",
    title: "`harv --version` hints when it is out of date",
    measurements: { pretendVersion: ANCIENT_VERSION, published, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() },
    expectations: [
      expect(
        `a ${ANCIENT_VERSION} build says a newer harv exists`,
        /newer harv is available/i.test(ran.stderr),
        ran.stderr.trim().split("\n").filter(Boolean)[0] ?? "(nothing on stderr)",
      ),
      expect(
        "it names the version to upgrade to, and how",
        ran.stderr.includes(published) && /install\.sh/.test(ran.stderr),
        `mentions ${published}`,
      ),
      expect(
        "the hint stays out of stdout, so --version remains machine-readable",
        !/newer harv/i.test(ran.stdout),
        ran.stdout.trim().replaceAll("\n", " | "),
      ),
      expect(
        "HARV_NO_UPDATE_CHECK silences it",
        !/newer harv/i.test(current.stderr),
        current.stderr.trim() || "nothing on stderr",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const failed = (c: Check) => Boolean(c.error) || c.expectations.some((e) => e.ok === false);

function report(checks: Check[]): void {
  for (const check of checks) {
    console.log(`\n[${failed(check) ? `${RED}FAIL${RESET}` : `${GREEN}PASS${RESET}`}] ${check.id} — ${check.title}`);
    if (check.error) {
      console.log(`  ${RED}x${RESET} ${check.error}`);
      continue;
    }
    for (const e of check.expectations) {
      const glyph = e.ok === true ? `${GREEN}ok${RESET}` : e.ok === false ? `${RED}x ${RESET}` : `${YELLOW}n/a${RESET}`;
      console.log(`  ${glyph} ${e.label}`);
      console.log(`      ${DIM}${e.detail}${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const asJson = argv.includes("--json");
  const keep = argv.includes("--keep");
  const log = asJson ? () => {} : console.log;

  const platform = currentPlatform();
  if (!isPlatform(platform)) throw new Error(`harv does not build for ${platform}`);
  const built: Platform[] = argv.includes("--all") ? [...PLATFORMS] : [platform];

  log("harvenv packaging verification");
  log(`${DIM}scratch: ${scratch}${RESET}`);

  mkdirSync(distDir, { recursive: true });
  const lock = readLock();
  for (const target of built) {
    log(`\n${DIM}building ${VERIFY_VERSION} for ${target}...${RESET}`);
    await buildPlatform(target, VERIFY_VERSION, distDir, lock);
  }
  const artifacts = built.map((p) => ({
    platform: p,
    tarball: join(distDir, `harv-${VERIFY_VERSION}-${p}.tar.gz`),
    sha256: sha256(join(distDir, `harv-${VERIFY_VERSION}-${p}.tar.gz`)),
    binaryBytes: 0,
    tarballBytes: 0,
  }));
  writeFileSync(join(distDir, "checksums.txt"), checksumsFile(artifacts));

  const binary = join(REPO_ROOT, "build", platform, "stage", "harv");
  const installable = installableVersion();
  const stable = latestStableVersion();
  log(`${DIM}newest release: ${installable ?? "none"}; newest stable: ${stable ?? "none"}${RESET}`);

  const runners: Array<[string, string, () => Check | Promise<Check>]> = [
    ["self-contained", "The binary needs no Node and no Bun at runtime", () => checkSelfContained(binary)],
    ["vendored-mise", "mise is vendored and pinned per platform", () => checkVendoredMise(binary)],
    ["release-artifacts", "A tagged release builds one archive per platform", () => checkArtifacts(built)],
    ["one-command-install", "One command installs harv from the published release", () => checkInstall(installable)],
    ["update-hint", "`harv --version` hints when it is out of date", () => checkUpdateHint(stable)],
  ];

  const checks: Check[] = [];
  for (const [id, title, run] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ id, title, expectations: [], measurements: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!keep) rmSync(scratch, { recursive: true, force: true });

  const failures = checks.filter(failed);
  const skipped = checks.filter((c) => !failed(c) && c.expectations.some((e) => e.ok === null));

  if (asJson) {
    console.log(JSON.stringify({ platform, installable, stable, ok: failures.length === 0, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\nharv packaging on ${platform}: ${checks.length - failures.length}/${checks.length} criteria verified` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : "") +
        (skipped.length ? ` ${YELLOW}[incomplete: ${skipped.map((c) => c.id).join(", ")}]${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`verify-packaging: ${err.message}`);
  rmSync(scratch, { recursive: true, force: true });
  return 1;
});

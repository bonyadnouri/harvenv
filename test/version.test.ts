import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  compareVersions,
  DEV_VERSION,
  latestVersion,
  parseVersion,
  updateCheckEnabled,
  updateHint,
} from "../src/version.ts";
import type { UpdateCheckDeps } from "../src/version.ts";
import { tempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test("compareVersions orders releases by each part in turn", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.1.2", "0.1.2"), 0);
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1, "parts are numbers, not strings");
});

test("compareVersions ignores a leading v, so a tag compares against a version", () => {
  assert.equal(compareVersions("v0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", "v0.2.0"), -1);
});

test("a release outranks its own pre-releases", () => {
  assert.equal(compareVersions("0.1.0-rc.1", "0.1.0"), -1);
  assert.equal(compareVersions("0.1.0", "0.1.0-rc.1"), 1);
  assert.equal(compareVersions("0.1.0-rc.1", "0.1.0-rc.2"), -1);
  assert.equal(compareVersions("0.1.0-rc.2", "0.1.0-rc.10"), -1, "rc numbers compare numerically");
  assert.equal(compareVersions("0.1.0-alpha", "0.1.0-beta"), -1);
  assert.equal(compareVersions("0.1.0-rc", "0.1.0-rc.1"), -1, "more identifiers wins when the prefix ties");
});

test("an unreadable version compares equal, so nothing is ever claimed about it", () => {
  assert.equal(compareVersions("not-a-version", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", ""), 0);
  assert.equal(parseVersion("0.1"), null);
});

test("the development version parses, so it can be compared rather than special-cased twice", () => {
  assert.notEqual(parseVersion(DEV_VERSION), null);
  assert.equal(compareVersions(DEV_VERSION, "0.0.0"), -1);
});

// ---------------------------------------------------------------------------
// When to ask at all
// ---------------------------------------------------------------------------

test("the update check is off for development builds, in CI, and when told no", () => {
  assert.equal(updateCheckEnabled({}, "0.1.0"), true);
  assert.equal(updateCheckEnabled({}, DEV_VERSION), false, "a dev build has no release to be behind");
  assert.equal(updateCheckEnabled({ CI: "true" }, "0.1.0"), false);
  assert.equal(updateCheckEnabled({ HARV_NO_UPDATE_CHECK: "1" }, "0.1.0"), false);
});

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

function deps(overrides: Partial<UpdateCheckDeps> & { latest?: string; calls?: string[] } = {}): UpdateCheckDeps {
  const calls = overrides.calls ?? [];
  return {
    now: overrides.now ?? (() => 1_000_000),
    cachePath: overrides.cachePath ?? join(tempDir(), "update-check.json"),
    env: overrides.env ?? {},
    fetch:
      overrides.fetch ??
      (async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ tag_name: `v${overrides.latest ?? "0.2.0"}` }), { status: 200 });
      }),
  };
}

test("a newer release produces a hint naming both versions and how to upgrade", async () => {
  const hint = await updateHint(deps({ latest: "0.4.0" }), "0.1.0");

  assert.ok(hint);
  assert.match(hint, /0\.4\.0/);
  assert.match(hint, /0\.1\.0/);
  assert.match(hint, /install\.sh/, "says how to act on it");
});

test("nothing is said when harv is current or ahead", async () => {
  assert.equal(await updateHint(deps({ latest: "0.1.0" }), "0.1.0"), null);
  assert.equal(await updateHint(deps({ latest: "0.1.0" }), "0.2.0"), null);
});

test("being offline is silent, not an error", async () => {
  const offline = deps({
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });

  assert.equal(await updateHint(offline, "0.1.0"), null);
});

test("a rate-limited or unparseable answer is silent too", async () => {
  const limited = deps({ fetch: async () => new Response("rate limited", { status: 403 }) });
  const nonsense = deps({ fetch: async () => new Response("<html>", { status: 200 }) });

  assert.equal(await updateHint(limited, "0.1.0"), null);
  assert.equal(await updateHint(nonsense, "0.1.0"), null);
});

test("the answer is cached, so a day of --version runs costs one request", async () => {
  const calls: string[] = [];
  const cachePath = join(tempDir(), "update-check.json");

  assert.equal(await latestVersion(deps({ calls, cachePath, latest: "0.3.0" })), "0.3.0");
  assert.equal(await latestVersion(deps({ calls, cachePath, latest: "0.3.0" })), "0.3.0");

  assert.equal(calls.length, 1, "the second run reads the cache");
  assert.match(readFileSync(cachePath, "utf8"), /0\.3\.0/);
});

test("the cache expires after a day", async () => {
  const calls: string[] = [];
  const cachePath = join(tempDir(), "update-check.json");
  const day = 24 * 60 * 60 * 1000;

  await latestVersion(deps({ calls, cachePath, now: () => 0, latest: "0.3.0" }));
  await latestVersion(deps({ calls, cachePath, now: () => day + 1, latest: "0.5.0" }));

  assert.deepEqual(calls.length, 2);
  assert.match(readFileSync(cachePath, "utf8"), /0\.5\.0/);
});

test("a stale cache still answers when the network does not", async () => {
  const cachePath = join(tempDir(), "update-check.json");
  writeFileSync(cachePath, JSON.stringify({ checkedAt: 0, latest: "0.3.0" }));

  const latest = await latestVersion(
    deps({
      cachePath,
      now: () => 10 * 24 * 60 * 60 * 1000,
      fetch: async () => {
        throw new Error("offline");
      },
    }),
  );

  assert.equal(latest, "0.3.0", "a day-old answer beats no answer");
});

test("a corrupt cache is ignored rather than fatal", async () => {
  const cachePath = join(tempDir(), "update-check.json");
  writeFileSync(cachePath, "{ not json");

  assert.equal(await latestVersion(deps({ cachePath, latest: "0.2.0" })), "0.2.0");
});

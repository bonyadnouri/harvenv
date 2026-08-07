import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { Manifest } from "../src/manifest.ts";
import { buildLaunchArgs, generateSettings, SettingsError } from "../src/launch.ts";
import { tempDir } from "./helpers.ts";

function manifestWith(settings: Record<string, unknown> = {}): Manifest {
  const root = tempDir();
  return { path: join(root, "harvenv.toml"), root, skills: [], settings };
}

/** The value `--settings` was handed, parsed back. */
function injectedSettings(args: string[]): unknown {
  return JSON.parse(args[args.indexOf("--settings") + 1]!);
}

test("buildLaunchArgs composes the ADR 0003 recipe", () => {
  const args = buildLaunchArgs(manifestWith(), []);

  assert.deepEqual(args, [
    "--setting-sources",
    "project,local",
    "--settings",
    "{}",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ]);
});

test("buildLaunchArgs injects the Manifest's settings so they outrank both settings files", () => {
  const args = buildLaunchArgs(manifestWith({ model: "opus", permissions: { defaultMode: "plan" } }), []);

  assert.deepEqual(injectedSettings(args), { model: "opus", permissions: { defaultMode: "plan" } });
});

test("buildLaunchArgs appends extra arguments after the recipe, unchanged", () => {
  const args = buildLaunchArgs(manifestWith(), ["-p", "hi", "--resume", "--", "--settings", "nope"]);

  assert.deepEqual(args.slice(-6), ["-p", "hi", "--resume", "--", "--settings", "nope"]);
});

test("buildLaunchArgs never serves skills through --plugin-dir", () => {
  const manifest = manifestWith();
  manifest.skills = [{ name: "example-skill", path: "/store/example-skill" }];

  assert.equal(buildLaunchArgs(manifest, []).includes("--plugin-dir"), false);
});

test("generateSettings emits an empty object when the Manifest sets nothing", () => {
  assert.equal(generateSettings({}), "{}");
});

test("generateSettings rejects a permission mode the settings schema silently discards", () => {
  assert.throws(
    () => generateSettings({ permissions: { defaultMode: "manual" } }),
    (err: Error) => err instanceof SettingsError && /manual/.test(err.message),
  );
});

test("generateSettings accepts every permission mode a settings file honours", () => {
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]) {
    assert.equal(
      JSON.parse(generateSettings({ permissions: { defaultMode: mode } })).permissions.defaultMode,
      mode,
    );
  }
});

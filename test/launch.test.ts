import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { Manifest } from "../src/manifest.ts";
import { buildLaunchArgs } from "../src/launch.ts";
import { tempDir } from "./helpers.ts";

function manifestWith(overrides: Partial<Manifest> = {}): Manifest {
  const root = tempDir();
  return {
    path: join(root, "harvenv.toml"),
    root,
    skills: [],
    settings: {},
    mcpServers: [],
    ...overrides,
  };
}

/** The value a flag was handed, parsed back. */
const payload = (args: string[], flag: string): unknown => JSON.parse(args[args.indexOf(flag) + 1]!);

test("buildLaunchArgs composes the ADR 0003 recipe", () => {
  const args = buildLaunchArgs(manifestWith(), [], {});

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
  const settings = { model: "opus", permissions: { defaultMode: "plan" } };

  const args = buildLaunchArgs(manifestWith({ settings }), [], {});

  assert.deepEqual(payload(args, "--settings"), settings);
});

test("buildLaunchArgs injects the Manifest's MCP servers under strict mode", () => {
  const manifest = manifestWith({
    mcpServers: [{ name: "tickets", definition: { command: "npx", args: ["-y", "tickets-mcp"] } }],
  });

  const args = buildLaunchArgs(manifest, [], {});

  assert.equal(args.includes("--strict-mcp-config"), true, "only Manifest servers exist in the session");
  assert.deepEqual(payload(args, "--mcp-config"), {
    mcpServers: { tickets: { command: "npx", args: ["-y", "tickets-mcp"] } },
  });
});

test("buildLaunchArgs resolves ${VAR} from the environment it is handed", () => {
  const manifest = manifestWith({
    mcpServers: [{ name: "tickets", definition: { command: "npx", env: { TOKEN: "${TICKETS_TOKEN}" } } }],
  });

  const args = buildLaunchArgs(manifest, [], { TICKETS_TOKEN: "s3cret" });

  assert.deepEqual(payload(args, "--mcp-config"), {
    mcpServers: { tickets: { command: "npx", env: { TOKEN: "s3cret" } } },
  });
});

test("buildLaunchArgs leaves the Manifest's own definition unresolved, so nothing can persist a secret", () => {
  const definition = { command: "npx", env: { TOKEN: "${TICKETS_TOKEN}" } };
  const manifest = manifestWith({ mcpServers: [{ name: "tickets", definition }] });

  buildLaunchArgs(manifest, [], { TICKETS_TOKEN: "s3cret" });

  assert.deepEqual(definition, { command: "npx", env: { TOKEN: "${TICKETS_TOKEN}" } });
});

test("buildLaunchArgs appends extra arguments after the recipe, unchanged", () => {
  const args = buildLaunchArgs(manifestWith(), ["-p", "hi", "--resume", "--", "--settings", "nope"], {});

  assert.deepEqual(args.slice(-6), ["-p", "hi", "--resume", "--", "--settings", "nope"]);
});

test("buildLaunchArgs never serves skills through --plugin-dir", () => {
  const manifest = manifestWith({
    skills: [{ name: "example-skill", source: { kind: "git", repo: "https://example.com/s.git" } }],
  });

  assert.equal(buildLaunchArgs(manifest, [], {}).includes("--plugin-dir"), false);
});

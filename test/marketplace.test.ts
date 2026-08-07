import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { declaredMcpServers, declaredPluginName, MarketplaceError, resolvePlugin } from "../src/marketplace.ts";
import { marketplaceFile, pluginFile, tempDir } from "./helpers.ts";

/** A checkout on disk: paths relative to a fresh directory. */
function checkout(files: Record<string, string>): string {
  const root = tempDir();
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

test("resolvePlugin finds a plugin at the subdirectory the catalogue names", () => {
  const root = checkout({
    ".claude-plugin/marketplace.json": marketplaceFile("fixtures", { alpha: "./plugins/alpha" }),
  });

  assert.deepEqual(resolvePlugin(root, "alpha"), { subdir: join("plugins", "alpha"), marketplace: "fixtures" });
});

test("resolvePlugin reads `./` as the repository itself being the plugin", () => {
  const root = checkout({ ".claude-plugin/marketplace.json": marketplaceFile("fixtures", { alpha: "./" }) });

  assert.equal(resolvePlugin(root, "alpha").subdir, "");
});

test("resolvePlugin ignores a trailing slash, which marketplaces write both ways", () => {
  const root = checkout({
    ".claude-plugin/marketplace.json": marketplaceFile("fixtures", { alpha: "./providers/claude/plugin/" }),
  });

  assert.equal(resolvePlugin(root, "alpha").subdir, join("providers", "claude", "plugin"));
});

test("resolvePlugin names the plugins on offer when the pinned one is not among them", () => {
  const root = checkout({
    ".claude-plugin/marketplace.json": marketplaceFile("fixtures", { alpha: "./a", beta: "./b" }),
  });

  assert.throws(
    () => resolvePlugin(root, "gamma"),
    (err: Error) => err instanceof MarketplaceError && /gamma/.test(err.message) && /alpha, beta/.test(err.message),
  );
});

test("resolvePlugin refuses a repository that is not a marketplace at all", () => {
  assert.throws(
    () => resolvePlugin(checkout({ "README.md": "just a repo\n" }), "alpha"),
    (err: Error) => err instanceof MarketplaceError && /marketplace\.json/.test(err.message),
  );
});

test("resolvePlugin refuses a plugin published from another repository", () => {
  // Real catalogues carry these: `{ "source": "git-subdir", "url": … }`. They
  // are a second Source with a second pin, so harv says so rather than guessing.
  const root = checkout({
    ".claude-plugin/marketplace.json": marketplaceFile("fixtures", {
      alpha: { source: "git-subdir", url: "https://example.com/elsewhere.git", path: "plugins/alpha" },
    }),
  });

  assert.throws(
    () => resolvePlugin(root, "alpha"),
    (err: Error) => err instanceof MarketplaceError && /alpha/.test(err.message) && /repository/.test(err.message),
  );
});

test("resolvePlugin refuses a catalogue path that escapes the repository", () => {
  const root = checkout({
    ".claude-plugin/marketplace.json": marketplaceFile("fixtures", { alpha: "../../etc" }),
  });

  assert.throws(
    () => resolvePlugin(root, "alpha"),
    (err: Error) => err instanceof MarketplaceError && /outside/.test(err.message),
  );
});

test("resolvePlugin refuses a catalogue that is not valid JSON", () => {
  const root = checkout({ ".claude-plugin/marketplace.json": "{ not json\n" });

  assert.throws(() => resolvePlugin(root, "alpha"), MarketplaceError);
});

// ---------------------------------------------------------------------------
// What a plugin says about itself
// ---------------------------------------------------------------------------

test("declaredPluginName reads the name a plugin publishes itself under", () => {
  const root = checkout({ ".claude-plugin/plugin.json": pluginFile("alpha") });

  assert.equal(declaredPluginName(root), "alpha");
});

test("declaredPluginName is undefined for a plugin that declares nothing", () => {
  // Real marketplaces publish these: the directory name is then the plugin's
  // name, which is why harv serves plugins through a link it named itself.
  assert.equal(declaredPluginName(checkout({ "skills/x/SKILL.md": "---\nname: x\n---\n" })), undefined);
});

test("declaredMcpServers lists servers from a plugin's .mcp.json", () => {
  const root = checkout({
    ".claude-plugin/plugin.json": pluginFile("alpha"),
    ".mcp.json": JSON.stringify({ mcpServers: { docs: { command: "node" }, api: { command: "node" } } }),
  });

  assert.deepEqual(declaredMcpServers(root), ["api", "docs"]);
});

test("declaredMcpServers also lists servers declared inline in plugin.json", () => {
  const root = checkout({
    ".claude-plugin/plugin.json": pluginFile("alpha", { mcpServers: { inline: { command: "node" } } }),
  });

  assert.deepEqual(declaredMcpServers(root), ["inline"]);
});

test("declaredMcpServers is empty for a plugin that ships no servers", () => {
  assert.deepEqual(declaredMcpServers(checkout({ ".claude-plugin/plugin.json": pluginFile("alpha") })), []);
});

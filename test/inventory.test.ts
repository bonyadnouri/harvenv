import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GROUPS, inventory, userScope } from "../src/inventory.ts";
import type { InventoryItem } from "../src/inventory.ts";
import { commitFiles, git, skillFile, tempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// A user scope to scan
// ---------------------------------------------------------------------------

/** Write a file under `home`, creating the directories above it. */
function put(home: string, relative: string, contents: string): void {
  const path = join(home, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

/** A `~/.claude` with one skill directory of its own. */
function scope(name = "house-style"): string {
  const home = tempDir();
  put(home, join(".claude", "skills", name, "SKILL.md"), skillFile(name));
  return home;
}

const named = (items: InventoryItem[], name: string): InventoryItem =>
  items.find((item) => item.name === name) ?? assert.fail(`no item called \`${name}\`: ${items.map((i) => i.name)}`);

const scan = (home: string, root = tempDir()) => inventory(root, { HOME: home, HARV_HOME: join(home, ".harv") });

// ---------------------------------------------------------------------------
// Where the scan looks
// ---------------------------------------------------------------------------

test("the user scope is HOME's .claude directory", () => {
  const home = tempDir();

  const found = userScope({ HOME: home });

  assert.equal(found.dir, join(home, ".claude"));
  assert.equal(found.config, join(home, ".claude.json"));
});

test("CLAUDE_CONFIG_DIR moves the whole scan, as it does for Claude Code itself", () => {
  const home = tempDir();
  const elsewhere = join(home, "somewhere-else");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, ".claude.json"), "{}");

  const found = userScope({ HOME: home, CLAUDE_CONFIG_DIR: elsewhere });

  assert.equal(found.dir, elsewhere);
  assert.equal(found.config, join(elsewhere, ".claude.json"), "the config file follows the directory");
});

test("a machine with no user scope at all inventories nothing rather than failing", () => {
  const { items, scope: found } = scan(tempDir());

  assert.deepEqual(items, []);
  assert.equal(found.exists, false);
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

test("a user-scope skill directory is inventoried", () => {
  const { items } = scan(scope());

  const skill = named(items, "house-style");
  assert.equal(skill.kind, "skill");
});

test("a skill is keyed by the name it publishes, not by its directory", () => {
  const home = tempDir();
  // ADR 0008: the Manifest key, the invocation and the published name are one
  // string, so importing the directory name would declare a name that never
  // answers.
  put(home, join(".claude", "skills", "old-folder", "SKILL.md"), skillFile("grill-me"));

  const { items } = scan(home);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, "grill-me");
});

test("a directory with no SKILL.md is not a skill and is passed over", () => {
  const home = tempDir();
  mkdirSync(join(home, ".claude", "skills", "notes"), { recursive: true });

  assert.deepEqual(scan(home).items, []);
});

test("a skill that exists only on this machine is flagged non-portable", () => {
  const { items } = scan(scope());

  const skill = named(items, "house-style");
  assert.equal(skill.source, null, "there is no coordinate to derive");
  assert.notEqual(skill.local, null);
  assert.match(skill.local ?? "", /git/i, "the flag says what to do about it");
});

test("a skill inside a git checkout derives its repository, ref and subdirectory", () => {
  const home = tempDir();
  const repo = join(tempDir(), "skills-repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "--quiet"], repo);
  const commit = commitFiles(repo, { "packs/house-style/SKILL.md": skillFile("house-style") }, "a skill");
  git(["remote", "add", "origin", "https://github.com/you/skills.git"], repo);
  // The user scope's copy is the usual thing: a link into a checkout.
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(join(repo, "packs", "house-style"), join(home, ".claude", "skills", "house-style"));

  const skill = named(scan(home).items, "house-style");

  assert.equal(skill.local, null, "it is portable — a teammate can fetch it");
  assert.deepEqual(skill.source, {
    kind: "git",
    repo: "https://github.com/you/skills.git",
    ref: commit,
    subdir: "packs/house-style",
  });
});

test("portable skills come before local-only ones, so the easy decisions come first", () => {
  const home = tempDir();
  const repo = join(tempDir(), "skills-repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "--quiet"], repo);
  commitFiles(repo, { "SKILL.md": skillFile("zebra") }, "a skill");
  git(["remote", "add", "origin", "https://github.com/you/skills.git"], repo);
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(repo, join(home, ".claude", "skills", "zebra"));
  put(home, join(".claude", "skills", "aardvark", "SKILL.md"), skillFile("aardvark"));

  const groups = scan(home).items.map((item) => item.group);

  assert.deepEqual(groups, [GROUPS.skillsFromGit, GROUPS.skillsLocal], "not alphabetical across the two");
});

test("a checkout with no remote is local-only however much git it has", () => {
  const home = tempDir();
  const repo = join(tempDir(), "unpushed");
  mkdirSync(repo, { recursive: true });
  git(["init", "--quiet"], repo);
  commitFiles(repo, { "SKILL.md": skillFile("unpushed") }, "never pushed");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(repo, join(home, ".claude", "skills", "unpushed"));

  const skill = named(scan(home).items, "unpushed");

  assert.equal(skill.source, null);
  assert.match(skill.local ?? "", /remote|push/i);
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/** A user scope with one enabled plugin from one github marketplace. */
function withPlugin(home: string, enabled = true, sha = "a".repeat(40)): void {
  put(home, join(".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@official": enabled } }));
  put(
    home,
    join(".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({ official: { source: { source: "github", repo: "anthropics/claude-plugins-official" } } }),
  );
  put(
    home,
    join(".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "superpowers@official": [{ scope: "user", version: "6.2.0", gitCommitSha: sha }] } }),
  );
}

test("an enabled plugin becomes a marketplace coordinate", () => {
  const home = tempDir();
  withPlugin(home);

  const plugin = named(scan(home).items, "superpowers");

  assert.equal(plugin.kind, "plugin");
  assert.deepEqual(plugin.source, {
    kind: "marketplace",
    repo: "https://github.com/anthropics/claude-plugins-official.git",
    ref: "a".repeat(40),
  });
});

test("a plugin switched off in settings is not inventoried", () => {
  const home = tempDir();
  withPlugin(home, false);

  assert.deepEqual(scan(home).items, [], "importing a plugin you turned off would import a decision you reversed");
});

test("plugins are grouped by the marketplace they came from", () => {
  const home = tempDir();
  withPlugin(home);

  const plugin = named(scan(home).items, "superpowers");

  assert.match(plugin.group, /official/);
});

test("a plugin from a marketplace that only exists on this machine is flagged non-portable", () => {
  const home = tempDir();
  put(home, join(".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "mine@local": true } }));
  put(
    home,
    join(".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({ local: { source: { source: "directory", path: "/Users/someone/market" } } }),
  );

  const plugin = named(scan(home).items, "mine");

  assert.equal(plugin.source, null);
  assert.match(plugin.local ?? "", /marketplace/i);
});

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

test("the machine's global MCP servers are inventoried with their definitions", () => {
  const home = tempDir();
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { tickets: { type: "stdio", command: "npx", args: ["-y", "tickets-mcp"] } } }),
  );

  const server = named(scan(home).items, "tickets");

  assert.equal(server.kind, "mcp");
  assert.deepEqual(server.definition, { type: "stdio", command: "npx", args: ["-y", "tickets-mcp"] });
});

test("the servers this project already runs are inventoried and grouped apart from the global ones", () => {
  const home = tempDir();
  const root = tempDir();
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { global: { type: "http", url: "https://example.invalid/mcp" } },
      projects: { [root]: { mcpServers: { here: { command: "./serve" } } } },
    }),
  );

  const { items } = scan(home, root);

  assert.notEqual(named(items, "here").group, named(items, "global").group);
  assert.match(named(items, "here").group, /project/i);
});

test("another project's servers are not this project's to import", () => {
  const home = tempDir();
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ projects: { "/somewhere/else": { mcpServers: { theirs: { command: "./serve" } } } } }),
  );

  assert.deepEqual(scan(home).items, []);
});

// ---------------------------------------------------------------------------
// What is already declared
// ---------------------------------------------------------------------------

test("a Component the Manifest already declares is marked as declared there", () => {
  const home = scope();
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), '[skills]\nhouse-style = { path = "vendor/house-style" }\n');

  assert.equal(named(scan(home, root).items, "house-style").declared, "manifest");
});

test("a Component the global Overlay already declares is marked as declared there", () => {
  const home = scope();
  put(home, join(".harv", "overlay.toml"), '[skills]\nhouse-style = { path = "/somewhere" }\n');

  assert.equal(named(scan(home).items, "house-style").declared, "overlay");
});

test("a Component nothing declares yet is marked as declared nowhere", () => {
  assert.equal(named(scan(scope()).items, "house-style").declared, null);
});

// ---------------------------------------------------------------------------
// Reading what is there
// ---------------------------------------------------------------------------

test("an unreadable user-scope file is reported rather than silently skipped", () => {
  const home = tempDir();
  put(home, join(".claude", "settings.json"), "{ not json");

  const { warnings, items } = scan(home);

  assert.equal(items.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /settings\.json/);
});

test("a read-only user scope scans fine, because the scan only ever reads", () => {
  const home = scope();
  const claude = join(home, ".claude");
  chmodSync(join(claude, "skills", "house-style"), 0o500);
  chmodSync(claude, 0o500);

  try {
    assert.equal(named(scan(home).items, "house-style").kind, "skill");
  } finally {
    chmodSync(claude, 0o700);
    chmodSync(join(claude, "skills", "house-style"), 0o700);
  }
});

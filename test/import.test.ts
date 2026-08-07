import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { runImport } from "../src/import.ts";
import type { ImportResult } from "../src/import.ts";
import { loadManifest, MANIFEST_FILENAME } from "../src/manifest.ts";
import { globalOverlayPath, loadOverlay } from "../src/overlay.ts";
import { commitFiles, git, skillFile, tempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// A machine, a project, and a script of answers
// ---------------------------------------------------------------------------

function put(root: string, relative: string, contents: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

interface Machine {
  /** The fake `$HOME`, holding the user scope this wizard reads. */
  home: string;
  /** The project the wizard runs in. */
  root: string;
  env: { HOME: string; HARV_HOME: string };
}

/** A machine with a user scope, and a project with an empty Manifest. */
function machine(options: { skills?: string[]; manifest?: string } = {}): Machine {
  const home = tempDir();
  const root = tempDir();
  for (const name of options.skills ?? ["house-style"]) {
    put(home, join(".claude", "skills", name, "SKILL.md"), skillFile(name));
  }
  writeFileSync(join(root, MANIFEST_FILENAME), options.manifest ?? "[skills]\n\n[plugins]\n\n[settings]\n");
  return { home, root, env: { HOME: home, HARV_HOME: join(home, ".harv") } };
}

/** One enabled plugin, from a github marketplace, as Claude Code records it. */
function withPlugin(home: string, name = "superpowers"): void {
  put(home, join(".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [`${name}@official`]: true } }));
  put(
    home,
    join(".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({ official: { source: { source: "github", repo: "anthropics/claude-plugins-official" } } }),
  );
  put(
    home,
    join(".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { [`${name}@official`]: [{ scope: "user", gitCommitSha: "b".repeat(40) }] } }),
  );
}

interface Run extends ImportResult {
  /** Every question the wizard asked, in order. */
  asked: string[];
  /** Everything it printed, as one block. */
  said: string;
}

/** Run the wizard against a script of answers, consumed in order. */
async function wizard(m: Machine, answers: string[]): Promise<Run> {
  const asked: string[] = [];
  let said = "";
  const queue = [...answers];

  const result = await runImport({
    root: m.root,
    env: m.env,
    ask: async (question) => {
      asked.push(question);
      const answer = queue.shift();
      if (answer === undefined) assert.fail(`the wizard asked more than the script answers:\n${question}`);
      return answer;
    },
    say: (line) => {
      said += `${line}\n`;
    },
  });
  return { ...result, asked, said };
}

const manifestOf = (m: Machine) => loadManifest(join(m.root, MANIFEST_FILENAME));
const manifestText = (m: Machine) => readFileSync(join(m.root, MANIFEST_FILENAME), "utf8");

/** Every file under a directory with its bytes — for proving nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return files;
}

// ---------------------------------------------------------------------------
// The inventory, presented
// ---------------------------------------------------------------------------

test("the wizard shows what it found, grouped, before asking anything", async () => {
  const m = machine({ skills: ["house-style", "grill-me"] });

  const { said, asked } = await wizard(m, ["s"]);

  assert.match(said, /skills that exist only on this machine/);
  assert.match(said, /house-style/);
  assert.match(said, /grill-me/);
  assert.equal(asked.length, 1, "one group, one question");
});

test("a group's question offers the Manifest, the Overlay, skipping, and choosing", async () => {
  const m = machine();

  const { asked } = await wizard(m, ["s"]);

  assert.match(asked[0] ?? "", /\bm\b.*\bo\b.*\bs\b.*\bc\b/s);
});

test("a machine with nothing to import says so and asks nothing", async () => {
  const m = machine({ skills: [] });

  const { asked, said, written } = await wizard(m, []);

  assert.deepEqual(asked, []);
  assert.deepEqual(written, []);
  assert.match(said, /nothing/i);
});

// ---------------------------------------------------------------------------
// Where the selections land
// ---------------------------------------------------------------------------

test("a group answered `m` declares every one of its items in the Manifest", async () => {
  const m = machine({ skills: ["house-style", "grill-me"] });

  await wizard(m, ["m"]);

  assert.deepEqual(
    manifestOf(m).skills.map((skill) => skill.name).sort(),
    ["grill-me", "house-style"],
  );
});

test("a group answered `o` declares its items in the global Overlay, creating the file", async () => {
  const m = machine();
  assert.equal(existsSync(globalOverlayPath(m.env)), false);

  await wizard(m, ["o"]);

  assert.deepEqual(loadOverlay(m.root, m.env).skills.map((skill) => skill.name), ["house-style"]);
  assert.deepEqual(manifestOf(m).skills, [], "and nothing reaches the committed file");
});

test("a group answered `s` writes nothing at all", async () => {
  const m = machine();

  const { written } = await wizard(m, ["s"]);

  assert.deepEqual(written, []);
  assert.deepEqual(manifestOf(m).skills, []);
  assert.equal(existsSync(globalOverlayPath(m.env)), false);
});

test("an empty answer skips, because a wizard that writes on a stray newline is not one", async () => {
  const m = machine();

  const { written } = await wizard(m, [""]);

  assert.deepEqual(written, []);
});

test("an answer that means nothing is asked again rather than guessed at", async () => {
  const m = machine();

  const { asked, said, written } = await wizard(m, ["yes please", "s"]);

  assert.equal(asked.length, 2);
  assert.equal(asked[1], asked[0], "the same question, put again unchanged");
  assert.match(said, /yes please/, "and it says what it could not read");
  assert.deepEqual(written, []);
});

test("`c` asks about each item in the group separately", async () => {
  const m = machine({ skills: ["house-style", "grill-me"] });

  const { asked } = await wizard(m, ["c", "m", "o"]);

  assert.equal(asked.length, 3);
  assert.deepEqual(manifestOf(m).skills.map((s) => s.name), ["grill-me"]);
  assert.deepEqual(loadOverlay(m.root, m.env).skills.map((s) => s.name), ["house-style"]);
});

// ---------------------------------------------------------------------------
// Sources, where they are derivable
// ---------------------------------------------------------------------------

test("a skill from a git checkout is declared by its coordinate, not by its path", async () => {
  const m = machine({ skills: [] });
  const repo = join(tempDir(), "skills-repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "--quiet"], repo);
  const commit = commitFiles(repo, { "packs/house-style/SKILL.md": skillFile("house-style") }, "a skill");
  git(["remote", "add", "origin", "https://github.com/you/skills.git"], repo);
  mkdirSync(join(m.home, ".claude", "skills"), { recursive: true });
  symlinkSync(join(repo, "packs", "house-style"), join(m.home, ".claude", "skills", "house-style"));

  await wizard(m, ["m"]);

  assert.deepEqual(manifestOf(m).skills[0]?.source, {
    kind: "git",
    repo: "https://github.com/you/skills.git",
    ref: commit,
    subdir: "packs/house-style",
  });
});

test("a skill that exists only here is declared by its absolute path", async () => {
  const m = machine();

  await wizard(m, ["m"]);

  assert.deepEqual(manifestOf(m).skills[0]?.source, {
    kind: "path",
    declared: join(m.home, ".claude", "skills", "house-style"),
    path: join(m.home, ".claude", "skills", "house-style"),
  });
});

test("a plugin is declared in `[plugins]` by its marketplace coordinate", async () => {
  const m = machine({ skills: [] });
  withPlugin(m.home);

  await wizard(m, ["m"]);

  const manifest = manifestOf(m);
  assert.deepEqual(manifest.plugins, [
    {
      name: "superpowers",
      source: {
        kind: "marketplace",
        repo: "https://github.com/anthropics/claude-plugins-official.git",
        ref: "b".repeat(40),
      },
    },
  ]);
  assert.deepEqual(manifest.skills, [], "a plugin is not a skill");
});

test("a plugin is never offered the Overlay, which cannot carry a plugin pin", async () => {
  const m = machine({ skills: [] });
  withPlugin(m.home);

  const { asked, said } = await wizard(m, ["s"]);

  assert.doesNotMatch(asked[0] ?? "", /\[o\]|overlay/i);
  assert.match(said, /overlay/i, "and it says why, rather than leaving the gap unexplained");
});

test("an MCP server routed to the Manifest becomes an [mcp] section harv can read back", async () => {
  const m = machine({ skills: [] });
  writeFileSync(
    join(m.home, ".claude.json"),
    JSON.stringify({ mcpServers: { tickets: { type: "stdio", command: "npx", args: ["-y", "tickets-mcp"] } } }),
  );

  await wizard(m, ["m"]);

  assert.deepEqual(manifestOf(m).mcpServers, [
    { name: "tickets", definition: { type: "stdio", command: "npx", args: ["-y", "tickets-mcp"] } },
  ]);
});

test("an MCP server routed to the Overlay lands in the staples file", async () => {
  const m = machine({ skills: [] });
  writeFileSync(join(m.home, ".claude.json"), JSON.stringify({ mcpServers: { tickets: { command: "./serve" } } }));

  await wizard(m, ["o"]);

  assert.deepEqual(loadOverlay(m.root, m.env).mcpServers.map((s) => s.name), ["tickets"]);
});

test("a credential sitting in a server definition is not copied into the committed Manifest", async () => {
  const m = machine({ skills: [] });
  writeFileSync(
    join(m.home, ".claude.json"),
    JSON.stringify({
      mcpServers: { tickets: { type: "http", url: "https://x.invalid/mcp", headers: { "X-Api-Key": "sk-live-42" } } },
    }),
  );

  const { said } = await wizard(m, ["m"]);

  const text = manifestText(m);
  assert.doesNotMatch(text, /sk-live-42/, "a Manifest is committed; the secret stays where it was");
  assert.match(text, /\$\{[A-Z_]+\}/, "and is replaced by a reference harv resolves at launch");
  assert.match(said, /export/i, "the summary says how to supply it");
});

test("a credential in a definition bound for the Overlay is left alone", async () => {
  const m = machine({ skills: [] });
  writeFileSync(
    join(m.home, ".claude.json"),
    JSON.stringify({ mcpServers: { tickets: { url: "https://x.invalid/mcp", headers: { "X-Api-Key": "sk-live-42" } } } }),
  );

  await wizard(m, ["o"]);

  // The staples file is uncommitted and personal — the same place the value
  // already lives. Rewriting it would break a working server for nothing.
  assert.match(readFileSync(globalOverlayPath(m.env), "utf8"), /sk-live-42/);
});

// ---------------------------------------------------------------------------
// Local-only Components (ADR 0004)
// ---------------------------------------------------------------------------

test("a local-only skill sent to the Manifest is flagged with what to do about it", async () => {
  const m = machine();

  const { said, flagged } = await wizard(m, ["m"]);

  assert.deepEqual(flagged.map((entry) => entry.name), ["house-style"]);
  assert.match(said, /git/i);
  assert.match(said, /push/i);
});

test("a local-only skill sent to the Overlay is not flagged, because nobody clones an Overlay", async () => {
  const m = machine();

  const { flagged } = await wizard(m, ["o"]);

  assert.deepEqual(flagged, []);
});

test("the local-only group says so where the choice is made, not only afterwards", async () => {
  const m = machine();

  const { said } = await wizard(m, ["s"]);

  assert.match(said, /no clone|not handoff|only on this machine/i);
});

// ---------------------------------------------------------------------------
// Re-running
// ---------------------------------------------------------------------------

test("re-running offers nothing it has already declared", async () => {
  const m = machine({ skills: ["house-style", "grill-me"] });
  await wizard(m, ["m"]);

  const { asked, said, alreadyDeclared } = await wizard(m, []);

  assert.deepEqual(asked, []);
  assert.deepEqual(alreadyDeclared.map((item) => item.name).sort(), ["grill-me", "house-style"]);
  assert.match(said, /already declared/i);
});

test("re-running writes no duplicate entry", async () => {
  const m = machine({ skills: ["house-style"] });
  withPlugin(m.home);
  writeFileSync(join(m.home, ".claude.json"), JSON.stringify({ mcpServers: { tickets: { command: "./serve" } } }));

  await wizard(m, ["m", "m", "m"]);
  const first = manifestText(m);
  await wizard(m, []);

  assert.equal(manifestText(m), first, "a second run with nothing left to do changes no byte");
  const manifest = manifestOf(m);
  assert.equal(manifest.skills.length, 1);
  assert.equal(manifest.plugins.length, 1);
  assert.equal(manifest.mcpServers.length, 1);
});

test("an item declared in the Manifest by hand is not offered either", async () => {
  const m = machine({
    manifest: '[skills]\nhouse-style = { git = "https://example.invalid/x.git" }\n',
  });

  const { asked, alreadyDeclared } = await wizard(m, []);

  assert.deepEqual(asked, []);
  assert.deepEqual(alreadyDeclared.map((item) => item.name), ["house-style"]);
});

// ---------------------------------------------------------------------------
// What the wizard must not do
// ---------------------------------------------------------------------------

test("the wizard never writes to the user scope it read", async () => {
  const m = machine({ skills: ["house-style", "grill-me"] });
  writeFileSync(join(m.home, ".claude.json"), JSON.stringify({ mcpServers: { tickets: { command: "./serve" } } }));
  withPlugin(m.home);
  const before = snapshot(join(m.home, ".claude"));
  const config = readFileSync(join(m.home, ".claude.json"), "utf8");

  await wizard(m, ["m", "m", "m", "m"]);

  assert.deepEqual(snapshot(join(m.home, ".claude")), before);
  assert.equal(readFileSync(join(m.home, ".claude.json"), "utf8"), config);
});

test("the Manifest's own comments and ordering survive the wizard's edits", async () => {
  const m = machine({
    manifest: "# my project\n[skills]\n# a note I wrote\n\n[settings]\nmodel = \"opus\"\n",
  });

  await wizard(m, ["m"]);

  const text = manifestText(m);
  assert.match(text, /^# my project$/m);
  assert.match(text, /^# a note I wrote$/m);
  assert.match(text, /^model = "opus"$/m);
});

test("the Manifest the wizard wrote is one harv can load", async () => {
  const m = machine({ skills: ["house-style"] });
  withPlugin(m.home);
  writeFileSync(
    join(m.home, ".claude.json"),
    JSON.stringify({ mcpServers: { tickets: { type: "stdio", command: "npx", args: ["-y", "t"] } } }),
  );

  await wizard(m, ["m", "m", "m"]);

  const manifest = manifestOf(m);
  assert.equal(manifest.skills.length, 1);
  assert.equal(manifest.plugins.length, 1);
  assert.equal(manifest.mcpServers.length, 1);
});

test("a skill whose name also happens to be a settings key is still imported", async () => {
  const m = machine({ skills: ["model"], manifest: '[skills]\n\n[settings]\nmodel = "opus"\n' });

  await wizard(m, ["m"]);

  // The guard against writing a name twice has to look in the table the entry
  // would go in. `model = "opus"` under `[settings]` is not a declared skill.
  assert.deepEqual(manifestOf(m).skills.map((skill) => skill.name), ["model"]);
});

test("a warning about the user scope is printed once, not once per pass", async () => {
  const m = machine();
  put(m.home, join(".claude", "settings.json"), "{ not json");

  // With something actually imported, so the run reaches its closing summary
  // as well as its opening one.
  const { said, warnings } = await wizard(m, ["m"]);

  assert.equal(warnings.length, 1);
  assert.equal(said.split("settings.json").length - 1, 1, `printed more than once:\n${said}`);
});

test("the summary says what to run next", async () => {
  const m = machine();

  const { said } = await wizard(m, ["m"]);

  assert.match(said, /harv sync/);
});

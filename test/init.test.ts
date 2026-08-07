import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GITIGNORE_ENTRIES, init, InitError, PROJECT_SETTINGS_PATH } from "../src/init.ts";
import { loadManifest, MANIFEST_FILENAME } from "../src/manifest.ts";
import { hasTripwire, LAUNCHER_ENV } from "../src/tripwire.ts";
import { tempDir } from "./helpers.ts";

const read = (root: string, ...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

const settingsOf = (root: string): Record<string, unknown> =>
  JSON.parse(read(root, ...PROJECT_SETTINGS_PATH)) as Record<string, unknown>;

/** The lines a `.gitignore` actually ignores, comments and blanks dropped. */
const ignoreLines = (root: string): string[] =>
  read(root, ".gitignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

const actionFor = (root: string, path: string) => init(root).steps.find((step) => step.path === path)?.action;

/** Write a file, creating the directories above it. */
function put(root: string, relative: string, contents: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

// ---------------------------------------------------------------------------
// An empty project
// ---------------------------------------------------------------------------

test("init on an empty project produces a Manifest that harv can load", () => {
  const root = tempDir();

  init(root);

  const manifest = loadManifest(join(root, MANIFEST_FILENAME));
  assert.deepEqual(manifest.skills, []);
  assert.deepEqual(manifest.settings, {});
  assert.equal(manifest.root, root);
});

test("the scaffolded Manifest documents itself with commented examples", () => {
  const root = tempDir();

  init(root);

  const text = read(root, MANIFEST_FILENAME);
  assert.match(text, /^\[skills]$/m);
  assert.match(text, /^\[plugins]$/m);
  assert.match(text, /^\[settings]$/m);
  // A git coordinate, not a local path: a `path` Source is the one thing a
  // clone cannot reproduce, so it has no business being the worked example.
  assert.match(text, /# \S+ = \{ git = /, "shows how to declare a skill");
  assert.match(text, /# \S+ = \{ marketplace = /, "shows how to pin a plugin");
  // The caveat belongs where a first-time author meets the table, not only in
  // the README: pinning a plugin runs its hooks.
  assert.match(text, /whole/i, "warns that a plugin cannot be taken in part");
  assert.doesNotMatch(text, /path = /);
});

test("init on an empty project writes the gitignore entries", () => {
  const root = tempDir();

  init(root);

  for (const entry of GITIGNORE_ENTRIES) assert.ok(ignoreLines(root).includes(entry), `missing ${entry}`);
});

test("the gitignore entries cover what Sync generates and what stays personal", () => {
  assert.ok(GITIGNORE_ENTRIES.includes(".claude/skills/"), "materialized Components");
  assert.ok(GITIGNORE_ENTRIES.includes(".claude/harv-plugins/"), "the links pinned plugins are served from");
  assert.ok(GITIGNORE_ENTRIES.includes(".claude/.harv-materialized.json"), "harv's ownership record");
  assert.ok(GITIGNORE_ENTRIES.includes("harvenv.local.toml"), "the per-project Overlay");
});

test("init on an empty project plants the Tripwire in committed project settings", () => {
  const root = tempDir();

  init(root);

  const settings = settingsOf(root);
  assert.equal(hasTripwire(settings), true);
  const [entry] = (settings.hooks as { SessionStart: Array<{ hooks: Array<{ command: string }> }> }).SessionStart;
  assert.match(entry!.hooks[0]!.command, new RegExp(`\\$${LAUNCHER_ENV}`));
});

test("the Tripwire lands in the committed settings file, not the personal one", () => {
  const root = tempDir();

  init(root);

  assert.deepEqual(PROJECT_SETTINGS_PATH, [".claude", "settings.json"]);
  assert.throws(() => read(root, ".claude", "settings.local.json"));
});

test("init reports what it did to each of the three artifacts", () => {
  const result = init(tempDir());

  assert.deepEqual(
    result.steps.map((step) => [step.path, step.action]),
    [
      [MANIFEST_FILENAME, "created"],
      [".gitignore", "created"],
      [PROJECT_SETTINGS_PATH.join("/"), "created"],
    ],
  );
});

// ---------------------------------------------------------------------------
// Re-running
// ---------------------------------------------------------------------------

test("re-running init changes nothing on disk", () => {
  const root = tempDir();
  init(root);
  const before = [MANIFEST_FILENAME, ".gitignore", PROJECT_SETTINGS_PATH.join("/")].map((p) =>
    read(root, ...p.split("/")),
  );

  const second = init(root);

  assert.deepEqual(
    [MANIFEST_FILENAME, ".gitignore", PROJECT_SETTINGS_PATH.join("/")].map((p) => read(root, ...p.split("/"))),
    before,
  );
  assert.deepEqual(
    second.steps.map((step) => step.action),
    ["unchanged", "unchanged", "unchanged"],
  );
});

test("re-running init restores an entry that was deleted from .gitignore", () => {
  const root = tempDir();
  init(root);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");

  init(root);

  for (const entry of GITIGNORE_ENTRIES) assert.ok(ignoreLines(root).includes(entry), `missing ${entry}`);
  assert.ok(ignoreLines(root).includes("node_modules/"), "and keeps what was there");
});

test("init leaves an existing Manifest alone", () => {
  const root = tempDir();
  const authored = '[skills]\nexample-skill = { path = "vendor/example-skill" }\n';
  put(root, MANIFEST_FILENAME, authored);

  const action = actionFor(root, MANIFEST_FILENAME);

  assert.equal(action, "unchanged");
  assert.equal(read(root, MANIFEST_FILENAME), authored);
});

// ---------------------------------------------------------------------------
// Merging into a project that already has its own configuration
// ---------------------------------------------------------------------------

test("init merges the Tripwire into existing committed settings without clobbering them", () => {
  const root = tempDir();
  put(
    root,
    ".claude/settings.json",
    JSON.stringify(
      {
        model: "opus",
        permissions: { allow: ["Bash(npm test:*)"], defaultMode: "acceptEdits" },
        hooks: {
          PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "echo project context" }] }],
        },
      },
      null,
      2,
    ) + "\n",
  );

  const action = actionFor(root, PROJECT_SETTINGS_PATH.join("/"));

  const settings = settingsOf(root);
  assert.equal(action, "updated");
  assert.equal(hasTripwire(settings), true);
  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test:*)"], defaultMode: "acceptEdits" });
  const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  assert.deepEqual(hooks.PostToolUse, [
    { matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] },
  ]);
  assert.equal(hooks.SessionStart!.length, 2);
  assert.equal(hooks.SessionStart![0]!.hooks[0]!.command, "echo project context");
});

test("init on a project with existing settings is idempotent too", () => {
  const root = tempDir();
  put(root, ".claude/settings.json", '{\n  "model": "opus"\n}\n');
  init(root);
  const after = read(root, ...PROJECT_SETTINGS_PATH);

  const action = actionFor(root, PROJECT_SETTINGS_PATH.join("/"));

  assert.equal(action, "unchanged");
  assert.equal(read(root, ...PROJECT_SETTINGS_PATH), after);
});

test("init keeps the settings file's own indentation", () => {
  const root = tempDir();
  put(root, ".claude/settings.json", '{\n    "model": "opus"\n}\n');

  init(root);

  assert.match(read(root, ...PROJECT_SETTINGS_PATH), /\n {4}"model": "opus"/);
});

test("init appends to an existing .gitignore without disturbing it", () => {
  const root = tempDir();
  put(root, ".gitignore", "node_modules/\ndist/\n");

  const action = actionFor(root, ".gitignore");

  assert.equal(action, "updated");
  assert.equal(ignoreLines(root).slice(0, 2).join("\n"), "node_modules/\ndist/");
  for (const entry of GITIGNORE_ENTRIES) assert.ok(ignoreLines(root).includes(entry), `missing ${entry}`);
});

test("init adds a trailing newline to a .gitignore that lacked one", () => {
  const root = tempDir();
  put(root, ".gitignore", "node_modules/");

  init(root);

  assert.equal(ignoreLines(root)[0], "node_modules/");
  assert.equal(ignoreLines(root).includes("node_modules/.claude/skills/"), false, "no line got glued together");
});

test("init does not duplicate an entry a project already ignores under a different slash", () => {
  const root = tempDir();
  put(root, ".gitignore", ".claude/skills\nharvenv.local.toml\n");

  init(root);

  const lines = ignoreLines(root);
  assert.equal(lines.filter((line) => line.startsWith(".claude/skills")).length, 1);
  assert.equal(lines.filter((line) => line === "harvenv.local.toml").length, 1);
});

test("init does not treat a commented-out entry as already ignored", () => {
  const root = tempDir();
  put(root, ".gitignore", "# .claude/skills/\n");

  init(root);

  assert.ok(ignoreLines(root).includes(".claude/skills/"));
});

// ---------------------------------------------------------------------------
// Refusing rather than guessing
// ---------------------------------------------------------------------------

test("init refuses to rewrite committed settings that are not valid JSON", () => {
  const root = tempDir();
  put(root, ".claude/settings.json", '{ "model": "opus",, }');

  assert.throws(
    () => init(root),
    (err: Error) => err instanceof InitError && /not valid JSON/.test(err.message),
  );
});

test("a project init refuses to touch is left exactly as it was", () => {
  const root = tempDir();
  put(root, ".claude/settings.json", "not json at all");

  assert.throws(() => init(root));

  assert.equal(read(root, ".claude", "settings.json"), "not json at all");
  assert.throws(() => read(root, MANIFEST_FILENAME), "no Manifest was scaffolded");
  assert.throws(() => read(root, ".gitignore"), "no gitignore entries were added");
});

test("init refuses a file it cannot read rather than replacing it", () => {
  // Absent and unreadable are not the same thing: init plans a *create* for
  // anything missing, so a file it failed to read must never look missing.
  for (const relative of [".gitignore", ".claude/settings.json"]) {
    const root = tempDir();
    mkdirSync(join(root, relative), { recursive: true });

    assert.throws(
      () => init(root),
      (err: Error) => err instanceof InitError && /Cannot read/.test(err.message),
      `${relative} was treated as absent`,
    );
    assert.throws(() => read(root, MANIFEST_FILENAME), "and nothing was scaffolded around it");
  }
});

test("init surfaces a broken existing Manifest instead of scaffolding around it", () => {
  const root = tempDir();
  put(root, MANIFEST_FILENAME, "[skills\nbroken");

  assert.throws(
    () => init(root),
    (err: Error) => /not valid TOML/.test(err.message),
  );
  assert.throws(() => read(root, ".gitignore"), "nothing was written");
});

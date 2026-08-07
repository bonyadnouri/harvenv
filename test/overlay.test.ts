import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest } from "../src/manifest.ts";
import type { Manifest } from "../src/manifest.ts";
import { composeSession, loadOverlay, OverlayError, sessionSkills } from "../src/overlay.ts";
import type { Overlay } from "../src/overlay.ts";
import type { Env } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

/**
 * One machine, one project. The Store pointer doubles as the home the global
 * staples file lives in, which is what lets a test have an Overlay of its own.
 */
interface Fixture {
  root: string;
  env: Env;
  /** Writes `~/.harv/overlay.toml` — the staples, shared by every project. */
  staples: (body: string) => void;
  /** Writes `<root>/harvenv.local.toml` — this project's extras. */
  extras: (body: string) => void;
  manifest: (body: string) => Manifest;
  overlay: () => Overlay;
}

function fixture(): Fixture {
  const root = tempDir();
  const home = tempDir();
  const env: Env = { HARV_HOME: home };

  return {
    root,
    env,
    staples: (body) => writeFileSync(join(home, "overlay.toml"), body),
    extras: (body) => writeFileSync(join(root, "harvenv.local.toml"), body),
    manifest: (body) => {
      writeFileSync(join(root, "harvenv.toml"), body);
      return loadManifest(join(root, "harvenv.toml"));
    },
    overlay: () => loadOverlay(root, env),
  };
}

/** A local skill a Source can point at, so path Sources resolve for real. */
function skillDir(root: string, name: string): string {
  const dir = join(root, "vendor", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return dir;
}

const names = (entries: Array<{ name: string }>): string[] => entries.map((entry) => entry.name);

function rejects(load: () => unknown, ...mustMention: RegExp[]): void {
  assert.throws(load, (err: Error) => {
    assert.ok(err instanceof OverlayError, `expected an OverlayError, got ${err.name}: ${err.message}`);
    for (const pattern of mustMention) assert.match(err.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Loading the two files
// ---------------------------------------------------------------------------

test("an Overlay with neither file declares nothing", () => {
  const fx = fixture();

  const overlay = fx.overlay();

  assert.deepEqual(overlay.skills, []);
  assert.deepEqual(overlay.settings, {});
  assert.deepEqual(overlay.mcpServers, []);
  assert.deepEqual(overlay.layers, []);
});

test("the global staples file contributes skills, settings and MCP servers", () => {
  const fx = fixture();
  skillDir(fx.root, "staple");
  fx.staples(
    `[skills]\nstaple = { path = "${join(fx.root, "vendor", "staple")}" }\n` +
      `[settings]\ntheme = "dark"\n` +
      `[mcp.notes]\ncommand = "notes-mcp"\n`,
  );

  const overlay = fx.overlay();

  assert.deepEqual(names(overlay.skills), ["staple"]);
  assert.deepEqual(overlay.settings, { theme: "dark" });
  assert.deepEqual(names(overlay.mcpServers), ["notes"]);
});

test("the per-project extras file adds Components on top of the staples", () => {
  const fx = fixture();
  skillDir(fx.root, "staple");
  skillDir(fx.root, "extra");
  fx.staples(`[skills]\nstaple = { path = "${join(fx.root, "vendor", "staple")}" }\n`);
  fx.extras(`[skills]\nextra = { path = "vendor/extra" }\n`);

  const overlay = fx.overlay();

  assert.deepEqual(names(overlay.skills).sort(), ["extra", "staple"]);
});

test("a relative path in the extras file resolves against the project, not the Store", () => {
  const fx = fixture();
  const dir = skillDir(fx.root, "extra");
  fx.extras(`[skills]\nextra = { path = "vendor/extra" }\n`);

  const source = fx.overlay().skills[0]?.source;
  assert.equal(source?.kind, "path");
  assert.equal(source?.kind === "path" ? source.path : undefined, dir);
});

test("the extras file wins over the staples on the same skill name", () => {
  const fx = fixture();
  skillDir(fx.root, "shared");
  fx.staples(`[skills]\nshared = { git = "https://example.com/staple.git" }\n`);
  fx.extras(`[skills]\nshared = { path = "vendor/shared" }\n`);

  const overlay = fx.overlay();

  assert.equal(overlay.skills.length, 1);
  assert.equal(overlay.skills[0]?.source.kind, "path");
});

test("the extras file wins over the staples on the same settings key", () => {
  const fx = fixture();
  fx.staples(`[settings]\ntheme = "dark"\nenv = { EDITOR = "vi" }\n`);
  fx.extras(`[settings]\ntheme = "light"\n`);

  assert.deepEqual(fx.overlay().settings, { theme: "light", env: { EDITOR: "vi" } });
});

// ---------------------------------------------------------------------------
// Disabling a staple, in one project only
// ---------------------------------------------------------------------------

test("a disable entry in the extras file removes a staple", () => {
  const fx = fixture();
  fx.staples(`[skills]\nstaple = { git = "https://example.com/staple.git" }\n`);
  fx.extras(`[skills]\nstaple = { disable = true }\n`);

  assert.deepEqual(fx.overlay().skills, []);
});

test("a disable entry removes a staple MCP server too", () => {
  const fx = fixture();
  fx.staples(`[mcp.notes]\ncommand = "notes-mcp"\n`);
  fx.extras(`[mcp.notes]\ndisable = true\n`);

  assert.deepEqual(fx.overlay().mcpServers, []);
});

test("a disable entry that matches no staple is reported rather than ignored", () => {
  const fx = fixture();
  fx.extras(`[skills]\nnever-declared = { disable = true }\n`);

  const overlay = fx.overlay();

  assert.deepEqual(overlay.skills, []);
  assert.equal(overlay.warnings.length, 1);
  assert.match(overlay.warnings[0] ?? "", /never-declared/);
});

test("disable is refused in the global staples file, where it could only mean deleting the entry", () => {
  const fx = fixture();
  fx.staples(`[skills]\nstaple = { disable = true }\n`);

  rejects(fx.overlay, /staple/, /harvenv\.local\.toml/);
});

test("disable alongside a Source is refused rather than silently picking one", () => {
  const fx = fixture();
  fx.extras(`[skills]\nstaple = { disable = true, git = "https://example.com/x.git" }\n`);

  rejects(fx.overlay, /staple/, /disable/);
});

test("disable = false is refused, so a staple is never disabled by a typo's opposite", () => {
  const fx = fixture();
  fx.extras(`[skills]\nstaple = { disable = false }\n`);

  rejects(fx.overlay, /disable/);
});

// ---------------------------------------------------------------------------
// What an Overlay may say that a Manifest may not, and what it still may not
// ---------------------------------------------------------------------------

test("an Overlay may set the personal-ergonomics keys a Manifest is refused", () => {
  const fx = fixture();
  fx.staples(`[settings]\nstatusLine = { type = "command", command = "date" }\ntheme = "dark"\n`);

  assert.deepEqual(fx.overlay().settings, {
    statusLine: { type: "command", command: "date" },
    theme: "dark",
  });
});

test("an Overlay setting Claude Code would discard is still refused, naming the file", () => {
  const fx = fixture();
  fx.staples(`[settings]\neffortLevel = "max"\n`);

  rejects(fx.overlay, /effortLevel/, /overlay\.toml/);
});

test("an Overlay MCP server Claude Code would drop is refused", () => {
  const fx = fixture();
  fx.extras(`[mcp.notes]\ntype = "bogus"\ncommand = "notes-mcp"\n`);

  rejects(fx.overlay, /notes/, /bogus/);
});

test("an Overlay file that is not valid TOML names itself", () => {
  const fx = fixture();
  fx.extras("[skills\n");

  rejects(fx.overlay, /harvenv\.local\.toml/);
});

// ---------------------------------------------------------------------------
// Manifest union Overlay — the Manifest wins, and says so
// ---------------------------------------------------------------------------

test("Overlay skills join the Manifest's rather than replacing them", () => {
  const fx = fixture();
  skillDir(fx.root, "project-skill");
  skillDir(fx.root, "staple");
  const manifest = fx.manifest(`[skills]\nproject-skill = { path = "vendor/project-skill" }\n`);
  fx.staples(`[skills]\nstaple = { path = "${join(fx.root, "vendor", "staple")}" }\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(names(sessionSkills(session)), ["project-skill", "staple"]);
  assert.deepEqual(session.warnings, []);
});

test("Overlay settings fill in keys the Manifest left unset", () => {
  const fx = fixture();
  const manifest = fx.manifest(`[settings]\nmodel = "opus"\n`);
  fx.staples(`[settings]\ntheme = "dark"\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(session.settings, { model: "opus", theme: "dark" });
});

test("the merge is per key, so an Overlay may add a sibling of a bound key", () => {
  const fx = fixture();
  const manifest = fx.manifest(`[settings.permissions]\ndeny = ["Bash(git push:*)"]\n`);
  fx.staples(`[settings.permissions]\nallow = ["Bash(ls:*)"]\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(session.settings, {
    permissions: { deny: ["Bash(git push:*)"], allow: ["Bash(ls:*)"] },
  });
  assert.deepEqual(session.warnings, []);
});

test("an Overlay value for a Manifest-set key is rejected, and the warning names the key", () => {
  const fx = fixture();
  const manifest = fx.manifest(`[settings]\nmodel = "opus"\n`);
  fx.staples(`[settings]\nmodel = "haiku"\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(session.settings, { model: "opus" }, "the Manifest's value is what the session gets");
  assert.equal(session.warnings.length, 1);
  assert.match(session.warnings[0] ?? "", /\bmodel\b/);
  assert.match(session.warnings[0] ?? "", /overlay\.toml/, "names the file to edit");
});

test("a nested conflict is named by its full path, not by its top-level table", () => {
  const fx = fixture();
  const manifest = fx.manifest(`[settings.permissions]\ndefaultMode = "plan"\n`);
  fx.extras(`[settings.permissions]\ndefaultMode = "bypassPermissions"\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(session.settings, { permissions: { defaultMode: "plan" } });
  assert.match(session.warnings[0] ?? "", /permissions\.defaultMode/);
});

test("an Overlay skill the Manifest already declares is rejected, and the warning names it", () => {
  const fx = fixture();
  skillDir(fx.root, "shared");
  const manifest = fx.manifest(`[skills]\nshared = { path = "vendor/shared" }\n`);
  fx.staples(`[skills]\nshared = { git = "https://example.com/other.git" }\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(session.overlaySkills, [], "the Manifest's Source is the one that stands");
  assert.deepEqual(names(sessionSkills(session)), ["shared"]);
  assert.match(session.warnings[0] ?? "", /shared/);
});

test("an Overlay MCP server the Manifest already declares is rejected by the same rule", () => {
  const fx = fixture();
  const manifest = fx.manifest(`[mcp.tickets]\ncommand = "project-tickets"\n`);
  fx.staples(`[mcp.tickets]\ncommand = "my-tickets"\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(names(session.mcpServers), ["tickets"]);
  assert.equal(session.mcpServers[0]?.definition.command, "project-tickets");
  assert.match(session.warnings[0] ?? "", /tickets/);
});

test("an Overlay MCP server the Manifest leaves alone joins the session", () => {
  const fx = fixture();
  const manifest = fx.manifest(`[mcp.tickets]\ncommand = "project-tickets"\n`);
  fx.staples(`[mcp.notes]\ncommand = "notes-mcp"\n`);

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(names(session.mcpServers).sort(), ["notes", "tickets"]);
});

test("composing with no Overlay leaves the Manifest exactly as it was", () => {
  const fx = fixture();
  skillDir(fx.root, "project-skill");
  const manifest = fx.manifest(
    `[skills]\nproject-skill = { path = "vendor/project-skill" }\n[settings]\nmodel = "opus"\n`,
  );

  const session = composeSession(manifest, fx.overlay());

  assert.deepEqual(session.settings, { model: "opus" });
  assert.deepEqual(session.overlaySkills, []);
  assert.deepEqual(names(sessionSkills(session)), ["project-skill"]);
});

test("a plugin pin in an Overlay is refused by name rather than parsed and then not loaded", () => {
  const fx = fixture();
  fx.staples('[plugins]\ngsap-skills = { marketplace = "https://example.com/m.git" }\n');

  rejects(fx.overlay, /plugins/, /Manifest/);
});

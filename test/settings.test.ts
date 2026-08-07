import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateSettings,
  SETTINGS_EFFORT_LEVELS,
  SETTINGS_PERMISSION_MODES,
  SettingsError,
} from "../src/settings.ts";

/** Asserts a rejection, and that its message says enough to act on. */
function rejects(settings: Record<string, unknown>, ...mustMention: RegExp[]): void {
  assert.throws(
    () => generateSettings(settings),
    (err: Error) => {
      assert.ok(err instanceof SettingsError, `expected a SettingsError, got ${err.name}`);
      for (const pattern of mustMention) assert.match(err.message, pattern);
      return true;
    },
  );
}

test("generateSettings emits an empty object when the Manifest sets nothing", () => {
  assert.equal(generateSettings({}), "{}");
});

test("generateSettings passes the behavior-shaping keys through as Claude Code's own schema", () => {
  const settings = {
    model: "opus",
    effortLevel: "high",
    env: { HARVENV: "1" },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
    permissions: { defaultMode: "plan", deny: ["Bash", "WebSearch"] },
  };

  assert.deepEqual(JSON.parse(generateSettings(settings)), settings);
});

// ---------------------------------------------------------------------------
// ADR 0005's split: personal-ergonomics keys are never the Manifest's business
// ---------------------------------------------------------------------------

test("generateSettings rejects each of ADR 0005's personal-ergonomics keys by name", () => {
  for (const key of ["statusLine", "tui", "theme", "keybindings"]) {
    rejects({ [key]: "anything" }, new RegExp(key), /ADR 0005/, /Overlay/);
  }
});

test("generateSettings rejects the schema's own personal keys, naming the ADR category they belong to", () => {
  rejects({ editorMode: "vim" }, /editorMode/, /keybindings/);
  rejects({ subagentStatusLine: {} }, /subagentStatusLine/, /statusLine/);
  rejects({ prefersReducedMotion: true }, /prefersReducedMotion/, /tui/);
});

test("generateSettings leaves a key it cannot classify binding, as ADR 0005 prefers", () => {
  // Loosening later is harmless; tightening later breaks people. `language`
  // shapes what the session produces, so it is not obviously personal.
  assert.deepEqual(JSON.parse(generateSettings({ language: "japanese" })), { language: "japanese" });
});

// ---------------------------------------------------------------------------
// Binding means binding: nothing may be silently discarded
// ---------------------------------------------------------------------------

test("generateSettings rejects a permission mode the settings schema silently discards", () => {
  rejects({ permissions: { defaultMode: "manual" } }, /manual/, /discard/);
});

test("generateSettings accepts every permission mode a settings file honours", () => {
  for (const mode of SETTINGS_PERMISSION_MODES) {
    const settings = JSON.parse(generateSettings({ permissions: { defaultMode: mode } }));
    assert.equal(settings.permissions.defaultMode, mode);
  }
});

test("generateSettings rejects an effort level that exists only as a session command", () => {
  for (const level of ["max", "ultracode", "auto"]) {
    rejects({ effortLevel: level }, new RegExp(level), /discard/);
  }
});

test("generateSettings accepts every effort level a settings file honours", () => {
  for (const level of SETTINGS_EFFORT_LEVELS) {
    assert.equal(JSON.parse(generateSettings({ effortLevel: level })).effortLevel, level);
  }
});

test("generateSettings names the right key when the Manifest says `effort`", () => {
  rejects({ effort: "high" }, /effort/, /effortLevel/);
});

test("generateSettings rejects a permission rule list that is not a list of rules", () => {
  rejects({ permissions: { deny: "Bash" } }, /deny/, /array/);
  rejects({ permissions: { allow: ["Bash", 7] } }, /allow/, /array/);
  rejects({ permissions: "none" }, /permissions/, /table/);
});

test("generateSettings rejects an env value that is not a string", () => {
  rejects({ env: { PORT: 8080 } }, /PORT/, /string/);
  rejects({ env: "PORT=8080" }, /env/, /table/);
});

test("generateSettings rejects a model that could never resolve", () => {
  rejects({ model: "" }, /model/, /non-empty/);
  rejects({ model: 5 }, /model/, /non-empty/);
});

test("generateSettings rejects a hooks value that is not a table of events", () => {
  rejects({ hooks: ["echo hi"] }, /hooks/, /table/);
});

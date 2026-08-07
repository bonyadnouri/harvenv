import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  hasTripwire,
  LAUNCHER_ENV,
  plantTripwire,
  tripwireCommand,
  tripwireHook,
  TripwireError,
  TRIPWIRE_WARNING,
} from "../src/tripwire.ts";

/** Run the hook command the way Claude Code does, and read back its stdout. */
function fire(env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("sh", ["-c", tripwireCommand()], { env, encoding: "utf8" });
}

const commandsIn = (settings: Record<string, unknown>): string[] =>
  ((settings.hooks as { SessionStart: Array<{ hooks: Array<{ command: string }> }> }).SessionStart ?? []).flatMap(
    (entry) => entry.hooks.map((hook) => hook.command),
  );

test("the Tripwire warns when nothing marks the session as launcher-started", () => {
  const output = fire();

  assert.deepEqual(JSON.parse(output), { systemMessage: TRIPWIRE_WARNING });
});

test("the warning reaches the user, not the model — it travels as systemMessage", () => {
  // A hook's bare stdout is injected into the model's context; `systemMessage`
  // is the field Claude Code displays to the person (ADR 0012).
  assert.equal(typeof JSON.parse(fire()).systemMessage, "string");
});

test("the warning names the un-isolation, the Launcher, and the Shim", () => {
  assert.match(TRIPWIRE_WARNING, /NOT isolated/);
  assert.match(TRIPWIRE_WARNING, /harv claude/);
  assert.match(TRIPWIRE_WARNING, /shim/i);
});

test("the Tripwire stays silent in a Launcher-started session", () => {
  assert.equal(fire({ [LAUNCHER_ENV]: "1" }), "");
});

test("the Tripwire succeeds either way, so it never reads as a broken hook", () => {
  for (const env of [{}, { [LAUNCHER_ENV]: "1" }]) {
    assert.doesNotThrow(() => fire(env));
  }
});

test("the hook command survives a warning containing a shell quote", () => {
  const warning = "harvenv: don't trust this session's isolation";

  const output = execFileSync("sh", ["-c", tripwireCommand(warning)], { env: {}, encoding: "utf8" });

  assert.deepEqual(JSON.parse(output), { systemMessage: warning });
});

test("the hook has no matcher, so resumed and cleared sessions are warned too", () => {
  assert.equal("matcher" in tripwireHook(), false);
});

test("plantTripwire creates the hooks tree in settings that have none", () => {
  const settings: Record<string, unknown> = {};

  assert.equal(plantTripwire(settings), true);
  assert.deepEqual(settings, { hooks: { SessionStart: [tripwireHook()] } });
});

test("plantTripwire leaves every other setting untouched", () => {
  const settings: Record<string, unknown> = {
    model: "opus",
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }] },
  };

  plantTripwire(settings);

  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.deepEqual((settings.hooks as Record<string, unknown>).PostToolUse, [
    { matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] },
  ]);
});

test("plantTripwire appends to existing SessionStart hooks rather than replacing them", () => {
  const theirs = { hooks: [{ type: "command", command: "echo context" }] };
  const settings: Record<string, unknown> = { hooks: { SessionStart: [theirs] } };

  plantTripwire(settings);

  const sessionStart = (settings.hooks as { SessionStart: unknown[] }).SessionStart;
  assert.equal(sessionStart.length, 2);
  assert.equal(sessionStart[0], theirs, "the project's own hook keeps its identity and its place");
});

test("plantTripwire is idempotent", () => {
  const settings: Record<string, unknown> = {};
  plantTripwire(settings);
  const after = JSON.stringify(settings);

  assert.equal(plantTripwire(settings), false);
  assert.equal(JSON.stringify(settings), after);
});

test("a reworded Tripwire still counts as planted", () => {
  const settings: Record<string, unknown> = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `[ -n "$${LAUNCHER_ENV}" ] || echo 'our own wording'` }] },
      ],
    },
  };

  assert.equal(hasTripwire(settings), true);
  assert.equal(plantTripwire(settings), false);
  assert.deepEqual(commandsIn(settings), [`[ -n "$${LAUNCHER_ENV}" ] || echo 'our own wording'`]);
});

test("an unrelated SessionStart hook does not count as a Tripwire", () => {
  const settings: Record<string, unknown> = {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }] },
  };

  assert.equal(hasTripwire(settings), false);
});

test("hasTripwire tolerates settings shaped nothing like hooks", () => {
  for (const settings of [{}, { hooks: 3 }, { hooks: { SessionStart: "nope" } }, { hooks: { SessionStart: [null] } }]) {
    assert.equal(hasTripwire(settings as Record<string, unknown>), false);
  }
});

test("plantTripwire refuses to rewrite a hooks key it cannot read", () => {
  assert.throws(
    () => plantTripwire({ hooks: "surprise" }),
    (err: Error) => err instanceof TripwireError && /hooks is a string/.test(err.message),
  );
});

test("plantTripwire refuses to rewrite a SessionStart key it cannot read", () => {
  assert.throws(
    () => plantTripwire({ hooks: { SessionStart: { hooks: [] } } }),
    (err: Error) => err instanceof TripwireError && /SessionStart is an? object/.test(err.message),
  );
});

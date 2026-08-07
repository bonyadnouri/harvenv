import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "../src/manifest.ts";
import { run } from "../src/cli.ts";
import { tempDir } from "./helpers.ts";

interface Recorded {
  exit: number;
  out: string;
  err: string;
  launched: Array<{ manifest: Manifest; passthrough: string[] }>;
}

/** Run the CLI against a scratch project, capturing everything it emits. */
async function cli(argv: string[], cwd: string, exitCode = 0): Promise<Recorded> {
  const launched: Recorded["launched"] = [];
  let out = "";
  let err = "";

  const exit = await run(argv, {
    cwd,
    stdout: (line) => {
      out += `${line}\n`;
    },
    stderr: (line) => {
      err += `${line}\n`;
    },
    launch: async (manifest, passthrough) => {
      launched.push({ manifest, passthrough });
      return exitCode;
    },
  });

  return { exit, out, err, launched };
}

/** A project with a Manifest declaring one local skill that really exists. */
function project(manifestBody?: string): string {
  const root = tempDir();
  const skill = join(root, "vendor", "example-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: example-skill\ndescription: Fixture skill for harvenv tests.\n---\n\nMarker.\n",
  );
  writeFileSync(
    join(root, "harvenv.toml"),
    manifestBody ?? '[skills]\nexample-skill = { path = "vendor/example-skill" }\n',
  );
  return root;
}

test("harv claude outside a harvenv project fails with a clear no-Manifest error", async () => {
  const empty = tempDir();

  const { exit, err, launched } = await cli(["claude"], empty);

  assert.notEqual(exit, 0);
  assert.match(err, /no Manifest found/i);
  assert.match(err, /harvenv\.toml/);
  assert.match(err, new RegExp(empty.replaceAll(".", "\\.")), "names where it searched from");
  assert.deepEqual(launched, [], "nothing is launched without a Manifest");
});

test("harv claude launches from a Manifest-bearing project", async () => {
  const root = project();

  const { exit, launched } = await cli(["claude"], root);

  assert.equal(exit, 0);
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.manifest.root, root);
  assert.deepEqual(launched[0]?.passthrough, []);
});

test("harv claude materializes declared skills before launching", async () => {
  const root = project();

  await cli(["claude"], root);

  assert.equal(existsSync(join(root, ".claude", "skills", "example-skill", "SKILL.md")), true);
});

test("harv claude works from a subdirectory of the project", async () => {
  const root = project();
  const nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });

  const { launched } = await cli(["claude"], nested);

  assert.equal(launched[0]?.manifest.root, root);
});

test("harv claude passes extra arguments through to claude", async () => {
  const root = project();

  const { launched } = await cli(["claude", "-p", "hi", "--resume"], root);

  assert.deepEqual(launched[0]?.passthrough, ["-p", "hi", "--resume"]);
});

test("harv claude adopts claude's exit code", async () => {
  const { exit } = await cli(["claude"], project(), 42);

  assert.equal(exit, 42);
});

test("harv reports a broken Manifest without a stack trace", async () => {
  const root = project('[skills]\nexample-skill = { git = "https://example.com/s.git" }\n');

  const { exit, err } = await cli(["claude"], root);

  assert.notEqual(exit, 0);
  assert.match(err, /cannot fetch yet/);
  assert.doesNotMatch(err, /at .*\.ts:\d+/, "no stack trace leaks to the user");
});

test("harv with no subcommand prints usage and fails", async () => {
  const { exit, err } = await cli([], tempDir());

  assert.notEqual(exit, 0);
  assert.match(err, /usage/i);
});

test("harv rejects an unknown subcommand by name", async () => {
  const { exit, err } = await cli(["sync"], tempDir());

  assert.notEqual(exit, 0);
  assert.match(err, /sync/);
});

test("harv --help prints usage and succeeds", async () => {
  const { exit, out } = await cli(["--help"], tempDir());

  assert.equal(exit, 0);
  assert.match(out, /usage/i);
});

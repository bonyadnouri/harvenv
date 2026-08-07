import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "../src/manifest.ts";
import { run } from "../src/cli.ts";
import { MISE_VERSION, MiseError } from "../src/mise.ts";
import { currentPlatform } from "../src/platform.ts";
import { VERSION } from "../src/version.ts";
import { tempDir } from "./helpers.ts";

interface Recorded {
  exit: number;
  out: string;
  err: string;
  launched: Array<{ manifest: Manifest; passthrough: string[] }>;
  mised: string[][];
}

interface Options {
  /** What the injected launch/mise call returns. */
  exitCode?: number;
  /** What the update check has to say, if anything. */
  hint?: string | null;
}

/** Run the CLI against a scratch project, capturing everything it emits. */
async function cli(argv: string[], cwd: string, options: Options | number = {}): Promise<Recorded> {
  const { exitCode = 0, hint = null } = typeof options === "number" ? { exitCode: options } : options;
  const launched: Recorded["launched"] = [];
  const mised: string[][] = [];
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
    runMise: async (args) => {
      mised.push(args);
      return exitCode;
    },
    updateHint: async () => hint,
  });

  return { exit, out, err, launched, mised };
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

test("harv --version reports harv and the mise it carries", async () => {
  const { exit, out } = await cli(["--version"], tempDir());

  assert.equal(exit, 0);
  assert.match(out, new RegExp(`harv ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(out, new RegExp(currentPlatform()), "which build you have, not just which version");
  assert.match(out, new RegExp(`vendored mise ${MISE_VERSION.replaceAll(".", "\\.")}`));
});

test("harv -v and harv version say the same thing, from anywhere", async () => {
  for (const argv of [["--version"], ["-v"], ["version"]]) {
    const { exit, out } = await cli(argv, tempDir());
    assert.equal(exit, 0, argv.join(" "));
    assert.match(out, /^harv /, argv.join(" "));
  }
});

test("the out-of-date hint goes to stderr, so --version stays machine-readable", async () => {
  const { exit, out, err } = await cli(["--version"], tempDir(), { hint: "A newer harv is available: 9.9.9" });

  assert.equal(exit, 0);
  assert.doesNotMatch(out, /newer harv/, "stdout is the answer");
  assert.match(err, /newer harv/, "the notice is a remark");
});

test("harv --version works outside a harvenv project — it is what a clean machine runs first", async () => {
  const { exit, err } = await cli(["--version"], tempDir());

  assert.equal(exit, 0);
  assert.doesNotMatch(err, /no Manifest/);
});

test("harv mise passes its arguments to the vendored engine and adopts the exit code", async () => {
  const { exit, mised } = await cli(["mise", "ls", "--json"], tempDir(), { exitCode: 3 });

  assert.equal(exit, 3);
  assert.deepEqual(mised, [["ls", "--json"]]);
});

test("harv mise reports a missing engine without a stack trace", async () => {
  let err = "";
  const exit = await run(["mise", "--version"], {
    cwd: tempDir(),
    stdout: () => {},
    stderr: (line) => {
      err += `${line}\n`;
    },
    launch: async () => 0,
    runMise: async () => {
      throw new MiseError("No vendored mise for this platform.");
    },
    updateHint: async () => null,
  });

  assert.equal(exit, 1);
  assert.match(err, /No vendored mise/);
  assert.doesNotMatch(err, /at .*\.ts:\d+/, "no stack trace leaks to the user");
});

test("harv claude rejects unusable settings before writing anything into the project", async () => {
  const root = project(
    '[skills]\nexample-skill = { path = "vendor/example-skill" }\n\n[settings.permissions]\ndefaultMode = "manual"\n',
  );

  const { exit, err, launched } = await cli(["claude"], root);

  assert.notEqual(exit, 0);
  assert.match(err, /manual/);
  assert.deepEqual(launched, []);
  assert.equal(existsSync(join(root, ".claude")), false, "the project tree is untouched when launch cannot succeed");
});

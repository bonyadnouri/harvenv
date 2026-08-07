import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "../src/manifest.ts";
import type { Env } from "../src/store.ts";
import { run } from "../src/cli.ts";
import { MISE_VERSION, MiseError } from "../src/mise.ts";
import { currentPlatform } from "../src/platform.ts";
import { hasTripwire } from "../src/tripwire.ts";
import { VERSION } from "../src/version.ts";
import { commitFiles, gitRepo, skillFile, tempDir } from "./helpers.ts";

interface Recorded {
  exit: number;
  out: string;
  err: string;
  launched: Array<{ manifest: Manifest; passthrough: string[]; env: Env }>;
  mised: string[][];
}

interface Options {
  /** What the stand-in `claude` and `mise` exit with. */
  exitCode?: number;
  /** Merged onto the Store pointer, for tests about `${VAR}` resolution. */
  env?: Env;
  hint?: string | null;
}

/** One project, one Store, one CLI — reused across the calls of a single test. */
function harv(cwd: string, options: Options = {}) {
  const store = tempDir();
  const launched: Recorded["launched"] = [];
  const mised: string[][] = [];

  return async (argv: string[], from = cwd): Promise<Recorded> => {
    let out = "";
    let err = "";
    const exit = await run(argv, {
      cwd: from,
      env: { HARV_HOME: store, ...options.env },
      stdout: (line) => {
        out += `${line}\n`;
      },
      stderr: (line) => {
        err += `${line}\n`;
      },
      launch: async (manifest, passthrough, env) => {
        launched.push({ manifest, passthrough, env });
        return options.exitCode ?? 0;
      },
      runMise: async (args) => {
        mised.push(args);
        return options.exitCode ?? 0;
      },
      updateHint: async () => options.hint ?? null,
    });
    return { exit, out, err, launched, mised };
  };
}

/** A project with a Manifest declaring one local skill that really exists. */
function project(manifestBody?: string): string {
  const root = tempDir();
  const skill = join(root, "vendor", "example-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), skillFile("example-skill"));
  writeFileSync(
    join(root, "harvenv.toml"),
    manifestBody ?? '[skills]\nexample-skill = { path = "vendor/example-skill" }\n',
  );
  return root;
}

const manifestText = (root: string) => readFileSync(join(root, "harvenv.toml"), "utf8");

// ---------------------------------------------------------------------------
// harv claude
// ---------------------------------------------------------------------------

test("harv claude outside a harvenv project fails with a clear no-Manifest error", async () => {
  const empty = tempDir();

  const { exit, err, launched } = await harv(empty)(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /no Manifest found/i);
  assert.match(err, /harvenv\.toml/);
  assert.match(err, new RegExp(empty.replaceAll(".", "\\.")), "names where it searched from");
  assert.deepEqual(launched, [], "nothing is launched without a Manifest");
});

test("harv claude launches from a synced project", async () => {
  const root = project();
  const cli = harv(root);
  await cli(["sync"]);

  const { exit, launched } = await cli(["claude"]);

  assert.equal(exit, 0);
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.manifest.root, root);
  assert.deepEqual(launched[0]?.passthrough, []);
});

test("harv claude materializes declared skills before launching", async () => {
  const root = project();
  const cli = harv(root);
  await cli(["sync"]);
  rmSync(join(root, ".claude"), { recursive: true, force: true });

  await cli(["claude"]);

  assert.equal(existsSync(join(root, ".claude", "skills", "example-skill", "SKILL.md")), true);
});

test("harv claude works from a subdirectory of the project", async () => {
  const root = project();
  const nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });
  const cli = harv(root);
  await cli(["sync"]);

  const { launched } = await cli(["claude"], nested);

  assert.equal(launched[0]?.manifest.root, root);
});

test("harv claude passes extra arguments through to claude", async () => {
  const cli = harv(project());
  await cli(["sync"]);

  const { launched } = await cli(["claude", "-p", "hi", "--resume"]);

  assert.deepEqual(launched[0]?.passthrough, ["-p", "hi", "--resume"]);
});

test("harv claude adopts claude's exit code", async () => {
  const cli = harv(project(), { exitCode: 42 });
  await cli(["sync"]);

  assert.equal((await cli(["claude"])).exit, 42);
});

test("harv claude refuses to launch a project that was never synced, naming the skill", async () => {
  const root = project();

  const { exit, err, launched } = await harv(root)(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /example-skill/);
  assert.match(err, /harv sync/);
  assert.deepEqual(launched, [], "a drifted Harvenv is not the one the Manifest describes");
});

test("harv claude refuses to launch once the Manifest has moved past the Lockfile", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const root = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  const cli = harv(root);
  await cli(["sync"]);

  writeFileSync(join(root, "harvenv.toml"), `[skills]\nexample = { git = "${repo.url}", ref = "main" }\n`);
  const { exit, err, launched } = await cli(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /drift/i);
  assert.match(err, /example/);
  assert.match(err, /harv sync/);
  assert.deepEqual(launched, []);
});

test("harv claude launches a Manifest that declares nothing but settings", async () => {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), '[settings]\nmodel = "opus"\n');

  const { exit, launched } = await harv(root)(["claude"]);

  assert.equal(exit, 0);
  assert.equal(launched.length, 1);
});

test("harv claude rejects unusable settings before writing anything into the project", async () => {
  const root = project(
    '[skills]\nexample-skill = { path = "vendor/example-skill" }\n\n[settings.permissions]\ndefaultMode = "manual"\n',
  );

  const { exit, err, launched } = await harv(root)(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /manual/);
  assert.deepEqual(launched, []);
  assert.equal(existsSync(join(root, ".claude")), false, "the project tree is untouched when launch cannot succeed");
});

test("harv claude rejects a personal-ergonomics key, naming the key and the rule", async () => {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), '[settings]\nstatusLine = { type = "command", command = "~/bin/mine" }\n');

  const { exit, err, launched } = await harv(root)(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /statusLine/, "names the offending key");
  assert.match(err, /ADR 0005/, "names the rule");
  assert.match(err, /Overlay/, "says where the setting does belong");
  assert.deepEqual(launched, []);
  assert.equal(existsSync(join(root, ".claude")), false, "a rejected Manifest leaves no trace");
});

test("harv claude rejects an unresolvable ${VAR} before writing anything into the project", async () => {
  const root = tempDir();
  writeFileSync(
    join(root, "harvenv.toml"),
    '[mcp.tickets]\ncommand = "npx"\nenv = { TOKEN = "${HARVENV_TEST_ABSENT}" }\n',
  );

  const { exit, err, launched } = await harv(root)(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /HARVENV_TEST_ABSENT/, "names the variable that is missing");
  assert.match(err, /mcp\.tickets/, "names the server that referenced it");
  assert.deepEqual(launched, []);
  assert.equal(existsSync(join(root, ".claude")), false);
});

test("harv claude launches when every ${VAR} the Manifest references is set", async () => {
  const root = tempDir();
  writeFileSync(
    join(root, "harvenv.toml"),
    '[mcp.tickets]\ncommand = "npx"\nenv = { TOKEN = "${HARVENV_TEST_PRESENT}" }\n',
  );

  const { exit, launched } = await harv(root, { env: { HARVENV_TEST_PRESENT: "s3cret" } })(["claude"]);

  assert.equal(exit, 0);
  assert.equal(launched[0]?.manifest.mcpServers.length, 1);
  assert.equal(
    launched[0]?.env.HARVENV_TEST_PRESENT,
    "s3cret",
    "the session inherits the environment the references resolved from",
  );
});

// ---------------------------------------------------------------------------
// harv sync
// ---------------------------------------------------------------------------

test("harv sync refuses a personal-ergonomics key too, so the rule is not a launch-time afterthought", async () => {
  const root = project('[settings]\ntheme = "dark"\n');

  const { exit, err } = await harv(root)(["sync"]);

  assert.notEqual(exit, 0);
  assert.match(err, /theme/);
  assert.match(err, /ADR 0005/);
  assert.equal(existsSync(join(root, "harvenv.lock")), false, "a refused Manifest writes no Lockfile");
});

test("harv sync writes a Lockfile pinning the commit and content hash of a git Source", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const root = project(`[skills]\nexample = { git = "${repo.url}" }\n`);

  const { exit } = await harv(root)(["sync"]);

  assert.equal(exit, 0);
  const lock = readFileSync(join(root, "harvenv.lock"), "utf8");
  assert.match(lock, new RegExp(`commit = "${repo.commit}"`));
  assert.match(lock, /hash = "sha256:[0-9a-f]{64}"/);
});

test("harv sync says what it fetched and what it reused", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const cli = harv(project(`[skills]\nexample = { git = "${repo.url}" }\n`));

  const first = await cli(["sync"]);
  const second = await cli(["sync"]);

  assert.match(first.out, /fetched/i);
  assert.match(first.out, /example/);
  assert.match(second.out, /reused|up to date/i);
});

test("harv sync warns on stderr that a path Source is not portable, naming the entry", async () => {
  const { out, err, exit } = await harv(project())(["sync"]);

  assert.equal(exit, 0, "a non-portable Source is a warning, not a failure");
  assert.match(err, /example-skill/);
  assert.match(err, /vendor\/example-skill/);
  assert.doesNotMatch(out, /warning/i, "warnings belong on stderr");
});

test("harv sync reports the drift it is resolving", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const cli = harv(project(`[skills]\nexample = { git = "${repo.url}" }\n`));

  const { out } = await cli(["sync"]);

  assert.match(out, /example/);
});

test("harv sync rejects arguments rather than silently ignoring them", async () => {
  const { exit, err } = await harv(project())(["sync", "--update"]);

  assert.notEqual(exit, 0);
  assert.match(err, /--update/);
});

test("harv sync outside a harvenv project fails with the same clear error as claude", async () => {
  const { exit, err } = await harv(tempDir())(["sync"]);

  assert.notEqual(exit, 0);
  assert.match(err, /no Manifest found/i);
});

test("harv sync reports a fetch failure without a stack trace", async () => {
  const root = project('[skills]\nexample = { git = "file:///harvenv/not/a/repo" }\n');

  const { exit, err } = await harv(root)(["sync"]);

  assert.notEqual(exit, 0);
  assert.match(err, /not\/a\/repo/);
  assert.doesNotMatch(err, /at .*\.ts:\d+/, "no stack trace leaks to the user");
});

// ---------------------------------------------------------------------------
// harv add
// ---------------------------------------------------------------------------

test("harv add appends a git entry to the Manifest and syncs it", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example") });
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), "");

  const { exit } = await harv(root)(["add", "example", "--git", repo.url]);

  assert.equal(exit, 0);
  assert.match(manifestText(root), new RegExp(`example = \\{ git = "${repo.url}" \\}`));
  assert.equal(existsSync(join(root, ".claude", "skills", "example", "SKILL.md")), true);
  assert.match(readFileSync(join(root, "harvenv.lock"), "utf8"), new RegExp(repo.commit));
});

test("harv add adds to an existing [skills] table, leaving the rest of the Manifest alone", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("added") });
  const root = project();

  await harv(root)(["add", "added", "--git", repo.url]);

  const text = manifestText(root);
  assert.match(text, /example-skill = \{ path = "vendor\/example-skill" \}/, "the existing entry survives");
  assert.match(text, /added = \{ git = /);
  assert.equal(text.match(/\[skills\]/g)?.length, 1, "one [skills] table, not two");
});

test("harv add keeps a Manifest's comments and settings", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("added") });
  const root = tempDir();
  writeFileSync(
    join(root, "harvenv.toml"),
    '# what this project needs\n[skills]\n\n[settings]\nmodel = "opus"\n',
  );

  await harv(root)(["add", "added", "--git", repo.url]);

  const text = manifestText(root);
  assert.match(text, /# what this project needs/);
  assert.match(text, /model = "opus"/);
  assert.match(text, /added = \{ git = /);
  assert.equal(text.indexOf("added ="), text.search(/added =/));
  assert.equal(text.indexOf("added =") < text.indexOf("[settings]"), true, "the entry lands inside [skills]");
});

test("harv add reads a ref and a subdirectory out of the coordinate", async () => {
  const repo = gitRepo({ "skills/example/SKILL.md": skillFile("example") });
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), "");

  const { exit, err } = await harv(root)(["add", "example", "--git", `${repo.url}@main#skills/example`]);

  assert.equal(exit, 0, err);
  assert.match(manifestText(root), /ref = "main"/);
  assert.match(manifestText(root), /subdir = "skills\/example"/);
  assert.equal(existsSync(join(root, ".claude", "skills", "example", "SKILL.md")), true);
});

test("harv add takes the ref and subdirectory as flags too", async () => {
  const repo = gitRepo({ "skills/example/SKILL.md": skillFile("example") });
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), "");

  const { exit, err } = await harv(root)([
    "add", "example", "--git", repo.url, "--ref", "main", "--subdir", "skills/example",
  ]);

  assert.equal(exit, 0, err);
  assert.match(manifestText(root), /ref = "main"/);
  assert.match(manifestText(root), /subdir = "skills\/example"/);
});

test("harv add leaves an SSH coordinate's user@host alone", async () => {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), "");

  // Unreachable on purpose: what the entry says is the point, not the fetch.
  const { err } = await harv(root)(["add", "example", "--git", "git@github.com:owner/repo.git"]);

  assert.match(err, /git@github\.com:owner\/repo\.git/, "the coordinate is reported whole");
  assert.doesNotMatch(err, /ref/, "no ref was invented from the user@host");
});

test("harv add refuses a name the Manifest already declares", async () => {
  const root = project();

  const { exit, err } = await harv(root)(["add", "example-skill", "--git", "https://example.com/s.git"]);

  assert.notEqual(exit, 0);
  assert.match(err, /already/);
  assert.match(manifestText(root), /path = "vendor\/example-skill"/, "the Manifest is not touched");
});

test("harv add refuses a name that would escape the skills directory", async () => {
  const root = project();

  const { exit, err } = await harv(root)(["add", "../agents", "--git", "https://example.com/s.git"]);

  assert.notEqual(exit, 0);
  assert.match(err, /name/i);
  assert.doesNotMatch(manifestText(root), /agents/);
});

test("harv add refuses to declare two Sources at once", async () => {
  const root = project();

  const { exit, err } = await harv(root)([
    "add", "thing", "--git", "https://example.com/s.git", "--path", "vendor/thing",
  ]);

  assert.notEqual(exit, 0);
  assert.match(err, /--git/);
  assert.match(err, /--path/);
});

test("harv add needs a Source", async () => {
  const { exit, err } = await harv(project())(["add", "thing"]);

  assert.notEqual(exit, 0);
  assert.match(err, /--git/);
});

test("harv add needs a name", async () => {
  const { exit, err } = await harv(project())(["add", "--git", "https://example.com/s.git"]);

  assert.notEqual(exit, 0);
  assert.match(err, /name/i);
});

test("harv add declares a local path when asked, warning that it is not portable", async () => {
  const root = project();
  mkdirSync(join(root, "vendor", "local-thing"), { recursive: true });
  writeFileSync(join(root, "vendor", "local-thing", "SKILL.md"), skillFile("local-thing"));

  const { exit, err } = await harv(root)(["add", "local-thing", "--path", "vendor/local-thing"]);

  assert.equal(exit, 0);
  assert.match(manifestText(root), /local-thing = \{ path = "vendor\/local-thing" \}/);
  assert.match(err, /local-thing/);
});

test("harv add leaves the Manifest unchanged when the Source cannot be fetched", async () => {
  const root = project();
  const before = manifestText(root);

  const { exit } = await harv(root)(["add", "example", "--git", "file:///harvenv/not/a/repo"]);

  assert.notEqual(exit, 0);
  assert.equal(manifestText(root), before, "a failed add does not leave a half-declared Manifest");
});

test("harv add refuses a Manifest whose [skills] it cannot edit safely", async () => {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), 'skills = { example-skill = { path = "vendor/x" } }\n');

  const { exit, err } = await harv(root)(["add", "thing", "--git", "https://example.com/s.git"]);

  assert.notEqual(exit, 0);
  assert.match(err, /by hand/i);
});

// ---------------------------------------------------------------------------
// harv init
// ---------------------------------------------------------------------------

test("harv init scaffolds a project a later harv claude can launch", async () => {
  const root = tempDir();
  const cli = harv(root);

  const { exit, out } = await cli(["init"]);

  assert.equal(exit, 0);
  assert.match(out, /Initialized a Harvenv/);
  assert.equal(existsSync(join(root, "harvenv.toml")), true);
  assert.equal(existsSync(join(root, ".gitignore")), true);
  assert.equal(hasTripwire(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"))), true);

  const { exit: launchExit, launched } = await cli(["claude"]);
  assert.equal(launchExit, 0);
  assert.equal(launched.length, 1, "the scaffolded Manifest launches");
});

test("harv init lists what it did to each artifact", async () => {
  const { out } = await harv(tempDir())(["init"]);

  assert.match(out, /created\s+harvenv\.toml/);
  assert.match(out, /created\s+\.gitignore/);
  assert.match(out, /created\s+\.claude\/settings\.json\s+.*Tripwire/);
});

test("re-running harv init reports it changed nothing", async () => {
  const root = tempDir();
  const cli = harv(root);
  await cli(["init"]);

  const { exit, out } = await cli(["init"]);

  assert.equal(exit, 0);
  assert.match(out, /Already a harvenv project/);
  assert.doesNotMatch(out, /created|updated/);
});

test("harv init reports a settings file it will not rewrite, without a stack trace", async () => {
  const root = tempDir();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), "{ nope");

  const { exit, err } = await harv(root)(["init"]);

  assert.notEqual(exit, 0);
  assert.match(err, /not valid JSON/);
  assert.doesNotMatch(err, /at .*\.ts:\d+/);
});

test("harv init takes no arguments and says so", async () => {
  const { exit, err } = await harv(tempDir())(["init", "./somewhere"]);

  assert.equal(exit, 2);
  assert.match(err, /takes no arguments/);
});

test("outside a harvenv project, harv names init as the way in", async () => {
  const { err } = await harv(tempDir())(["claude"]);

  assert.match(err, /harv init/);
});

// ---------------------------------------------------------------------------
// harv itself
// ---------------------------------------------------------------------------

test("harv with no subcommand prints usage and fails", async () => {
  const { exit, err } = await harv(tempDir())([]);

  assert.notEqual(exit, 0);
  assert.match(err, /usage/i);
});

test("harv rejects an unknown subcommand by name", async () => {
  const { exit, err } = await harv(tempDir())(["frobnicate"]);

  assert.notEqual(exit, 0);
  assert.match(err, /frobnicate/);
});

test("harv --help lists every command it has", async () => {
  const { exit, out } = await harv(tempDir())(["--help"]);

  assert.equal(exit, 0);
  assert.match(out, /usage/i);
  for (const command of ["sync", "add", "claude", "mise"]) assert.match(out, new RegExp(`\\b${command}\\b`));
});

test("harv --version reports harv and the mise it carries", async () => {
  const { exit, out } = await harv(tempDir())(["--version"]);

  assert.equal(exit, 0);
  assert.match(out, new RegExp(`harv ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(out, new RegExp(currentPlatform()), "which build you have, not just which version");
  assert.match(out, new RegExp(`vendored mise ${MISE_VERSION.replaceAll(".", "\\.")}`));
});

test("harv -v and harv version say the same thing", async () => {
  for (const argv of [["--version"], ["-v"], ["version"]]) {
    const { exit, out } = await harv(tempDir())(argv);
    assert.equal(exit, 0, argv.join(" "));
    assert.match(out, /^harv /, argv.join(" "));
  }
});

test("the out-of-date hint goes to stderr, so --version stays machine-readable", async () => {
  const { exit, out, err } = await harv(tempDir(), { hint: "A newer harv is available: 9.9.9" })(["--version"]);

  assert.equal(exit, 0);
  assert.doesNotMatch(out, /newer harv/, "stdout is the answer");
  assert.match(err, /newer harv/, "the notice is a remark");
});

test("harv --version works outside a harvenv project — it is what a clean machine runs first", async () => {
  const { exit, err } = await harv(tempDir())(["--version"]);

  assert.equal(exit, 0);
  assert.doesNotMatch(err, /no Manifest/);
});

test("harv mise passes its arguments to the vendored engine and adopts the exit code", async () => {
  const { exit, mised } = await harv(tempDir(), { exitCode: 3 })(["mise", "ls", "--json"]);

  assert.equal(exit, 3);
  assert.deepEqual(mised, [["ls", "--json"]]);
});

test("harv mise needs no Manifest — the Toolchain engine is not a project's business", async () => {
  const { exit, err } = await harv(tempDir())(["mise", "--version"]);

  assert.equal(exit, 0);
  assert.doesNotMatch(err, /no Manifest/);
});

test("harv mise reports a missing engine without a stack trace", async () => {
  let err = "";
  const exit = await run(["mise", "--version"], {
    cwd: tempDir(),
    env: { HARV_HOME: tempDir() },
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

test("harv reports a broken Manifest without a stack trace", async () => {
  const root = project('[skills]\nexample-skill = { marketplace = "vendor/pack" }\n');

  const { exit, err } = await harv(root)(["sync"]);

  assert.notEqual(exit, 0);
  assert.match(err, /cannot fetch yet/);
  assert.doesNotMatch(err, /at .*\.ts:\d+/, "no stack trace leaks to the user");
});

test("a Lockfile survives a fresh clone: sync, wipe the Store and the tree, sync again", async () => {
  const repo = gitRepo({ "SKILL.md": skillFile("example", "First.\n") });
  const root = project(`[skills]\nexample = { git = "${repo.url}" }\n`);
  const cli = harv(root);
  await cli(["sync"]);
  const lock = readFileSync(join(root, "harvenv.lock"), "utf8");
  const materialized = readFileSync(join(root, ".claude", "skills", "example", "SKILL.md"), "utf8");

  // What a teammate's clone looks like — plus a repository that moved on.
  commitFiles(repo.dir, { "SKILL.md": skillFile("example", "Second.\n") }, "second");
  rmSync(join(root, ".claude"), { recursive: true, force: true });
  const clone = harv(root);
  await clone(["sync"]);

  assert.equal(readFileSync(join(root, ".claude", "skills", "example", "SKILL.md"), "utf8"), materialized);
  assert.equal(readFileSync(join(root, "harvenv.lock"), "utf8"), lock);
});

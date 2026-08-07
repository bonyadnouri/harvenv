import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Session } from "../src/overlay.ts";
import type { ShimContext } from "../src/shim.ts";
import type { Env } from "../src/store.ts";
import { run } from "../src/cli.ts";
import { buildLaunchArgs } from "../src/launch.ts";
import { MISE_VERSION, MiseError } from "../src/mise.ts";
import { currentPlatform } from "../src/platform.ts";
import { hasTripwire } from "../src/tripwire.ts";
import { VERSION } from "../src/version.ts";
import {
  commitFiles,
  git,
  gitRepo,
  marketplaceWith,
  shimSandbox,
  skillFile,
  tempDir,
} from "./helpers.ts";

interface Recorded {
  exit: number;
  out: string;
  err: string;
  launched: Array<{ session: Session; passthrough: string[]; env: Env; toolPaths: string[] }>;
  mised: string[][];
}

interface Options {
  /** What the stand-in `claude` and `mise` exit with. */
  exitCode?: number;
  /** Merged onto the Store pointer, for tests about `${VAR}` resolution. */
  env?: Env;
  hint?: string | null;
  /** Scratch by default, so no test reaches the real HOME, PATH or dotfiles. */
  shim?: ShimContext;
  /** harv's home — the Store, and the global Overlay. Shared to share either. */
  home?: string;
}

/** One project, one Store, one shim sandbox, one CLI — reused within one test. */
function harv(cwd: string, options: Options = {}) {
  const store = options.home ?? tempDir();
  const shim = options.shim ?? shimSandbox();
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
      launch: async (session, passthrough, env, toolPaths) => {
        launched.push({ session, passthrough, env, toolPaths });
        return options.exitCode ?? 0;
      },
      runMise: async (args) => {
        mised.push(args);
        return options.exitCode ?? 0;
      },
      updateHint: async () => options.hint ?? null,
      shim,
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
  assert.equal(launched[0]?.session.manifest.root, root);
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

  assert.equal(launched[0]?.session.manifest.root, root);
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

test("harv shim install reports the shim, the PATH entry and the real claude behind it", async () => {
  const ctx = shimSandbox();
  const cli = harv(tempDir(), { shim: ctx });

  const { exit, out } = await cli(["shim", "install"]);

  assert.equal(exit, 0);
  assert.match(out, /shim installed/);
  assert.match(out, new RegExp(ctx.shimPath.replaceAll(".", "\\.")));
  assert.match(out, new RegExp(`added to ${join(ctx.home, "\\.zshrc")}`));
  assert.match(out, /HARV_NO_SHIM=1/, "the escape hatch is named where it is installed");
  assert.equal(existsSync(ctx.shimPath), true);
});

test("harv shim status reports an uninstalled shim, then an installed one", async () => {
  const ctx = shimSandbox();
  const cli = harv(tempDir(), { shim: ctx });

  const before = await cli(["shim", "status"]);
  await cli(["shim", "install"]);
  const after = await cli(["shim", "status"]);

  assert.match(before.out, /shim\s+not installed/);
  assert.match(after.out, new RegExp(`shim\\s+installed at ${ctx.shimPath.replaceAll(".", "\\.")}`));
  assert.equal(after.exit, 0);
});

test("harv shim status --json is machine-readable", async () => {
  const ctx = shimSandbox();
  const cli = harv(tempDir(), { shim: ctx });
  await cli(["shim", "install"]);

  const { out } = await cli(["shim", "status", "--json"]);

  assert.equal(JSON.parse(out).installed, true);
  assert.equal(JSON.parse(out).shimPath, ctx.shimPath);
});

test("harv shim uninstall removes what install added, and says so", async () => {
  const ctx = shimSandbox();
  const cli = harv(tempDir(), { shim: ctx });
  await cli(["shim", "install"]);

  const { exit, out } = await cli(["shim", "uninstall"]);

  assert.equal(exit, 0);
  assert.match(out, /shim uninstalled/);
  assert.equal(existsSync(ctx.shimPath), false);
  assert.equal(readFileSync(join(ctx.home, ".zshrc"), "utf8").includes("harv shim"), false);
});

test("harv shim uninstall with nothing installed says so instead of failing", async () => {
  const { exit, out } = await harv(tempDir())(["shim", "uninstall"]);

  assert.equal(exit, 0);
  assert.match(out, /nothing to remove/);
});

test("harv shim reports a refusal without a stack trace", async () => {
  const ctx = shimSandbox();
  mkdirSync(ctx.binDir, { recursive: true });
  writeFileSync(ctx.shimPath, "#!/bin/sh\n", { mode: 0o755 });

  const { exit, err } = await harv(tempDir(), { shim: ctx })(["shim", "install"]);

  assert.notEqual(exit, 0);
  assert.match(err, /did not create it/);
  assert.doesNotMatch(err, /at .*\.ts:\d+/);
});

test("harv shim with no action prints its own usage", async () => {
  const { exit, err } = await harv(tempDir())(["shim"]);

  assert.notEqual(exit, 0);
  assert.match(err, /install\|uninstall\|status/);
});

test("harv shim rejects an unknown action by name", async () => {
  const { exit, err } = await harv(tempDir())(["shim", "activate"]);

  assert.notEqual(exit, 0);
  assert.match(err, /activate/);
});

test("harv shim install rejects an option it does not understand", async () => {
  const { exit, err } = await harv(tempDir())(["shim", "install", "--global"]);

  assert.notEqual(exit, 0);
  assert.match(err, /--global/);
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
  assert.equal(launched[0]?.session.manifest.mcpServers.length, 1);
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
    shim: shimSandbox(),
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
  assert.match(err, /\[plugins\]/);
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

// ---------------------------------------------------------------------------
// Plugin pins, end to end through the CLI
// ---------------------------------------------------------------------------

test("harv add --marketplace declares the plugin under [plugins] and syncs it", async () => {
  const marketplace = gitRepo(marketplaceWith("alpha-pack"));
  const root = project("");

  const { exit, out } = await harv(root)(["add", "alpha-pack", "--marketplace", marketplace.url]);

  assert.equal(exit, 0, out);
  assert.match(manifestText(root), /\[plugins\]\nalpha-pack = \{ marketplace = "[^"]+" \}/);
  assert.match(out, /alpha-pack/);
  assert.equal(existsSync(join(root, ".claude", "harv-plugins", "alpha-pack", "SKILL.md")), false);
  assert.equal(
    existsSync(join(root, ".claude", "harv-plugins", "alpha-pack", "skills", "alpha-pack-skill", "SKILL.md")),
    true,
  );
});

test("harv add --marketplace carries a ref from the coordinate", async () => {
  const marketplace = gitRepo(marketplaceWith("alpha-pack"));
  git(["tag", "v1"], marketplace.dir);
  const root = project("");

  await harv(root)(["add", "alpha-pack", "--marketplace", `${marketplace.url}@v1`]);

  assert.match(manifestText(root), /ref = "v1"/);
  assert.match(readFileSync(join(root, "harvenv.lock"), "utf8"), /\[\[plugins\]\]/);
});

test("harv add --marketplace refuses a subdirectory the marketplace decides", async () => {
  const root = project("");

  const { exit, err } = await harv(root)([
    "add",
    "alpha-pack",
    "--marketplace",
    "https://example.com/m.git#plugins/alpha-pack",
  ]);

  assert.notEqual(exit, 0);
  assert.match(err, /subdirectory/);
  assert.doesNotMatch(manifestText(root), /alpha-pack/, "the Manifest is left as it was");
});

test("harv add puts the Manifest back when a marketplace does not offer the plugin", async () => {
  const marketplace = gitRepo(marketplaceWith("alpha-pack"));
  const root = project("");
  const before = manifestText(root);

  const { exit, err } = await harv(root)(["add", "beta-pack", "--marketplace", marketplace.url]);

  assert.notEqual(exit, 0);
  assert.match(err, /beta-pack/);
  assert.match(err, /alpha-pack/, "the plugins the marketplace does offer are named");
  assert.equal(manifestText(root), before);
});

test("harv claude serves a pinned plugin through --plugin-dir, and no skill that way", async () => {
  const marketplace = gitRepo(marketplaceWith("alpha-pack"));
  const root = project(
    '[skills]\nexample-skill = { path = "vendor/example-skill" }\n\n' +
      `[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`,
  );
  const cli = harv(root);
  await cli(["sync"]);

  const { exit, launched } = await cli(["claude"]);

  assert.equal(exit, 0);
  const args = buildLaunchArgs(launched[0]!.session, [], {});
  assert.deepEqual(args.slice(args.indexOf("--plugin-dir")), [
    "--plugin-dir",
    join(root, ".claude", "harv-plugins", "alpha-pack"),
  ]);
});

test("harv claude refuses to start when a plugin pin has drifted from the Lockfile", async () => {
  const marketplace = gitRepo(marketplaceWith("alpha-pack"));
  const root = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);
  const cli = harv(root);
  await cli(["sync"]);

  writeFileSync(
    join(root, "harvenv.toml"),
    `[plugins]\nalpha-pack = { marketplace = "${marketplace.url}", ref = "main" }\n`,
  );
  const { exit, err, launched } = await cli(["claude"]);

  assert.notEqual(exit, 0);
  assert.equal(launched.length, 0, "no session is started while the Harvenv is drifted");
  assert.match(err, /alpha-pack/);
  assert.match(err, /harv sync/);
});

test("harv sync reports a pinned plugin's suppressed MCP servers as a warning", async () => {
  const files = marketplaceWith("alpha-pack");
  files["plugins/alpha-pack/.mcp.json"] = JSON.stringify({ mcpServers: { docs: { command: "node" } } });
  const marketplace = gitRepo(files);
  const root = project(`[plugins]\nalpha-pack = { marketplace = "${marketplace.url}" }\n`);

  const { exit, out, err } = await harv(root)(["sync"]);

  assert.equal(exit, 0);
  assert.match(err, /warning/i);
  assert.match(err, /alpha-pack/);
  assert.match(err, /docs/);
  assert.doesNotMatch(out, /warning/i, "a warning belongs on stderr");
});
// ---------------------------------------------------------------------------
// The Overlay
// ---------------------------------------------------------------------------

/** The global staples file, in the harv home this CLI was pointed at. */
const staples = (home: string, body: string) => writeFileSync(join(home, "overlay.toml"), body);

/** This project's extras — gitignored, and the half that wins inside the Overlay. */
const extras = (root: string, body: string) => writeFileSync(join(root, "harvenv.local.toml"), body);

const materialized = (root: string, name: string) => existsSync(join(root, ".claude", "skills", name, "SKILL.md"));

/** A skill directory outside any project, for a staple every project can reach. */
function stapleDir(name: string): string {
  const dir = join(tempDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillFile(name));
  return dir;
}

test("a staple declared once in the global Overlay reaches two different projects", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const one = project();
  const two = project();

  await harv(one, { home })(["sync"]);
  await harv(two, { home })(["sync"]);

  assert.equal(materialized(one, "staple"), true);
  assert.equal(materialized(two, "staple"), true);
  assert.equal(materialized(one, "example-skill"), true, "the Manifest's own Components are still there");
});

test("the Overlay is locked outside the committed Lockfile, so nothing personal is handed over", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const root = project();

  await harv(root, { home })(["sync"]);

  assert.doesNotMatch(readFileSync(join(root, "harvenv.lock"), "utf8"), /staple/);
  assert.match(readFileSync(join(root, ".harv", "overlay.lock"), "utf8"), /staple/);
});

test("project-local extras add a Component to that project alone", async () => {
  const home = tempDir();
  const one = project();
  const two = project();
  mkdirSync(join(one, "vendor", "scratch"), { recursive: true });
  writeFileSync(join(one, "vendor", "scratch", "SKILL.md"), skillFile("scratch"));
  extras(one, '[skills]\nscratch = { path = "vendor/scratch" }\n');

  await harv(one, { home })(["sync"]);
  await harv(two, { home })(["sync"]);

  assert.equal(materialized(one, "scratch"), true);
  assert.equal(materialized(two, "scratch"), false);
});

test("a disable entry in the extras file removes a staple in that project only", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const kept = project();
  const without = project();
  extras(without, "[skills]\nstaple = { disable = true }\n");

  await harv(kept, { home })(["sync"]);
  await harv(without, { home })(["sync"]);

  assert.equal(materialized(kept, "staple"), true);
  assert.equal(materialized(without, "staple"), false);
});

test("disabling a staple after it was synced takes it back out of the project", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const root = project();
  const cli = harv(root, { home });
  await cli(["sync"]);

  extras(root, "[skills]\nstaple = { disable = true }\n");
  const { exit } = await cli(["sync"]);

  assert.equal(exit, 0);
  assert.equal(materialized(root, "staple"), false);
});

test("an Overlay value for a Manifest-bound key is rejected at sync, and the warning names the key", async () => {
  const home = tempDir();
  const root = project('[settings]\nmodel = "opus"\n');
  staples(home, '[settings]\nmodel = "haiku"\n');

  const { exit, err } = await harv(root, { home })(["sync"]);

  assert.equal(exit, 0, "a personal file may not fail a project's sync");
  assert.match(err, /warning/i);
  assert.match(err, /\bmodel\b/, "names the locked key");
  assert.match(err, /ADR 0005/, "names the rule");
});

test("a rejected Overlay setting never reaches the session; the Manifest's value does", async () => {
  const home = tempDir();
  const root = project('[settings]\nmodel = "opus"\n');
  staples(home, '[settings]\nmodel = "haiku"\ntheme = "dark"\n');
  const cli = harv(root, { home });
  await cli(["sync"]);

  const { launched } = await cli(["claude"]);

  assert.deepEqual(launched[0]?.session.settings, { model: "opus", theme: "dark" });
});

test("an Overlay MCP server the Manifest leaves alone joins the session", async () => {
  const home = tempDir();
  const root = project('[mcp.tickets]\ncommand = "project-tickets"\n');
  staples(home, '[mcp.notes]\ncommand = "notes-mcp"\n');
  const cli = harv(root, { home });
  await cli(["sync"]);

  const { launched } = await cli(["claude"]);

  assert.deepEqual(
    launched[0]?.session.mcpServers.map((server) => server.name).sort(),
    ["notes", "tickets"],
  );
});

test("a path Source in the Overlay is not flagged non-portable — the Overlay is never cloned", async () => {
  const home = tempDir();
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), "");
  staples(home, `[skills]\nstaple = { path = "${stapleDir("staple")}" }\n`);

  const { exit, err } = await harv(root, { home })(["sync"]);

  assert.equal(exit, 0);
  assert.equal(materialized(root, "staple"), true);
  assert.doesNotMatch(err, /no clone of this project can resolve/);
});

test("harv claude reports Overlay drift rather than quietly fetching it", async () => {
  const home = tempDir();
  const root = project();
  const cli = harv(root, { home });
  await cli(["sync"]);

  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const { exit, err, launched } = await cli(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /Overlay/);
  assert.match(err, /staple/);
  assert.match(err, /harv sync/);
  assert.deepEqual(launched, []);
});

// ---------------------------------------------------------------------------
// --no-overlay: the CI and headless baseline
// ---------------------------------------------------------------------------

test("harv claude --no-overlay launches a session composed from the Manifest alone", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n[settings]\ntheme = "dark"\n`);
  const root = project();
  const cli = harv(root, { home });
  await cli(["sync"]);

  const { exit, launched } = await cli(["claude", "--no-overlay"]);

  assert.equal(exit, 0);
  assert.deepEqual(launched[0]?.session.settings, {}, "no Overlay settings reach the session");
  assert.deepEqual(launched[0]?.session.overlaySkills, []);
  assert.equal(materialized(root, "staple"), false, "and none of its Components are in project scope");
  assert.equal(materialized(root, "example-skill"), true, "while the Manifest's still are");
});

test("--no-overlay is harv's own flag and is not passed through to claude", async () => {
  const cli = harv(project());
  await cli(["sync"]);

  const { launched } = await cli(["claude", "-p", "hi", "--no-overlay", "--resume"]);

  assert.deepEqual(launched[0]?.passthrough, ["-p", "hi", "--resume"]);
});

test("harv sync --no-overlay leaves the Overlay unfetched and unlocked", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const root = project();

  const { exit } = await harv(root, { home })(["sync", "--no-overlay"]);

  assert.equal(exit, 0);
  assert.equal(materialized(root, "staple"), false);
  assert.equal(existsSync(join(root, ".harv", "overlay.lock")), false);
});

test("harv sync --no-overlay clears an Overlay a previous sync materialized", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const root = project();
  const cli = harv(root, { home });
  await cli(["sync"]);

  await cli(["sync", "--no-overlay"]);

  assert.equal(materialized(root, "staple"), false);
  assert.equal(existsSync(join(root, ".harv", "overlay.lock")), false);
});

test("harv sync still rejects an argument that is not --no-overlay", async () => {
  const { exit, err } = await harv(project())(["sync", "--update"]);

  assert.notEqual(exit, 0);
  assert.match(err, /--update/);
});

test("an unusable Overlay fails the command by name rather than being skipped", async () => {
  const home = tempDir();
  const root = project();
  staples(home, '[settings]\neffortLevel = "max"\n');

  const { exit, err } = await harv(root, { home })(["sync"]);

  assert.notEqual(exit, 0);
  assert.match(err, /effortLevel/);
  assert.match(err, /overlay\.toml/, "names the file to edit");
});

test("harv claude names the locked key too, so the warning is not only sync's to give", async () => {
  const home = tempDir();
  const root = project('[settings]\nmodel = "opus"\n');
  staples(home, '[settings]\nmodel = "haiku"\n');
  const cli = harv(root, { home });
  await cli(["sync"]);

  const { exit, err } = await cli(["claude"]);

  assert.equal(exit, 0);
  assert.match(err, /\bmodel\b/);
  assert.match(err, /ADR 0005/);
});

test("harv add leaves the Overlay's Components in place", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const added = gitRepo({ "SKILL.md": skillFile("added") });
  const root = project();
  const cli = harv(root, { home });
  await cli(["sync"]);

  const { exit } = await cli(["add", "added", "--git", added.url]);

  assert.equal(exit, 0);
  assert.equal(materialized(root, "added"), true);
  assert.equal(materialized(root, "staple"), true, "adding to the Manifest does not unmaterialize a staple");
});

test("the Overlay's Lockfile says not to commit it, where the Manifest's says the opposite", async () => {
  const home = tempDir();
  const repo = gitRepo({ "SKILL.md": skillFile("staple") });
  staples(home, `[skills]\nstaple = { git = "${repo.url}" }\n`);
  const root = project();

  await harv(root, { home })(["sync"]);

  const overlayLock = readFileSync(join(root, ".harv", "overlay.lock"), "utf8");
  assert.doesNotMatch(overlayLock, /Commit it/, "it is gitignored, so telling anyone to commit it is wrong");
  assert.match(overlayLock, /not commit/i);
  assert.match(readFileSync(join(root, "harvenv.lock"), "utf8"), /Commit it/);
});

// ---------------------------------------------------------------------------
// The Toolchain (ADR 0006)
// ---------------------------------------------------------------------------

/**
 * A stand-in for the install engine: it answers the three questions harv asks,
 * installs by creating the directory a real one would, and records the
 * environment it was handed — so a test can assert that harv redirected mise
 * away from the user's own setup before running it.
 */
function stubMise(receipt: string): string {
  const path = join(tempDir(), "mise");
  writeFileSync(
    path,
    `#!/usr/bin/env node\n` +
      `const fs = require("node:fs");\n` +
      `const p = require("node:path");\n` +
      `const [command, coordinate = ""] = process.argv.slice(2);\n` +
      `const at = coordinate.lastIndexOf("@");\n` +
      `const tool = at > 0 ? coordinate.slice(0, at) : coordinate;\n` +
      `const spec = at > 0 ? coordinate.slice(at + 1) : "";\n` +
      `fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), env: process.env, cwd: process.cwd()\n` +
      `}) + "\\n");\n` +
      `const data = process.env.MISE_DATA_DIR;\n` +
      `const version = spec.includes(".") ? spec : spec + ".1.0";\n` +
      `const bin = p.join(data, "installs", tool, version, "bin");\n` +
      `if (command === "latest") { if (tool === "obscurity") process.exit(1); console.log(version); }\n` +
      `else if (command === "registry") { process.exit(tool === "obscurity" ? 1 : 0); }\n` +
      `else if (command === "install") { fs.mkdirSync(bin, { recursive: true }); }\n` +
      `else if (command === "bin-paths") { console.log(bin); }\n` +
      `else { process.exit(1); }\n`,
    { mode: 0o755 },
  );
  return path;
}

/** Every invocation the stub engine recorded. */
const invocations = (receipt: string): Array<{ argv: string[]; env: Record<string, string>; cwd: string }> =>
  existsSync(receipt)
    ? readFileSync(receipt, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

/**
 * A CLI whose Toolchain engine is the stub above, pointed at through the same
 * `HARV_MISE_BIN` a user would use — so these exercise the real resolution and
 * the real process layer, and only the downloading is faked.
 */
function harvWithEngine(cwd: string, receipt: string) {
  const store = tempDir();
  const launched: Recorded["launched"] = [];
  const mised: string[][] = [];

  return async (argv: string[]): Promise<Recorded> => {
    let out = "";
    let err = "";
    const exit = await run(argv, {
      cwd,
      env: { HARV_HOME: store, HARV_MISE_BIN: stubMise(receipt), PATH: process.env.PATH ?? "" },
      stdout: (line) => {
        out += `${line}\n`;
      },
      stderr: (line) => {
        err += `${line}\n`;
      },
      launch: async (session, passthrough, env, toolPaths) => {
        launched.push({ session, passthrough, env, toolPaths });
        return 0;
      },
      runMise: async (args) => {
        mised.push(args);
        return 0;
      },
      updateHint: async () => null,
      shim: shimSandbox(),
    });
    return { exit, out, err, launched, mised };
  };
}

test("harv sync installs a declared tool and reports it", async () => {
  const receipt = join(tempDir(), "mise.jsonl");
  const cli = harvWithEngine(project('[tools]\nnode = "22"\n'), receipt);

  const { exit, out } = await cli(["sync"]);

  assert.equal(exit, 0);
  assert.match(out, /installed node@22\.1\.0/);
  assert.ok(
    invocations(receipt).some((call) => call.argv[0] === "install"),
    "the engine was asked to install",
  );
});

test("harv never lets the engine touch the user's own mise setup", async () => {
  const receipt = join(tempDir(), "mise.jsonl");
  await harvWithEngine(project('[tools]\nnode = "22"\n'), receipt)(["sync"]);

  for (const call of invocations(receipt)) {
    for (const key of ["MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "MISE_STATE_DIR"]) {
      assert.ok(call.env[key]?.length, `${key} was redirected`);
      assert.ok(!/\.local\/share\/mise$|\.config\/mise$/.test(call.env[key]!), `${key} is not the user's own`);
    }
  }
});

test("harv claude hands the session the Harvenv's tool paths", async () => {
  const receipt = join(tempDir(), "mise.jsonl");
  const cli = harvWithEngine(project('[tools]\nnode = "22"\n'), receipt);
  await cli(["sync"]);

  const { exit, launched } = await cli(["claude"]);

  assert.equal(exit, 0);
  assert.equal(launched[0]?.toolPaths.length, 1);
  assert.match(launched[0]?.toolPaths[0] ?? "", /installs\/node\/22\.1\.0\/bin$/);
});

test("harv claude refuses to start when the Toolchain has drifted from the Lockfile", async () => {
  const receipt = join(tempDir(), "mise.jsonl");
  const root = project('[tools]\nnode = "22"\n');
  const cli = harvWithEngine(root, receipt);
  await cli(["sync"]);
  writeFileSync(join(root, "harvenv.toml"), '[tools]\nnode = "24"\n');

  const { exit, err, launched } = await cli(["claude"]);

  assert.notEqual(exit, 0);
  assert.match(err, /node/);
  assert.match(err, /harv sync/);
  assert.deepEqual(launched, [], "no session started from a Harvenv the Manifest does not describe");
});

test("an unscopeable tool is a warning and a launch, not a failure", async () => {
  const receipt = join(tempDir(), "mise.jsonl");
  const cli = harvWithEngine(project('[tools]\nobscurity = "1"\n'), receipt);

  const synced = await cli(["sync"]);
  const { exit, launched } = await cli(["claude"]);

  assert.equal(synced.exit, 0);
  assert.match(synced.err, /obscurity/);
  assert.match(synced.err, /no scoped installer/);
  assert.equal(exit, 0);
  assert.deepEqual(launched[0]?.toolPaths, [], "the session falls back to the machine's own PATH");
});

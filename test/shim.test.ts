import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findManifest, MANIFEST_FILENAME } from "../src/manifest.ts";
import {
  claudesOnPath,
  detectHarvCommand,
  installShim,
  renderShim,
  resolveRealClaude,
  shellProfile,
  ShimError,
  shimStatus,
  SHIM_RECORD_FILE,
  uninstallShim,
  withBlock,
  withoutBlock,
} from "../src/shim.ts";
import { argsOf, fakeExecutable, shimSandbox, tempDir, whoRan } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Resolving the real claude
// ---------------------------------------------------------------------------

/** A directory holding a stand-in claude, optionally marked as a shim dir. */
function claudeDir(label: string, isShim = false): string {
  const dir = tempDir();
  fakeExecutable(dir, "claude", label);
  if (isShim) writeFileSync(join(dir, SHIM_RECORD_FILE), '{"version":1,"kind":"harv-shim","entries":["claude"]}\n');
  return dir;
}

test("resolveRealClaude finds the first claude on PATH", () => {
  const [first, second] = [claudeDir("first"), claudeDir("second")];

  assert.equal(resolveRealClaude(`${first}:${second}`), join(first, "claude"));
});

test("resolveRealClaude walks past a harv shim directory", () => {
  const [shim, real] = [claudeDir("shim", true), claudeDir("real")];

  assert.equal(resolveRealClaude(`${shim}:${real}`), join(real, "claude"));
});

test("resolveRealClaude walks past a *second* harv installation's shim too", () => {
  const [mine, theirs, real] = [claudeDir("mine", true), claudeDir("theirs", true), claudeDir("real")];

  assert.equal(resolveRealClaude(`${mine}:${theirs}:${real}`), join(real, "claude"));
});

test("resolveRealClaude returns null when every claude on PATH is a shim", () => {
  assert.equal(resolveRealClaude(claudeDir("shim", true)), null);
});

test("resolveRealClaude returns null when there is no claude at all", () => {
  assert.equal(resolveRealClaude(tempDir()), null);
});

test("resolveRealClaude ignores a claude that is not executable", () => {
  const dir = tempDir();
  chmodSync(fakeExecutable(dir, "claude", "not-executable"), 0o644);
  const real = claudeDir("real");

  assert.equal(resolveRealClaude(`${dir}:${real}`), join(real, "claude"));
});

test("resolveRealClaude ignores a directory named claude", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "claude"));
  const real = claudeDir("real");

  assert.equal(resolveRealClaude(`${dir}:${real}`), join(real, "claude"));
});

test("claudesOnPath reports every claude in order, flagging the shims", () => {
  const [shim, real] = [claudeDir("shim", true), claudeDir("real")];

  assert.deepEqual(claudesOnPath(`${shim}:${real}`), [
    { path: join(shim, "claude"), isShim: true },
    { path: join(real, "claude"), isShim: false },
  ]);
});

// ---------------------------------------------------------------------------
// The generated shim script, actually run
// ---------------------------------------------------------------------------

interface ShimWorld {
  ctx: ReturnType<typeof shimSandbox>;
  /** Directory holding the stand-in real claude. */
  realDir: string;
  /** Directory holding the stand-in harv. */
  harvDir: string;
  harvPath: string;
  /** A directory with a harvenv.toml in it. */
  project: string;
  /** A directory with no Manifest at or above it. */
  outside: string;
  /** PATH the shim runs with: shim directory first, then the real claude. */
  path: string;
}

/**
 * A world where `claude`, `harv` and a harvenv project are all stand-ins, so
 * the shim's routing can be observed without a Claude Code session anywhere in
 * sight. `harv` is a stand-in executable rather than the real one, which is
 * what lets a test assert "it handed over to harv" rather than infer it.
 */
function shimWorld(): ShimWorld {
  const root = tempDir();
  const harvDir = join(root, "harv-bin");
  const harvPath = fakeExecutable(harvDir, "harv", "harv");
  const realDir = join(root, "real-bin");
  fakeExecutable(realDir, "claude", "real-claude");

  const ctx = shimSandbox({ harvCommand: [harvPath] });
  installShim(ctx, "none");

  const project = join(root, "project", "nested", "deep");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(root, "project", MANIFEST_FILENAME), "[skills]\n");

  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });

  return {
    ctx,
    realDir,
    harvDir,
    harvPath,
    project,
    outside,
    path: `${ctx.binDir}:${realDir}`,
  };
}

interface ShimRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runShim(w: ShimWorld, args: string[], opts: { cwd: string; path?: string; env?: Record<string, string> } ): ShimRun {
  const result = spawnSync(w.ctx.shimPath, args, {
    cwd: opts.cwd,
    env: { PATH: opts.path ?? w.path, ...opts.env },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the generated shim is valid POSIX sh", () => {
  const check = spawnSync("sh", ["-n", "-"], { input: renderShim(shimSandbox()), encoding: "utf8" });

  assert.equal(check.status, 0, check.stderr);
});

test("the shim execs the real claude outside a harvenv project", () => {
  const w = shimWorld();

  const run = runShim(w, [], { cwd: w.outside });

  assert.equal(whoRan(run.stdout), "real-claude");
  assert.equal(run.code, 0);
});

test("the shim routes through harv inside a harvenv project", () => {
  const w = shimWorld();

  const run = runShim(w, [], { cwd: join(w.project, "..", "..") });

  assert.equal(whoRan(run.stdout), "harv");
  assert.deepEqual(argsOf(run.stdout), ["claude"]);
});

test("the shim routes through harv from a subdirectory of the project", () => {
  const w = shimWorld();

  const run = runShim(w, [], { cwd: w.project });

  assert.equal(whoRan(run.stdout), "harv");
});

test("the shim hands arguments to harv untouched, after `claude`", () => {
  const w = shimWorld();
  const args = ["-p", "hello world", "--resume", "--", "--settings", "", "a'b\"c", "$PATH", "*"];

  const run = runShim(w, args, { cwd: w.project });

  assert.deepEqual(argsOf(run.stdout), ["claude", ...args]);
});

test("the shim hands arguments to the real claude untouched outside a project", () => {
  const w = shimWorld();
  const args = ["-p", "hello world", "--", "--setting-sources", "", "a'b\"c", "*"];

  const run = runShim(w, args, { cwd: w.outside });

  assert.equal(whoRan(run.stdout), "real-claude");
  assert.deepEqual(argsOf(run.stdout), args);
});

test("the shim runs claude in the caller's working directory, not the project root", () => {
  const w = shimWorld();

  const run = runShim(w, [], { cwd: w.outside });

  assert.match(run.stdout, new RegExp(`cwd=${w.outside}$`, "m"));
});

test("HARV_NO_SHIM keeps ADR 0005's escape hatch open inside a harvenv project", () => {
  const w = shimWorld();

  const run = runShim(w, ["-p", "hi"], { cwd: w.project, env: { HARV_NO_SHIM: "1" } });

  assert.equal(whoRan(run.stdout), "real-claude");
  assert.deepEqual(argsOf(run.stdout), ["-p", "hi"]);
});

test("the shim resolves the real claude afresh, so an upgrade in place needs no reinstall", () => {
  const w = shimWorld();

  // What `claude` points at changed under the shim — the shape of every Claude
  // Code upgrade, which replaces the binary its launcher symlink resolves to.
  fakeExecutable(w.realDir, "claude", "real-claude-v2");
  const run = runShim(w, [], { cwd: w.outside });

  assert.equal(whoRan(run.stdout), "real-claude-v2");
});

test("the shim resolves the real claude afresh when the upgrade moves it to another PATH entry", () => {
  const w = shimWorld();
  rmSync(join(w.realDir, "claude"));
  const moved = tempDir();
  fakeExecutable(moved, "claude", "real-claude-relocated");

  const run = runShim(w, [], { cwd: w.outside, path: `${w.ctx.binDir}:${w.realDir}:${moved}` });

  assert.equal(whoRan(run.stdout), "real-claude-relocated");
});

test("the shim never resolves to itself, whatever its position on PATH", () => {
  const w = shimWorld();

  for (const path of [`${w.ctx.binDir}:${w.realDir}`, `${w.realDir}:${w.ctx.binDir}`]) {
    const run = runShim(w, [], { cwd: w.outside, path });
    assert.equal(whoRan(run.stdout), "real-claude", `PATH=${path}`);
  }
});

test("a second harv installation on PATH does not send the shim in circles", () => {
  const w = shimWorld();
  const other = shimSandbox({ harvCommand: [w.harvPath] });
  installShim(other, "none");

  const run = runShim(w, [], { cwd: w.outside, path: `${w.ctx.binDir}:${other.binDir}:${w.realDir}` });

  assert.equal(whoRan(run.stdout), "real-claude");
});

/**
 * The other shape of `harvCommand`. `shimWorld` installs the one-element form —
 * a compiled harv, which is how a released harv runs (ADR 0007) — so the
 * two-element form a source checkout runs under needs its own world.
 */
function twoElementWorld(): { ctx: ReturnType<typeof shimSandbox>; entry: string; project: string; path: string } {
  const root = tempDir();
  const runner = fakeExecutable(join(root, "runtime"), "node", "runtime");
  const entry = join(root, "harv.ts");
  writeFileSync(entry, "");
  const realDir = join(root, "real-bin");
  fakeExecutable(realDir, "claude", "real-claude");

  const ctx = shimSandbox({ harvCommand: [runner, entry] });
  installShim(ctx, "none");

  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, MANIFEST_FILENAME), "[skills]\n");

  return { ctx, entry, project, path: `${ctx.binDir}:${realDir}` };
}

test("the shim runs a harv that is a runtime plus an entry script, not only a single binary", () => {
  const w = twoElementWorld();

  const run = spawnSync(w.ctx.shimPath, ["-p", "hi"], {
    cwd: w.project,
    env: { PATH: w.path },
    encoding: "utf8",
  });

  assert.equal(whoRan(run.stdout), "runtime");
  assert.deepEqual(argsOf(run.stdout), [w.entry, "claude", "-p", "hi"]);
});

test("a vanished entry script fails open the same way a vanished runtime does", () => {
  const w = twoElementWorld();
  rmSync(w.entry);

  const run = spawnSync(w.ctx.shimPath, ["-p", "hi"], {
    cwd: w.project,
    env: { PATH: w.path },
    encoding: "utf8",
  });

  assert.equal(whoRan(run.stdout), "real-claude");
  assert.match(run.stderr, /NOT isolated/);
});

test("a vanished harv makes the session un-isolated and says so — it never breaks claude", () => {
  const w = shimWorld();
  rmSync(w.harvPath);

  const run = runShim(w, ["-p", "hi"], { cwd: w.project });

  assert.equal(whoRan(run.stdout), "real-claude", "claude still runs");
  assert.deepEqual(argsOf(run.stdout), ["-p", "hi"]);
  assert.match(run.stderr, /NOT isolated/);
  assert.match(run.stderr, /harv shim uninstall/);
});

test("with no real claude to find, the shim fails like a missing command instead of looping", () => {
  const w = shimWorld();

  const run = runShim(w, [], { cwd: w.outside, path: w.ctx.binDir });

  assert.equal(run.code, 127);
  assert.match(run.stderr, /not found on PATH/);
  assert.match(run.stderr, /harv shim uninstall/);
});

test("the shim survives a PATH entry containing a glob character", () => {
  const w = shimWorld();

  const run = runShim(w, [], { cwd: w.outside, path: `/no/such/*/dir:${w.ctx.binDir}:${w.realDir}` });

  assert.equal(whoRan(run.stdout), "real-claude");
});

test("the shim's Manifest search agrees with harv's, directory for directory", () => {
  const w = shimWorld();
  const root = tempDir();
  const cases = [
    join(root, "plain"),
    join(root, "project"),
    join(root, "project", "src"),
    join(root, "project", "src", "deep"),
    join(root, "sibling"),
  ];
  for (const dir of cases) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "project", MANIFEST_FILENAME), "[skills]\n");

  for (const cwd of cases) {
    const routedToHarv = whoRan(runShim(w, [], { cwd }).stdout) === "harv";
    assert.equal(routedToHarv, findManifest(cwd) !== null, `disagreed about ${cwd}`);
  }
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

test("install writes an executable shim and an ownership record", () => {
  const ctx = shimSandbox();

  const result = installShim(ctx);

  assert.equal(result.created, true);
  assert.equal(existsSync(ctx.shimPath), true);
  assert.equal(statSync(ctx.shimPath).mode & 0o111, 0o111, "the shim is executable");
  assert.deepEqual(JSON.parse(readFileSync(ctx.recordPath, "utf8")), {
    version: 1,
    kind: "harv-shim",
    entries: ["claude"],
  });
});

test("install puts the shim directory first on PATH in the shell's startup file", () => {
  const ctx = shimSandbox({ shell: "/bin/zsh" });

  const result = installShim(ctx);

  const zshrc = readFileSync(join(ctx.home, ".zshrc"), "utf8");
  assert.deepEqual(result.startupFiles, [join(ctx.home, ".zshrc")]);
  assert.match(zshrc, /# >>> harv shim >>>/);
  assert.match(zshrc, new RegExp(`export PATH="${ctx.binDir}:\\$PATH"`));
  assert.match(zshrc, /# <<< harv shim <<</);
});

test("install leaves the rest of a startup file exactly as it was", () => {
  const ctx = shimSandbox();
  const zshrc = join(ctx.home, ".zshrc");
  const before = "# my shell\nexport EDITOR=vim\nalias ll='ls -la'\n";
  writeFileSync(zshrc, before);

  installShim(ctx);

  assert.equal(readFileSync(zshrc, "utf8").startsWith(before), true);
});

test("installing twice leaves exactly one PATH block", () => {
  const ctx = shimSandbox();

  installShim(ctx);
  const second = installShim(ctx);

  const zshrc = readFileSync(join(ctx.home, ".zshrc"), "utf8");
  assert.equal(zshrc.match(/# >>> harv shim >>>/g)?.length, 1);
  assert.equal(second.created, false, "an identical shim is reported as already installed");
});

test("reinstalling after moving HARV_HOME replaces the PATH entry rather than stacking a second", () => {
  const ctx = shimSandbox();
  installShim(ctx);
  const moved = shimSandbox({ home: ctx.home, harvHome: join(ctx.home, "elsewhere") });

  installShim({ ...moved, home: ctx.home, configHome: ctx.configHome });

  const zshrc = readFileSync(join(ctx.home, ".zshrc"), "utf8");
  assert.equal(zshrc.match(/# >>> harv shim >>>/g)?.length, 1);
  assert.equal(zshrc.includes(moved.binDir), true);
  assert.equal(zshrc.includes(`"${ctx.binDir}:`), false, "the old entry is gone");
});

test("install refuses to overwrite a claude harv did not create", () => {
  const ctx = shimSandbox();
  mkdirSync(ctx.binDir, { recursive: true });
  writeFileSync(ctx.shimPath, "#!/bin/sh\necho someone else's\n", { mode: 0o755 });

  assert.throws(
    () => installShim(ctx),
    (err: Error) => err instanceof ShimError && /did not create it/.test(err.message),
  );
});

test("install --shell none writes the shim and touches no startup file", () => {
  const ctx = shimSandbox();

  const result = installShim(ctx, "none");

  assert.equal(existsSync(ctx.shimPath), true);
  assert.deepEqual(result.startupFiles, []);
  assert.equal(result.unconfigurableShell, null, "opting out is not a failure to detect");
  assert.equal(existsSync(join(ctx.home, ".zshrc")), false);
});

test("install names a shell it cannot configure instead of guessing at a file", () => {
  const ctx = shimSandbox({ shell: "/usr/bin/elvish" });

  const result = installShim(ctx);

  assert.equal(result.unconfigurableShell, "elvish");
  assert.deepEqual(result.startupFiles, []);
  assert.match(result.pathLine, new RegExp(ctx.binDir));
});

test("install writes fish syntax into the fish config", () => {
  const ctx = shimSandbox({ shell: "/opt/homebrew/bin/fish" });

  installShim(ctx);

  const config = readFileSync(join(ctx.configHome, "fish", "config.fish"), "utf8");
  assert.match(config, new RegExp(`set -gx PATH '${ctx.binDir}' \\$PATH`));
});

test("install writes both bash startup files when both exist", () => {
  const ctx = shimSandbox({ shell: "/bin/bash" });
  writeFileSync(join(ctx.home, ".bashrc"), "# rc\n");
  writeFileSync(join(ctx.home, ".bash_profile"), "# profile\n");

  const result = installShim(ctx);

  assert.deepEqual(result.startupFiles, [join(ctx.home, ".bashrc"), join(ctx.home, ".bash_profile")]);
});

test("install falls back to the bash file the platform's terminals actually read", () => {
  const darwin = shimSandbox({ shell: "/bin/bash", platform: "darwin" });
  const linux = shimSandbox({ shell: "/bin/bash", platform: "linux" });

  assert.deepEqual(shellProfile(darwin)?.files, [join(darwin.home, ".bash_profile")]);
  assert.deepEqual(shellProfile(linux)?.files, [join(linux.home, ".bashrc")]);
});

test("install refuses on Windows rather than writing a shell script nothing will run", () => {
  assert.throws(
    () => installShim(shimSandbox({ platform: "win32" })),
    (err: Error) => err instanceof ShimError && /Windows/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

test("uninstall restores the startup file byte for byte", () => {
  const ctx = shimSandbox();
  const zshrc = join(ctx.home, ".zshrc");
  const before = "# my shell\nexport EDITOR=vim\n\n# a trailing comment\n";
  writeFileSync(zshrc, before);

  installShim(ctx);
  const result = uninstallShim(ctx);

  assert.equal(readFileSync(zshrc, "utf8"), before);
  assert.deepEqual(result.cleanedFiles, [zshrc]);
});

test("uninstall removes the shim, the record and the directories harv created", () => {
  const ctx = shimSandbox();
  installShim(ctx);

  const result = uninstallShim(ctx);

  assert.equal(result.removedShim, true);
  assert.equal(existsSync(ctx.shimPath), false);
  assert.equal(existsSync(ctx.recordPath), false);
  assert.equal(existsSync(ctx.binDir), false);
  assert.equal(existsSync(ctx.harvHome), false);
  assert.deepEqual(result.removedDirs, [ctx.binDir, ctx.harvHome]);
});

test("uninstall leaves a HARV_HOME that holds anything else alone", () => {
  const ctx = shimSandbox();
  installShim(ctx, "none");
  mkdirSync(join(ctx.harvHome, "store"), { recursive: true });

  uninstallShim(ctx);

  assert.equal(existsSync(join(ctx.harvHome, "store")), true);
  assert.equal(existsSync(ctx.binDir), false);
});

test("uninstall scrubs the PATH entry from every startup file, not just the current shell's", () => {
  const ctx = shimSandbox({ shell: "/bin/zsh" });
  installShim(ctx);
  // The shell changed after installing; the stale block must still go.
  const bashrc = join(ctx.home, ".bashrc");
  writeFileSync(bashrc, withBlock("# bash\n", `export PATH="${ctx.binDir}:$PATH"`));

  const result = uninstallShim({ ...ctx, shell: "/bin/fish" });

  assert.deepEqual(result.cleanedFiles.sort(), [bashrc, join(ctx.home, ".zshrc")].sort());
  assert.equal(readFileSync(bashrc, "utf8"), "# bash\n");
});

test("uninstall with nothing installed is a no-op, not an error", () => {
  const ctx = shimSandbox();

  const result = uninstallShim(ctx);

  assert.deepEqual(result, { removedShim: false, cleanedFiles: [], removedDirs: [], realClaude: null });
});

test("uninstall run twice is a no-op the second time", () => {
  const ctx = shimSandbox();
  installShim(ctx);
  uninstallShim(ctx);

  const second = uninstallShim(ctx);

  assert.equal(second.removedShim, false);
  assert.deepEqual(second.cleanedFiles, []);
});

test("uninstall refuses to remove a claude harv has no record of creating", () => {
  const ctx = shimSandbox();
  installShim(ctx, "none");
  rmSync(ctx.recordPath);

  assert.throws(
    () => uninstallShim(ctx),
    (err: Error) => err instanceof ShimError && /no record of creating it/.test(err.message),
  );
  assert.equal(existsSync(ctx.shimPath), true, "the file it will not claim is the file it does not touch");
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("status reports an uninstalled shim, and what claude runs instead", () => {
  const real = claudeDir("real");
  const ctx = shimSandbox({ path: real });

  const status = shimStatus(ctx);

  assert.equal(status.installed, false);
  assert.equal(status.active, false);
  assert.equal(status.resolvedClaude, join(real, "claude"));
  assert.equal(status.realClaude, join(real, "claude"));
});

test("status reports an installed and active shim, and the real claude behind it", () => {
  const real = claudeDir("real");
  const ctx = shimSandbox();
  installShim({ ...ctx, path: `${ctx.binDir}:${real}` }, "none");

  const status = shimStatus({ ...ctx, path: `${ctx.binDir}:${real}` });

  assert.equal(status.installed, true);
  assert.equal(status.active, true);
  assert.equal(status.onPath, true);
  assert.equal(status.resolvedClaude, ctx.shimPath);
  assert.equal(status.realClaude, join(real, "claude"));
});

test("status does not call a shim active when the shell has not picked up the PATH entry", () => {
  const real = claudeDir("real");
  const ctx = shimSandbox({ path: real });
  installShim(ctx, "none");

  const status = shimStatus(ctx);

  assert.equal(status.installed, true);
  assert.equal(status.onPath, false);
  assert.equal(status.active, false);
  assert.equal(status.resolvedClaude, join(real, "claude"));
});

test("status does not call a shim active when something on PATH shadows it", () => {
  const real = claudeDir("real");
  const ctx = shimSandbox();
  const path = `${real}:${ctx.binDir}`;
  installShim({ ...ctx, path }, "none");

  const status = shimStatus({ ...ctx, path });

  assert.equal(status.installed, true);
  assert.equal(status.onPath, true, "it is on PATH");
  assert.equal(status.active, false, "but not what `claude` reaches");
  assert.equal(status.resolvedClaude, join(real, "claude"));
});

test("status flags a claude sitting at the shim path that harv did not write", () => {
  const ctx = shimSandbox();
  mkdirSync(ctx.binDir, { recursive: true });
  writeFileSync(ctx.shimPath, "#!/bin/sh\n", { mode: 0o755 });

  const status = shimStatus(ctx);

  assert.equal(status.foreign, true);
  assert.equal(status.installed, false);
});

test("status reads back the harv the installed shim will actually run", () => {
  const harvDir = tempDir();
  const harvPath = fakeExecutable(harvDir, "harv", "harv");
  const ctx = shimSandbox({ harvCommand: [harvPath, join(harvDir, "entry.ts")] });
  writeFileSync(join(harvDir, "entry.ts"), "");
  installShim(ctx, "none");

  const status = shimStatus(ctx);

  assert.deepEqual(status.harvCommand, [harvPath, join(harvDir, "entry.ts")]);
  assert.equal(status.harvReachable, true);
});

test("status says so when the shim points at a harv that is no longer there", () => {
  const harvDir = tempDir();
  const harvPath = fakeExecutable(harvDir, "harv", "harv");
  const ctx = shimSandbox({ harvCommand: [harvPath] });
  installShim(ctx, "none");
  rmSync(harvPath);

  const status = shimStatus(ctx);

  assert.deepEqual(status.harvCommand, [harvPath]);
  assert.equal(status.harvReachable, false, "a shim routing nowhere is not a working shim");
});

test("status reads back a harv path with a space or a quote in it", () => {
  const harvDir = join(tempDir(), "some dir's harv");
  const harvPath = fakeExecutable(harvDir, "harv", "harv");
  const ctx = shimSandbox({ harvCommand: [harvPath] });
  installShim(ctx, "none");

  assert.deepEqual(shimStatus(ctx).harvCommand, [harvPath]);
});

test("status reports which startup files carry the PATH entry", () => {
  const ctx = shimSandbox();
  installShim(ctx);

  const status = shimStatus(ctx);

  assert.deepEqual(
    status.startupFiles.filter((f) => f.blockPresent).map((f) => f.path),
    [join(ctx.home, ".zshrc")],
  );
});

// ---------------------------------------------------------------------------
// Startup-file editing, in isolation
// ---------------------------------------------------------------------------

test("withBlock then withoutBlock is the identity on a file that ends in a newline", () => {
  for (const content of ["", "a\n", "a\nb\n", "\n", "# x\n\n\n"]) {
    assert.equal(withoutBlock(withBlock(content, "export PATH=x")), content, JSON.stringify(content));
  }
});

test("withBlock on a file with no final newline adds exactly one, and no more", () => {
  const restored = withoutBlock(withBlock("export EDITOR=vim", "export PATH=x"));

  assert.equal(restored, "export EDITOR=vim\n");
});

test("withoutBlock leaves a file harv never wrote to alone", () => {
  const content = "# nothing of harv's here\nexport PATH=/usr/bin\n";

  assert.equal(withoutBlock(content), content);
});

// ---------------------------------------------------------------------------
// Recording how to re-invoke harv
// ---------------------------------------------------------------------------

test("detectHarvCommand records runtime and entry script when harv runs as a script", () => {
  const entry = join(process.cwd(), "bin", "harv.ts");

  assert.deepEqual(detectHarvCommand(process.execPath, entry), [process.execPath, entry]);
});

test("detectHarvCommand records one element when harv is the executable itself", () => {
  assert.deepEqual(detectHarvCommand(process.execPath, process.execPath), [process.execPath]);
});

test("detectHarvCommand ignores an entry that is not on disk", () => {
  assert.deepEqual(detectHarvCommand(process.execPath, "/nope/harv.ts"), [process.execPath]);
});

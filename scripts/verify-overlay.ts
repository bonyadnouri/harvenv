#!/usr/bin/env bun
/**
 * Overlay verification.
 *
 * The unit tests pin what harv composes; this script pins what the composition
 * does to a real Claude Code session started by a real `harv claude`. It is the
 * acceptance criteria of issue #5, executed rather than asserted:
 *
 *   1. A staple declared once in the global Overlay file is loaded by sessions
 *      in two different harvenv projects.
 *   2. A project's own extras file adds a Component, and a disable entry takes a
 *      staple out of that project while leaving it in the other one.
 *   3. An Overlay value for a key the Manifest binds is rejected at Sync with a
 *      warning naming the key — and the session runs the Manifest's value.
 *   4. `--no-overlay` starts a session composed from the Manifest alone.
 *
 * …and then the same four claims for a plugin staple, which is issue #29:
 *
 *   5. A plugin declared once in the global Overlay file is served in two
 *      different projects, out of one Store entry, pinned in the Overlay's own
 *      Lockfile at the marketplace commit the committed Lockfile would name.
 *   6. A project's extras file adds a plugin and disables a plugin staple, in
 *      that project only.
 *   7. An Overlay plugin whose name a Manifest `[plugins]` entry already pins is
 *      rejected at Sync naming the entry — and the session loads the Manifest's
 *      plugin, not the personal one.
 *   8. `--no-overlay` serves no Overlay plugin at all.
 *
 * The last three of those are claims about *which* plugin, so the fixture
 * publishes one name from two marketplaces whose plugins carry differently-named
 * skills: `<plugin>:<skill>` in `init.skills` then says which tree won, rather
 * than only that something loaded.
 *
 * What the session loaded comes from the `system`/`init` event Claude Code emits
 * under `--output-format stream-json --verbose`, as in spikes 0001 and 0002:
 * `init.skills` names every skill by the name it answers to, and `init.model` is
 * the model the session resolved. Both are direct reads with no model in the
 * loop. The one thing `init` cannot show is a personal-ergonomics key —
 * `statusLine` has no observable — so that half is read from the `--settings`
 * payload harv hands over, captured by a stand-in `claude` that records its
 * argv. The distinction is labelled in the output rather than glossed.
 *
 * Nothing here touches the machine's own Store or Overlay: `HARV_HOME` points at
 * the fixture tree, which is where the global staples file is read from too. The
 * machine's `~/.claude` is read, never written — every probe runs with
 * `--no-session-persistence`.
 *
 * Run:  bun scripts/verify-overlay.ts [--json] [--keep]
 *       node scripts/verify-overlay.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARV = join(REPO_ROOT, "bin", "harv.ts");

/**
 * Salted per process, and cleaned up on the way out.
 *
 * Every verifier used to build at one fixed path, which is why two of them
 * running at once deleted each other's fixtures mid-run (issue #22). `mkdtemp`
 * is the whole fix: this script can run beside anything, including a second
 * copy of itself.
 */
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-overlay-verify-"));
const PROBE_TIMEOUT_MS = 180_000;

/** The staple: declared once, in the global file, and expected everywhere. */
const STAPLE = "harvenv-staple";
/** Declared by one project's extras file, and expected only there. */
const EXTRA = "harvenv-extra";
/** Declared by a Manifest, so it is the thing `--no-overlay` must keep. */
const PROJECT_SKILL = "harvenv-project";

/** A plugin staple: pinned once in the global file, and expected everywhere. */
const STAPLE_PACK = "harvenv-staple-pack";
/** Pinned by one project's extras file, and expected only there. */
const EXTRA_PACK = "harvenv-extra-pack";
/** Pinned by a Manifest *and* by that project's extras. ADR 0005 decides it. */
const CONTESTED_PACK = "harvenv-contested-pack";
/** The skill inside each side of the contested pin, so the winner is legible. */
const PROJECT_SIDE = "harvenv-contested-project";
const PERSONAL_SIDE = "harvenv-contested-personal";

/** The Manifest binds this; the Overlay tries to move it and must not. */
const BOUND_MODEL = "haiku";
const BOUND_MODEL_FAMILY = /haiku/;
const OVERRIDDEN_MODEL = "opus";

/** A key ADR 0005 calls personal — refused in a Manifest, and the Overlay's job. */
const PERSONAL_KEY = "statusLine";

// ---------------------------------------------------------------------------
// Running harv, git and claude
// ---------------------------------------------------------------------------

interface InitEvent {
  claude_code_version: string;
  skills: string[];
  plugins: Array<{ name: string }>;
  model: string;
}

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runToCompletion(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<Completed> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`${command}\` timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const harv = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  runToCompletion(process.execPath, [HARV, ...args], { cwd, env });

const GIT_FIXTURE = [
  "-c", "user.name=harvenv verification",
  "-c", "user.email=verify@harvenv.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runToCompletion("git", [...GIT_FIXTURE, ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Start a session, capture its `init` event, kill it before the turn completes. */
function probeInit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<InitEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARV, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`))),
      PROBE_TIMEOUT_MS,
    );

    child.stderr.on("data", (c) => (stderr += String(c)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "system" && event.subtype === "init") {
        finish(() => resolve(event as unknown as InitEvent));
      }
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) =>
      finish(() =>
        reject(new Error(`session exited (code ${code}) before emitting init.\n${stderr.trim().slice(-800)}`)),
      ),
    );
  });
}

/** The flags a headless probe needs, passed through harv to prove pass-through works. */
const STREAM_JSON = ["-p", "probe", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];

const session = (cwd: string, env: NodeJS.ProcessEnv, harvFlags: string[] = []) =>
  probeInit(["claude", ...harvFlags, ...STREAM_JSON], cwd, env);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** Declares `PROJECT_SKILL` and binds `model`. Keeps every staple. */
  alpha: string;
  /** Declares nothing of its own — the second project the staple must reach. */
  beta: string;
  /** Adds `EXTRA` and disables `STAPLE`, through its own extras file. */
  gamma: string;
  /** A stand-in `claude` that records the argv it was handed. */
  fakeClaudeDir: string;
  fakeClaudeDump: string;
  /** The commit each fixture marketplace is at, so a pin can be checked. */
  marketplaces: { staples: string; project: string; personal: string };
  env: NodeJS.ProcessEnv;
}

const skillSource = (name: string) =>
  `---\nname: ${name}\ndescription: Fixture skill for harvenv Overlay verification. Never invoke it.\n---\n\nMarker.\n`;

const dir = (...parts: string[]) => {
  const p = join(FIXTURE_ROOT, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

/**
 * A marketplace repository publishing one plugin per `[plugin, skill]` pair.
 *
 * A real repository with a real catalogue, because a plugin staple has to take
 * the whole path a Manifest pin takes: resolve the marketplace, read where the
 * plugin sits at that commit, hash the plugin's own tree, link it under its
 * name. Two marketplaces may publish the same plugin name with a differently
 * named skill inside, which is how a session says which one it loaded.
 */
async function marketplace(name: string, packs: Array<[string, string]>): Promise<{ url: string; commit: string }> {
  const repo = dir(`marketplace-${name}`);
  await git(["init", "--quiet"], repo);

  const catalogue = {
    name,
    owner: { name: "harvenv verification" },
    plugins: packs.map(([pack]) => ({
      name: pack,
      source: `./plugins/${pack}`,
      description: `Fixture plugin ${pack} for harvenv Overlay verification.`,
    })),
  };
  writeFileSync(join(dir(`marketplace-${name}`, ".claude-plugin"), "marketplace.json"), `${JSON.stringify(catalogue, null, 2)}\n`);

  for (const [pack, skill] of packs) {
    const manifest = { name: pack, version: "1.0.0", description: `Fixture plugin ${pack}.` };
    writeFileSync(
      join(dir(`marketplace-${name}`, "plugins", pack, ".claude-plugin"), "plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeFileSync(join(dir(`marketplace-${name}`, "plugins", pack, "skills", skill), "SKILL.md"), skillSource(skill));
  }
  writeFileSync(join(repo, "README.md"), "The rest of the marketplace, which resolving a plugin must leave behind.\n");

  await git(["add", "--all"], repo);
  await git(["commit", "--quiet", "--message", `the ${name} marketplace`], repo);
  return { url: `file://${repo}`, commit: await git(["rev-parse", "HEAD"], repo) };
}

async function buildFixtures(): Promise<Fixtures> {
  // The staple comes from a real repository, so criterion 1 exercises the whole
  // path a personal skill actually takes: resolve, fetch, hash, Store, link.
  const repo = dir("staple-repo");
  await git(["init", "--quiet"], repo);
  writeFileSync(join(repo, "SKILL.md"), skillSource(STAPLE));
  await git(["add", "--all"], repo);
  await git(["commit", "--quiet", "--message", "the staple"], repo);

  const packs = await marketplace("staples", [
    [STAPLE_PACK, `${STAPLE_PACK}-skill`],
    [EXTRA_PACK, `${EXTRA_PACK}-skill`],
  ]);
  // One plugin name, two publishers: the project's, and the user's own.
  const theirs = await marketplace("project", [[CONTESTED_PACK, PROJECT_SIDE]]);
  const mine = await marketplace("personal", [[CONTESTED_PACK, PERSONAL_SIDE]]);

  const home = dir("harv-home");
  writeFileSync(
    join(home, "overlay.toml"),
    `[skills]\n${STAPLE} = { git = "file://${repo}" }\n\n` +
      `[plugins]\n${STAPLE_PACK} = { marketplace = "${packs.url}" }\n\n` +
      `[settings]\n` +
      // A key the Manifest binds. The Overlay must lose it, loudly.
      `model = "${OVERRIDDEN_MODEL}"\n` +
      // A key a Manifest may not set at all. The Overlay is where it belongs.
      `${PERSONAL_KEY} = { type = "command", command = "echo harvenv" }\n`,
  );

  const alpha = dir("alpha");
  writeFileSync(join(dir("alpha", "vendor", PROJECT_SKILL), "SKILL.md"), skillSource(PROJECT_SKILL));
  writeFileSync(
    join(alpha, "harvenv.toml"),
    `[skills]\n${PROJECT_SKILL} = { path = "vendor/${PROJECT_SKILL}" }\n\n` +
      `[plugins]\n${CONTESTED_PACK} = { marketplace = "${theirs.url}" }\n\n` +
      `[settings]\nmodel = "${BOUND_MODEL}"\n`,
  );
  // The contested pin, kept local to this project so the others stay clean.
  writeFileSync(
    join(alpha, "harvenv.local.toml"),
    `[plugins]\n${CONTESTED_PACK} = { marketplace = "${mine.url}" }\n`,
  );

  const beta = dir("beta");
  writeFileSync(join(beta, "harvenv.toml"), "[settings]\n");

  const gamma = dir("gamma");
  writeFileSync(join(gamma, "harvenv.toml"), "[settings]\n");
  writeFileSync(join(dir("gamma", "vendor", EXTRA), "SKILL.md"), skillSource(EXTRA));
  writeFileSync(
    join(gamma, "harvenv.local.toml"),
    `[skills]\n${EXTRA} = { path = "vendor/${EXTRA}" }\n${STAPLE} = { disable = true }\n\n` +
      `[plugins]\n${EXTRA_PACK} = { marketplace = "${packs.url}" }\n${STAPLE_PACK} = { disable = true }\n`,
  );

  const fakeClaudeDir = dir("fake-bin");
  const fakeClaudeDump = join(FIXTURE_ROOT, "handover.json");
  writeFileSync(
    join(fakeClaudeDir, "claude"),
    `#!/usr/bin/env node\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(fakeClaudeDump)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd()\n` +
      `}));\n`,
    { mode: 0o755 },
  );

  return {
    alpha,
    beta,
    gamma,
    fakeClaudeDir,
    fakeClaudeDump,
    marketplaces: { staples: packs.commit, project: theirs.commit, personal: mine.commit },
    // HARV_HOME is both the Store and where the global staples file is read
    // from, so redirecting it keeps the whole run off the real machine's.
    env: { ...process.env, HARV_HOME: home },
  };
}

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

type Outcome = boolean | null;

interface Expectation {
  label: string;
  ok: Outcome;
  detail: string;
}

interface Check {
  id: string;
  title: string;
  expectations: Expectation[];
  measurements: Record<string, unknown>;
  error?: string;
}

const expect = (label: string, ok: Outcome, detail: string): Expectation => ({ label, ok, detail });

const summarize = (names: string[], limit = 8): string =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} … and ${names.length - limit} more`;

/** What `--settings` was handed on the last recorded handover. */
function handedOverSettings(dump: string): Record<string, unknown> {
  const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
  return JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}");
}

/**
 * What the project's Overlay Lockfile pins for one entry, by table.
 *
 * Split on the array-of-tables header rather than searched whole, because the
 * file now carries two tables and a plugin's name is a prefix of nothing by
 * accident: `harvenv-staple` and `harvenv-staple-pack` must not read as each
 * other.
 */
function lockedEntry(root: string, table: "skills" | "plugins", name: string): { commit: string; hash: string } {
  const lock = join(root, ".harv", "overlay.lock");
  if (!existsSync(lock)) return { commit: "", hash: "" };
  const block =
    readFileSync(lock, "utf8")
      .split(/^\[\[/m)
      .find((chunk) => chunk.startsWith(`${table}]]`) && chunk.includes(`name = "${name}"`)) ?? "";
  return {
    commit: /commit = "([0-9a-f]{40})"/.exec(block)?.[1] ?? "",
    hash: /hash = "(sha256:[0-9a-f]{64})"/.exec(block)?.[1] ?? "",
  };
}

/** The content hash the project's Overlay Lockfile pins for one staple skill. */
const lockedHash = (root: string, name: string): string => lockedEntry(root, "skills", name).hash;

/** Every plugin directory `harv claude` handed to `--plugin-dir`, by name. */
function servedPlugins(dump: string): string[] {
  const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
  return argv
    .map((arg, at) => (argv[at - 1] === "--plugin-dir" ? basename(arg) : null))
    .filter((name): name is string => name !== null);
}

/** Run `harv claude` against the stand-in, so the payload can be read back. */
const handover = (fx: Fixtures, cwd: string, flags: string[] = []) =>
  harv(["claude", ...flags], cwd, {
    ...fx.env,
    PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}`,
  });

// ---------------------------------------------------------------------------
// Criterion 1 — one staples file, two projects
// ---------------------------------------------------------------------------

async function checkStaplesEverywhere(fx: Fixtures): Promise<Check> {
  const syncedAlpha = await harv(["sync"], fx.alpha, fx.env);
  const syncedBeta = await harv(["sync"], fx.beta, fx.env);

  const alpha = await session(fx.alpha, fx.env);
  const beta = await session(fx.beta, fx.env);

  // One declaration, one set of bytes: both projects must land on the same
  // Store address, which is the Store's promise (ADR 0010) rather than an
  // accident of two fetches happening to agree.
  const alphaHash = lockedHash(fx.alpha, STAPLE);
  const betaHash = lockedHash(fx.beta, STAPLE);

  return {
    id: "staples-everywhere",
    title: "A staple declared once in the global Overlay reaches two different projects",
    measurements: {
      claudeCodeVersion: alpha.claude_code_version,
      alphaSkills: alpha.skills,
      betaSkills: beta.skills,
      alphaSync: syncedAlpha.stdout.trim(),
      betaSync: syncedBeta.stdout.trim(),
      stapleHash: alphaHash,
    },
    expectations: [
      expect(
        `the first project's session loads \`${STAPLE}\``,
        alpha.skills.includes(STAPLE),
        `skills: ${summarize(alpha.skills)}`,
      ),
      expect(
        `the second project's session loads it too, declaring nothing itself`,
        beta.skills.includes(STAPLE),
        `${fx.beta}/harvenv.toml declares no skills; skills: ${summarize(beta.skills)}`,
      ),
      expect(
        "both projects resolve it to the same Store entry, so it is stored once",
        alphaHash !== "" && alphaHash === betaHash,
        `both pin ${alphaHash || "(nothing)"}; the Store address is the content, so this is one directory`,
      ),
      expect(
        "the second Sync does contact the remote — an Overlay carries no shared pin",
        null,
        `${syncedBeta.stdout.trim()} — the committed Lockfile is what lets a second machine skip the network, ` +
          `and an Overlay deliberately has none (ADR 0013). Each project asks what its staple's ref means the ` +
          `first time it meets it; the bytes are then deduplicated by the Store rather than by the fetch.`,
      ),
      expect(
        "the staple is pinned outside the committed Lockfile",
        !readFileSync(join(fx.alpha, "harvenv.lock"), "utf8").includes(STAPLE) &&
          readFileSync(join(fx.alpha, ".harv", "overlay.lock"), "utf8").includes(STAPLE),
        `harvenv.lock does not mention it; .harv/overlay.lock does`,
      ),
      expect(
        "the project's own Component is still loaded alongside it",
        alpha.skills.includes(PROJECT_SKILL),
        `skills: ${summarize(alpha.skills)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — extras add, and a disable subtracts, in one project only
// ---------------------------------------------------------------------------

async function checkProjectExtras(fx: Fixtures): Promise<Check> {
  const synced = await harv(["sync"], fx.gamma, fx.env);
  const gamma = await session(fx.gamma, fx.env);
  // Re-read the project that declares no extras, to show the staple survived
  // there — "in that project only" is a claim about two projects, not one.
  const alpha = await session(fx.alpha, fx.env);

  return {
    id: "project-extras",
    title: "Project-local extras add Components, and a disable removes a staple in that project only",
    measurements: { gammaSkills: gamma.skills, alphaSkills: alpha.skills, gammaSync: synced.stdout.trim() },
    expectations: [
      expect(
        `the extras file's \`${EXTRA}\` is loaded`,
        gamma.skills.includes(EXTRA),
        `skills: ${summarize(gamma.skills)}`,
      ),
      expect(
        `the disabled \`${STAPLE}\` is absent from this project's session`,
        !gamma.skills.includes(STAPLE),
        `skills: ${summarize(gamma.skills)}`,
      ),
      expect(
        "and absent from its project scope on disk, not merely from the session",
        !existsSync(join(fx.gamma, ".claude", "skills", STAPLE)),
        `${join(fx.gamma, ".claude", "skills", STAPLE)} does not exist`,
      ),
      expect(
        "while the other project still loads it",
        alpha.skills.includes(STAPLE),
        `skills: ${summarize(alpha.skills)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — the Manifest binds; the Overlay is told so
// ---------------------------------------------------------------------------

async function checkBindingWins(fx: Fixtures): Promise<Check> {
  const synced = await harv(["sync"], fx.alpha, fx.env);
  const alpha = await session(fx.alpha, fx.env);

  await handover(fx, fx.alpha);
  const injected = handedOverSettings(fx.fakeClaudeDump);
  const warning = synced.stderr;

  return {
    id: "binding-wins",
    title: "An Overlay value for a Manifest-bound key is rejected at Sync, and the session runs the Manifest's",
    measurements: {
      syncStderr: warning.trim(),
      resolvedModel: alpha.model,
      injectedSettings: injected,
    },
    expectations: [
      expect(
        "`harv sync` warns rather than passing it on in silence",
        /warning/i.test(warning),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "the warning names the locked key",
        /\bmodel\b/.test(warning),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "and names the rule, so the reason is findable",
        /ADR 0005/.test(warning),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "the Sync still succeeds — a personal file cannot fail a project",
        synced.code === 0,
        `exit ${synced.code}`,
      ),
      expect(
        `the session resolves the Manifest's model, not the Overlay's`,
        BOUND_MODEL_FAMILY.test(alpha.model),
        `init.model = ${alpha.model} (Manifest said ${BOUND_MODEL}, Overlay said ${OVERRIDDEN_MODEL})`,
      ),
      expect(
        `the Overlay's own \`${PERSONAL_KEY}\` does reach the payload — the remedy is real`,
        Object.hasOwn(injected, PERSONAL_KEY),
        `--settings carried: ${Object.keys(injected).join(", ")}. ` +
          `A Manifest declaring ${PERSONAL_KEY} is refused; an Overlay is not.`,
      ),
      expect(
        "no observable for a resolved statusLine exists, so this half is read from the payload",
        null,
        "`init` reports model and permissionMode but nothing about statusLine (spike 0002, finding 2's shape)",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — --no-overlay is the Manifest, alone
// ---------------------------------------------------------------------------

async function checkNoOverlay(fx: Fixtures): Promise<Check> {
  const bare = await session(fx.alpha, fx.env, ["--no-overlay"]);

  await handover(fx, fx.alpha, ["--no-overlay"]);
  const injected = handedOverSettings(fx.fakeClaudeDump);

  // And back again, so the flag is shown to be per-invocation rather than a
  // state change: the next ordinary launch has the Overlay again.
  const restored = await session(fx.alpha, fx.env);

  return {
    id: "no-overlay",
    title: "`--no-overlay` starts a session composed from the Manifest alone",
    measurements: { bareSkills: bare.skills, injectedSettings: injected, restoredSkills: restored.skills },
    expectations: [
      expect(
        `the Manifest's \`${PROJECT_SKILL}\` is still loaded`,
        bare.skills.includes(PROJECT_SKILL),
        `skills: ${summarize(bare.skills)}`,
      ),
      expect(
        `the Overlay's \`${STAPLE}\` is not`,
        !bare.skills.includes(STAPLE),
        `skills: ${summarize(bare.skills)}`,
      ),
      expect(
        `and no Overlay setting reaches the payload`,
        !Object.hasOwn(injected, PERSONAL_KEY),
        `--settings carried: ${Object.keys(injected).join(", ")}`,
      ),
      expect(
        "the probe's own arguments still arrive, so the flag was taken out and nothing else was",
        bare.claude_code_version.length > 0,
        `the session started under ${STREAM_JSON.join(" ")} and emitted init`,
      ),
      expect(
        "the next launch without the flag has the Overlay back",
        restored.skills.includes(STAPLE),
        `skills: ${summarize(restored.skills)}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 5 — a plugin staple, in two projects, pinned like a Manifest's
// ---------------------------------------------------------------------------

const pluginNames = (init: InitEvent): string[] => (init.plugins ?? []).map((plugin) => plugin.name);

/** The skill a fixture plugin carries, under the prefix a plugin gives it. */
const carried = (pack: string, skill: string): string => `${pack}:${skill}`;

async function checkPluginStaples(fx: Fixtures): Promise<Check> {
  await harv(["sync"], fx.alpha, fx.env);
  await harv(["sync"], fx.beta, fx.env);

  const alpha = await session(fx.alpha, fx.env);
  const beta = await session(fx.beta, fx.env);

  const alphaPin = lockedEntry(fx.alpha, "plugins", STAPLE_PACK);
  const betaPin = lockedEntry(fx.beta, "plugins", STAPLE_PACK);
  const committed = readFileSync(join(fx.alpha, "harvenv.lock"), "utf8");

  return {
    id: "plugin-staples-everywhere",
    title: "A plugin declared once in the global Overlay is served in two different projects",
    measurements: {
      alphaPlugins: pluginNames(alpha),
      betaPlugins: pluginNames(beta),
      alphaPin,
      betaPin,
      marketplaceCommit: fx.marketplaces.staples,
    },
    expectations: [
      expect(
        `the first project's session loads \`${STAPLE_PACK}\``,
        pluginNames(alpha).includes(STAPLE_PACK),
        `plugins: ${summarize(pluginNames(alpha))}`,
      ),
      expect(
        "the second project's session loads it too, pinning nothing itself",
        pluginNames(beta).includes(STAPLE_PACK),
        `${fx.beta}/harvenv.toml declares no plugins; plugins: ${summarize(pluginNames(beta))}`,
      ),
      expect(
        "and what it carries is invocable, under the plugin's own name",
        beta.skills.includes(carried(STAPLE_PACK, `${STAPLE_PACK}-skill`)),
        `skills: ${summarize(beta.skills)}`,
      ),
      expect(
        "the Overlay Lockfile pins the marketplace commit, exactly as the committed one does",
        alphaPin.commit === fx.marketplaces.staples && alphaPin.commit === betaPin.commit,
        `both pin commit ${alphaPin.commit || "(nothing)"}; the marketplace is at ${fx.marketplaces.staples}`,
      ),
      expect(
        "beside a hash of the plugin's own tree, so both projects share one Store entry",
        alphaPin.hash !== "" && alphaPin.hash === betaPin.hash,
        `both pin ${alphaPin.hash || "(nothing)"} — the Store address is the content, so this is one directory`,
      ),
      expect(
        "and none of it reaches the file the repository hands over",
        !committed.includes(STAPLE_PACK),
        `harvenv.lock does not mention it; .harv/overlay.lock does`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 6 — extras add a plugin, and a disable takes one out, here only
// ---------------------------------------------------------------------------

async function checkPluginExtras(fx: Fixtures): Promise<Check> {
  await harv(["sync"], fx.gamma, fx.env);
  const gamma = await session(fx.gamma, fx.env);
  // Re-read the project that declares no extras: "in that project only" is a
  // claim about two projects, not one.
  const alpha = await session(fx.alpha, fx.env);
  const link = join(fx.gamma, ".claude", "harv-plugins", STAPLE_PACK);

  return {
    id: "plugin-project-extras",
    title: "Project-local extras pin a plugin, and a disable removes a plugin staple in that project only",
    measurements: { gammaPlugins: pluginNames(gamma), alphaPlugins: pluginNames(alpha), gammaSkills: gamma.skills },
    expectations: [
      expect(
        `the extras file's \`${EXTRA_PACK}\` is served`,
        pluginNames(gamma).includes(EXTRA_PACK),
        `plugins: ${summarize(pluginNames(gamma))}`,
      ),
      expect(
        "and what it carries is invocable here",
        gamma.skills.includes(carried(EXTRA_PACK, `${EXTRA_PACK}-skill`)),
        `skills: ${summarize(gamma.skills)}`,
      ),
      expect(
        `the disabled \`${STAPLE_PACK}\` is absent from this project's session`,
        !pluginNames(gamma).includes(STAPLE_PACK),
        `plugins: ${summarize(pluginNames(gamma))}`,
      ),
      expect(
        "and absent from the directory harv serves plugins out of, not merely from the session",
        !existsSync(link),
        `${link} does not exist`,
      ),
      expect(
        "while the other project still has it",
        pluginNames(alpha).includes(STAPLE_PACK),
        `plugins: ${summarize(pluginNames(alpha))}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 7 — a Manifest `[plugins]` entry outranks an Overlay pin
// ---------------------------------------------------------------------------

async function checkPluginBindingWins(fx: Fixtures): Promise<Check> {
  const synced = await harv(["sync"], fx.alpha, fx.env);
  const alpha = await session(fx.alpha, fx.env);
  const warning = synced.stderr;
  const overlayPin = lockedEntry(fx.alpha, "plugins", CONTESTED_PACK);
  const committed = readFileSync(join(fx.alpha, "harvenv.lock"), "utf8");

  return {
    id: "plugin-manifest-wins",
    title: "An Overlay plugin whose name the Manifest pins is rejected at Sync, and the Manifest's is what loads",
    measurements: {
      syncStderr: warning.trim(),
      plugins: pluginNames(alpha),
      skills: alpha.skills.filter((skill) => skill.startsWith(`${CONTESTED_PACK}:`)),
      overlayPin,
    },
    expectations: [
      expect(
        "`harv sync` warns rather than passing it on in silence",
        /warning/i.test(warning) && warning.includes(CONTESTED_PACK),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "the warning names the entry, and the rule that decided it",
        new RegExp(`\`${CONTESTED_PACK}\``).test(warning) && /ADR 0005/.test(warning),
        warning.trim() || "(nothing on stderr)",
      ),
      expect(
        "the Sync still succeeds — a personal file cannot fail a project",
        synced.code === 0,
        `exit ${synced.code}`,
      ),
      expect(
        "the session loads the Manifest's plugin, by the skill only that marketplace publishes",
        alpha.skills.includes(carried(CONTESTED_PACK, PROJECT_SIDE)),
        `skills: ${summarize(alpha.skills.filter((skill) => skill.startsWith(`${CONTESTED_PACK}:`)))}`,
      ),
      expect(
        "and not the Overlay's, which publishes a different skill under the same plugin name",
        !alpha.skills.includes(carried(CONTESTED_PACK, PERSONAL_SIDE)),
        `\`${PERSONAL_SIDE}\` is absent from the session`,
      ),
      expect(
        "the rejected pin is not in the Overlay Lockfile either — it was dropped, not merely outranked at launch",
        overlayPin.commit === "" && committed.includes(fx.marketplaces.project),
        `.harv/overlay.lock holds no ${CONTESTED_PACK}; harvenv.lock pins ${fx.marketplaces.project}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 8 — --no-overlay serves no Overlay plugin
// ---------------------------------------------------------------------------

async function checkNoOverlayPlugins(fx: Fixtures): Promise<Check> {
  const bare = await session(fx.alpha, fx.env, ["--no-overlay"]);
  await handover(fx, fx.alpha, ["--no-overlay"]);
  const served = servedPlugins(fx.fakeClaudeDump);

  await handover(fx, fx.alpha);
  const restored = servedPlugins(fx.fakeClaudeDump);

  return {
    id: "no-overlay-plugins",
    title: "`--no-overlay` serves the Manifest's plugins and none of the Overlay's",
    measurements: { barePlugins: pluginNames(bare), served, restored },
    expectations: [
      expect(
        `the Manifest's \`${CONTESTED_PACK}\` is still served`,
        pluginNames(bare).includes(CONTESTED_PACK),
        `plugins: ${summarize(pluginNames(bare))}`,
      ),
      expect(
        `the Overlay's \`${STAPLE_PACK}\` is not`,
        !pluginNames(bare).includes(STAPLE_PACK),
        `plugins: ${summarize(pluginNames(bare))}`,
      ),
      expect(
        "and harv handed `--plugin-dir` nothing but the Manifest's own",
        served.length === 1 && served[0] === CONTESTED_PACK,
        `--plugin-dir carried: ${served.join(", ") || "(nothing)"}`,
      ),
      expect(
        "the next launch without the flag has the Overlay's plugin back",
        restored.includes(STAPLE_PACK),
        `--plugin-dir carried: ${restored.join(", ") || "(nothing)"}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const failed = (c: Check) => Boolean(c.error) || c.expectations.some((e) => e.ok === false);

function report(checks: Check[]): void {
  for (const check of checks) {
    console.log(`\n[${failed(check) ? `${RED}FAIL${RESET}` : `${GREEN}PASS${RESET}`}] ${check.id} — ${check.title}`);
    if (check.error) {
      console.log(`  ${RED}x${RESET} ${check.error}`);
      continue;
    }
    for (const e of check.expectations) {
      const glyph = e.ok === true ? `${GREEN}ok${RESET}` : e.ok === false ? `${RED}x ${RESET}` : `${YELLOW}n/a${RESET}`;
      console.log(`  ${glyph} ${e.label}`);
      console.log(`      ${DIM}${e.detail}${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const asJson = process.argv.includes("--json");
  const keep = process.argv.includes("--keep");
  const log = asJson ? () => {} : console.log;

  const fx = await buildFixtures();
  log("harvenv Overlay verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);

  // Ordered, and deliberately so: criterion 2 reads the project criterion 1
  // synced, which is what makes "in that project only" a comparison rather
  // than an assertion about one tree.
  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["staples-everywhere", "A staple declared once reaches two different projects", () => checkStaplesEverywhere(fx)],
    ["project-extras", "Extras add a Component; a disable removes a staple in that project only", () => checkProjectExtras(fx)],
    ["binding-wins", "An Overlay override of a Manifest-bound key is rejected, naming the key", () => checkBindingWins(fx)],
    ["no-overlay", "`--no-overlay` launches a Manifest-only session", () => checkNoOverlay(fx)],
    ["plugin-staples-everywhere", "A plugin staple reaches two different projects, pinned in the Overlay's Lockfile", () => checkPluginStaples(fx)],
    ["plugin-project-extras", "Extras pin a plugin; a disable removes a plugin staple in that project only", () => checkPluginExtras(fx)],
    ["plugin-manifest-wins", "An Overlay plugin the Manifest already pins is rejected, naming the entry", () => checkPluginBindingWins(fx)],
    ["no-overlay-plugins", "`--no-overlay` serves no Overlay plugin", () => checkNoOverlayPlugins(fx)],
  ];

  const checks: Check[] = [];
  for (const [id, title, run] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ id, title, expectations: [], measurements: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (keep) log(`\n${DIM}fixtures kept at ${FIXTURE_ROOT}${RESET}`);
  else rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const version = (checks[0]?.measurements as { claudeCodeVersion?: string })?.claudeCodeVersion ?? "unknown";
  const failures = checks.filter(failed);

  if (asJson) {
    console.log(JSON.stringify({ claudeCodeVersion: version, ok: failures.length === 0, fixtures: keep ? FIXTURE_ROOT : null, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\nClaude Code ${version}: ${checks.length - failures.length}/${checks.length} criteria verified` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

if (!existsSync(HARV)) throw new Error(`harv entry point not found at ${HARV}`);
process.exitCode = await main();

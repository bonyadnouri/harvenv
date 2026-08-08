#!/usr/bin/env bun
/**
 * Import wizard verification.
 *
 * The unit tests pin what the wizard decides; this script pins what a real
 * `harv init --import` does to a real machine's user scope — and, crucially,
 * whether what it wrote is a Harvenv that actually syncs and launches. It is
 * the acceptance criteria of issue #10, executed rather than asserted:
 *
 *   1. The wizard inventories user-scope skills, plugins and MCP servers, and
 *      groups them so a person can answer a group at a time.
 *   2. Selections land in the Manifest or the global Overlay as chosen, with
 *      the Sources that were derivable — proved by syncing what it wrote and
 *      launching a session from it.
 *   3. A Component that exists only on this machine is flagged, with the push
 *      it needs spelled out (ADR 0004's consequence).
 *   4. Re-running changes nothing: no duplicate entries, no second question.
 *   5. The same run driven through a pseudo-terminal — because the wizard's
 *      users are people at a prompt, and a pipe is not a terminal.
 *
 * ## Nothing here touches the real machine
 *
 * Every run has `HOME` and `HARV_HOME` pointed at the fixture tree, so the
 * user scope being read is the fixture's and the global Overlay being written
 * is the fixture's. The real `~/.claude` is never read and never written; the
 * real `~/.harv/overlay.toml` is never opened. That is not merely hygiene
 * here — a wizard that writes to a global staples file is exactly the kind of
 * thing a verification run must not be allowed to do to the machine it runs on.
 *
 * The remotes are `file://` repositories built in the fixture tree, so the
 * whole script runs with no network.
 *
 * Run:  bun scripts/verify-import.ts [--json] [--keep]
 *       node scripts/verify-import.ts [--json] [--keep]   (Node >= 22.18)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const FIXTURE_ROOT = mkdtempSync(join(realpathSync(tmpdir()), "harvenv-import-verify-"));
const TIMEOUT_MS = 120_000;

/** In a git repository with a remote, so a coordinate is derivable. */
const PORTABLE_SKILL = "team-style";
/** A directory and nothing else — ADR 0004's non-portable case. */
const LOCAL_SKILL = "house-style";
/** In a marketplace that is a real repository, so the pin can be synced. */
const PLUGIN = "fixture-plugin";
/** From a marketplace named the way Claude Code names GitHub ones. */
const GITHUB_PLUGIN = "superpowers";
/** Enabled = false in the user scope. Importing it would reverse a decision. */
const RETIRED_PLUGIN = "retired";
/** A global MCP server whose definition holds a credential in the clear. */
const GLOBAL_SERVER = "tickets";
const SECRET = "sk-live-do-not-commit-me";
const SECRET_VARIABLE = "TICKETS_X_API_KEY";
/** A server the user scope records against this project only. */
const PROJECT_SERVER = "here";
/** A server the user scope records against a different project. */
const OTHER_SERVER = "not-ours";

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

interface Completed {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runToCompletion(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string },
): Promise<Completed> {
  return new Promise((resolve, reject) => {
    // stdin is always a pipe, and always closed: a command given no answers
    // must reach the end of its input rather than wait for a terminal that is
    // not there.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`${command} ${args.join(" ")}\` timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

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
    child.stdin.end(options.stdin ?? "");
  });
}

const harv = (args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin?: string) =>
  runToCompletion(process.execPath, [HARV, ...args], { cwd, env, stdin });

/** The wizard, answered from a pipe — one line per question, in order. */
const importInto = (cwd: string, env: NodeJS.ProcessEnv, answers: string[]) =>
  harv(["init", "--import"], cwd, env, `${answers.join("\n")}\n`);

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  home: string;
  /**
   * A second, identical user scope for the pseudo-terminal run.
   *
   * Independent because the global staples file is shared by every project on
   * one machine: once `alpha` has sent a staple there, a later project is
   * offered one group fewer, and the pty check would then be measuring the
   * residue of an earlier check rather than a whole run.
   */
  ptyHome: string;
  /** The project the main import runs in. */
  alpha: string;
  /** A second project, for the local-only-into-the-Manifest case. */
  beta: string;
  /** A third, for the pseudo-terminal run. */
  gamma: string;
  /** HEAD of the skills repository — what a derived coordinate should pin. */
  skillsCommit: string;
  skillsRepo: string;
  marketplaceRepo: string;
  fakeClaudeDir: string;
  fakeClaudeDump: string;
  env: NodeJS.ProcessEnv;
  ptyEnv: NodeJS.ProcessEnv;
}

const skillSource = (name: string) =>
  `---\nname: ${name}\ndescription: Fixture skill for harvenv import verification. Never invoke it.\n---\n\nMarker.\n`;

async function buildFixtures(): Promise<Fixtures> {
  const dir = (...parts: string[]) => {
    const path = join(FIXTURE_ROOT, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const file = (path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  // A repository holding a skill in a subdirectory, with a remote — the shape
  // a derivable Source is derived from.
  const skillsRepo = dir("skills-repo");
  await git(["init", "--quiet"], skillsRepo);
  file(join(skillsRepo, "packs", PORTABLE_SKILL, "SKILL.md"), skillSource(PORTABLE_SKILL));
  await git(["add", "--all"], skillsRepo);
  await git(["commit", "--quiet", "--message", "the team's skill"], skillsRepo);
  const skillsCommit = await git(["rev-parse", "HEAD"], skillsRepo);
  // `origin` is what a clone would have. A `file://` URL so the coordinate the
  // wizard derives is one `harv sync` can really fetch, with no network.
  await git(["remote", "add", "origin", `file://${skillsRepo}`], skillsRepo);

  // A marketplace, as a repository — the other half of ADR 0004's coordinates.
  const marketplaceRepo = dir("marketplace-repo");
  await git(["init", "--quiet"], marketplaceRepo);
  file(
    join(marketplaceRepo, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        owner: { name: "harvenv verification" },
        plugins: [{ name: PLUGIN, source: `./plugins/${PLUGIN}`, description: "Fixture plugin." }],
      },
      null,
      2,
    )}\n`,
  );
  file(
    join(marketplaceRepo, "plugins", PLUGIN, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: PLUGIN, version: "1.0.0", description: "Fixture plugin." }, null, 2)}\n`,
  );
  file(join(marketplaceRepo, "plugins", PLUGIN, "skills", `${PLUGIN}-skill`, "SKILL.md"), skillSource(`${PLUGIN}-skill`));
  await git(["add", "--all"], marketplaceRepo);
  await git(["commit", "--quiet", "--message", "the marketplace"], marketplaceRepo);
  const marketplaceCommit = await git(["rev-parse", "HEAD"], marketplaceRepo);

  const alpha = dir("alpha");
  const beta = dir("beta");
  const gamma = dir("gamma");

  /** The pile the wizard exists for, written as Claude Code writes it. */
  const userScope = (home: string, project: string): void => {
    const claude = join(home, ".claude");
    file(join(claude, "skills", LOCAL_SKILL, "SKILL.md"), skillSource(LOCAL_SKILL));
    mkdirSync(join(claude, "skills"), { recursive: true });
    symlinkSync(join(skillsRepo, "packs", PORTABLE_SKILL), join(claude, "skills", PORTABLE_SKILL));

    file(
      join(claude, "settings.json"),
      `${JSON.stringify(
        {
          enabledPlugins: {
            [`${PLUGIN}@fixture`]: true,
            [`${GITHUB_PLUGIN}@official`]: true,
            [`${RETIRED_PLUGIN}@fixture`]: false,
          },
        },
        null,
        2,
      )}\n`,
    );
    file(
      join(claude, "plugins", "known_marketplaces.json"),
      `${JSON.stringify(
        {
          fixture: { source: { source: "git", url: `file://${marketplaceRepo}` } },
          official: { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
        },
        null,
        2,
      )}\n`,
    );
    file(
      join(claude, "plugins", "installed_plugins.json"),
      `${JSON.stringify(
        {
          version: 2,
          plugins: {
            [`${PLUGIN}@fixture`]: [{ scope: "user", version: "1.0.0", gitCommitSha: marketplaceCommit }],
            [`${GITHUB_PLUGIN}@official`]: [{ scope: "user", version: "6.2.0", gitCommitSha: "c".repeat(40) }],
          },
        },
        null,
        2,
      )}\n`,
    );

    // MCP servers live beside the directory, not in it, and are keyed by project.
    file(
      join(home, ".claude.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            [GLOBAL_SERVER]: { type: "http", url: "https://tickets.invalid/mcp", headers: { "X-Api-Key": SECRET } },
          },
          projects: {
            [project]: { mcpServers: { [PROJECT_SERVER]: { command: "/bin/echo", args: ["serving"] } } },
            "/somewhere/else/entirely": { mcpServers: { [OTHER_SERVER]: { command: "/bin/false" } } },
          },
        },
        null,
        2,
      )}\n`,
    );
  };

  const home = dir("home");
  userScope(home, alpha);
  const ptyHome = dir("home-pty");
  userScope(ptyHome, gamma);

  const fakeClaudeDir = dir("fake-bin");
  const fakeClaudeDump = join(FIXTURE_ROOT, "handover.json");
  file(
    join(fakeClaudeDir, "claude"),
    `#!/usr/bin/env node\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(fakeClaudeDump)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd()\n` +
      `}));\n`,
  );
  await runToCompletion("chmod", ["+x", join(fakeClaudeDir, "claude")], { cwd: FIXTURE_ROOT });

  return {
    home,
    ptyHome,
    alpha,
    beta,
    gamma,
    skillsCommit,
    skillsRepo,
    marketplaceRepo,
    fakeClaudeDir,
    fakeClaudeDump,
    // Both pointers moved: HOME is the user scope the wizard reads, HARV_HOME
    // is the Store and the global staples file it writes. Neither is the real
    // machine's.
    env: { ...process.env, HOME: home, HARV_HOME: join(home, ".harv") },
    ptyEnv: { ...process.env, HOME: ptyHome, HARV_HOME: join(ptyHome, ".harv") },
  };
}

const overlayPath = (fx: Fixtures): string => join(fx.home, ".harv", "overlay.toml");
const manifestPath = (root: string): string => join(root, "harvenv.toml");
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

/**
 * The answers for `alpha`, one per group, in the order the wizard asks.
 *
 * Deliberately mixed: every destination is exercised, and the two halves of
 * criterion 2 — Manifest and Overlay — are decided in the same run rather than
 * in two runs that could each be right on their own.
 */
const ALPHA_ANSWERS = [
  "m", // skills from a git repository      -> the Manifest
  "o", // skills that exist only here       -> the Overlay
  "m", // plugins from `fixture`            -> the Manifest
  "s", // plugins from `official`           -> skipped (its marketplace is not local)
  "m", // MCP servers, everywhere           -> the Manifest
  "o", // MCP servers, this project         -> the Overlay
];

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

/** Strip the dim/reset sequences, so an assertion is about the words. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * How many entries a declaration file has for a name.
 *
 * An *entry*, not a mention: the scaffolded Manifest carries commented examples
 * that name real skills and plugins, and a `[mcp.x.headers]` header is part of
 * the same section as `[mcp.x]` rather than a second one.
 */
const declarations = (text: string, name: string): number =>
  (text.match(new RegExp(`^(${name} = |\\[mcp\\.${name}])`, "gm")) ?? []).length;

const declaresName = (text: string, name: string): boolean => declarations(text, name) > 0;

// ---------------------------------------------------------------------------
// Criterion 1 — what it found, and how it grouped it
// ---------------------------------------------------------------------------

async function checkInventory(fx: Fixtures): Promise<Check> {
  // Every group skipped: this criterion is about what the wizard *offers*, and
  // it must be answerable without writing anything.
  const run = await importInto(fx.alpha, fx.env, ["s", "s", "s", "s", "s", "s"]);
  const out = plain(run.stdout);
  const groups = out.split("\n").filter((line) => /^ {2}\S.*\(\d+\)$/.test(line.replace(/\x1b\[[0-9;]*m/g, "")));
  const offers = (name: string) => new RegExp(`^ {4}${name}\\b`, "m").test(out);

  return {
    id: "inventory",
    title: "The wizard inventories skills, plugins and MCP servers, grouped",
    measurements: { exit: run.code, groups, stdout: out },
    expectations: [
      expect(`the user scope's skills are offered`, offers(PORTABLE_SKILL) && offers(LOCAL_SKILL), `groups: ${groups.join(" | ")}`),
      expect(`the enabled plugins are offered`, offers(PLUGIN) && offers(GITHUB_PLUGIN), `groups: ${groups.join(" | ")}`),
      expect(
        `the MCP servers are offered`,
        offers(GLOBAL_SERVER) && offers(PROJECT_SERVER),
        `both the machine's own and the ones it records against this project`,
      ),
      expect(
        "the grouping separates portable skills from local-only ones",
        /skills from a git repository/.test(out) && /skills that exist only on this machine/.test(out),
        `groups: ${groups.join(" | ")}`,
      ),
      expect(
        "and separates plugins by marketplace, and global servers from this project's",
        /plugins from the `fixture` marketplace/.test(out) &&
          /plugins from the `official` marketplace/.test(out) &&
          /MCP servers this machine runs everywhere/.test(out) &&
          /MCP servers this machine runs in this project/.test(out),
        `groups: ${groups.join(" | ")}`,
      ),
      expect(
        "one question per group, not one per item",
        (out.match(/\[s\]kip/g) ?? []).length === groups.length,
        `${(out.match(/\[s\]kip/g) ?? []).length} questions for ${groups.length} groups`,
      ),
      expect(
        `a plugin switched off in settings is not offered`,
        !offers(RETIRED_PLUGIN),
        `\`${RETIRED_PLUGIN}\` is \`false\` in enabledPlugins — importing it would reverse a decision`,
      ),
      expect(
        `another project's MCP server is not offered`,
        !offers(OTHER_SERVER),
        `\`${OTHER_SERVER}\` is recorded against a different directory`,
      ),
      expect("skipping every group writes nothing", read(manifestPath(fx.alpha)).includes(PORTABLE_SKILL) === false, `harvenv.toml declares none of them`),
      expect("and leaves no global Overlay behind", !existsSync(overlayPath(fx)), overlayPath(fx)),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 2 — the selections land where they were sent, and they work
// ---------------------------------------------------------------------------

async function checkSelections(fx: Fixtures): Promise<Check> {
  const run = await importInto(fx.alpha, fx.env, ALPHA_ANSWERS);
  const manifest = read(manifestPath(fx.alpha));
  const overlay = read(overlayPath(fx));

  // The Manifest now names a variable rather than a token, so a Sync without
  // it must fail — which is the proof that the wizard's instruction is real
  // rather than decorative.
  const withoutSecret = await harv(["sync"], fx.alpha, fx.env);
  const synced = await harv(["sync"], fx.alpha, { ...fx.env, [SECRET_VARIABLE]: SECRET });

  // And the strongest statement available without credentials: the Harvenv the
  // wizard wrote composes a session.
  const launched = await harv(["claude"], fx.alpha, {
    ...fx.env,
    [SECRET_VARIABLE]: SECRET,
    PATH: `${fx.fakeClaudeDir}:${process.env.PATH ?? ""}`,
  });
  const argv = existsSync(fx.fakeClaudeDump)
    ? (JSON.parse(readFileSync(fx.fakeClaudeDump, "utf8")) as { argv: string[] }).argv
    : [];
  const mcpConfig: { mcpServers?: Record<string, Record<string, unknown>> } = JSON.parse(
    argv[argv.indexOf("--mcp-config") + 1] ?? "{}",
  );

  const linked = (name: string) => existsSync(join(fx.alpha, ".claude", "skills", name));

  return {
    id: "selections",
    title: "Selections land in the Manifest or the Overlay as chosen, with derivable Sources",
    measurements: {
      exit: run.code,
      manifest,
      overlay,
      syncWithoutSecret: withoutSecret.stderr.trim(),
      sync: synced.stdout.trim(),
      mcpConfig,
    },
    expectations: [
      expect(
        `the git-derived skill is in the Manifest as a coordinate, pinned at the commit it was on`,
        new RegExp(`^${PORTABLE_SKILL} = \\{ git = "file://${fx.skillsRepo}", ref = "${fx.skillsCommit}", subdir = "packs/${PORTABLE_SKILL}" \\}$`, "m").test(manifest),
        manifest.split("\n").find((line) => line.startsWith(PORTABLE_SKILL)) ?? "(not declared)",
      ),
      expect(
        `the plugin is in \`[plugins]\` as its marketplace coordinate`,
        new RegExp(`^${PLUGIN} = \\{ marketplace = "file://${fx.marketplaceRepo}", ref = "[0-9a-f]{40}" \\}$`, "m").test(manifest),
        manifest.split("\n").find((line) => line.startsWith(PLUGIN)) ?? "(not declared)",
      ),
      expect(
        `the global MCP server is in the Manifest as an \`[mcp.${GLOBAL_SERVER}]\` section`,
        new RegExp(`^\\[mcp\\.${GLOBAL_SERVER}]$`, "m").test(manifest),
        manifest.includes(`[mcp.${GLOBAL_SERVER}]`) ? "declared" : "(not declared)",
      ),
      expect(
        `the credential in that definition is not in the committed file`,
        !manifest.includes(SECRET) && manifest.includes(`\${${SECRET_VARIABLE}}`),
        `the Manifest carries \${${SECRET_VARIABLE}}; the value stays in ~/.claude.json`,
      ),
      expect(
        `the local-only skill went to the Overlay, and only there`,
        overlay.includes(LOCAL_SKILL) && !manifest.includes(LOCAL_SKILL),
        `${overlayPath(fx)} declares it; harvenv.toml does not`,
      ),
      expect(
        `the project's own MCP server went to the Overlay, and only there`,
        overlay.includes(`[mcp.${PROJECT_SERVER}]`) && !manifest.includes(`[mcp.${PROJECT_SERVER}]`),
        `an Overlay carries an \`[mcp]\` table; this one now does`,
      ),
      expect(
        `no plugin reached the Overlay, which cannot carry one`,
        !overlay.includes("[plugins]") && !overlay.includes(PLUGIN),
        `the wizard never offered the choice, and the file bears that out`,
      ),
      expect(
        `the skipped plugin reached neither file`,
        !declaresName(manifest, GITHUB_PLUGIN) && !declaresName(overlay, GITHUB_PLUGIN),
        `\`${GITHUB_PLUGIN}\` was answered \`s\`, and neither file declares it ` +
          `(the scaffolded Manifest's commented example names it, which is why this looks for an entry)`,
      ),
      expect(
        `a Sync without ${SECRET_VARIABLE} fails naming it — the instruction the wizard printed is real`,
        withoutSecret.code !== 0 && withoutSecret.stderr.includes(SECRET_VARIABLE),
        withoutSecret.stderr.trim().split("\n")[0] ?? "(nothing on stderr)",
      ),
      expect(
        `with it exported, \`harv sync\` resolves everything the wizard declared`,
        synced.code === 0,
        synced.stdout.trim() || synced.stderr.trim(),
      ),
      expect(
        `both skills are materialized into project scope — the Manifest's and the Overlay's`,
        linked(PORTABLE_SKILL) && linked(LOCAL_SKILL),
        `.claude/skills/ holds ${[PORTABLE_SKILL, LOCAL_SKILL].filter(linked).join(", ") || "nothing"}`,
      ),
      expect(
        `the pinned plugin is served from the Store`,
        existsSync(join(fx.alpha, ".claude", "harv-plugins", PLUGIN)),
        join(fx.alpha, ".claude", "harv-plugins", PLUGIN),
      ),
      expect(
        `a session composed from it carries both servers, with the credential resolved at launch`,
        mcpConfig.mcpServers?.[GLOBAL_SERVER] !== undefined &&
          mcpConfig.mcpServers?.[PROJECT_SERVER] !== undefined &&
          JSON.stringify(mcpConfig).includes(SECRET),
        `--mcp-config carried: ${Object.keys(mcpConfig.mcpServers ?? {}).join(", ")}`,
      ),
      expect(
        `and the launch itself succeeds`,
        launched.code === 0,
        `exit ${launched.code}${launched.stderr.trim() ? `: ${launched.stderr.trim()}` : ""}`,
      ),
      expect(
        "the user scope is untouched by all of it",
        !existsSync(join(fx.home, ".claude", "harvenv.toml")) &&
          readFileSync(join(fx.home, ".claude.json"), "utf8").includes(SECRET),
        `~/.claude.json still holds the value it always did; nothing was written into ~/.claude`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 3 — a local-only Component in the Manifest is flagged
// ---------------------------------------------------------------------------

async function checkLocalFlagged(fx: Fixtures): Promise<Check> {
  // `beta` sends the local-only skill to the Manifest — the choice ADR 0004
  // permits and calls non-portable. Everything else is skipped.
  const run = await importInto(fx.beta, fx.env, ["s", "m", "s", "s", "s"]);
  const out = plain(run.stdout);
  const synced = await harv(["sync"], fx.beta, fx.env);

  return {
    id: "local-flagged",
    title: "A Component that exists only on this machine is flagged, with the push it needs",
    measurements: { exit: run.code, stdout: out, syncStderr: synced.stderr.trim() },
    expectations: [
      expect(
        "the group says so before the question is answered",
        out.includes("no clone of this project can resolve it"),
        out.split("\n").find((line) => line.includes("note:"))?.trim() ?? "(no note)",
      ),
      expect(
        "the summary names the Component",
        new RegExp(`${LOCAL_SKILL} is declared by local path`).test(out),
        out.split("\n").find((line) => line.includes("declared by local path"))?.trim() ?? "(not flagged)",
      ),
      expect(
        "and says to push it to a git repository",
        /git repository and push it/.test(out),
        "ADR 0004: keeping personal skills in a personal git repo is the expected pattern",
      ),
      expect(
        "and gives the command that replaces the entry once it is pushed",
        new RegExp(`harv add ${LOCAL_SKILL} --git`).test(out),
        out.split("\n").find((line) => line.includes(`harv add ${LOCAL_SKILL}`))?.trim() ?? "(no follow-up given)",
      ),
      expect(
        "the entry it wrote is a `path` Source, which Sync then warns about by name every time",
        synced.stderr.includes(LOCAL_SKILL) && /no clone of this project can resolve/.test(synced.stderr),
        synced.stderr.trim().split("\n")[0] ?? "(nothing on stderr)",
      ),
      expect(
        "the project still syncs — a flag is not a refusal",
        synced.code === 0,
        `exit ${synced.code}: ${synced.stdout.trim()}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 4 — re-running changes nothing
// ---------------------------------------------------------------------------

async function checkIdempotent(fx: Fixtures): Promise<Check> {
  // `alpha` has already been imported by criterion 2. Running the same command
  // again must offer only what was *skipped* — a skip is not a decision the
  // wizard records — and must not offer, move or duplicate anything declared.
  const manifestBefore = read(manifestPath(fx.alpha));
  const overlayBefore = read(overlayPath(fx));

  // Generous on purpose: more answers than there can be questions, so a wizard
  // that re-offered an imported item would have an answer waiting and would
  // write a duplicate rather than quietly running out of input.
  const again = await importInto(fx.alpha, fx.env, ["s", "s", "s", "s", "s", "s", "s", "s"]);
  const out = plain(again.stdout);

  const manifestAfter = read(manifestPath(fx.alpha));
  const overlayAfter = read(overlayPath(fx));
  const imported = [PORTABLE_SKILL, PLUGIN, GLOBAL_SERVER, LOCAL_SKILL, PROJECT_SERVER];
  // Listed and offered are different things, and the wizard prints both: an
  // already-declared item is named in a block that says which file declares it,
  // and an offered one is named under a group that is about to be asked about.
  const offered = (name: string) =>
    out
      .split("\n")
      .some((line) => new RegExp(`^ {4}${name}\\s`).test(line) && !/\bin the (manifest|overlay)\b/.test(line));

  return {
    id: "idempotent",
    title: "Re-running the wizard produces no duplicate entries",
    measurements: {
      exit: again.code,
      stdout: out,
      questionsOnSecondRun: (out.match(/\[s\]kip/g) ?? []).length,
    },
    expectations: [
      expect(
        "nothing already imported is offered a second time",
        imported.every((name) => !offered(name)),
        `still offered: ${imported.filter(offered).join(", ") || "nothing"}`,
      ),
      expect(
        "it says what is already declared, and which file declares it",
        /already declared/.test(out) &&
          new RegExp(`${PORTABLE_SKILL}\\s+in the manifest`).test(out) &&
          new RegExp(`${LOCAL_SKILL}\\s+in the overlay`).test(out),
        out.split("\n").filter((line) => line.includes("in the ")).slice(0, 3).map((l) => l.trim()).join(" | ") ||
          "(nothing listed)",
      ),
      expect(
        "what was skipped is offered again — a skip is not a decision harv records",
        offered(GITHUB_PLUGIN),
        `\`${GITHUB_PLUGIN}\` was skipped last time and is on the table again`,
      ),
      expect("the Manifest is byte-identical", manifestAfter === manifestBefore, `${manifestAfter.length} bytes, unchanged`),
      expect("the Overlay is byte-identical", overlayAfter === overlayBefore, `${overlayAfter.length} bytes, unchanged`),
      expect(
        "every imported name is declared exactly once, in exactly one file",
        [PORTABLE_SKILL, PLUGIN, GLOBAL_SERVER].every(
          (name) => declarations(manifestAfter, name) === 1 && declarations(overlayAfter, name) === 0,
        ) &&
          [LOCAL_SKILL, PROJECT_SERVER].every(
            (name) => declarations(overlayAfter, name) === 1 && declarations(manifestAfter, name) === 0,
          ),
        `Manifest: ${[PORTABLE_SKILL, PLUGIN, GLOBAL_SERVER].map((n) => `${n}x${declarations(manifestAfter, n)}`).join(", ")}; ` +
          `Overlay: ${[LOCAL_SKILL, PROJECT_SERVER].map((n) => `${n}x${declarations(overlayAfter, n)}`).join(", ")}`,
      ),
      expect(
        "and so a declared name cannot be moved into the other file by re-importing",
        [LOCAL_SKILL, PROJECT_SERVER].every((name) => declarations(manifestAfter, name) === 0),
        `the Overlay's two were never put on the table again, so there was no answer that could move them`,
      ),
      expect(
        "the run reports that it imported nothing",
        /Nothing was imported/.test(out),
        out.split("\n").filter((line) => line.startsWith("Nothing")).join(" | ") || "(no such line)",
      ),
      expect(
        "and the Manifest still loads, through the parser a teammate's clone uses",
        (await harv(["sync"], fx.alpha, { ...fx.env, [SECRET_VARIABLE]: SECRET })).code === 0,
        "`harv sync` re-reads it and resolves every entry",
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Criterion 5 — the same thing, driven by a terminal
// ---------------------------------------------------------------------------

/**
 * A pipe is not a terminal, and the wizard's users are at one.
 *
 * Driven through a real pty by a short Python program, because Node has no
 * pseudo-terminal of its own and the difference is exactly what this check is
 * about: readline echoes and edits on a tty and does neither on a pipe, and
 * answers are typed one at a time rather than delivered in one chunk.
 */
const PTY_DRIVER = `import os, pty, select, subprocess, sys, time

answers = sys.argv[1].split(",")
command = sys.argv[2:]

master, slave = pty.openpty()
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)

seen = b""
sent = 0
deadline = time.time() + 90
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.5)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        seen += chunk
        # One answer per question, typed only once its prompt has appeared.
        while sent < len(answers) and seen.count(b"[s]kip") > sent:
            time.sleep(0.05)
            os.write(master, (answers[sent] + "\\r").encode())
            sent += 1
    elif child.poll() is not None:
        break

try:
    child.wait(timeout=20)
except subprocess.TimeoutExpired:
    child.kill()
os.close(master)
sys.stdout.buffer.write(seen)
sys.exit(child.returncode if child.returncode is not None else 1)
`;

async function checkPseudoTerminal(fx: Fixtures): Promise<Check> {
  const python = (await runToCompletion("python3", ["--version"], { cwd: FIXTURE_ROOT }).catch(() => null))?.code;
  if (python !== 0) {
    return {
      id: "pseudo-terminal",
      title: "The wizard driven through a real pseudo-terminal",
      measurements: {},
      expectations: [expect("python3 is available to open a pty", null, "no python3 on PATH — this check did not run")],
    };
  }

  const driver = join(FIXTURE_ROOT, "pty-driver.py");
  writeFileSync(driver, PTY_DRIVER);

  const run = await runToCompletion(
    "python3",
    [driver, ALPHA_ANSWERS.join(","), process.execPath, HARV, "init", "--import"],
    { cwd: fx.gamma, env: fx.ptyEnv },
  );
  const out = plain(run.stdout);
  const manifest = read(manifestPath(fx.gamma));
  const overlay = read(join(fx.ptyHome, ".harv", "overlay.toml"));

  return {
    id: "pseudo-terminal",
    title: "The wizard driven through a real pseudo-terminal answers as it does on a pipe",
    measurements: { exit: run.code, transcript: out.slice(-2000) },
    expectations: [
      expect("the wizard ran to completion on a tty", run.code === 0, `exit ${run.code}`),
      expect(
        "every question was put and answered in turn",
        (out.match(/\[s\]kip/g) ?? []).length === ALPHA_ANSWERS.length,
        `${(out.match(/\[s\]kip/g) ?? []).length} questions for ${ALPHA_ANSWERS.length} answers`,
      ),
      expect(
        "the answers were echoed back, as a terminal echoes what is typed at it",
        /> m\r/.test(out),
        "readline is in terminal mode here, which a pipe never puts it in",
      ),
      expect(
        `the Manifest it wrote declares the git-derived skill, the plugin and the server`,
        declarations(manifest, PORTABLE_SKILL) === 1 &&
          declarations(manifest, PLUGIN) === 1 &&
          declarations(manifest, GLOBAL_SERVER) === 1,
        manifest.split("\n").filter((line) => /^(team|fixture|\[mcp)/.test(line)).join(" | ") || "(nothing declared)",
      ),
      expect(
        `the Overlay it wrote holds the two it was told to keep personal`,
        declarations(overlay, LOCAL_SKILL) === 1 && declarations(overlay, PROJECT_SERVER) === 1,
        `${join(fx.ptyHome, ".harv", "overlay.toml")}: ${overlay.split("\n").filter((l) => /=|\[mcp/.test(l)).join(" | ")}`,
      ),
      expect(
        "the credential was kept out of the committed file here too",
        !manifest.includes(SECRET),
        `the Manifest carries \${${SECRET_VARIABLE}}`,
      ),
      expect(
        "and it, too, wrote nothing into the user scope",
        !existsSync(join(fx.ptyHome, ".claude", "harvenv.toml")),
        join(fx.ptyHome, ".claude"),
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

const failed = (check: Check): boolean => Boolean(check.error) || check.expectations.some((e) => e.ok === false);

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
  log("harvenv import wizard verification");
  log(`${DIM}fixtures: ${FIXTURE_ROOT}${RESET}`);
  log(`${DIM}HOME and HARV_HOME both point inside them; the real ~/.claude is never opened.${RESET}`);

  // Ordered, and deliberately so. `local-flagged` runs before anything has
  // written to the global staples file, because a staple declared there is not
  // offered again anywhere — which is criterion 4 working, and would silently
  // hollow out criterion 3 if it ran second. `idempotent` then re-imports the
  // project `selections` imported, which is what makes "re-running" a statement
  // about a second run rather than about a fresh one.
  const runners: Array<[string, string, () => Promise<Check>]> = [
    ["inventory", "Skills, plugins and MCP servers are inventoried and grouped", () => checkInventory(fx)],
    ["local-flagged", "Local-only Components are flagged with push-to-repo guidance", () => checkLocalFlagged(fx)],
    ["selections", "Selections land where they were sent, and what they wrote works", () => checkSelections(fx)],
    ["idempotent", "Re-running produces no duplicate entries", () => checkIdempotent(fx)],
    ["pseudo-terminal", "The same run, driven by a terminal rather than a pipe", () => checkPseudoTerminal(fx)],
  ];

  const checks: Check[] = [];
  for (const [id, title, run] of runners) {
    log(`\n${DIM}running ${id}...${RESET}`);
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({
        id,
        title,
        expectations: [],
        measurements: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (keep) log(`\n${DIM}fixtures kept at ${FIXTURE_ROOT}${RESET}`);
  else rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  const failures = checks.filter(failed);
  if (asJson) {
    console.log(JSON.stringify({ ok: failures.length === 0, fixtures: keep ? FIXTURE_ROOT : null, checks }, null, 2));
  } else {
    report(checks);
    console.log(
      `\n${checks.length - failures.length}/${checks.length} criteria verified` +
        (failures.length ? ` ${RED}(${failures.map((c) => c.id).join(", ")})${RESET}` : ""),
    );
  }
  return failures.length === 0 ? 0 : 1;
}

if (!existsSync(HARV)) throw new Error(`harv entry point not found at ${HARV}`);
process.exitCode = await main();

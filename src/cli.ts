/**
 * `harv` — the command line surface.
 *
 * `claude` is the Launcher: it finds the project's Manifest, materializes what
 * the Manifest declares, and hands the terminal to a hermetic Claude Code
 * session. Everything after `claude` belongs to Claude Code and is passed
 * through untouched.
 *
 * `mise` reaches the vendored Toolchain engine, and `--version` says which harv
 * and which mise you have. Neither reads a Manifest — they answer questions
 * about the installation, so they work anywhere, including on the clean machine
 * where the first thing anyone runs is `harv --version`.
 */

import { findManifest, loadManifest, ManifestError, MANIFEST_FILENAME } from "./manifest.ts";
import { materialize, MaterializeError } from "./materialize.ts";
import { launch as launchSession, SettingsError, validateSettings } from "./launch.ts";
import { MISE_VERSION, MiseError, runMise as runMiseBinary } from "./mise.ts";
import { currentPlatform } from "./platform.ts";
import { defaultUpdateCheckDeps, isDevBuild, updateHint, VERSION } from "./version.ts";
import type { Manifest } from "./manifest.ts";

export interface CliDeps {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Injected so tests can exercise the whole command without a real session. */
  launch: (manifest: Manifest, passthrough: string[]) => Promise<number>;
  /** Injected for the same reason: no test should need a 40MB binary on disk. */
  runMise: (args: string[]) => Promise<number>;
  /** Resolves to the one line worth printing, or null. Never throws. */
  updateHint: () => Promise<string | null>;
}

const USAGE = `Usage: harv <command> [args...]

Commands:
  claude [args...]   Start a Claude Code session composed strictly from this
                     project's Manifest. Arguments after \`claude\` are passed
                     through unchanged (harv claude -p "hi", --resume, ...).
  mise [args...]     Run the vendored Toolchain engine. Mostly for diagnosis
                     until \`harv sync\` drives it.

Options:
  --version, -v      Print the harv and mise versions, and whether harv is
                     behind the latest release.
  --help, -h         Print this.

harv reads ${MANIFEST_FILENAME} from the current directory or the nearest ancestor.`;

/** Errors whose message is written for the user, not for a debugger. */
const EXPECTED_ERRORS = [ManifestError, MaterializeError, SettingsError, MiseError];

export function defaultDeps(): CliDeps {
  return {
    cwd: process.cwd(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    launch: launchSession,
    runMise: runMiseBinary,
    updateHint: () => updateHint(defaultUpdateCheckDeps()).catch(() => null),
  };
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return await version(deps);
  }
  if (command === undefined) {
    deps.stderr(USAGE);
    return 2;
  }

  try {
    if (command === "claude") return await claude(rest, deps);
    if (command === "mise") return await deps.runMise(rest);
  } catch (err) {
    if (EXPECTED_ERRORS.some((type) => err instanceof type)) {
      deps.stderr(`harv: ${(err as Error).message}`);
      return 1;
    }
    throw err;
  }

  deps.stderr(`harv: unknown command \`${command}\`.\n`);
  deps.stderr(USAGE);
  return 2;
}

/**
 * The version report. The facts go to stdout so `harv --version` stays
 * something a script can read; the "you are behind" notice goes to stderr,
 * because it is a remark about the installation rather than an answer.
 */
async function version(deps: CliDeps): Promise<number> {
  const suffix = isDevBuild() ? " — development build, run from source" : "";
  deps.stdout(`harv ${VERSION} (${currentPlatform()})${suffix}`);
  deps.stdout(`vendored mise ${MISE_VERSION}`);

  const hint = await deps.updateHint();
  if (hint !== null) deps.stderr(`\n${hint}`);
  return 0;
}

async function claude(passthrough: string[], deps: CliDeps): Promise<number> {
  const manifestPath = findManifest(deps.cwd);
  if (manifestPath === null) {
    deps.stderr(
      `harv: no Manifest found — this is not a harvenv project.\n` +
        `  Searched for ${MANIFEST_FILENAME} in ${deps.cwd} and every directory above it.\n` +
        `  Create one to declare this project's Harvenv, or run \`claude\` directly for an un-isolated session.`,
    );
    return 1;
  }

  const manifest = loadManifest(manifestPath);
  // Everything that can be judged from the Manifest alone is judged before the
  // first write, so a Manifest that cannot launch leaves no trace in the tree.
  validateSettings(manifest.settings);
  materialize(manifest);
  return deps.launch(manifest, passthrough);
}

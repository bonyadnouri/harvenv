/**
 * `harv` — the command line surface.
 *
 * One subcommand so far: `claude`, the Launcher. It finds the project's
 * Manifest, materializes what the Manifest declares, and hands the terminal to
 * a hermetic Claude Code session. Everything after `claude` belongs to Claude
 * Code and is passed through untouched.
 */

import { findManifest, loadManifest, ManifestError, MANIFEST_FILENAME } from "./manifest.ts";
import { materialize, MaterializeError } from "./materialize.ts";
import { launch as launchSession, SettingsError } from "./launch.ts";
import type { Manifest } from "./manifest.ts";

export interface CliDeps {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Injected so tests can exercise the whole command without a real session. */
  launch: (manifest: Manifest, passthrough: string[]) => Promise<number>;
}

const USAGE = `Usage: harv <command> [args...]

Commands:
  claude [args...]   Start a Claude Code session composed strictly from this
                     project's Manifest. Arguments after \`claude\` are passed
                     through unchanged (harv claude -p "hi", --resume, ...).

harv reads ${MANIFEST_FILENAME} from the current directory or the nearest ancestor.`;

/** Errors whose message is written for the user, not for a debugger. */
const EXPECTED_ERRORS = [ManifestError, MaterializeError, SettingsError];

export function defaultDeps(): CliDeps {
  return {
    cwd: process.cwd(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    launch: launchSession,
  };
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command === undefined) {
    deps.stderr(USAGE);
    return 2;
  }
  if (command !== "claude") {
    deps.stderr(`harv: unknown command \`${command}\`.\n`);
    deps.stderr(USAGE);
    return 2;
  }

  try {
    return await claude(rest, deps);
  } catch (err) {
    if (EXPECTED_ERRORS.some((type) => err instanceof type)) {
      deps.stderr(`harv: ${(err as Error).message}`);
      return 1;
    }
    throw err;
  }
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
  materialize(manifest);
  return deps.launch(manifest, passthrough);
}

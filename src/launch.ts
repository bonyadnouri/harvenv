/**
 * The Launcher (ADR 0003): a hermetic session is a composed recipe of native
 * Claude Code flags, never a swapped `CLAUDE_CONFIG_DIR`. The user's config
 * directory is read by Claude Code as it always was — login, session history
 * and MCP OAuth keep working — while the flags decide what loads.
 *
 *   --setting-sources project,local   user scope, its skills, plugins and hooks
 *                                     stop loading (spike 0001, finding 1)
 *   --settings <json>                 the Harvenv's settings, at the top of the
 *                                     precedence stack, so ADR 0005's "Manifest
 *                                     settings are binding" survives a
 *                                     teammate's settings.local.json (finding 2)
 *   --strict-mcp-config --mcp-config  the Harvenv's MCP servers, and only those.
 *                                     Servers live in ~/.claude.json, which is
 *                                     not a settings source, so suppressing the
 *                                     machine's own takes its own pair of flags
 *   --plugin-dir <link>               one per pinned plugin, and nothing else:
 *                                     the flag renames what it serves, which is
 *                                     wrong for a skill and right for a plugin
 *                                     (ADR 0008)
 *
 * Declared skills are not passed here at all: they reach the session through
 * project scope, so they keep their bare names. Pinned plugins do come through
 * `--plugin-dir`, because the `<plugin>:<name>` prefix it adds is the name they
 * are published under — and suppressing the user's plugins with
 * `--setting-sources` while re-adding the Manifest's own is what makes the two
 * sets disjoint rather than merged.
 *
 * The settings and MCP payloads are built here rather than merged into one
 * settings blob because they answer to different flags — but both are built by
 * harv rather than assembled by Claude Code out of layers, which is what lets
 * ADR 0005's rules be enforced at all (spike 0001, finding 2).
 */

import { spawn } from "node:child_process";

import { generateMcpConfig } from "./mcp.ts";
import { generateSettings } from "./settings.ts";
import { resolveRealClaude } from "./shim.ts";
import { LAUNCHER_ENV } from "./tripwire.ts";
import type { Session } from "./overlay.ts";
import { pluginDir } from "./materialize.ts";

/** A session that cannot be started at all — as opposed to one that fails. */
export class LaunchError extends Error {
  override name = "LaunchError";
}

/**
 * The full argv for `claude`, with the caller's own arguments left untouched.
 *
 * `env` is both the source of `${VAR}` resolution and the environment the
 * session runs in, so the two cannot drift: what a server definition referred to
 * is what the launching shell had.
 */
export function buildLaunchArgs(
  session: Session,
  passthrough: string[],
  env: NodeJS.ProcessEnv,
): string[] {
  return [
    "--setting-sources",
    "project,local",
    "--settings",
    // Personal-ergonomics keys are legitimate here even though a Manifest may
    // not set them: by this point the Overlay has contributed its own.
    generateSettings(session.settings, { allowPersonalKeys: true }),
    "--strict-mcp-config",
    "--mcp-config",
    generateMcpConfig(session.mcpServers, env),
    // The link, never the Store entry it points at: a plugin with no
    // `plugin.json` is named after the directory it is served from, and that
    // directory has to be called what the Manifest calls it.
    ...session.manifest.plugins.flatMap((plugin) => [
      "--plugin-dir",
      pluginDir(session.manifest.root, plugin.name),
    ]),
    ...passthrough,
  ];
}

/**
 * The session's environment: the caller's, plus the marker that tells the
 * project's Tripwire this session is a Launcher session and needs no warning.
 *
 * Additive on purpose. ADR 0003's whole point is that harv does not reach into
 * how Claude Code finds the user's configuration, so nothing here redirects or
 * removes anything — it only leaves a note for a hook harv itself planted.
 */
export function launchEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [LAUNCHER_ENV]: "1" };
}

/**
 * Claude Code itself, never a harv shim.
 *
 * With the Shim installed, `claude` on PATH *is* harv — and the shim's job
 * inside a harvenv project is to run `harv claude`. Spawning by bare name here
 * would hand the session straight back to the shim, forever. So the launcher
 * resolves the same way the shim does, past every shim directory, and spawns
 * the absolute path it finds. Without a shim installed this resolves to exactly
 * what a bare `claude` would have run.
 */
export function claudeBinary(pathString: string): string {
  const real = resolveRealClaude(pathString);
  if (real === null) {
    throw new LaunchError(
      "claude was not found on PATH. Install Claude Code, or add it to PATH, and try again.",
    );
  }
  return real;
}

/**
 * Hand the terminal to Claude Code and adopt its exit code. The session runs
 * from the project root so that project scope — and with it every materialized
 * Component — is the one the Manifest describes, even when harv was invoked
 * from a subdirectory.
 */
export function launch(
  session: Session,
  passthrough: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  // Marked once, then used for both jobs, so `${VAR}` resolution and the
  // session still see the same environment — the marker is the only thing
  // either of them has that the launching shell did not.
  const sessionEnv = launchEnv(env);
  // Resolved from the same environment the session will run in, so the binary
  // harv starts is the one that PATH names — not the one harv's own happens to.
  const binary = claudeBinary(sessionEnv.PATH ?? "");

  return new Promise((resolveExit, reject) => {
    const child = spawn(binary, buildLaunchArgs(session, passthrough, sessionEnv), {
      cwd: session.manifest.root,
      env: sessionEnv,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveExit(signal ? 128 : (code ?? 0)));
  });
}

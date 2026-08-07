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
 *
 * Declared skills are not passed here at all: they reach the session through
 * project scope, because `--plugin-dir` renames what it serves (ADR 0008).
 *
 * The two payloads are built here rather than merged into one settings blob
 * because they answer to different flags — but both are built by harv rather
 * than assembled by Claude Code out of layers, which is what lets ADR 0005's
 * rules be enforced at all (spike 0001, finding 2).
 */

import { spawn } from "node:child_process";

import { generateMcpConfig } from "./mcp.ts";
import { generateSettings } from "./settings.ts";
import { LAUNCHER_ENV } from "./tripwire.ts";
import type { Manifest } from "./manifest.ts";

/**
 * The full argv for `claude`, with the caller's own arguments left untouched.
 *
 * `env` is both the source of `${VAR}` resolution and the environment the
 * session runs in, so the two cannot drift: what a server definition referred to
 * is what the launching shell had.
 */
export function buildLaunchArgs(
  manifest: Manifest,
  passthrough: string[],
  env: NodeJS.ProcessEnv,
): string[] {
  return [
    "--setting-sources",
    "project,local",
    "--settings",
    generateSettings(manifest.settings),
    "--strict-mcp-config",
    "--mcp-config",
    generateMcpConfig(manifest.mcpServers, env),
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
 * Hand the terminal to Claude Code and adopt its exit code. The session runs
 * from the project root so that project scope — and with it every materialized
 * Component — is the one the Manifest describes, even when harv was invoked
 * from a subdirectory.
 */
export function launch(
  manifest: Manifest,
  passthrough: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  // Marked once, then used for both jobs, so `${VAR}` resolution and the
  // session still see the same environment — the marker is the only thing
  // either of them has that the launching shell did not.
  const sessionEnv = launchEnv(env);

  return new Promise((resolveExit, reject) => {
    const child = spawn("claude", buildLaunchArgs(manifest, passthrough, sessionEnv), {
      cwd: manifest.root,
      env: sessionEnv,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveExit(signal ? 128 : (code ?? 0)));
  });
}

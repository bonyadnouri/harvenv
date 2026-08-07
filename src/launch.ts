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
 *   --strict-mcp-config --mcp-config  MCP servers live in ~/.claude.json, which
 *                                     is not a settings source, so suppressing
 *                                     them takes its own pair of flags
 *
 * Declared skills are not passed here at all: they reach the session through
 * project scope, because `--plugin-dir` renames what it serves (ADR 0008).
 */

import { spawn } from "node:child_process";

import type { Manifest } from "./manifest.ts";

/**
 * Permission modes a *settings file* honours. Narrower than the CLI's set:
 * `--permission-mode manual` is valid, but `"manual"` in a settings file is
 * discarded and the mode silently falls back to `default` (spike 0001,
 * finding 2). A silent fallback is exactly the divergence ADR 0005 exists to
 * prevent, so harv rejects it at generation time instead.
 */
const SETTINGS_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
];

/** No Manifest MCP servers in this slice — but the flag pair still has to run. */
const NO_MCP_SERVERS = JSON.stringify({ mcpServers: {} });

export class SettingsError extends Error {
  override name = "SettingsError";
}

/**
 * Throws if the Manifest asks for settings Claude Code would not honour.
 *
 * Exported so a caller can find that out *before* it starts writing into the
 * project tree: a Manifest that can never launch has no business leaving
 * materialized Components behind.
 */
export function validateSettings(settings: Record<string, unknown>): void {
  const permissions = settings.permissions;
  if (permissions && typeof permissions === "object" && !Array.isArray(permissions)) {
    const mode = (permissions as Record<string, unknown>).defaultMode;
    if (mode !== undefined && (typeof mode !== "string" || !SETTINGS_PERMISSION_MODES.includes(mode))) {
      throw new SettingsError(
        `[settings.permissions] defaultMode = ${JSON.stringify(mode)} is not a value a settings file accepts, ` +
          `and Claude Code would silently fall back to "default". Use one of: ${SETTINGS_PERMISSION_MODES.join(", ")}.`,
      );
    }
  }
}

/** The Harvenv's settings as a `--settings` payload. Inline JSON is accepted. */
export function generateSettings(settings: Record<string, unknown>): string {
  validateSettings(settings);
  return JSON.stringify(settings);
}

/** The full argv for `claude`, with the caller's own arguments left untouched. */
export function buildLaunchArgs(manifest: Manifest, passthrough: string[]): string[] {
  return [
    "--setting-sources",
    "project,local",
    "--settings",
    generateSettings(manifest.settings),
    "--strict-mcp-config",
    "--mcp-config",
    NO_MCP_SERVERS,
    ...passthrough,
  ];
}

/**
 * Hand the terminal to Claude Code and adopt its exit code. The session runs
 * from the project root so that project scope — and with it every materialized
 * Component — is the one the Manifest describes, even when harv was invoked
 * from a subdirectory.
 */
export function launch(manifest: Manifest, passthrough: string[]): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn("claude", buildLaunchArgs(manifest, passthrough), {
      cwd: manifest.root,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolveExit(signal ? 128 : (code ?? 0)));
  });
}

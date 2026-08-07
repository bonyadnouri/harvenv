/**
 * The Manifest's `[settings]` table, turned into the payload the Launcher
 * injects with `--settings`.
 *
 * Two rules live here, and both come from ADR 0005.
 *
 * The first is the split. Behavior-shaping settings — permissions, hooks, env,
 * model, effort — are the Manifest's business and are binding on everyone who
 * runs the project. Personal-ergonomics settings are never the Manifest's
 * business, so declaring one is an error rather than a courtesy: a Manifest that
 * pinned a teammate's theme would be reaching past the contract it is allowed to
 * set, and silently ignoring the key would leave the Manifest saying something
 * the session does not do.
 *
 * The second is that a binding setting has to actually bind. Claude Code accepts
 * a settings payload without complaint and then discards the parts it does not
 * recognise — an out-of-range `permissions.defaultMode`, an effort level that
 * exists on the command line but not in the settings schema. The Manifest says
 * one thing, the session does another, and nothing reports the gap. That is the
 * exact failure ADR 0005 exists to prevent, so every key the Manifest is allowed
 * to set is checked against what a *settings file* accepts, which is narrower
 * than what the CLI accepts (spike 0001, finding 2; spike 0002, findings 1-2).
 *
 * `[settings]` is Claude Code's own settings schema, verbatim — harv does not
 * invent a second vocabulary to translate. A translation layer would be one more
 * thing to keep in step with every Claude Code release, and the failure mode
 * would be the same silent divergence.
 */

/**
 * Permission modes a *settings file* honours. Narrower than the CLI's set:
 * `--permission-mode manual` is valid, but `"manual"` in a settings file is
 * discarded and the mode silently falls back to `default` (spike 0001,
 * finding 2).
 */
export const SETTINGS_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
];

/**
 * Effort levels a *settings file* honours. Narrower than `/effort`, which also
 * offers `max`, `ultracode` and `auto` — those are session commands, and in a
 * settings payload they are dropped without a word (spike 0002, finding 1).
 */
export const SETTINGS_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];

/** Keys whose values must be arrays of strings for the rule to mean anything. */
const PERMISSION_LISTS = ["allow", "deny", "ask", "additionalDirectories"];

/**
 * ADR 0005's personal side, mapped onto the keys Claude Code actually has.
 *
 * The ADR names four categories — statusLine, tui, theme, keybindings. Two of
 * them are not settings keys at all (`tui` and `keybindings` are the shapes the
 * ADR reasons about, not the schema's names), so the concrete list has to be
 * derived. Each entry is grouped under the ADR name it belongs to, and the ADR
 * names themselves are included so a Manifest author who writes what the ADR
 * says gets the rule explained rather than silently ignored.
 *
 * The list is deliberately narrow. ADR 0005's own guidance is that a setting
 * which should be personal is one the Manifest simply doesn't set — so a key
 * harv cannot confidently classify stays binding, which is the recoverable
 * direction: loosening later is harmless, tightening later breaks people.
 */
const PERSONAL_KEYS = new Map<string, string>([
  ["statusLine", "statusLine"],
  ["subagentStatusLine", "statusLine"],
  ["theme", "theme"],
  ["keybindings", "keybindings"],
  ["editorMode", "keybindings"],
  ["vimInsertModeRemaps", "keybindings"],
  ["hideVimModeIndicator", "keybindings"],
  ["tui", "tui"],
  ["viewMode", "tui"],
  ["verbose", "tui"],
  ["autoScrollEnabled", "tui"],
  ["wheelScrollAccelerationEnabled", "tui"],
  ["showTurnDuration", "tui"],
  ["showMessageTimestamps", "tui"],
  ["showThinkingSummaries", "tui"],
  ["terminalProgressBarEnabled", "tui"],
  ["terminalTitleFromRename", "tui"],
  ["syntaxHighlightingDisabled", "tui"],
  ["spinnerTipsEnabled", "tui"],
  ["spinnerTipsOverride", "tui"],
  ["spinnerVerbs", "tui"],
  ["prefersReducedMotion", "tui"],
  ["emojiCompletionEnabled", "tui"],
]);

/** Stated once, so the rejection and the documentation cannot drift apart. */
export const PERSONAL_KEY_RULE =
  "ADR 0005 splits settings in two: behavior-shaping keys (permissions, hooks, env, model, effort) are the " +
  "Manifest's business and bind everyone who runs the project, while personal-ergonomics keys " +
  "(statusLine, tui, theme, keybindings) are never the Manifest's business and stay free. " +
  "Move it to your Overlay, where it applies to you and to nobody else";

export class SettingsError extends Error {
  override name = "SettingsError";
}

/**
 * Throws if the Manifest asks for settings Claude Code would not honour, or for
 * settings ADR 0005 does not let it ask for.
 *
 * Exported so a caller can find that out *before* it starts writing into the
 * project tree: a Manifest that can never launch has no business leaving
 * materialized Components behind.
 */
export function validateSettings(settings: Record<string, unknown>): void {
  for (const key of Object.keys(settings)) {
    const category = PERSONAL_KEYS.get(key);
    if (category !== undefined) {
      const named = category === key ? "" : ` — one of ADR 0005's \`${category}\` keys`;
      throw new SettingsError(
        `[settings] declares \`${key}\`${named}, which a Manifest may not set. ${PERSONAL_KEY_RULE}.`,
      );
    }
  }

  // `effort` reads like the key and is not one, so it would be dropped in
  // silence — the near-miss is worth naming rather than leaving to the schema.
  if ("effort" in settings) {
    throw new SettingsError(
      "[settings] declares `effort`, which is not a key in Claude Code's settings schema — it would be " +
        'ignored without a word. The key is `effortLevel`, e.g. effortLevel = "high".',
    );
  }

  validateEnum(
    settings,
    "effortLevel",
    SETTINGS_EFFORT_LEVELS,
    "`/effort` also offers max, ultracode and auto, but a settings file does not",
  );
  validateModel(settings.model);
  validateEnvTable(settings.env);
  validateHooks(settings.hooks);
  validatePermissions(settings.permissions);
}

/** The Harvenv's settings as a `--settings` payload. Inline JSON is accepted. */
export function generateSettings(settings: Record<string, unknown>): string {
  validateSettings(settings);
  return JSON.stringify(settings);
}

function validateEnum(
  settings: Record<string, unknown>,
  key: string,
  allowed: string[],
  note: string,
): void {
  const value = settings[key];
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new SettingsError(
      `[settings] ${key} = ${JSON.stringify(value)} is not a value a settings file accepts, and Claude Code ` +
        `would discard it without a word (${note}). Use one of: ${allowed.join(", ")}.`,
    );
  }
}

function validateModel(model: unknown): void {
  if (model === undefined) return;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new SettingsError(
      `[settings] model = ${JSON.stringify(model)} must be a non-empty string — an alias like "opus" or a ` +
        `full model name like "claude-opus-5".`,
    );
  }
}

/**
 * `env` reaches the session's tools and hooks as process environment, which is
 * strings all the way down. TOML will happily give a number or a nested table,
 * and Claude Code drops the entry rather than coercing it.
 */
function validateEnvTable(env: unknown): void {
  if (env === undefined) return;
  if (!isTable(env)) throw new SettingsError("[settings.env] must be a table of string values");
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new SettingsError(
        `[settings.env] ${name} = ${JSON.stringify(value)} must be a string — environment variables have no other type. ` +
          `Quote it: ${name} = "${String(value)}"`,
      );
    }
  }
}

function validateHooks(hooks: unknown): void {
  if (hooks === undefined) return;
  if (!isTable(hooks)) {
    throw new SettingsError(
      "[settings.hooks] must be a table keyed by hook event, e.g. [settings.hooks] with a PreToolUse array",
    );
  }
}

function validatePermissions(permissions: unknown): void {
  if (permissions === undefined) return;
  if (!isTable(permissions)) throw new SettingsError("[settings.permissions] must be a table");

  validateEnum(
    permissions,
    "defaultMode",
    SETTINGS_PERMISSION_MODES,
    "`--permission-mode manual` is valid on the command line but not in a settings file",
  );

  for (const key of PERMISSION_LISTS) {
    const value = permissions[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((rule) => typeof rule !== "string")) {
      throw new SettingsError(
        `[settings.permissions] ${key} must be an array of rule strings, e.g. ${key} = ["Bash(git push:*)"]`,
      );
    }
  }
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The Tripwire (ADR 0012): the committed warning every synced project carries,
 * so a bare `claude` announces that it is not isolated instead of quietly
 * behaving like one that is.
 *
 * It is a SessionStart hook in the project's committed `.claude/settings.json`
 * — the one settings source a bare `claude` and a Launcher-started session both
 * read. The Launcher marks its own sessions with an environment variable, and
 * the hook stays silent when it sees it; every other session gets the warning.
 *
 * The hook command is a self-contained POSIX `sh` one-liner on purpose. It ends
 * up committed in someone's repository and runs on the machine of whoever
 * clones it — including teammates who have never installed harv, who are
 * exactly the people the warning is for. Shelling out to `harv` would turn the
 * warning into a `command not found` on every session they start.
 */

/**
 * Set by the Launcher on the session it starts. The Tripwire's whole job is to
 * notice its absence, so this string is a contract between the two — and, once
 * the Shim exists, between the Tripwire and every session the Shim routes.
 */
export const LAUNCHER_ENV = "HARV_SESSION";

/**
 * What the user reads. Claude Code renders it prefixed with
 * `SessionStart:startup says:`, so it opens by naming harvenv rather than
 * assuming the reader knows who is talking.
 */
export const TRIPWIRE_WARNING =
  "harvenv: this session is NOT isolated — it loads your user scope, not the Harvenv that " +
  "harvenv.toml declares. Run `harv claude` instead, or opt into the harv shim to route " +
  "plain claude through it here.";

/** A `hooks.SessionStart` entry, in the shape Claude Code's settings expect. */
export interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command?: string }>;
}

/** Committed project settings cannot be repaired by guessing. */
export class TripwireError extends Error {
  override name = "TripwireError";
}

/**
 * `systemMessage` is the field Claude Code displays to the *user*; a hook's
 * bare stdout goes to the model instead (measured — see ADR 0012). The warning
 * is for the person, so it travels as JSON.
 */
export function tripwireCommand(warning: string = TRIPWIRE_WARNING): string {
  const payload = JSON.stringify({ systemMessage: warning });
  return `[ -n "$${LAUNCHER_ENV}" ] || printf '%s' ${singleQuote(payload)}`;
}

/**
 * Quote for POSIX `sh`. The default warning carries no apostrophe, but the
 * safety of the generated command should not rest on someone remembering that.
 */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** No matcher: startup, resume, clear and compact all deserve the warning. */
export function tripwireHook(): HookEntry {
  return { hooks: [{ type: "command", command: tripwireCommand() }] };
}

/**
 * Whether these settings already carry a Tripwire.
 *
 * Recognition is by the environment marker rather than by the exact command,
 * so a project that has reworded the warning still counts as planted — `harv
 * init` tops a project up, it does not enforce harv's phrasing.
 */
export function hasTripwire(settings: Record<string, unknown>): boolean {
  return sessionStartEntries(settings).some((entry) =>
    entry.hooks.some((hook) => typeof hook.command === "string" && hook.command.includes(LAUNCHER_ENV)),
  );
}

/**
 * Plant the Tripwire in a parsed settings object, in place. Returns whether
 * anything changed, so a caller can tell "planted" from "already there".
 *
 * Everything already in the file survives: the hook is appended to whatever
 * `SessionStart` hooks the project runs, and no other key is read or written.
 */
export function plantTripwire(settings: Record<string, unknown>): boolean {
  if (hasTripwire(settings)) return false;

  const hooks = requireTable(settings.hooks, "hooks");
  if (settings.hooks === undefined) settings.hooks = hooks;

  const sessionStart = hooks.SessionStart;
  if (sessionStart === undefined) {
    hooks.SessionStart = [tripwireHook()];
    return true;
  }
  if (!Array.isArray(sessionStart)) {
    throw new TripwireError(
      `hooks.SessionStart is ${describe(sessionStart)}, but Claude Code expects a list of hook entries. ` +
        `Fix it by hand so harv never rewrites settings it cannot read.`,
    );
  }
  sessionStart.push(tripwireHook());
  return true;
}

/** The `SessionStart` entries that are shaped like hook entries; others are skipped. */
function sessionStartEntries(settings: Record<string, unknown>): HookEntry[] {
  const hooks = settings.hooks;
  if (!isTable(hooks) || !Array.isArray(hooks.SessionStart)) return [];
  return hooks.SessionStart.filter(
    (entry): entry is HookEntry => isTable(entry) && Array.isArray(entry.hooks),
  );
}

function requireTable(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isTable(value)) {
    throw new TripwireError(
      `${key} is ${describe(value)}, but Claude Code expects an object. ` +
        `Fix it by hand so harv never rewrites settings it cannot read.`,
    );
  }
  return value;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Named the way the error message needs to read, article included. */
const describe = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "a list" : `a ${typeof value}`;

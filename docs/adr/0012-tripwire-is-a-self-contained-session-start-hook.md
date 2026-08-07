# The Tripwire is a self-contained SessionStart hook, suppressed by a Launcher environment marker

Status: accepted

ADR 0003's consequence is that a bare `claude` inside a harvenv project is silently un-isolated,
and says the activation UX must address it. It does so with the Tripwire: a SessionStart hook in
the project's *committed* `.claude/settings.json`, planted by `harv init`, that prints a warning
through the hook JSON field `systemMessage`. The Launcher sets `HARV_SESSION=1` on the session it
starts; the hook is a POSIX `sh` one-liner that emits nothing when it sees that variable. So the
same committed hook warns a bare session and stays silent in a Launcher-started one.

Empirical basis (2026-08-07, measured on Claude Code 2.1.223, macOS 25.5.0 arm64):

- A SessionStart hook in project `.claude/settings.json` fires under a bare `claude` **and** under
  the ADR 0003 recipe — `--setting-sources project,local` suppresses the *user* layer's hooks
  (5 SessionStart hooks fired bare, 1 under the recipe: the project's own). The Tripwire therefore
  has to opt out of warning; it cannot rely on not being loaded.
- Hook stdout that is not JSON is injected into the *model's* context. `systemMessage` is the field
  Claude Code displays to the *person* — "Display a message to the user (all hooks)" in the running
  build's own hook reference. Measured through a real pty, an interactive session renders it as
  `⏵ SessionStart:startup says: harvenv: this session is NOT isolated — …`, and the same session
  started through `harv claude` renders no such line.
- Headless `-p` runs never display `systemMessage` on stdout or stderr; it is a TUI affordance.
  The automated check therefore reads the `hook_response` event under
  `--output-format stream-json --verbose`, which carries the hook's stdout verbatim.

`node scripts/verify-tripwire.ts` re-measures all of it and exits non-zero when a criterion stops
holding.

## Considered Options

- **Shell out to `harv` from the hook (`command: "harv tripwire"`):** the message would live in one
  place and could grow logic. But the hook is committed and runs on the machine of whoever clones
  the repo — including teammates who have never installed harv, who are exactly the people the
  warning exists for. On their machines every session would open with `harv: command not found`
  instead of a warning. A self-contained one-liner has no such failure mode.
- **Suppress by argument rather than by environment:** the Launcher could pass a flag the hook
  inspects. Hooks do not receive the session's argv, so this is not available; the environment is.
- **Suppress by overriding `hooks` in the `--settings` payload:** the Launcher could blank the
  SessionStart list. It would also silence the project's *own* SessionStart hooks, which are
  legitimate Manifest content, and spike 0001 (finding 2) showed `--settings` merges per key —
  so this would be a blunt instrument aimed at a precise target.
- **Warn from harv instead of from Claude Code:** only reaches people who already run harv.
  The Tripwire's entire audience is the session harv did not start.

## Consequences

- `HARV_SESSION` is now a contract, not an implementation detail: the Shim (issue #11) has to set
  it too, or every Shim-routed session will warn about itself.
- The hook command assumes a POSIX shell. On a platform where Claude Code runs hook commands
  through `cmd.exe` the one-liner would not evaluate, and the Tripwire would need a second form —
  the same platform caveat ADR 0008 already carries for symlinks.
- Recognition is by the presence of `HARV_SESSION` in a SessionStart command, not by the exact
  command string, so a project may reword the warning and `harv init` will still treat it as
  planted rather than adding a second one. The cost is that harv cannot upgrade a stale Tripwire
  in place; it would need an explicit `harv init --force` or a Doctor check (issue #9).
- The Tripwire is committed, so it travels with the repo and warns on a fresh clone. It is also
  visible and removable: ADR 0005's "the escape hatch is visible, not silent" is now literally
  true — the un-isolated session still exists, and announces itself.

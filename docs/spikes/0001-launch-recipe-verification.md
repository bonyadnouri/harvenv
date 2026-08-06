# Spike 0001 — verifying the hermetic launch recipe

Measured 2026-08-07 against **Claude Code 2.1.223** on macOS 25.5.0 (darwin arm64).

ADR 0003 composes the Launcher out of native Claude Code flags. Three of the behaviours it
leans on are observed rather than documented, so any release can retire them silently. This
spike re-measures all three and leaves behind a check that fails loudly when one changes:

```
node scripts/verify-launch-recipe.ts          # human-readable, exits 1 on any violation
node scripts/verify-launch-recipe.ts --json   # machine-readable, for Doctor
node scripts/verify-launch-recipe.ts --keep   # leave the fixture tree on disk to poke at
```

## Method

Every number below comes from the `system`/`init` event Claude Code emits on stdout under
`--output-format stream-json --verbose`. It carries the fully resolved inventory the session
will run with — `skills`, `slash_commands`, `agents`, `plugins`, `mcp_servers`, `tools` — plus
the resolved `model`, `permissionMode` and `output_style`. That makes it a direct, deterministic
read of what a flag combination actually produced, with no model in the loop.

The probe kills the session the moment `init` arrives, before the turn completes. `init` is
emitted after SessionStart hooks and before the first assistant token, so hook firing is
observable too — the count of `hook_started` events seen before `init` is itself a measurement.

Fixtures are built in a fresh temp tree per run, and the machine's `~/.claude` is only ever
read, never written.

Two caveats worth carrying forward:

- `init` requires a user message, so the probe sends a one-word prompt. Passing `/dev/null` on
  stdin never produces an `init` event at all.
- `mcp_servers` in `init` races asynchronous server registration — the same flags gave 7 on one
  run and 0 on the next. Only the `--strict-mcp-config` result is stable enough to assert on.

## Finding 1 — `--setting-sources project,local` suppresses user scope

Reproduced in an empty directory, so user scope is the only variable:

```
claude -p probe --output-format stream-json --verbose                                # default
claude -p probe --output-format stream-json --verbose --setting-sources project,local
```

| | default | `--setting-sources project,local` |
|---|---:|---:|
| Skills | 204 | **16** |
| Slash commands | 270 | **46** |
| Subagents | 29 | **5** |
| Plugins | 17 | **0** |
| Tools | 227 | **29** |
| SessionStart hooks fired | 4 | **0** |
| `model` | `claude-fable-5` (user `settings.json`) | `claude-opus-5[1m]` (built-in default) |
| `permissions.defaultMode` | `auto` (user `settings.json`) | `default` (built-in default) |

The 16 survivors are the built-ins, and nothing else:

> `deep-research`, `design-sync`, `dataviz`, `update-config`, `verify`, `debug`, `code-review`,
> `simplify`, `batch`, `fewer-permission-prompts`, `doctor`, `loop`, `schedule`, `claude-api`,
> `run`, `run-skill-generator`

ADR 0003's design-phase measurement was ~199 skills → ~11 built-ins. The shape holds; both
sides drifted (more user-scope plugins installed since, more built-in skills shipped since).
**The count is not the invariant and the check does not pin it.** What the check pins is the
behaviour: zero plugins, zero `<plugin>:<name>` entries, zero user SessionStart hooks, user
`settings.json` no longer applying, and the flag never *adding* a skill that a default session
lacked.

### Suppression stops at settings sources

`--setting-sources` does not govern MCP servers, because they are configured in `~/.claude.json`,
which is not a settings source. With the flag alone, user MCP servers still appeared. Adding the
rest of the ADR 0003 recipe removed them:

```
--strict-mcp-config --mcp-config '{"mcpServers":{}}'   ->  0 servers
```

This is not a gap in the recipe — it is why the recipe has two MCP flags in it. Worth stating
explicitly because "`--setting-sources` gives you a hermetic session" is the tempting shorthand,
and it is wrong.

## Finding 2 — `--settings` outranks both settings files

Three layers, each carrying two independently observable keys — project `.claude/settings.json`
(`haiku` / `acceptEdits`), local `.claude/settings.local.json` (`sonnet` / `plan`), and a file
passed to `--settings` (`opus` / `auto`):

| Flags | resolved `model` | resolved `defaultMode` | winner |
|---|---|---|---|
| `--setting-sources project` | `claude-haiku-4-5-20251001` | `acceptEdits` | project |
| `--setting-sources project,local` | `claude-sonnet-5` | `plan` | local |
| `--setting-sources project --settings f.json` | `claude-opus-5` | `auto` | `--settings` |
| `--setting-sources project,local --settings f.json` | `claude-opus-5` | `auto` | `--settings` |
| …with the same JSON passed inline instead of as a path | `claude-opus-5` | `auto` | `--settings` |

**Order: `--settings` > `.claude/settings.local.json` > `.claude/settings.json`.** A file path and
an inline JSON string behave identically.

The merge is per key and recurses into nested objects — it does not replace a layer:

- `--settings '{"model":"opus"}'` over a local layer setting both keys → `model` from `--settings`,
  `permissions.defaultMode` still `plan` from local.
- `--settings '{"permissions":{"allow":[…]}}'` — a *sibling* of `permissions.defaultMode` —
  left `permissions.defaultMode: plan` from local intact.

### What this means for the Launcher

`--settings` is the right injection point for the Harvenv's generated settings: it is the top of
the stack, so ADR 0005's "Manifest settings are binding" survives a teammate's
`.claude/settings.local.json`.

But because the merge is per key rather than per layer, precedence alone cannot express ADR 0005's
"an Overlay may add keys the Manifest left unset". If Manifest and Overlay were injected as two
layers, whichever lands lower silently loses on conflict instead of being rejected. **Sync must
merge Manifest and Overlay into one `--settings` payload itself, and reject Overlay conflicts at
merge time** — the flag stack cannot enforce that rule on harvenv's behalf.

One trap found on the way: `permissions.defaultMode` accepts a narrower value set in a settings
file than `--permission-mode` does on the command line. `"manual"` is valid as a CLI flag but is
discarded in a settings file, and the key falls back to `default` — silently, with no error in
`-p` mode. Manifest → settings generation has to validate against the settings schema, not the
CLI's.

## Finding 3 — `--plugin-dir` namespaces every Component it serves

A marker plugin in the Store (`.claude-plugin/plugin.json` naming it `harvenv-spike`, plus one
skill, one subagent and one slash command) loaded two ways:

| Served via | Skill | Subagent | Slash command |
|---|---|---|---|
| `--plugin-dir <store path>` | `harvenv-spike:harvenv-spike-skill` | `harvenv-spike:harvenv-spike-agent` | `harvenv-spike:harvenv-spike-command` |
| `.claude/skills/…` in project scope | `harvenv-spike-skill` | `harvenv-spike-agent` | `harvenv-spike-command` |

The prefix is not an alias. Under `--plugin-dir` the bare name is **absent** from the session's
skill list — `harvenv-spike-skill` simply does not exist, only `harvenv-spike:harvenv-spike-skill`
does. The two mechanisms produce different invocation names for identical files.

Materializing into project scope as **symlinks into the Store** rather than copies loads
identically — bare names for all three Component kinds, both for a per-entry symlink
(`.claude/skills/<name>` → Store) and for a whole-directory symlink (`.claude/skills` → Store).
So the naming benefit does not have to be paid for in duplicated bytes.

This decides the question the issue posed. Recorded as **[ADR 0008](../adr/0008-components-materialized-into-project-scope.md)**.

## Re-running this

The check is the artifact; this document is its first result. It is written to become Doctor's
version smoke test (`harv doctor`), which is why it reports per-check rather than aborting on the
first failure, and why `--json` exists.

Verified behaviours of the check itself:

| | outcome |
|---|---|
| All expectations hold | prints `3/3 checks passed`, exits **0** |
| An expectation pinned to the wrong value | that check prints `FAIL`, exits **1** |
| `claude` absent from `PATH` | all three checks report `spawn claude ENOENT`, exits **1** |
| User scope contributes nothing to suppress | Finding 1's marker expectations report `n/a` rather than passing vacuously |

The script is TypeScript per ADR 0007 and uses only `node:` built-ins, so it runs under `bun`
(the project runtime) or `node` ≥ 22.18 (which strips types natively). The measurements above
were taken with Node 26.0.0; `bun` was not installed on the measuring machine.

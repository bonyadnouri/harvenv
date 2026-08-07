# Spike 0003 — what `--plugin-dir` names, and how whole a plugin arrives

Measured 2026-08-07 against **Claude Code 2.1.223** on macOS 25.5.0 (darwin arm64), by the same
method as [spike 0001](./0001-launch-recipe-verification.md): the `system`/`init` event Claude Code
emits under `--output-format stream-json --verbose`, read from a fresh fixture tree, with the
session killed the moment `init` arrives.

ADR 0008 reserved `--plugin-dir` for real plugin pins on the strength of finding 3 — that the flag
renames what it serves. Building the pins raised three further questions the flag's behaviour
decides, and none of the answers is documented. The check that re-measures them is
`scripts/verify-plugin-pins.ts`; this document is its first result.

## Finding 1 — the name comes from `plugin.json`, and falls back to the directory

Three plugin directories, served one at a time under the ADR 0003 recipe:

| Directory on disk | `.claude-plugin/plugin.json` | plugin name in `init` | skill in `init` |
|---|---|---|---|
| `named-dir` | `{"name": "harv-probe-alpha"}` | `harv-probe-alpha` | `harv-probe-alpha:alpha-skill` |
| `f3a9c2b10e4d5678` | `{"name": "harv-probe-beta"}` | `harv-probe-beta` | `harv-probe-beta:beta-skill` |
| `harv-probe-gamma` | *(absent)* | `harv-probe-gamma` | `harv-probe-gamma:gamma-skill` |

So the served directory's name is a **fallback**, not an alias — it decides the plugin's name exactly
when the plugin declares none. That is not a rare case: of the 95 plugins published by the 11
marketplaces installed on the measuring machine, **19 carry no `plugin.json`**, including
`agent-browser@agent-browser` and `marketing-skills@marketingskills`.

A Store entry's directory is a hash digest. Serving those 19 plugins straight out of the Store would
therefore name them `1f9ecfc3…:some-skill`. Hence the named link: harv materializes
`.claude/harv-plugins/<name>` and points the flag at that.

Repeated with the link in place, and the target still hash-named:

| `--plugin-dir` | target | `plugin.json` | plugin name in `init` |
|---|---|---|---|
| `.claude/harv-plugins/harv-link-nameless` | `store/a1b2c3d4…` | *(absent)* | `harv-link-nameless` |
| `.claude/harv-plugins/harv-link-named` | `store/0f1e2d3c…` | `{"name": "harv-link-named"}` | `harv-link-named` |

The flag follows the symlink and reports the *link's* path, so both rules now give the pinned name.
`--plugin-dir` is repeatable and the two loaded together with no interaction.

### The link directory is inert on its own

With `.claude/harv-plugins/` populated but **no** `--plugin-dir` flag passed, `init` reported
`plugins: []` and none of the fixtures' skills or commands. Project scope does not discover it, so
what a session loads is decided by the flags harv passes and nothing else.

## Finding 2 — a plugin's hooks fire

A plugin whose `hooks/hooks.json` registers a `SessionStart` command writing a receipt file: the
receipt was written, under the full ADR 0003 recipe, with `--setting-sources project,local`
suppressing every user hook at the same time.

Counting `hook_started` events before `init` does **not** show this — that count stayed 0 while the
receipt was written anyway. The receipt is the measurement; the event count is not.

This is the empirical basis for the wholesale-plugin caveat in the Manifest reference. A pinned
plugin runs code from its own tree at session start, and nothing in the Manifest can pin the skills
without the hooks.

## Finding 3 — a plugin's MCP servers do not survive `--strict-mcp-config`

The same plugin, shipping a `.mcp.json`, under two flag sets:

| Flags | `mcp_servers` in `init` |
|---|---|
| recipe with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | *(empty)* |
| same, without `--strict-mcp-config` | `plugin:harv-whole:whole-mcp` — **plus every user server** |

So the flag that keeps the user's servers out keeps the plugin's out too, and dropping it to admit
the plugin's would admit the user's as well — which ADR 0002 forbids. There is no flag combination
here that serves one without the other, so harv keeps the recipe and Sync warns by name when a
pinned plugin ships a server. Serving them means merging them into harv's own `--mcp-config`
payload, which is the settings/MCP slice's job.

Worth noting for that slice: served this way the server is namespaced `plugin:<plugin>:<server>`,
and it appeared as `pending` — `init` races asynchronous MCP registration, exactly as spike 0001
recorded.

## Re-running this

```
node scripts/verify-plugin-pins.ts          # human-readable, exits 1 on any violation
node scripts/verify-plugin-pins.ts --json    # machine-readable, for Doctor
node scripts/verify-plugin-pins.ts --keep    # leave the fixture tree on disk to poke at
```

The check pins the behaviour rather than the numbers: it asserts that a pinned plugin's skill,
command and subagent are present under the pinned name, that its hook fired, that no MCP server
reached the session, and that a plugin declaring no name of its own still answers to the one it was
pinned as. Counts of the machine's own plugins are reported, never asserted — and when a machine has
no user plugins to suppress, the suppression expectations report `n/a` rather than passing
vacuously.

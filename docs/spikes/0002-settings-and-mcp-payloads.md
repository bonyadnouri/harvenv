# Spike 0002 — what a settings payload and an MCP payload actually do

Measured 2026-08-07 against **Claude Code 2.1.223** on macOS 25.5.0 (darwin arm64).

Spike 0001 established where the Harvenv's settings go (`--settings`, top of the precedence
stack) and that a Manifest-declared skill keeps its bare name. It left two questions open that
ADR 0005 depends on: *which* keys a settings file honours, and what happens to an MCP server
definition on its way into a session. Both matter because the failure mode is silence — Claude
Code accepts a payload, drops the parts it does not recognise, and starts a session that quietly
does something other than what the Manifest said.

The check is the artifact; this document is its first result:

```
node scripts/verify-manifest-settings.ts          # human-readable, exits 1 on any violation
node scripts/verify-manifest-settings.ts --json   # machine-readable, for Doctor
node scripts/verify-manifest-settings.ts --keep   # leave the fixture tree on disk to poke at
```

## Method

As in spike 0001, session facts come from the `system`/`init` event emitted under
`--output-format stream-json --verbose`. Two observables do most of the work here, and both are
findings in their own right (below): denied tools vanish from `init.tools`, and an MCP server's
tools arrive as `mcp__<server>__<tool>`. A probe MCP server that names its only tool after an
environment variable therefore makes "did that reference resolve, and to what?" a string in
`init`, with no model in the loop.

Where a value is settings-schema-only and produces no observable at all, it is read out of the
CLI's own bundled settings schema (`strings` over the compiled binary) and labelled as such —
that is weaker evidence than a measurement, and the findings say where the line is.

## Finding 1 — a settings file honours a narrower effort set than `/effort` does

`effortLevel` is the settings key; `effort` is not a key at all. The session command offers seven
levels, the settings schema four:

| | accepted values |
|---|---|
| `/effort <level>` (the command's own usage line) | `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`, `auto` |
| `effortLevel` in a settings file (bundled schema) | `low`, `medium`, `high`, `xhigh` |

`--settings '{"effortLevel":"max"}'` starts a normal session and exits 0. So does
`--settings '{"effortLevel":"bogus"}'`, and so does `--settings '{"totallyMadeUpKey":123}'`.
Nothing is printed in any of the three cases.

This is spike 0001's `permissions.defaultMode: "manual"` trap a second time, which makes it a
shape rather than an accident: **the settings schema is narrower than the CLI's, and the gap is
silent.** harv validates the keys a Manifest is allowed to bind against the settings schema, not
the CLI's.

## Finding 2 — the resolved effort level is not observable

Unlike `model` and `permissionMode`, which `init` reports resolved, effort appears nowhere
machine-readable. Checked and empty: the `init` event's fields, the `result` event (including
`usage`, `modelUsage` and `permission_denials`), `--debug` and `--debug api` on stderr,
`--debug-file`, and `/status` (which reports "isn't available in this environment" under `-p`).
`/effort` with no argument prints its usage line rather than the current level in print mode, and
under `-p` no `thinking` content blocks are emitted at any level, so there is no indirect read
either.

Consequence for verification: the pin can be verified as far as harv's own boundary — the
generated payload carries `effortLevel`, and the session accepts it — and no further. The check
reports that half as `n/a` with the reason rather than passing vacuously. If a later Claude Code
surfaces the resolved effort, this is the finding to revisit.

## Finding 3 — a denied tool is removed from the session, and a bad transport removes a server

`permissions.deny` is not only enforced at call time; the tool is gone from the session's
inventory. With `deny = ["Bash", "WebSearch"]`, `init.tools` no longer lists either, and the
session says so in its own words when asked to run a command: *"I don't have a Bash/shell tool in
this session"*. (`Glob` and `Grep` appear in exchange, so the check compares the named tools, not
the count.)

The same shape shows up in MCP configuration, one level worse:

| `--mcp-config` server definition | `init.mcp_servers` |
|---|---|
| `{"command":"node","args":[…]}` | `[{"name":"probe","status":"connected"}]` |
| `{"type":"stdio","command":"node",…}` | `[{"name":"probe","status":"connected"}]` |
| `{"type":"bogus","command":"node",…}` | `[]` — the server is dropped, silently |

The user-facing transports on 2.1.223 are `stdio` and `http`; `sse-ide`, `ws-ide` and
`claudeai-proxy` exist in the schema but are marked internal-only. A `type` outside the set takes
the whole server down without a word, so harv rejects it at generation time.

Server registration was stable across repeated runs for a local stdio server — three of three
gave `connected` plus the expected `mcp__<server>__<tool>` entry. Spike 0001's warning that
`mcp_servers` races registration still stands for the machine's own servers over the network; it
does not apply to the local probe this check uses.

## Finding 4 — Claude Code expands `${VAR}` itself, including when the variable is unset

An inline `--mcp-config` payload gets environment substitution from the launching process's
environment. Measured in both `env` values and `args` entries:

```
env  = {"HARVENV_PROBE_SECRET":"${HARVENV_OUTER}"}   with HARVENV_OUTER=expandedbyclaude
  ->  mcp__probe__saw_expandedbyclaude

args = [".../mcp-probe.mjs", "${HARVENV_OUTER}"]     with HARVENV_OUTER=argexpanded
  ->  mcp__probe__saw_argexpanded
```

And when the variable is **not** set:

```
args = [".../mcp-probe.mjs", "${HARVENV_NEVER_SET_ANYWHERE}"]
  ->  mcp__probe__saw___HARVENV_NEVER_SET_ANYWHERE_        server status: connected
```

The literal string `${HARVENV_NEVER_SET_ANYWHERE}` is handed to the server, which connects with
it. For a token that means an authentication failure inside somebody else's tool, one layer away
from the Manifest that caused it. (Claude Code does have a "Missing environment variables" check —
for *plugin* MCP configs. It does not cover `--mcp-config` payloads.)

### What this means for the Launcher

harv resolves `${VAR}` itself rather than passing references through, even though passing them
through would keep resolved secrets out of `claude`'s argv. Three reasons, in order of weight:

1. The unset case is silent breakage, and harv can name the variable and the server instead.
2. Expansion is observed behaviour on the fields it was measured on; leaning on it would mean
   mapping every field of every transport and re-measuring each release.
3. It is spike 0001's lesson again — precedence could not enforce ADR 0005 either, and Sync had to
   merge the payload itself. A rule harv is responsible for is a rule harv has to implement.

The cost is real and is recorded as such: a resolved payload travels in argv, which other
processes on the machine can read (`ps`). The alternative — writing a generated MCP config into
the project tree — is the one thing the `${VAR}` design exists to avoid. If a later slice wants
both, finding 4 is where it starts.

## Re-running this

Like spike 0001's check, `verify-manifest-settings.ts` reports per-check rather than aborting on
the first failure, and takes `--json`, so it can become part of `harv doctor`.

What it can and cannot catch is worth being plain about. It catches a value harv allows that
Claude Code has started rejecting, a denial that stops denying, a suppressed server that comes
back, and a resolved secret that lands on disk. It cannot catch a value Claude Code has started
*accepting* that harv still rejects — nothing is observable on that side of finding 1 — so the
enum lists are maintained against the bundled schema, not measured.

# Spike 0004 — what a session tells Doctor about its MCP servers

Measured 2026-08-07 against **Claude Code 2.1.223** on macOS 25.5.0 (darwin arm64), by the same
method as [spike 0001](./0001-launch-recipe-verification.md): the `system`/`init` event Claude Code
emits under `--output-format stream-json --verbose`, read from a fresh fixture directory, with the
session killed the moment `init` arrives.

Issue #9 asks Doctor to report "MCP servers still needing first-time auth". Nothing in a Manifest
records that: an OAuth grant is personal to a machine, it is not a Component, and harv never sees
it. So the question is whether a session says. It does — but only if you know which word to look
for, and the words are not documented.

## Finding 1 — `init.mcp_servers[].status` distinguishes all four states Doctor cares about

The same probe, four server definitions, each served under the ADR 0003 recipe with
`--strict-mcp-config --mcp-config <payload>`:

| Server as declared | `init.mcp_servers[0].status` |
|---|---|
| a working stdio server | `connected` |
| `{"command": "definitely-not-a-real-command-xyz"}` | `failed` |
| an http server behind OAuth, never authorized on this machine | `needs-auth` |
| a server still registering when `init` was emitted | `pending` |

`needs-auth` is the one the issue is about, and it is a distinct value rather than a flavour of
`failed` — which is what makes "run `/mcp` once" a hint Doctor can give with confidence instead of
"something went wrong with this server".

The machine's own servers, read from a bare session for comparison, showed the same vocabulary and
nothing else: of the 14 configured on the measuring machine, 9 reported `connected`, 3
`needs-auth`, and 2 `pending`.

## Finding 2 — `pending` is a race, not a verdict

Spike 0001 recorded that `init` is emitted before asynchronous MCP registration finishes, so a
server's status at that instant is a snapshot rather than an outcome. Repeated runs against the
machine's own servers moved individual entries between `pending` and `connected` with no change to
anything.

So Doctor treats the four statuses as three answers:

- `connected` — the check passes.
- `needs-auth`, `failed`, or anything unrecognised — a problem, named, with what to do.
- `pending` (and `connecting`) — **unverified**, not failed. Reported, exit code unaffected.

That asymmetry is the whole reason Doctor has a third status at all (ADR 0014). A check that
turned a race into a red build would be wrong on some fraction of runs, and the fraction would be
worst exactly where it hurts most: on a slow CI runner.

## Finding 3 — a server Claude Code cannot read is absent rather than failed

Spike 0002 (finding 3) recorded that a definition with an unrecognised `type` is dropped in
silence: the server does not appear in `init.mcp_servers` at all, with no status of any kind.
Doctor therefore compares the servers it declared against the servers that came back, and reports
a name that went missing — otherwise the loudest failure mode would be the one producing no
output. harv already rejects a bad `type` at generation time, so this is the backstop for a shape
nobody has met yet rather than the primary check.

## Finding 4 — the smoke test is two probes, and costs about four seconds

`harv doctor` re-measures ADR 0003's launch recipe on every run that can start a session. Timed on
the measuring machine, `harv doctor` in a project with no MCP servers completed in **4.1s** wall
clock, including both probes — the bare session and the one under the recipe. A third probe is
added only when the project declares MCP servers, because there is otherwise nothing to connect.

That is cheap enough to run by default, which is the point: a smoke test nobody runs pins nothing.
`--no-session` skips it for the machines that cannot start a session at all, and says so in the
report rather than passing quietly.

## Re-running this

```
node scripts/verify-doctor.ts          # human-readable, exits 1 on any violation
node scripts/verify-doctor.ts --json    # machine-readable
node scripts/verify-doctor.ts --keep    # leave the fixture tree on disk to poke at
```

Its `live-recipe` check is the part of this document that re-measures the real thing; the rest run
against a scripted `claude`, so a status this spike recorded can be turned into a fixture rather
than waited for. On a machine with no credentials the live check reports `n/a` with the reason —
which is the same rule the command itself follows.

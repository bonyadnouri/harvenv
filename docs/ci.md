# harvenv in CI

ADR 0002 ends in a consequence rather than a mechanism: *CI runs with Manifest
only (no Overlay), giving a canonical baseline harness.* This is that recipe.

A CI runner is the ideal harvenv user. It has no personal skills, no settings
it accumulated over a year, and no memory of the last project it built — so a
session it starts is the Harvenv the Manifest describes and nothing else. That
makes CI two things at once: a place to run Claude Code as part of a build, and
the strictest available test of whether the Manifest really does describe the
environment your team is working in. If a run needs something the Manifest does
not declare, CI is where you find out — before the teammate who cloned the repo
this morning does.

The runnable version of everything below is
[`.github/workflows/harvenv.yml`](../.github/workflows/harvenv.yml), which runs
on every push to this repository against the sample Manifest in
[`examples/ci/`](../examples/ci/). Its `recipe` job is meant to be copied.

## The recipe

```yaml
- uses: actions/checkout@v7

# harv, and the Claude Code it will launch. Pin the version — see "Pinning
# Claude Code" for why it is part of what your Harvenv is.
- run: |
    curl -fsSL https://raw.githubusercontent.com/bonyadnouri/harvenv/main/install.sh | sh
    npm install --global @anthropic-ai/claude-code@<version>

# Content-addressed, so a restored cache is never stale. See below.
- uses: actions/cache@v6
  with:
    path: ~/.harv/store
    key: harv-store-${{ runner.os }}-${{ hashFiles('harvenv.lock') }}
    restore-keys: harv-store-${{ runner.os }}-

# Clone, sync, launch — the same three steps a teammate performs, in the same
# order. `harv claude` never fetches (ADR 0009), so the sync is not optional.
# `--no-overlay` states the baseline rather than relying on the runner being
# bare — see "The Overlay in CI".
- run: harv sync --no-overlay

# The gate that costs nothing: a Sync that rewrote the Lockfile means the
# committed one is not what a clean machine produces.
- run: git diff --exit-code -- harvenv.lock

# Is this Harvenv actually runnable on this runner? Drift, Components and tools
# that are not here, MCP servers waiting on auth, the Tripwire — and ADR 0003's
# launch-recipe smoke test against the Claude Code installed above. Exits
# non-zero on any problem. See "The Doctor gate".
- run: harv doctor --json --no-overlay

- run: harv claude --no-overlay -p 'summarize the diff on this branch' --output-format json
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## The Overlay in CI

`--no-overlay` is harv's own flag, taken out of the arguments before the rest is
passed through, and it leaves the Overlay out of both commands entirely: no
staples file, no per-project extras, no personal settings key.

On a hosted runner it changes nothing, because there is nothing there to leave
out. It is in the recipe for the two cases where that stops being true — a
self-hosted or reused runner with an `overlay.toml` in its `$HARV_HOME`, and a
cache key that restores more of that directory than the Store — and because
ADR 0002's consequence is a claim the recipe should make rather than one the
environment happens to satisfy. If a run starts behaving differently on one
runner than another, this is the flag that removes a whole class of reason.

`harv claude` passes everything else after it through untouched and adopts the
session's exit code, so the last step is an ordinary `claude -p` and an ordinary
build gate: a session that fails fails the job, and its stdout can be piped into
`jq` like any other command's.

harvenv's own workflow installs harv from the checkout instead of from a
release, because a workflow that installed the published binary would be
checking the last release rather than the pull request in front of it. That is
the only line in its `recipe` job that is not the recipe above, apart from the
`claude` stand-in described at the end of this document.

Do not install the Shim on a runner. It exists so that a human who types
`claude` out of habit still gets the Harvenv; a workflow has no habits, and a
step that says `harv claude` says what it runs. The project's committed Tripwire
is equally a non-issue here — the Launcher marks its sessions, so the hook stays
silent rather than opening every CI log with a warning that does not apply.

## Auth

harv composes launch flags. It does not manage credentials, and it never will:
auth is personal, and a credential is not a Component (see
[CONTEXT.md](../CONTEXT.md)). So authenticating a CI session is the same job it
would be without harv — set `ANTHROPIC_API_KEY` from a repository secret, and
Claude Code reads it from the environment as usual. harv passes the environment
through untouched, which `scripts/verify-ci-recipe.ts` checks directly, along
with the other half of that claim: the key never reaches the command line, so it
cannot surface in a process listing or a `set -x` trace.

Three things follow from auth being outside harv:

- **A subscription login is not available to CI.** ADR 0003 keeps the user
  config directory intact precisely so that a developer's OAuth session keeps
  working; a runner has no such session and no browser to make one. API key it
  is. Third-party providers (Bedrock, Vertex) are configured with their own
  environment variables and are equally none of harv's business.
- **`harv sync` needs no credentials at all.** Resolving and fetching Sources is
  git, not Claude Code, so a job that only warms the Store — a nightly, a fork's
  pull request — needs no secret. Only the launch step does.
- **Pull requests from forks get no secrets**, so the launch step will fail
  there. Either guard it (`if: github.event.pull_request.head.repo.fork ==
  false`) or split the workflow so the Manifest-only checks, which need nothing,
  still run on every contribution.

### MCP servers need their own secrets

A `[mcp]` server definition is committed, so it cannot carry the token the
server needs. The Manifest names a variable — `env = { TICKETS_TOKEN =
"${TICKETS_TOKEN}" }` — and harv resolves it from the environment of whoever is
launching, which in CI means one more `env:` line on the launch step:

```yaml
- run: harv claude -p '...'
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    TICKETS_TOKEN: ${{ secrets.TICKETS_TOKEN }}
```

That is the whole mechanism, and its two edges are worth knowing. An unset
variable is an error naming the variable rather than a server that starts and
then fails to authenticate — so a missing secret fails the step legibly. And the
resolved value travels in `claude`'s argv, which is visible to other processes
on the runner; on a shared or self-hosted runner, weigh that.

## Pinning Claude Code

Install a version, not `@latest`:
`npm install --global @anthropic-ai/claude-code@<version>`.

The Launcher is a recipe of native flags (ADR 0003), and three of the behaviours
it depends on — user-scope suppression above all — are observed rather than
documented. Any release can retire one silently. Pinning makes that a change you
make deliberately, on a pull request where the checks can catch it, rather than
one that arrives between two otherwise identical runs.

`harv doctor` re-measures those behaviours against whatever version you pinned,
which is what makes the pin a decision rather than a hope: harv also carries a
list of the versions it has verified the recipe against, but that list is a
remark and the measurement is the verdict. A newer Claude Code on which the
recipe still holds is a note in the report; one on which it does not is a
problem naming the behaviour that stopped holding.
`scripts/verify-launch-recipe.ts` is the same measurement at full width — 13
probes rather than two — and the `session` job runs it when credentials are
available.

## Caching the Store

Cache `~/.harv/store` (or wherever `HARV_HOME` points). It is the machine-global
pool every project's Components are served from, and on a runner it is the
entire difference between a Sync that clones every Source and one that touches
no network at all.

It is an unusually easy thing to cache, because a Store entry is named by a hash
of its own content (ADR 0010). Entries are immutable: the bytes at an address
are the bytes that address means, so a restored cache can be wrong only by being
incomplete, never by being stale. There is no invalidation problem to get wrong.

The key still moves with the Lockfile, for a different reason: it is what gives
a changed Harvenv its own saved snapshot instead of appending to the old one
forever. `restore-keys` then makes the previous snapshot a warm base, so
changing one entry re-fetches one entry.

```yaml
- uses: actions/cache@v6
  with:
    path: ~/.harv/store
    key: harv-store-${{ runner.os }}-${{ hashFiles('harvenv.lock') }}
    restore-keys: harv-store-${{ runner.os }}-
```

Two consequences worth knowing. A warm Store makes the run resilient rather than
merely fast — with every locked hash already present, `harv sync` and
`harv claude` both complete with no remote reachable, which
`scripts/verify-ci-recipe.ts` proves by running them against a `git` that
records being called and then fails. And the Store is shared across projects on
the same runner, so a monorepo with several Harvenvs caches one directory, not
one per project.

## The Doctor gate

Between the Lockfile check and the launch:

```yaml
- run: harv doctor --json --no-overlay
```

It is the step that turns "a session started" into "a session could have
worked": Manifest/Lockfile drift, Components and tools that are not on this
runner, MCP servers waiting on first-time auth, the Tripwire — and the one CI
needs most, the Claude Code version smoke test ADR 0003 asks for. It exits
non-zero on any problem, so it is a gate without further wiring.

Put it **after** the step that installs Claude Code, not immediately after the
sync. The smoke test is a real session: Doctor has to be able to find a binary
before it can measure one, and a runner that has not installed Claude Code yet
gets a report whose first line is that it is missing.

`--json` prints one report on stdout and nothing else, so a job can assert on
the parts it cares about rather than on the whole of it:

```yaml
- run: |
    set -euo pipefail
    harv doctor --json --no-overlay | tee "$RUNNER_TEMP/doctor.json"
    jq -e '.ok == true' "$RUNNER_TEMP/doctor.json" > /dev/null
```

The shape is fixed. `version` is the report format, `ok` is "no check found a
problem", and `checks` is always the same seven ids in the same order —
`claude-code`, `settings`, `drift`, `components`, `toolchain`, `mcp`,
`tripwire` — whether or not the project has any MCP servers or tools to talk
about, so a gate never has to ask what a project contains before reading it.
Each carries a `status` of `ok`, `problem` or `unknown`, a one-line `summary`,
and `findings` with a `message` and, on every problem, a `hint`.

`unknown` is the third answer, and it is why the exit code stays readable: it
means Doctor could not ask the question on this machine — no credentials to
start a probe session with, an MCP server still registering when the session
reported in — and it does **not** fail the command
([ADR 0014](./adr/0014-doctor-reports-three-statuses.md)). A CI runner without
`ANTHROPIC_API_KEY` is the common case, and a gate that failed there would
teach a team to delete the gate. A job that wants the stricter rule can have
it:

```yaml
- run: jq -e '[.checks[].status] | index("unknown") == null' "$RUNNER_TEMP/doctor.json"
```

`--no-session` skips everything that needs to start Claude Code, and says so in
the report rather than passing quietly. It is the right flag for a job that
only wants the offline half — drift, Components, tools, the Tripwire — and does
not want to spend a session on the rest.

## What a run without credentials proves

This repository has no Claude subscription and sets no API key, so its own
workflow cannot start a real session. Rather than pretend otherwise, it splits
the claim in two.

**What harv hands over** is measured on every run, by
`node scripts/verify-ci-recipe.ts`. It runs the recipe against a fixture Store
and a fixture `$HOME` with a personal skill, a conflicting `settings.json` and
an MCP server planted in it — a machine that looks like a developer's, not a
clean room — and checks what a runner ends up with:

- a clean Store plus the committed Lockfile reproduces the Harvenv, every
  Component resolving to the Store entry its locked content hash names, and the
  Lockfile is not rewritten in the process;
- project scope holds exactly the declared Components, and the personal skill on
  the machine is not among them;
- the session is handed `--setting-sources project,local`, the Manifest's
  settings rather than the machine's, `--strict-mcp-config` naming the
  Manifest's servers and not the machine's, no `--plugin-dir` and no
  config-directory redirect;
- it is marked as a Launcher session, so the project's committed Tripwire stays
  silent instead of opening every CI log by announcing that the session is not
  isolated — which it is;
- `harv claude -p` passes its arguments through, passes the session's output
  through, and exits with the session's exit code;
- a warm Store makes both sync and launch network-free;
- an API key travels through the environment and never through the arguments.

The Doctor gate runs on those same credential-free runs, and most of it means
something there: drift, the Components in the Store, the tools, the Tripwire.
Its first check does not — the stand-in `claude` this workflow uses answers no
`init` event, so the launch recipe is reported as unverified with the reason,
which is exactly the case ADR 0014 exists for. In a repository with a key it is
the check that measures the recipe on every run.

**What Claude Code then does with those flags** is not measured, because it
cannot be without a session. That is `verify-launch-recipe.ts`,
`verify-walking-skeleton.ts` and `verify-manifest-settings.ts`, which the
`session` job runs only when `ANTHROPIC_API_KEY` is set — and which, in this
repository, have therefore never run in CI. On a developer's machine they run
against the real thing:

```
node scripts/verify-launch-recipe.ts     # what current Claude Code does with the recipe's flags
node scripts/verify-walking-skeleton.ts  # a real session loads the Harvenv and nothing else
node scripts/verify-manifest-settings.ts # settings and MCP definitions are binding in one
node scripts/verify-ci-recipe.ts         # this document, executed
```

`verify-ci-recipe.ts` takes `--project <dir>`, so it can be pointed at your own
project's Manifest rather than the sample one; like its siblings it takes
`--json` and `--keep`, and it touches neither your Store nor your `~/.claude`.

harv's own unit tests, `verify-sync-store.ts` — the Store guarantees the caching
above rests on — and `verify-doctor.ts` — the gate above, including the failure
classes it only detects during a session, scripted with a `claude` that emits
the `init` event it is told to — need git but neither credentials nor a network,
and run in [`ci.yml`](../.github/workflows/ci.yml) rather than here.

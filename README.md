# harvenv

**Harness virtual environments for Claude Code.**

harvenv makes a Claude Code harness configuration a reproducible property of a project — the way uv makes a Python environment one. A committed manifest (`harvenv.toml`) declares the skills, agents, commands, settings, MCP servers, plugins, and system tools a project needs; `harv sync` materializes them from a machine-global store; `harv claude` launches hermetic sessions that load exactly the declared environment — your teammate clones the repo and gets the identical harness, out of the box.

- Same manifest → same harness → same output quality, across teammates and CI.
- Personal staples survive through a declared, uncommitted overlay — nothing loads by accident.
- No config-dir tricks: isolation is a launch recipe of native Claude Code flags. Your login, history, and MCP auth are never touched.

## Install

```
curl -fsSL https://raw.githubusercontent.com/bonyadnouri/harvenv/main/install.sh | sh
```

One file lands in `~/.local/bin` (set `HARV_INSTALL_DIR` for somewhere else, `HARV_VERSION` for a specific release). It carries its own runtime and the pinned [mise](https://mise.jdx.dev) the Toolchain will use, so there is nothing to install first — no Node, no Bun, no sudo. macOS and Linux, arm64 and x64; Windows is deferred.

Or, once the tap is set up, `brew install bonyadnouri/harv/harv`. Or take the archive for your platform from [Releases](https://github.com/bonyadnouri/harvenv/releases) and put `harv` on your PATH — every release publishes `checksums.txt` beside them.

```
harv --version           # which harv, which mise, and whether you are behind
```

## Status

Skills work end to end: `harv init` scaffolds a project and plants the Tripwire, skills are declared by git coordinate, `harv sync` fetches them into a machine-global Store and writes a Lockfile, and `harv claude` launches a hermetic session serving them from it. Settings and MCP servers are declared and binding. No Overlay, Toolchain or Doctor yet, and the remaining Components — agents, commands, plugin pins — are still ahead. mise ships inside harv but nothing drives it yet; `harv mise` reaches it for diagnosis.

The domain language lives in [CONTEXT.md](./CONTEXT.md); the decisions and their trade-offs live in [docs/adr/](./docs/adr/). The implementation plan is the issue tracker — issues are thin vertical slices in dependency order.

## Using it

`harv init` turns a directory into a harvenv project. It writes three things and overwrites none of them:

- **`harvenv.toml`** — a valid, empty Manifest that documents itself.
- **`.gitignore` entries** — `.claude/skills/` and `.claude/.harv-materialized.json` are materialized by harv, `.claude/settings.local.json` and `harvenv.local.toml` are personal. None of them belong in a commit. (`harvenv.lock` is not on that list: it is committed.)
- **the Tripwire** in `.claude/settings.json` — the committed warning ([ADR 0012](./docs/adr/0012-tripwire-is-a-self-contained-session-start-hook.md)) that makes a bare `claude` announce it is not isolated:

  > ⏵ SessionStart:startup says: harvenv: this session is NOT isolated — it loads your user scope, not the Harvenv that harvenv.toml declares. Run `harv claude` instead, or opt into the harv shim to route plain claude through it here.

  A `harv claude` session runs the same hook and it stays silent, because the Launcher marks its sessions with `HARV_SESSION=1`. It is a self-contained shell one-liner, so it still warns a teammate who has never installed harv.

Init is safe on a project that already has its own `.gitignore` and `.claude/settings.json`: it appends the entries that are missing, merges the Tripwire alongside whatever hooks are already there, and leaves everything else byte-identical. Re-running it changes nothing.

A Manifest declares what the project's Harvenv contains: skills from git repositories, plus the settings and MCP servers the session runs with.

```toml
# harvenv.toml
[skills]
brainstorming = { git = "https://github.com/obra/superpowers.git", ref = "v6.2.0", subdir = "skills/brainstorming" }
house-style   = { path = "vendor/skills/house-style" }

[settings]
model = "opus"
effortLevel = "high"

[settings.permissions]
defaultMode = "plan"
deny = ["Bash(git push:*)"]

[mcp.tickets]
command = "npx"
args = ["-y", "tickets-mcp"]
env = { TICKETS_TOKEN = "${TICKETS_TOKEN}" }
```

`ref` and `subdir` are optional: without a `ref` harv follows the repository's default branch, and without a `subdir` the repository *is* the skill. There is no registry — a Source is a repository you can already clone (ADR 0004), so private repos work through whatever credentials your `git` already has.

The `[skills]` key is the name the session answers to — the Manifest entry, the invocation, and the skill's own published name are one string (ADR 0008), so harv rejects a skill whose `SKILL.md` disagrees with its key. A key is one path segment (`[A-Za-z0-9][A-Za-z0-9._-]*`): it becomes a directory harv creates and later removes, and a Manifest arrives from a clone, so it is checked rather than trusted.

Four commands:

```
harv init                # scaffold the Manifest, the gitignore entries and the Tripwire
harv add brainstorming --git https://github.com/obra/superpowers.git@v6.2.0#skills/brainstorming
harv sync                # resolve every entry into the Store and write harvenv.lock
harv claude              # a session composed strictly from this Manifest
harv claude -p "hi"      # anything after `claude` passes through untouched
```

`harv add` writes the entry into `[skills]` and syncs it; a coordinate may carry its ref and subdirectory as `@ref` and `#subdir`, or you can pass `--ref` and `--subdir` separately. It edits the Manifest as text, so your comments and ordering survive, and it puts the file back if the Source turns out not to be fetchable.

`harv sync` resolves each entry, fetches what the Store does not already hold, and writes `harvenv.lock` pinning both the commit SHA and a hash of the content that commit produced. **Commit the Lockfile** — it is what makes a teammate's Harvenv identical to yours.

`harv claude` finds `harvenv.toml` in the working directory or the nearest ancestor — switching environments is just `cd` (ADR 0001) — links the locked skills into `.claude/skills/` as symlinks into the Store, and starts Claude Code with the [ADR 0003](./docs/adr/0003-isolation-via-launch-flags.md) flag recipe. It never fetches: if the Manifest and the Lockfile disagree it names the entries and stops, rather than launching a session that is not the one the Manifest describes ([ADR 0009](./docs/adr/0009-launcher-never-syncs.md)). Outside a harvenv project it says so and stops too.

So the workflow after cloning a harvenv project is `harv sync`, then `harv claude`.

Both commands judge everything they can from the Manifest and your environment before the first write, so a Manifest that cannot launch leaves no Lockfile and no trace in the project tree.

### Settings are binding

`[settings]` is Claude Code's own settings schema, verbatim — harv does not invent a second vocabulary to translate. What harv adds is that the keys actually take effect for everyone (ADR 0005): the block is injected at the top of the precedence stack, so a teammate's `settings.local.json` cannot quietly move the project onto a cheaper model.

Because "binding" is worth nothing if a key can be dropped in transit, harv checks what it is asked to bind. Claude Code accepts a settings payload without complaint and then discards what it does not recognise: `permissions.defaultMode = "manual"` is a valid `--permission-mode` flag but not a valid setting, and `effortLevel = "max"` is a valid `/effort` argument but not a valid setting. Both fall back in silence. harv rejects them instead, and names what to write.

Personal-ergonomics keys are the other half of ADR 0005's split, and a Manifest may not set them at all — `statusLine`, `theme`, `editorMode` and their siblings are refused with an error naming the key and the rule. A key harv cannot confidently classify stays binding; if a setting should be personal, the Manifest simply doesn't set it.

### MCP servers

`[mcp]` entries become the session's MCP configuration, launched with `--strict-mcp-config` so the servers in the session are exactly the declared ones — the machine's own global and per-project servers do not load. The table key is the name the server's tools carry (`mcp__tickets__…`), so it is vocabulary teammates read and type, and it follows the same one-segment rule a skill key does.

A Manifest is committed, so it carries `${VAR}` references rather than credentials. harv resolves them from the environment of whoever is launching, at launch, and never writes the result anywhere: not into the Manifest, not into the project tree, not into a generated file. A reference whose variable is unset fails the launch naming the variable and the server — left to Claude Code, an unset `${VAR}` is substituted as the literal string and the server connects with it ([spike 0002](./docs/spikes/0002-settings-and-mcp-payloads.md), finding 4). One caveat worth knowing: the resolved payload travels in `claude`'s argv, which other processes on the machine can read via `ps`. That is the accepted trade for never writing it down.

### The Store

Fetched content lands in `~/.harv/store`, addressed by a hash of the tree itself rather than by the commit it came from ([ADR 0010](./docs/adr/0010-store-addressed-by-content-hash.md)). Two projects declaring the same skill share one copy, and the second one syncs with no network access at all — the Lockfile already says which bytes it needs, and the Store either has them or does not. `HARV_HOME` moves the whole thing, which is what CI and the verification scripts use.

A Source declared by `path` is allowed and stays live — it is materialized straight from where it sits, never copied into the Store, so you can develop a skill in-tree. It is also the one thing a clone cannot reproduce, so every Sync warns about it by name.

Materialized skills are harv's to manage: it records what it wrote, removes only what it recorded, and refuses to touch a `.claude/skills/` entry it did not create. `harv init` is what gitignores them.

## Hacking on it

Running from source needs Node ≥ 22.18 or Bun, `git` on PATH, and the repo's dependencies:

```
npm install
node bin/harv.ts init
node bin/harv.ts sync
node bin/harv.ts claude
```

Building the binaries needs [Bun](https://bun.sh) — a build-time dependency only (ADR 0007):

```
bun scripts/vendor-mise.ts --all     # fetch the pinned mise for every platform
bun scripts/build.ts --all           # four binaries + checksums.txt + harv.rb in dist/
```

`bun scripts/vendor-mise.ts --update <version>` re-pins mise from its own published checksums, so bumping the Toolchain engine is a reviewable diff.

Cutting a release is a tag — the version is baked in from it, and nothing else needs editing:

```
git tag v0.1.0 && git push origin v0.1.0
```

The [release workflow](./.github/workflows/release.yml) cross-compiles all four platforms from one runner, publishes them, and then installs the result on four clean machines before touching the Homebrew tap. A tag with a hyphen in it (`v0.2.0-rc.1`) publishes as a pre-release and is kept out of the tap.

## Verifying

The behaviours this rests on are measured, not assumed.

[Spike 0001](./docs/spikes/0001-launch-recipe-verification.md) records what current Claude Code does with the flags the recipe needs — behaviours that are observed rather than documented, so any release can retire them silently:

```
node scripts/verify-launch-recipe.ts     # exits non-zero if a behaviour the recipe needs has changed
```

The second check runs the real `harv` against the real `claude` and confirms the walking skeleton's acceptance criteria end to end — what the session actually loads, that the user's config directory is neither redirected nor written to, and that extra arguments arrive verbatim:

```
node scripts/verify-walking-skeleton.ts  # exits non-zero if a criterion no longer holds
```

The third runs `harv` against real git repositories and a real Store, and confirms that a clean clone reproduces byte-identical Components from the Lockfile, that a hash mismatch fails loudly, and that drift is caught at both sync and launch. Two of its claims are about things *not* happening — no re-fetch, no session — so it proves them by putting a `git` and a `claude` on PATH that record being run and then fail:

```
node scripts/verify-sync-store.ts        # needs git; needs no claude binary and no network
```

The fourth does what the second does, for binding settings and MCP definitions — that a pinned model reaches the session, that a denied tool is gone from it, that a declared server connects while the machine's own stay absent, and that a `${VAR}` resolves at launch without landing on disk. [Spike 0002](./docs/spikes/0002-settings-and-mcp-payloads.md) records what it found on the way, including the one half of one criterion current Claude Code makes unobservable:

```
node scripts/verify-manifest-settings.ts # exits non-zero if a criterion no longer holds
```

The fifth covers `harv init` and the Tripwire: that the scaffolded Manifest really launches, that a bare `claude` session really carries the warning, that a `harv claude` session really does not, and that a second init leaves the project byte-identical:

```
node scripts/verify-tripwire.ts          # exits non-zero if a criterion no longer holds
```

The sixth builds a binary and checks what shipping it promises: that it runs with no Node or Bun anywhere on PATH, that the mise it claims to carry is really inside it and really runs, that each archive matches its published checksum, and — once a release exists — that `install.sh` installs it and that an older build says so:

```
bun scripts/verify-packaging.ts          # add --all to build every platform
```

All six take `--json` (for Doctor, once it exists) and `--keep` (to leave the fixture tree on disk). None of them touch your Store or `~/.claude`. The unit tests are separate and need no `claude` binary:

```
npm test
```

# harvenv

**Harness virtual environments for Claude Code.**

harvenv makes a Claude Code harness configuration a reproducible property of a project — the way uv makes a Python environment one. A committed manifest (`harvenv.toml`) declares the skills, agents, commands, settings, MCP servers, plugins, and system tools a project needs; `harv sync` materializes them from a machine-global store; `harv claude` launches hermetic sessions that load exactly the declared environment — your teammate clones the repo and gets the identical harness, out of the box.

- Same manifest → same harness → same output quality, across teammates and CI.
- Personal staples survive through a declared, uncommitted overlay — nothing loads by accident.
- No config-dir tricks: isolation is a launch recipe of native Claude Code flags. Your login, history, and MCP auth are never touched.

## Status

Skills work end to end: declare them by git coordinate, `harv sync` fetches them into a machine-global Store and writes a Lockfile, and `harv claude` launches a hermetic session serving them from it. No Overlay, Toolchain or Doctor yet, and Components other than skills — agents, commands, MCP servers, plugin pins — are still ahead.

The domain language lives in [CONTEXT.md](./CONTEXT.md); the decisions and their trade-offs live in [docs/adr/](./docs/adr/). The implementation plan is the issue tracker — issues are thin vertical slices in dependency order.

## Using it

A Manifest declares what the project's Harvenv contains: skills from git repositories, plus an optional settings block.

```toml
# harvenv.toml
[skills]
brainstorming = { git = "https://github.com/obra/superpowers.git", ref = "v6.2.0", subdir = "skills/brainstorming" }
house-style   = { path = "vendor/skills/house-style" }

[settings]
model = "opus"
```

`ref` and `subdir` are optional: without a `ref` harv follows the repository's default branch, and without a `subdir` the repository *is* the skill. There is no registry — a Source is a repository you can already clone (ADR 0004), so private repos work through whatever credentials your `git` already has.

The `[skills]` key is the name the session answers to — the Manifest entry, the invocation, and the skill's own published name are one string (ADR 0008), so harv rejects a skill whose `SKILL.md` disagrees with its key. A key is one path segment (`[A-Za-z0-9][A-Za-z0-9._-]*`): it becomes a directory harv creates and later removes, and a Manifest arrives from a clone, so it is checked rather than trusted.

Three commands:

```
harv add brainstorming --git https://github.com/obra/superpowers.git@v6.2.0#skills/brainstorming
harv sync                # resolve every entry into the Store and write harvenv.lock
harv claude              # a session composed strictly from this Manifest
harv claude -p "hi"      # anything after `claude` passes through untouched
```

`harv add` writes the entry into `[skills]` and syncs it; a coordinate may carry its ref and subdirectory as `@ref` and `#subdir`, or you can pass `--ref` and `--subdir` separately. It edits the Manifest as text, so your comments and ordering survive, and it puts the file back if the Source turns out not to be fetchable.

`harv sync` resolves each entry, fetches what the Store does not already hold, and writes `harvenv.lock` pinning both the commit SHA and a hash of the content that commit produced. **Commit the Lockfile** — it is what makes a teammate's Harvenv identical to yours.

`harv claude` finds `harvenv.toml` in the working directory or the nearest ancestor — switching environments is just `cd` (ADR 0001) — links the locked skills into `.claude/skills/` as symlinks into the Store, and starts Claude Code with the [ADR 0003](./docs/adr/0003-isolation-via-launch-flags.md) flag recipe. It never fetches: if the Manifest and the Lockfile disagree it names the entries and stops, rather than launching a session that is not the one the Manifest describes ([ADR 0009](./docs/adr/0009-launcher-never-syncs.md)). Outside a harvenv project it says so and stops too.

So the workflow after cloning a harvenv project is `harv sync`, then `harv claude`.

### The Store

Fetched content lands in `~/.harv/store`, addressed by a hash of the tree itself rather than by the commit it came from ([ADR 0010](./docs/adr/0010-store-addressed-by-content-hash.md)). Two projects declaring the same skill share one copy, and the second one syncs with no network access at all — the Lockfile already says which bytes it needs, and the Store either has them or does not. `HARV_HOME` moves the whole thing, which is what CI and the verification scripts use.

A Source declared by `path` is allowed and stays live — it is materialized straight from where it sits, never copied into the Store, so you can develop a skill in-tree. It is also the one thing a clone cannot reproduce, so every Sync warns about it by name.

Materialized skills are harv's to manage: it records what it wrote, removes only what it recorded, and refuses to touch a `.claude/skills/` entry it did not create. Add `.claude/skills/` and `.claude/.harv-materialized.json` to the project's `.gitignore` — they are generated, not authored. `harvenv.lock` is not: it is committed.

Running it needs Node ≥ 22.18 or Bun, `git` on PATH, and the repo's dependencies:

```
npm install
node bin/harv.ts sync
node bin/harv.ts claude
```

The self-contained binary of ADR 0007 (`bun build --compile`) is not built yet.

## Verifying

Both of the behaviours this rests on are measured, not assumed.

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

All three take `--json` (for Doctor, once it exists) and `--keep` (to leave the fixture tree on disk). None of them touch your Store or `~/.claude`. The unit tests are separate and need no `claude` binary:

```
npm test
```

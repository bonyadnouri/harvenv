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

Walking skeleton. `harv claude` launches a hermetic session from a Manifest that declares skills by local path. No Store, Lockfile, Overlay, Toolchain or Doctor yet — those are the slices ahead. mise ships with harv but nothing drives it yet; `harv mise` reaches it for diagnosis.

The domain language lives in [CONTEXT.md](./CONTEXT.md); the decisions and their trade-offs live in [docs/adr/](./docs/adr/). The implementation plan is the issue tracker — issues are thin vertical slices in dependency order.

## Using it

A Manifest declares what the project's Harvenv contains. Today that means skills from local paths, plus an optional settings block:

```toml
# harvenv.toml
[skills]
grill-with-docs = { path = "vendor/skills/grill-with-docs" }

[settings]
model = "opus"
```

The `[skills]` key is the name the session answers to — the Manifest entry, the invocation, and the skill's own published name are one string (ADR 0008), so harv rejects a skill whose `SKILL.md` disagrees with its key. A key is one path segment (`[A-Za-z0-9][A-Za-z0-9._-]*`): it becomes a directory harv creates and later removes, and a Manifest arrives from a clone, so it is checked rather than trusted.

```
harv claude              # a session composed strictly from this Manifest
harv claude -p "hi"      # anything after `claude` passes through untouched
```

`harv claude` finds `harvenv.toml` in the working directory or the nearest ancestor — switching environments is just `cd` (ADR 0001) — links the declared skills into `.claude/skills/`, and starts Claude Code with the [ADR 0003](./docs/adr/0003-isolation-via-launch-flags.md) flag recipe. Outside a harvenv project it says so and stops, rather than starting a session that only looks isolated.

Materialized skills are harv's to manage: it records what it wrote, removes only what it recorded, and refuses to touch a `.claude/skills/` entry it did not create. Add `.claude/skills/` and `.claude/.harv-materialized.json` to the project's `.gitignore` — they are generated, not authored.

## Hacking on it

Running from source needs Node ≥ 22.18 or Bun, plus the repo's dependencies:

```
npm install
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

The third builds a binary and checks what shipping it promises: that it runs with no Node or Bun anywhere on PATH, that the mise it claims to carry is really inside it and really runs, that each archive matches its published checksum, and — once a release exists — that `install.sh` installs it and that an older build says so:

```
bun scripts/verify-packaging.ts          # add --all to build every platform
```

All three take `--json` (for Doctor, once it exists) and `--keep` (to leave the fixture tree on disk). The unit tests are separate and need no `claude` binary:

```
npm test
```

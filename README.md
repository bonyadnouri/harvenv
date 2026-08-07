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

Skills, plugin pins and the Toolchain work end to end: `harv init` scaffolds a project and plants the Tripwire — or `harv init --import` walks the machine's existing `~/.claude` and declares it for you — skills are declared by git coordinate, plugins by marketplace coordinate and system tools by version, `harv sync` fetches and installs them into a machine-global Store and writes a Lockfile, and `harv claude` launches a hermetic session serving them from it with the pinned tools in front of its PATH — or a bare `claude` does, if you opt into the Shim. Settings and MCP servers are declared and binding, your personal staples survive through an Overlay that adds to the Manifest without overriding it, and a GitHub Actions workflow runs that whole path on a clean runner on every push. No Doctor yet, and standalone agents and commands are still ahead.

The domain language lives in [CONTEXT.md](./CONTEXT.md); the decisions and their trade-offs live in [docs/adr/](./docs/adr/). The implementation plan is the issue tracker — issues are thin vertical slices in dependency order.

## Using it

`harv init` turns a directory into a harvenv project. It writes three things and overwrites none of them:

- **`harvenv.toml`** — a valid, empty Manifest that documents itself.
- **`.gitignore` entries** — `.claude/skills/`, `.claude/harv-plugins/` and `.claude/.harv-materialized.json` are materialized by harv, `.claude/settings.local.json` and `harvenv.local.toml` are personal. None of them belong in a commit. (`harvenv.lock` is not on that list: it is committed.)
- **the Tripwire** in `.claude/settings.json` — the committed warning ([ADR 0012](./docs/adr/0012-tripwire-is-a-self-contained-session-start-hook.md)) that makes a bare `claude` announce it is not isolated:

  > ⏵ SessionStart:startup says: harvenv: this session is NOT isolated — it loads your user scope, not the Harvenv that harvenv.toml declares. Run `harv claude` instead, or opt into the harv shim to route plain claude through it here.

  A `harv claude` session runs the same hook and it stays silent, because the Launcher marks its sessions with `HARV_SESSION=1`. It is a self-contained shell one-liner, so it still warns a teammate who has never installed harv.

Init is safe on a project that already has its own `.gitignore` and `.claude/settings.json`: it appends the entries that are missing, merges the Tripwire alongside whatever hooks are already there, and leaves everything else byte-identical. Re-running it changes nothing.

If the machine you are on already has years of `~/.claude` behind it, `harv init --import` declares it for you rather than making you retype it — see [Importing a machine you already have](#importing-a-machine-you-already-have).

A Manifest declares what the project's Harvenv contains: skills from git repositories, plugins from marketplaces, the system tools they run on, plus the settings and MCP servers the session runs with.

```toml
# harvenv.toml
[skills]
brainstorming = { git = "https://github.com/obra/superpowers.git", ref = "v6.2.0", subdir = "skills/brainstorming" }
house-style   = { path = "vendor/skills/house-style" }

[plugins]
gsap-skills = { marketplace = "https://github.com/greensock/gsap-skills.git", ref = "v1.0.0" }
[tools]
node = "22.18"

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
harv init --import       # ...and then declare what this machine already has
harv add brainstorming --git https://github.com/obra/superpowers.git@v6.2.0#skills/brainstorming
harv add gsap-skills --marketplace https://github.com/greensock/gsap-skills.git@v1.0.0
harv sync                # resolve every entry into the Store and write harvenv.lock
harv claude              # a session composed strictly from this Manifest, plus your Overlay
harv claude -p "hi"      # anything after `claude` passes through untouched
harv claude --no-overlay # the Manifest alone — what CI and a headless run should see
```

`harv add` writes the entry into `[skills]` — or into `[plugins]`, for `--marketplace` — and syncs it; a coordinate may carry its ref and subdirectory as `@ref` and `#subdir`, or you can pass `--ref` and `--subdir` separately. It edits the Manifest as text, so your comments and ordering survive, and it puts the file back if the Source turns out not to be fetchable.

`harv sync` resolves each entry, fetches what the Store does not already hold, and writes `harvenv.lock` pinning both the commit SHA and a hash of the content that commit produced. **Commit the Lockfile** — it is what makes a teammate's Harvenv identical to yours.

### The Toolchain

`[tools]` declares the system tools — runtimes, CLIs, SDKs — the project's skills run on, as a version spec each. A skill can also carry its own requirement, so a project that adds it does not have to learn what it needs:

```yaml
---
name: house-style
description: ...
requires: node@22, ripgrep
---
```

`harv sync` installs them **project-scoped** ([ADR 0006](./docs/adr/0006-project-scoped-toolchain.md)): into the Store, one directory per exact version, shared by every project on the machine. `harv claude` puts those directories in front of the session's PATH, so a session sees exactly the pinned versions while your shell keeps its own. Nothing on the machine is mutated — no sudo, no system package manager, no writes outside `HARV_HOME`; an existing nvm, brew or asdf setup is untouched.

The Lockfile pins the exact version each spec resolved to, so a teammate installs what you installed rather than what the spec means today ([ADR 0011](./docs/adr/0011-tools-pinned-by-version-not-content-hash.md)). Both routes into the Toolchain end up there, and the Manifest wins when they disagree: a `[tools]` pin overrides what a skill asked for, because Manifest settings are binding ([ADR 0005](./docs/adr/0005-manifest-settings-are-binding.md)). Two skills asking for different versions of the same tool is the one case harv will not guess at — it says so and asks you to pin it.

Installs run through [mise](https://mise.jdx.dev), which harv looks for in three places: `HARV_MISE`, a copy vendored alongside harv itself, then a `mise` already on your PATH. A tool mise has no installer for — or any tool at all when there is no mise to be found — is **not** a failure. It is recorded in the Lockfile as a hint naming who needed it, warned about at sync, and left to the machine's own copy; `harv doctor` will surface it. That is the honest degradation path, not a second install mechanism.

`harv claude` finds `harvenv.toml` in the working directory or the nearest ancestor — switching environments is just `cd` (ADR 0001) — links the locked skills into `.claude/skills/` as symlinks into the Store, and starts Claude Code with the [ADR 0003](./docs/adr/0003-isolation-via-launch-flags.md) flag recipe. It never fetches: if the Manifest and the Lockfile disagree it names the entries and stops, rather than launching a session that is not the one the Manifest describes ([ADR 0009](./docs/adr/0009-launcher-never-syncs.md)). Outside a harvenv project it says so and stops too.

So the workflow after cloning a harvenv project is `harv sync`, then `harv claude`.

Both commands judge everything they can from the Manifest and your environment before the first write, so a Manifest that cannot launch leaves no Lockfile and no trace in the project tree.

### Settings are binding

`[settings]` is Claude Code's own settings schema, verbatim — harv does not invent a second vocabulary to translate. What harv adds is that the keys actually take effect for everyone (ADR 0005): the block is injected at the top of the precedence stack, so a teammate's `settings.local.json` cannot quietly move the project onto a cheaper model.

Because "binding" is worth nothing if a key can be dropped in transit, harv checks what it is asked to bind. Claude Code accepts a settings payload without complaint and then discards what it does not recognise: `permissions.defaultMode = "manual"` is a valid `--permission-mode` flag but not a valid setting, and `effortLevel = "max"` is a valid `/effort` argument but not a valid setting. Both fall back in silence. harv rejects them instead, and names what to write.

Personal-ergonomics keys are the other half of ADR 0005's split, and a Manifest may not set them at all — `statusLine`, `theme`, `editorMode` and their siblings are refused with an error naming the key and the rule. A key harv cannot confidently classify stays binding; if a setting should be personal, the Manifest simply doesn't set it. Where it goes instead is the Overlay.

### Your Overlay

Inside a harvenv session the machine's user scope does not load ([ADR 0002](./docs/adr/0002-user-scope-suppressed-overlay.md)) — that is what makes "same config, same quality" true, and it would make your own staples vanish everywhere if nothing replaced them. The Overlay is what replaces them, and it is declared rather than ambient. Two files, in the same TOML a Manifest uses:

```toml
# ~/.harv/overlay.toml — your staples, in every harvenv project
[skills]
grill-with-docs = { git = "https://github.com/you/skills.git", subdir = "grill-with-docs" }

[settings]
statusLine = { type = "command", command = "~/bin/my-status" }
```

```toml
# harvenv.local.toml — this project only, and gitignored
[skills]
scratch          = { path = "vendor/scratch" }   # add one here
grill-with-docs  = { disable = true }            # or take a staple back out
```

The extras file wins inside the Overlay: a name it declares replaces the staple of the same name, and `{ disable = true }` removes one for this project and no other. A disable that matches no staple is a warning, not a no-op — it is almost always a name that has moved. `[plugins]` is the one table an Overlay cannot carry yet; a plugin pin resolves through a marketplace catalogue the Overlay's Lockfile does not have a table for, so it is refused by name rather than parsed and then quietly not loaded.

**Overlays add, never override.** Everything in the Overlay is unioned on top of the Manifest, and anything the Manifest already declares wins: an Overlay value for a bound settings key, or an Overlay skill or MCP server the Manifest already names, is dropped with a warning naming what was locked and which file tried it. That is ADR 0005 again, enforced in harv's own merge rather than by flag precedence, because `--settings` merges per key and would have resolved the conflict silently ([spike 0001](./docs/spikes/0001-launch-recipe-verification.md), finding 2). The conflict granularity is a leaf: a Manifest binding `permissions.deny` has not bound `permissions.allow`, so an Overlay may still add one.

It is a warning rather than an error because the Overlay is yours and the Manifest may not be — a personal file should not be able to stop you working in someone else's project — and because the outcome that matters is already guaranteed by dropping the value.

`--no-overlay` leaves the whole thing out, on `harv claude` and on `harv sync` alike. It is harv's own flag, taken out before the rest of the arguments are passed through, and it is the baseline CI and a headless run should use.

Because the Launcher never fetches ([ADR 0009](./docs/adr/0009-launcher-never-syncs.md)), `harv sync` pins the Overlay too — into `.harv/overlay.lock`, which `harv init` gitignores, because one person's staples are not part of what the repository hands over ([ADR 0013](./docs/adr/0013-overlay-pinned-in-an-uncommitted-lockfile.md)). Everything else is the same as a Manifest entry: fetched once, addressed by content, shared through the Store with every other project that declares it.

### MCP servers

`[mcp]` entries become the session's MCP configuration, launched with `--strict-mcp-config` so the servers in the session are exactly the declared ones — the machine's own global and per-project servers do not load. The table key is the name the server's tools carry (`mcp__tickets__…`), so it is vocabulary teammates read and type, and it follows the same one-segment rule a skill key does.

A Manifest is committed, so it carries `${VAR}` references rather than credentials. harv resolves them from the environment of whoever is launching, at launch, and never writes the result anywhere: not into the Manifest, not into the project tree, not into a generated file. A reference whose variable is unset fails the launch naming the variable and the server — left to Claude Code, an unset `${VAR}` is substituted as the literal string and the server connects with it ([spike 0002](./docs/spikes/0002-settings-and-mcp-payloads.md), finding 4). One caveat worth knowing: the resolved payload travels in `claude`'s argv, which other processes on the machine can read via `ps`. That is the accepted trade for never writing it down.

### Plugin pins

A `[plugins]` entry pins one plugin out of a marketplace — ADR 0004's native `name@marketplace` coordinate, with the marketplace spelled as what it is underneath: a repository you can clone.

```toml
[plugins]
gsap-skills = { marketplace = "https://github.com/greensock/gsap-skills.git", ref = "v1.0.0" }
```

The key is the plugin's name in that marketplace's `.claude-plugin/marketplace.json`. There is no `subdir`: where a plugin sits inside its marketplace is the marketplace's to state, and harv reads it from the catalogue at the commit it fetched — so a marketplace that reorganizes itself does not break the Manifests that pinned out of it. `harv sync` pins the marketplace commit and a hash of the plugin's own tree, and the Store holds the plugin rather than the catalogue it was listed beside.

**A plugin arrives whole.** Its skills, slash commands, subagents and hooks all load together, and there is no way to take part of one — no `skills = [...]` to narrow it, no way to disable its hooks and keep its skills. That is a property of the mechanism, not a gap in harv: a plugin is one directory that Claude Code loads entire. Pinning one is therefore accepting all of it, its hooks included — and a hook runs commands from the plugin's own tree, so pin plugins you would run code from. Pin a ref you trust, and read what you are pinning.

Everything a plugin carries keeps the plugin's name as a prefix — `gsap-skills:gsap-core`, not `gsap-core`. That is the name the plugin is published under, so unlike skills (which are materialized into project scope precisely to keep their bare names, [ADR 0008](./docs/adr/0008-components-materialized-into-project-scope.md)) the prefix here is correct rather than an artifact of packaging. harv refuses a pin whose key disagrees with the name the plugin publishes, so the Manifest entry and the session's prefix are always the same string.

One part of "whole" is not delivered: a plugin's own MCP servers do **not** reach the session. `--strict-mcp-config` makes the session's servers exactly the ones `[mcp]` declares, which is what keeps your personal servers out ([ADR 0003](./docs/adr/0003-isolation-via-launch-flags.md)), and measurement shows it keeps a plugin's servers out with them. `harv sync` warns by name when a pinned plugin declares one, rather than letting you discover it mid-session; if you want that server, declare it in `[mcp]`, where its command and its `${VAR}` references are visible in the Manifest like every other one.

Pinned plugins are linked under `.claude/harv-plugins/<name>` and served with `--plugin-dir`. The link exists because a plugin with no `.claude-plugin/plugin.json` is named after the directory it is served from, and a Store entry is named after a hash — so harv gives it a directory named what the Manifest calls it. `harv init` gitignores that path along with the others.

### The Store

Fetched content lands in `~/.harv/store`, addressed by a hash of the tree itself rather than by the commit it came from ([ADR 0010](./docs/adr/0010-store-addressed-by-content-hash.md)). Tools live beside it in `~/.harv/store/tools`, addressed by version instead — a runtime is not reproducible byte for byte the way a fetched skill is, so hashing one would report a false alarm on every second machine ([ADR 0011](./docs/adr/0011-tools-pinned-by-version-not-content-hash.md)). Two projects declaring the same skill share one copy, and the second one syncs with no network access at all — the Lockfile already says which bytes it needs, and the Store either has them or does not. `HARV_HOME` moves the whole thing, which is what CI and the verification scripts use.

A Source declared by `path` is allowed and stays live — it is materialized straight from where it sits, never copied into the Store, so you can develop a skill in-tree. It is also the one thing a clone cannot reproduce, so every Sync warns about it by name. An Overlay's path Sources are not warned about: nobody clones an Overlay, so a local directory in one is just where you keep a skill you are still writing.

Materialized Components are harv's to manage: it records what it wrote, removes only what it recorded, and refuses to touch a `.claude/skills/` or `.claude/harv-plugins/` entry it did not create. `harv init` is what gitignores them.

### Importing a machine you already have

Every harvenv project after the first one starts from a Manifest somebody wrote. The first one starts from a machine — months of `/plugin install`, a `~/.claude/skills` nobody has pruned since spring, MCP servers whose tokens sit in a file you have never opened. `harv init --import` scaffolds the project and then walks that pile with you:

```
harv init --import
```

It reads your user scope, groups what it finds, and asks one question per group — not one per skill:

```
  skills from a git repository  (3)
    brainstorming             https://github.com/obra/superpowers.git#skills/brainstorming
    ...
  Where do these go?  [m]anifest (committed, the team baseline)  [o]verlay (personal, every project)  [s]kip  [c]hoose one by one >
```

**The Manifest or your Overlay** is the only judgement it asks you to make, and it is the one nothing else can make for you: `superpowers` is probably the team's, your statusline skill is probably not. `[c]hoose` splits a group when it needs splitting; an empty answer skips, so a stray return never writes anything.

What it does decide, because these are not judgements:

- **Sources are derived where they can be.** A skill that came from a repository is declared by its coordinate — repository, subdirectory, and the commit it is on right now — rather than by the path it happens to occupy on your disk. A plugin becomes its `name@marketplace` coordinate, read out of Claude Code's own registry and pinned at the commit you are running. What it cannot derive, it flags rather than guesses.
- **A plugin can only go to the Manifest.** An Overlay refuses `[plugins]` by name, so the choice is not offered — and the group says why rather than leaving the gap to be discovered.
- **A skill that exists only on your machine is flagged**, with the push it needs spelled out ([ADR 0004](./docs/adr/0004-git-native-addressing-no-registry.md)). It is still declarable — by `path`, which `harv sync` then warns about by name on every run — because a migration that refused half your skills is one nobody finishes. Sent to your Overlay instead, it is not flagged at all: nobody clones an Overlay.
- **A credential is not copied into a committed file.** `~/.claude.json` holds tokens in the clear; a Manifest goes to a git remote. A server definition bound for the Manifest gets `${VAR}` where its token was, and the summary tells you what to export. The same definition sent to your Overlay is left exactly as it was — that file is uncommitted, and rewriting it would break a working server for nothing.

**Nothing in `~/.claude` is written to, ever.** The wizard reads your user scope and writes to the project's Manifest and your own staples file, so adopting harvenv leaves the machine you adopted it on exactly as it was — including if you decide against it.

**Re-running is a no-op.** Anything already declared is listed and not offered again, so there is no path from a second run to a second entry. Install something new next month and run it again; it will offer you that and nothing else. (Something you *skipped* is offered again — a skip is not a decision harv records anywhere.)

Then `harv sync`, and the pile is a Harvenv.

## Intercepting a bare `claude`

Isolation is a launch recipe, so it applies only to sessions harv starts — type `claude` in a harvenv project and you get an un-isolated session that looks exactly like an isolated one ([ADR 0003](./docs/adr/0003-isolation-via-launch-flags.md)). The optional Shim closes that gap:

```
harv shim install        # puts a `claude` lookalike first on PATH
harv shim status         # what `claude` resolves to, and what sits behind it
harv shim uninstall      # takes it back off, PATH entry included
```

With it installed, `claude` inside a harvenv project is the session the Manifest describes, and `claude` anywhere else is Claude Code exactly as before — same arguments, same binary. It is never installed by default, and it never becomes a way to lose the tool it intercepts: the real claude is resolved from PATH at every invocation, so an upgrade that replaces or moves the binary needs no reinstall, and a harv that has gone missing costs you isolation — announced on stderr — rather than the session ([ADR 0011](./docs/adr/0011-shim-is-a-generated-shell-script-that-fails-open.md)).

`HARV_NO_SHIM=1 claude` bypasses it, so [ADR 0005](./docs/adr/0005-manifest-settings-are-binding.md)'s visible escape hatch does not close when interception is on.

Install writes the shim to `$HARV_HOME/bin` (`~/.harv/bin` by default) and adds one marked block to your shell's startup file — zsh, bash, fish or sh. `--shell none` writes the shim and leaves your dotfiles alone, if you would rather put the directory on PATH yourself. Uninstall removes exactly that block and refuses to delete a `claude` harv has no record of creating.

## In CI

A CI runner is the ideal harvenv user: no personal skills, no accumulated settings, no memory of the last project it built. So a session it starts is the Manifest and nothing else ([ADR 0002](./docs/adr/0002-user-scope-suppressed-overlay.md)) — which makes CI both a place to run Claude Code as part of a build and the strictest available test of whether the Manifest really describes the environment your team works in.

The recipe is `harv sync`, a `git diff --exit-code` on the Lockfile, and a headless `harv claude -p`, with `~/.harv/store` cached between runs and `ANTHROPIC_API_KEY` coming from a repository secret. [docs/ci.md](./docs/ci.md) explains each part, including what a runner without credentials can and cannot prove; [`.github/workflows/harvenv.yml`](./.github/workflows/harvenv.yml) runs it on every push to this repository, against the sample Manifest in [`examples/ci/`](./examples/ci/).

## Hacking on it

Running from source needs Node ≥ 22.18 or Bun, `git` on PATH, and the repo's dependencies. A `[tools]` section also needs the vendored mise, which a source checkout fetches with `bun scripts/vendor-mise.ts` — without it, tools degrade to hints rather than failing:

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

The fifth runs a real `harv claude` against a plugin pinned out of a real git marketplace, and confirms that its skills and commands are in the session under the plugin's own name, that the user's own plugins are not, and that a second machine converges on identical bytes from the Lockfile after the marketplace has moved on and relocated the plugin. It also re-measures the three undocumented `--plugin-dir` behaviours the design leans on, recorded in [spike 0003](./docs/spikes/0003-plugin-dir-naming-and-wholeness.md) — where the plugin's name comes from, that its hooks fire, and that its MCP servers do not survive `--strict-mcp-config`:

```
node scripts/verify-plugin-pins.ts       # needs git and claude
```

The sixth covers `harv init` and the Tripwire: that the scaffolded Manifest really launches, that a bare `claude` session really carries the warning, that a `harv claude` session really does not, and that a second init leaves the project byte-identical:

```
node scripts/verify-tripwire.ts          # exits non-zero if a criterion no longer holds
```

The seventh is the CI recipe of [docs/ci.md](./docs/ci.md), executed: it syncs the sample Manifest into an empty Store and launches it against a fixture `$HOME` that has a personal skill, a conflicting `settings.json` and an MCP server planted in it, then checks that the Harvenv is the Manifest and nothing else — the one check that runs on every push to this repository, because it is the only one that needs no credentials. `--project <dir>` points it at your own project instead:

```
node scripts/verify-ci-recipe.ts         # needs git and network; needs no claude binary and no credentials
```

The eighth builds a binary and checks what shipping it promises: that it runs with no Node or Bun anywhere on PATH, that the mise it claims to carry is really inside it and really runs, that each archive matches its published checksum, and — once a release exists — that `install.sh` installs it and that an older build says so:

```
bun scripts/verify-packaging.ts          # add --all to build every platform
```

The ninth runs `harv` against a real, pinned mise and installs a real Node into a fixture Store, then reads back what a session's PATH actually resolves to. Two of its claims are again about absences — no second install, and nothing global touched — so it proves them by removing the possibility: the second project syncs with a `mise` that records being run and then fails, and `sudo` plus every system package manager sit on PATH ahead of the real ones for the whole run, recording any call. It also snapshots the machine's own tool directories before and after and diffs them:

```
node scripts/verify-toolchain.ts         # needs network; uses the vendored or pinned mise
```

The tenth does the second's job for the Shim: it installs one into a scratch `HARV_HOME`, types `claude` into a real shell inside and outside a harvenv project, and compares the resulting sessions against an unshimmed control. Its own last check re-reads the machine's dotfiles and `claude` and asserts the run left them exactly as it found them:

```
node scripts/verify-shim.ts              # exits non-zero if interception, uninstall or
                                         # pass-through has stopped holding
```

The eleventh is the Overlay's: that one staples file reaches two different projects, that a project's extras add a Component and a disable takes a staple out of that project alone, that an Overlay value for a Manifest-bound key is rejected with a warning while the session runs the Manifest's value, and that `--no-overlay` leaves the whole Overlay behind. It reads `init.skills` and `init.model` out of real sessions, and the one thing `init` cannot show — a resolved `statusLine` — out of the payload harv hands over:

```
node scripts/verify-overlay.ts           # needs git and claude
```

The last is the import wizard's: that a fixture user scope's skills, plugins and MCP servers are inventoried and grouped, that each group lands where it was sent with the Sources that were derivable, that a Component which exists only on that machine is flagged with the push it needs, and that a second run asks nothing and writes nothing. It then syncs and launches what the wizard declared, because a Manifest that parses and does not resolve would pass every other check. The whole run is repeated through a real pseudo-terminal, since a pipe is not a terminal and the wizard's users are at one:

```
node scripts/verify-import.ts            # needs git and python3; needs no claude binary,
                                         # no credentials and no network
```

All twelve take `--json` (for Doctor, once it exists) and `--keep` (to leave the fixture tree on disk). None of them touch your Store, your Overlay, your `~/.claude`, your shell's startup files, or your own mise setup. The unit tests are separate and need no `claude` binary and no install engine:

```
npm test
```

# harvenv

**Virtual environments for your Claude Code harness** — like `uv` or `virtualenv`, but for skills, plugins, MCP servers, settings, and tools instead of Python packages.

One committed file declares the complete Claude Code setup a project needs. Anyone who clones the repo runs two commands and works in the identical harness — same skills, same settings, same tool versions, nothing personal leaking in:

```sh
git clone <your-project> && cd <your-project>
harv sync      # fetch and install everything the manifest declares
harv claude    # a Claude Code session with exactly that — and nothing else
```

## Why

If you use Claude Code seriously, you know the problem:

- **Everything you ever installed loads everywhere.** Every skill, plugin, and MCP server in your user scope rides into every project — we measured 200+ skills in a default session on a well-used machine. Irrelevant tools burn context and steer the model.
- **Skills have no installer.** No registry, no versions, no lockfile. Sharing one means "copy this folder."
- **Teammates run different harnesses.** Different skills, models, and permission settings produce visibly different code from the same repo — and nothing in the repo reveals why.

harvenv fixes this the way package managers fixed dependencies:

- **Declared** — `harvenv.toml` lists skills (by git repo), plugins (by marketplace), MCP servers, settings, and system tools.
- **Locked** — `harvenv.lock` pins commits, content hashes, and tool versions, so two machines get identical bytes.
- **Isolated** — `harv claude` sessions load the manifest and *only* the manifest. Your personal favorites follow you through a declared [overlay](./docs/guide.md#your-overlay), never by accident.
- **Non-invasive** — no config-dir tricks, no sudo, no global installs. Your login, history, MCP auth, and existing nvm/brew setup are never touched.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/bonyadnouri/harvenv/main/install.sh | sh
```

One self-contained binary lands in `~/.local/bin` — no Node, no sudo required. macOS and Linux, arm64 and x64 (Windows is deferred). Or grab an archive from [Releases](https://github.com/bonyadnouri/harvenv/releases); every release ships `checksums.txt`.

## Quick start

```sh
cd your-project
harv init                # writes harvenv.toml + a tripwire that warns when claude runs un-isolated
harv add brainstorming --git https://github.com/obra/superpowers.git@v6.2.0#skills/brainstorming
harv sync                # fetch into the machine-global store, write harvenv.lock
harv claude              # hermetic session: your manifest, Claude Code's built-ins, nothing else
```

Commit `harvenv.toml`, `harvenv.lock`, and `.claude/settings.json`. Your teammate's whole setup is now `harv sync && harv claude`.

Already have years of `~/.claude` on your machine? **`harv init --import`** inventories it — skills, plugins, MCP servers — and turns your picks into manifest and overlay entries, deriving git coordinates where it can and stripping credentials into `${VAR}` references. It never writes to `~/.claude`.

## The manifest

```toml
# harvenv.toml — the complete harness, declared
[skills]
brainstorming = { git = "https://github.com/obra/superpowers.git", ref = "v6.2.0", subdir = "skills/brainstorming" }

[plugins]
gsap-skills = { marketplace = "https://github.com/greensock/gsap-skills.git", ref = "v1.0.0" }

[tools]
node = "22.18"            # project-scoped install, on PATH only inside sessions

[settings]                # Claude Code's own schema — and binding for everyone
model = "opus"

[settings.permissions]
deny = ["Bash(git push:*)"]

[mcp.tickets]
command = "npx"
args = ["-y", "tickets-mcp"]
env = { TICKETS_TOKEN = "${TICKETS_TOKEN}" }   # resolved at launch, never written to disk
```

There is no registry: a skill source is any git repository you can clone, so private repos work with the credentials `git` already has.

## Commands

| Command | What it does |
|---|---|
| `harv init` | Turn a directory into a harvenv project (`--import` to declare an existing machine) |
| `harv add <name> --git <repo>[@ref][#subdir]` | Declare a skill and sync it |
| `harv add <name> --marketplace <repo>[@ref]` | Pin a plugin from a marketplace |
| `harv sync` | Resolve the manifest into the store, write the lockfile |
| `harv claude [args…]` | Launch a hermetic session (extra args pass through to `claude`) |
| `harv claude --no-overlay` | The manifest alone — the CI baseline |
| `harv doctor` | Is this synced project actually runnable? (`--json` for CI) |
| `harv shim install` | Optional: make bare `claude` auto-hermetic in harvenv projects |

## Your personal skills still follow you

Hermetic doesn't mean spartan. Declare your staples once, globally, and they join every harvenv session on top of the project baseline — visible, versioned, and impossible to confuse with the team's setup:

```toml
# ~/.harv/overlay.toml — yours, in every project
[skills]
grill-with-docs = { git = "https://github.com/you/skills.git", subdir = "grill-with-docs" }
```

Overlays **add, never override**: anything the manifest declares wins, with a warning. A gitignored `harvenv.local.toml` tunes single projects. Details in the [guide](./docs/guide.md#your-overlay).

## How it works

- Isolation is a **launch recipe of native Claude Code flags** — measured, and re-measured by `harv doctor` on every Claude Code version, since the behavior is observed rather than documented ([ADR 0003](./docs/adr/0003-isolation-via-launch-flags.md)).
- The environment is a **property of the project**: switching environments is `cd` ([ADR 0001](./docs/adr/0001-project-anchored-environments.md)).
- Sources are **git-native** — no registry to run or trust ([ADR 0004](./docs/adr/0004-git-native-addressing-no-registry.md)); the store is content-addressed, so a second project syncs with zero network ([ADR 0010](./docs/adr/0010-store-addressed-by-content-hash.md)).
- Tools install **project-scoped** through a vendored [mise](https://mise.jdx.dev) — sessions see pinned versions, your shell keeps its own ([ADR 0006](./docs/adr/0006-project-scoped-toolchain.md)).
- Every claim above is backed by one of **13 verification scripts** that run the real `harv` against the real `claude` — see [Verifying](./docs/guide.md#verifying).

## Documentation

- **[The guide](./docs/guide.md)** — every feature in depth: manifest reference, the toolchain, binding settings, overlays, MCP, plugin pins, the store, importing, doctor, the shim.
- **[CI recipe](./docs/ci.md)** — running harvenv projects headlessly on GitHub Actions.
- **[CONTEXT.md](./CONTEXT.md)** — the project's domain language.
- **[Design decisions](./docs/adr/)** — 17 ADRs recording why it's built this way, and **[spikes](./docs/spikes/)** measuring the Claude Code behaviors it rests on.

## Status

v0.1.x — skills, plugin pins, tools, settings, MCP, overlay, doctor, shim, and CI all work end to end and are exercised on every push. Still ahead: standalone subagents and slash commands as first-class manifest entries, and plugin pins in overlays ([#29](https://github.com/bonyadnouri/harvenv/issues/29)). Issues are welcome — so are PRs; start with [Hacking on it](./docs/guide.md#hacking-on-it).

## License

[MIT](./LICENSE)

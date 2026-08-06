# harvenv

Tooling that makes a Claude Code harness configuration a reproducible property of a project — declared, locked, and handed over with the code, the way package dependencies are.

## Language

**Harvenv**:
A harness virtual environment — the complete, declared set of harness extensions and configuration a project runs Claude Code with. Always derived from the project's Manifest, never assembled ad hoc.
_Avoid_: HARBINF, profile, workspace

**Manifest**:
The committed file in a project that declares what the project's Harvenv contains. The single source of truth for handoff; settings it declares are binding — an Overlay may add, never override (ADR 0005).
_Avoid_: requirements, config file

**Component**:
A unit the Manifest can declare: a skill, subagent, slash command, settings block, MCP server definition, or plugin pin. Credentials and `CLAUDE.md` are never Components — auth is personal, and project context already travels with git.

**Lockfile**:
The committed, machine-resolved pin of every Manifest entry — exact versions and hashes — so that two Syncs on two machines produce the same Harvenv.

**Overlay**:
A personal, uncommitted set of Components layered on top of a project's Harvenv — declared in one global staples file plus an optional gitignored per-project extras file (which wins on conflict and may disable a staple). Explicit and per-user: the committed baseline stays identical for everyone, and nothing personal loads by accident.
_Avoid_: local config, user scope

**Store**:
The machine-global, deduplicated pool of fetched artifacts that Harvenvs materialize from. Reusing a skill in a second project never re-downloads or copy-pastes it.
_Avoid_: cache (undersells that it is the canonical local copy)

**Sync**:
Realizing the Manifest and Lockfile into a working harness configuration for one project.
_Avoid_: install, activate (activation implies conda-style named environments, which were rejected — see ADR 0001)

**Toolchain**:
The system tools (CLIs, SDKs, runtimes) a Harvenv's skills depend on — installed by Sync into the Store, pinned in the Lockfile, and visible only on the PATH of Launcher-started sessions. Never installed globally.
_Avoid_: system dependencies, prerequisites

**Doctor**:
The diagnosis command that verifies a synced Harvenv is actually runnable: pending MCP auth, missing unscopeable tools, and Claude Code version compatibility.
_Avoid_: healthcheck, validate

**Source**:
The fetchable coordinate a Manifest entry resolves to: a git repository (with optional ref and subdirectory), a plugin marketplace coordinate, or a local path (non-portable, flagged at Sync). There is no central registry — see ADR 0004.
_Avoid_: package index, feed

**Launcher**:
The harv command that starts a Claude Code session composed strictly from the project's Harvenv (Manifest plus Overlay). The only supported way to get a hermetic session.
_Avoid_: wrapper

**Tripwire**:
The committed warning hook every synced project carries, so a bare `claude` session announces it is not isolated instead of failing silently.

**Shim**:
An opt-in `claude` lookalike on PATH that routes through the Launcher inside harvenv projects and passes through everywhere else. Never installed by default.

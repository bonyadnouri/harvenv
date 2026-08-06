# Skill tool dependencies are installed by harv, project-scoped and session-injected

Status: accepted

harvenv owns the full out-of-box promise: `harv sync` installs the system tools skills depend on (CLIs, SDKs, runtimes), not just the skills' files. Installs are project-scoped — tools land in the Store per version (shared across projects), are pinned in the Lockfile, and appear on PATH only inside Launcher-started sessions. The host machine is never mutated: no sudo, no global package-manager calls, existing nvm/brew/asdf setups untouched. Engine-wise harv embeds a mise-style backend rather than inventing per-OS installers. Tools with no scoped installer degrade to a Doctor check with an install hint.

## Considered Options

- **Check, never install** (original recommendation): cleanest boundary, but teammates sync a perfect Manifest and still watch half the skills fail at runtime — breaks the "ready out of the box" goal that motivated the project.
- **Drive system package managers (brew/apt/winget):** familiar results, but global mutation, elevation walls on locked-down machines, version conflicts with existing setups, and a per-OS support matrix.
- **Hybrid (scoped + consented global fallback):** better coverage, two install regimes to document and support forever.

## Consequences

- The Toolchain becomes part of the hermetic environment: teammates and CI run the same pinned tool versions, extending "same config → same quality" below the harness layer.
- The Launcher gains a second job: PATH injection, not just flag composition.
- Coverage is bounded by the scoped-installer ecosystem (mise/asdf/aqua registries); the Doctor-hint fallback is the honest degradation path, not a second install pathway.

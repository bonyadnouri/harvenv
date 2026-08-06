# Environments are project-anchored, not named globals

Status: accepted

harvenv follows the uv/venv model, not the conda model: an environment is derived from a committed Manifest in the project, materialized locally by Sync, and reproduced identically by anyone who clones the repo. There are no free-standing named environments to activate. Chosen because the primary job is reproducible handoff — a repo must fully describe the harness it needs — and cross-project reuse is served by a shared Store rather than by shared mutable environments.

## Considered Options

- **Conda model (named global envs, activated anywhere):** better for ad-hoc switching, but handoff needs an export/import step, projects don't self-describe, and teammates drift.
- **Both from day one:** covers everything but doubles the v1 surface — two lifecycles plus layering/precedence rules before anything ships.

## Consequences

- "Switching environments" is just `cd`. No activation state to manage or forget.
- Personal named overlays (e.g. a writing stack applied on top of any project) can be added later without reversing this decision — the project Manifest stays the spine.

# User scope is suppressed inside a Harvenv; personal additions come through a declared Overlay

Status: accepted

Inside a harvenv project, a Claude Code session loads only Manifest Components plus the user's uncommitted Overlay — never the machine's user scope (`~/.claude`). Chosen because the project's core promise is "same config → same quality" across teammates and CI, which silently dies if each person's personal pile keeps loading. Personal ergonomics survive through the Overlay, which is explicit and per-user rather than accidental.

## Considered Options

- **Layered mode** (user scope keeps loading underneath): works natively today with zero mechanism risk, but reproducibility becomes "baseline plus whatever each person has" and the context bloat from dozens of personal skill listings remains.
- **Pure hermetic** (Manifest only, no Overlay): simplest semantics, but personal staples vanish everywhere, so in practice people pollute shared Manifests with personal picks — a worse outcome than a sanctioned overlay.

## Consequences

- Claude Code has no native way to exclude user scope (docs-verified), so harvenv must control the configuration directory at session launch. The launch/activation mechanism becomes a core part of the tool, not an optional convenience.
- CI runs with Manifest only (no Overlay), giving a canonical baseline harness.

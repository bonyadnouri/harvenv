# Manifest settings are binding; Overlays add, never override

Status: accepted

Any settings key the Manifest sets is locked: an Overlay may add Components and set keys the Manifest left unset, but a conflicting Overlay value is rejected at Sync. This inverts the usual dotfiles precedence (local wins) on purpose — team uniformity of behavior-shaping settings (permissions, hooks, env, model, effort, MCP enablement) is the product's core promise, and "local wins" would let it die silently. Personal-ergonomics keys (statusLine, tui, theme, keybindings) are never Manifest business and stay free.

## Considered Options

- **Overlay wins (classic local-beats-shared):** maximum personal freedom, but a teammate on a cheaper model ships different-quality output and nothing in the repo reveals it.
- **Per-key lock flags:** most expressive; deferred — it can be layered onto "binding by default" later if real demand appears, whereas starting permissive and tightening later breaks people.

## Consequences

- If a setting should be personal, the Manifest simply doesn't set it — Manifest authors choose the contract surface.
- The escape hatch is visible, not silent: a bare un-isolated `claude` session always exists, and the Tripwire announces it.

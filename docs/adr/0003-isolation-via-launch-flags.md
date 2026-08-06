# Isolation via launch-time flags, not config-dir swapping

Status: accepted

harvenv achieves hermetic sessions by launching Claude Code with a composed flag recipe — `--setting-sources project,local` (suppresses the user layer, and with it user skills and plugin enablement), `--settings` (injects the Harvenv's generated settings), `--strict-mcp-config --mcp-config` (only the Harvenv's MCP servers), and `--plugin-dir` (serves Components from the Store) — rather than by pointing `CLAUDE_CONFIG_DIR` at a per-project directory.

Empirical basis (2026-08-07, measured on Claude Code CLI): a fresh `CLAUDE_CONFIG_DIR` loses login credentials ("Not logged in"), onboarding state, and session history; whereas `--setting-sources project` reduced a ~199-skill session (user scope + plugins) to the ~11 built-ins while leaving auth and history intact.

## Consequences

- Auth, history, resume, and MCP OAuth all keep working — the user config dir is never touched.
- Sessions are only hermetic when started through the harvenv launcher; a bare `claude` in the same directory is silently un-isolated. The activation UX must address this.
- The skill/plugin-suppression breadth of `--setting-sources` is observed behavior, not documented contract. harvenv must smoke-test it against each Claude Code version (e.g. a `harv doctor` check) and pin known-good versions.

## Considered Options

- **`CLAUDE_CONFIG_DIR` swap per project:** full control and the obvious venv analogy, but empirically logs the user out, fragments state, and would require fragile credential-sharing (symlinks into every env dir).
- **`--bare` mode:** cleanest slate, but disables OAuth entirely (API-key auth only) — unusable for subscription users.

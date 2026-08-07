# A plugin pin stores the plugin, is served through a link harv names, and is accepted whole

Status: accepted

A `[plugins]` entry is keyed by the plugin's name and declares its marketplace as a repository
coordinate. Sync fetches the marketplace at a commit, reads that commit's
`.claude-plugin/marketplace.json` to find where the plugin sits, and stores **the plugin's own
tree** under its content hash — the Lockfile pinning the marketplace's commit alongside it. The
Launcher links each pinned plugin at `.claude/harv-plugins/<name>` and points `--plugin-dir` at the
link. A plugin is taken entire: there is no syntax for selecting parts of one, because the mechanism
has no such seam.

Chosen because the three questions a plugin pin raises have different answers from a skill's.
*What is fetched* is a marketplace, but *what is loaded* is one directory inside it — and ADR 0010
addresses the Store by the tree a session loads, so storing the catalogue would both bloat the Store
and hash the wrong thing. *Where that directory is* is stated by the marketplace rather than by the
Manifest, so it is read at the pinned commit, which keeps the answer identical everywhere and lets a
marketplace reorganize without breaking its dependants. *What the plugin is called* is decided by
Claude Code, and — measured on Claude Code 2.1.223 (spike 0003) — it takes the name from `.claude-plugin/plugin.json`, or
from the served directory's own name when the plugin has none. Since a Store entry is named after a
hash, serving a plugin straight out of the Store would name roughly a fifth of real marketplace
plugins after a digest.

## Considered Options

- **Store the marketplace, and point `--plugin-dir` inside it:** one fetch serves every plugin a
  project pins from the same marketplace, and provenance stays visible in the Store. But the address
  would no longer be the tree a session loads, so two marketplaces vendoring the same plugin would
  dedupe to nothing, and pinning one plugin out of a large catalogue would store the whole catalogue.
- **Require `.claude-plugin/plugin.json` and serve the Store path directly:** no project writes at
  all, and the plugin's name comes from the plugin. But 19 of the 95 plugins published by the
  marketplaces on the measuring machine declare no `plugin.json`, so this refuses working plugins for
  the sake of avoiding one symlink.
- **Let the Manifest name the plugin's subdirectory:** removes the catalogue read, and makes a pin
  legible without fetching anything. But it duplicates a fact the marketplace already states, and the
  duplicate goes stale the first time a marketplace moves a plugin — precisely when the coordinate
  should keep working.
- **Let a Manifest disable parts of a plugin (its hooks, say, or a subset of its skills):** the
  obvious answer to "I want the skills but not the hooks". But Claude Code loads a plugin directory
  whole, so harv could only fake it by rewriting the plugin's tree on the way into the Store — which
  would mean the bytes a session loads are not the bytes anybody published, the content hash would
  address harv's edit rather than the plugin, and a plugin's own files would have to be understood
  rather than carried. Vendor the parts you want as skills instead.

## Consequences

- Pinning a plugin is trusting it: its hooks fire in the session and run commands from its own tree.
  The Manifest reference says so, because the alternative is a user discovering it mid-session.
- `--strict-mcp-config` suppresses a pinned plugin's MCP servers along with the user's own, so "whole"
  is not yet literally true. Sync warns by name when a pinned plugin ships one; composing a Harvenv's
  MCP servers belongs to the settings/MCP slice.
- Two projects pinning the same plugin from the same commit share one Store entry, and a project
  pinning two plugins from one marketplace fetches that marketplace twice. The second is a real cost
  and a deliberate one: the alternative is caching a fetch, which is a different concern from
  addressing content.
- The Lockfile gains `[[plugins]]`, and its version gates on it — an older harv reading a newer
  Lockfile would otherwise launch a Harvenv silently missing every plugin the project declares.
- `.claude/harv-plugins/` joins `.claude/skills/` as a generated path the project must gitignore, and
  as one harv will remove only entries it recorded creating.

# Component addressing is git-native; no central registry

Status: accepted

Manifest entries resolve to Sources that already exist: git repositories (with ref and subdirectory) for skills, agents, and commands; native `name@marketplace` coordinates for plugins; and local paths, which are allowed but flagged non-portable at Sync. The Lockfile pins commit SHA and content hash. Chosen because a registry is a platform product — service, publishing flow, namespacing, moderation, uptime — that would consume v1, while git coordinates work today for every public and private skill repo with zero infrastructure and give teammates byte-identical fetches.

## Considered Options

- **Central registry from day one:** best UX (bare names, semver) but harvenv would have to build and operate it. Revisit later as a thin name→git index once the git-native core is proven.
- **Plugin marketplaces as sole source:** zero new fetch logic, but every bare skill would need wrapping and publishing as a plugin first — highest friction exactly where the tool must reduce it.

## Consequences

- Bare-name installs (`harv add grill-with-docs`) need an explicit Source until an index exists.
- Versioning is git refs/tags plus content hashes, not semver ranges.
- A skill that exists only on one laptop is not handoff-able until pushed to a repo harv can fetch — keeping personal skills in a personal git repo becomes the expected pattern.

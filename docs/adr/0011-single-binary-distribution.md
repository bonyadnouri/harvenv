# harv ships as one file per platform, with mise inside it, released by tag

Status: accepted

A release is four self-contained binaries — macOS and Linux, arm64 and x64 — each carrying both
its own runtime (`bun build --compile`, ADR 0007) and the platform-matched mise it needs (ADR 0006),
gzipped and unpacked under `~/.harv` the first time the Toolchain is used. Installing is one command
that downloads, verifies against published checksums, and writes a single file into a user-writable
directory; the git tag is the version, baked in at build time, so cutting a release is `git tag`.
Chosen because harvenv's promise is "your teammate clones the repo and it works", and a tool that
opens with "first install Node, then install mise" spends that promise before it has made it.

## Considered Options

- **Ship mise beside the binary in the archive:** ~30MB smaller on disk, because the compressed copy
  inside harv stops being redundant once it is unpacked — but the installer, the Homebrew formula and
  every other channel each have to place a second file at a versioned path, and copying `harv`
  somewhere on its own silently produces a harv with no Toolchain. Embedding makes that class of bug
  unrepresentable.
- **Download mise on first use, pinned by checksum:** the smallest binary, and the same pin — but it
  moves a network round trip into the first `harv sync`, which is exactly the moment someone is
  finding out whether the tool works, and it makes an offline or firewalled machine a broken one.
- **Publish to npm and let `npx harv` work:** familiar to the JS ecosystem harv already lives in
  (ADR 0007), and no install script to maintain — but it reintroduces the Node prerequisite the
  compiled binary exists to remove, and would make harv's own bootstrap depend on the kind of global
  toolchain state ADR 0006 refuses to rely on.
- **Version from `package.json` rather than the tag:** one committed source of truth, visible in a
  diff — but it has to be bumped in lockstep with the tag, and the failure mode is a binary that
  reports a version it is not. The tag is the thing people install by, so it is the thing baked in.
- **A runner per platform instead of cross-compiling:** the conventional matrix, and it builds each
  artifact on the OS it targets — but Bun cross-compiles, so four runners would buy nothing except
  four times the wait. The matrix is spent on *installing* the results instead, which is the part
  that can only be learned on a real machine.

## Consequences

- Binaries are large: ~90MB installed, ~50–70MB compressed, plus ~85MB once mise is unpacked. That is
  the price of the prerequisite-free install, and it is paid on disk rather than in anyone's setup
  instructions.
- The unpacked mise lives at `~/.harv/mise/<version>/mise` — beside the Store, not in it. The Store
  addresses fetched Component trees by content hash (ADR 0010), and mise is neither fetched nor a
  tree: it arrives inside harv, already pinned by the checksum compiled in next to it. Putting it
  under a content address would mean hashing a thing whose identity is already known.
- Every tagged release is installed onto four clean runners before the tap is updated, so
  "one command installs it" is a test that runs, not a claim in a README.
- Linux builds link against glibc, so musl systems (Alpine) are told so by the installer rather than
  meeting an exec format error. Windows stays deferred: `--compile` targets it, but the launch recipe
  (ADR 0003) and symlinked materialization (ADR 0008) have not been measured there.
- The Homebrew tap is a second repository, so the release workflow can only update it when a token is
  configured. Without one the formula is still attached to the release, and the release still
  succeeds — a distribution channel that is not set up must not be able to fail a release.
- Bumping mise is a deliberate, reviewable commit: `bun scripts/vendor-mise.ts --update <version>`
  rewrites `vendor/mise.lock.json` from mise's own published checksums. Nothing bumps it silently.

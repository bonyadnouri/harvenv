# Implementation stack: TypeScript on Bun, shipped as a compiled binary

Status: accepted

harv is written in TypeScript and distributed as a self-contained binary produced by `bun build --compile`; the Toolchain backend (ADR 0006) shells out to a vendored, pinned mise binary rather than linking an install engine. Chosen for ecosystem fit — Claude Code and most skill tooling are Node-based, so contributors and skills already live in JS gravity — while the compiled binary keeps the end-user install zero-dependency.

## Considered Options

- **Go:** static binaries and strong CLI ergonomics, but shells out to mise anyway and sits outside the ecosystem.
- **Rust:** mise is Rust, so the Toolchain engine could be linked as a crate — tightest integration, slowest iteration for this team.

## Consequences

- mise is vendored per platform and pinned in harv's own release process, like any other dependency.
- Bun is a build-time dependency only; end users never need Node or Bun installed.

# Tools are pinned by resolved version and stored per version, not by content hash

Status: accepted

The Store's Toolchain half addresses a tool by `installs/<tool>/<version>` — the install engine's
own layout — rather than by ADR 0010's hash of the tree. The Lockfile records two things per tool:
the exact version a Sync resolved, and the bin directories that version contributes, written
relative to the tools Store root. Those two facts are enough for the Launcher to build a session's
PATH without running the engine at all, which keeps ADR 0009's "the Launcher never syncs" true for
tools as well as for Components.

## Considered Options

- **Hash the installed tree, like a Component (ADR 0010):** one addressing scheme for everything,
  and the same integrity guarantee. But a runtime is hundreds of megabytes, so the hash would have
  to be recomputed on every Sync for it to check anything; and the tree is not reproducible between
  two machines the way a fetched Component is — installers bake absolute prefixes into scripts,
  build native extensions, and ship different bytes per platform. The hash would differ where a
  Component's would not, so the check that exists to catch tampering would spend its life crying
  wolf.
- **Ask the engine at launch (`mise bin-paths` each time):** no new Lockfile fields at all. But it
  makes the engine a launch-time dependency, and it makes a session's PATH a function of what the
  engine says today rather than of what the Lockfile pins — the same reason ADR 0009 keeps
  resolution out of the Launcher for Sources.
- **Derive the bin directory from a convention (`installs/<tool>/<version>/bin`):** free, and right
  for most tools. But it is wrong for the ones that put executables elsewhere, and a PATH that is
  wrong does not fail — it silently resolves to the machine's copy, which is the exact outcome the
  Toolchain exists to prevent.

## Consequences

- Reproducibility for tools rests on the upstream release being immutable, not on bytes harv
  verified. That is genuinely weaker than a Component's content hash, and it is the price of not
  re-hashing a runtime on every Sync. Two machines syncing the same Lockfile install the same
  version; whether that version is the same bytes is the publisher's promise, not harv's.
- The bin paths in the Lockfile are relative, so a pin written on one machine means the same thing
  on another whose `HARV_HOME` is somewhere else. They are also revalidated on read, because a
  Lockfile arrives from a clone and these paths become a session's PATH — a relative path that
  climbed out of the Store would put a directory of someone else's choosing in front of everything
  the user has installed.
- The Launcher needs no install engine. A machine that has synced once can start sessions with its
  pinned Toolchain even if the engine is later removed, and `harv claude` stays a read-only
  operation.
- Dedup is per exact version and machine-global: two projects that pin `node@22.18.0` name the same
  directory, so the second one installs nothing. That is the property projects actually need, and
  it falls out of the address rather than being arranged.
- The two halves of the Store are addressed differently and are documented as such. A reader who
  knows ADR 0010 will expect `sha256/…` everywhere and should be told, once, why `tools/` is not.

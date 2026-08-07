# The Overlay is pinned in an uncommitted Lockfile of its own, beside the project

Status: accepted

A project's Overlay resolves into `.harv/overlay.lock`, in the same format as `harvenv.lock` and
under the same rules, but gitignored. Chosen because the Overlay is caught between two decisions
that would otherwise contradict each other: ADR 0009 says the Launcher never resolves a ref and
never fetches, so a staple has to be pinned somewhere before `harv claude` can serve it — and
ADR 0002 says the Overlay is personal, so that pin cannot be a line in a file the repository
hands over. A second Lockfile at the same scope as the project, outside the commit, is the only
place that satisfies both.

## Considered Options

- **Put the Overlay's entries in `harvenv.lock`:** no new file, no new format, and drift is one
  comparison instead of two — but the committed Lockfile would then name one person's staples,
  which is a change to what the repository claims about itself. Every teammate's `harv sync`
  would produce a different `harvenv.lock`, so the file whose entire job is to be identical
  across machines would be the one file guaranteed not to be.
- **Pin nothing; resolve the Overlay at launch:** the Overlay is not part of the reproducible
  contract, so it is tempting to let the Launcher just fetch what it needs — but that is exactly
  the auto-sync ADR 0009 rejected, and rejecting it for the Manifest while allowing it for the
  Overlay would mean `harv claude` reaches the network *sometimes*, which is worse than either
  rule on its own. "Does this touch the network?" has to stay a question about which subcommand
  ran.
- **One machine-global Overlay Lockfile in `~/.harv`:** the staples file is global, so its
  resolution arguably is too — and a second project would then reuse a pin instead of resolving
  again. But the extras file is per-project and may disable a staple, so a global file would have
  to be keyed by project path to stay correct, which puts a project's state outside the project
  and orphans it the moment a directory is renamed or deleted.

## Consequences

- The first `harv sync` in each project resolves and fetches each staple, because there is no
  pin shared between projects. The Store still holds one copy — both projects address the same
  content hash (ADR 0010), so the cost is a fetch that is discarded, not a second directory. A
  machine-global commit-to-hash index would remove it, and would be a slice of its own.
- Two Lockfiles mean two drift reports, and they are not the same report. The committed one is
  strict in both directions, because it has to agree with the Manifest a teammate reads beside
  it. The Overlay's is strict only about what the Launcher cannot serve: an entry it holds that
  nothing declares any more is not drift, since the file is rewritten by every Sync and nothing
  downstream depends on it.
- `.harv/` joins `.claude/skills/` on the list of paths a harvenv project must gitignore, which
  makes the list long enough that the README has to say it rather than imply it.
- A Sync that is told to leave the Overlay out (`--no-overlay`) deletes the Overlay Lockfile
  rather than leaving a stale one, so the file's presence answers "is there an Overlay here?"
  and never has to be read to find out that it is empty.

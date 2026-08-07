# The Launcher never syncs; drift is reported, not repaired

Status: accepted

`harv claude` reads the Lockfile and refuses to start a session when it disagrees with the
Manifest, naming each entry and telling the user to run `harv sync`. It never resolves a ref,
never fetches, and never writes a Lockfile — those belong to `harv sync` alone. Chosen because
the Lockfile's entire value is that two machines running the same commit get the same Harvenv,
and a Launcher that silently reconciled would make the Lockfile advisory: the first teammate to
launch after an edit would resolve a moving ref, and what a session loaded would depend on who
ran what and when, which is the drift harvenv exists to remove.

## Considered Options

- **Auto-sync at launch (the `uv run` model):** the friendliest — a stale checkout just works.
  But `uv run` reconciles against a lockfile it also writes, so the fix is committed by whoever
  ran it; here the same convenience means a session can quietly load a Component that is in
  nobody's Lockfile, and a teammate reproducing a result gets a different harness with no
  indication that anything happened.
- **Launch anyway, print a warning:** keeps the session available when the drift is harmless.
  But a warning scrolls past above a session the user is already typing into, and the failure it
  predicts — different skills, different output — is invisible at the moment it matters.
- **Fail only when a Component is missing from the Store:** cheap, and catches the case that
  cannot work at all. But a Manifest whose ref moved from `v1` to `v2` still resolves against a
  full Store, so the loudest kind of drift would be the one nothing noticed.

## Consequences

- `harv sync` is a real step in the workflow, not an implementation detail: clone, sync, launch.
  The walking skeleton's "clone and run `harv claude`" is no longer the whole story, and the
  README says so.
- Every code path that can reach a remote lives behind one command, so "does this touch the
  network?" is answered by which subcommand ran, not by reading the call graph.
- The drift report is the tool's main teaching surface for the Manifest/Lockfile relationship —
  it has to name the entry and quote both coordinates, because for most users it is the first
  time the distinction becomes visible.
- A project whose Manifest declares nothing needs no Lockfile, so the smallest possible
  Harvenv — settings only — still launches with no ceremony.

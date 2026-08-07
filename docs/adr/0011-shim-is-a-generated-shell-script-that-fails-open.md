# The Shim is a generated POSIX shell script that fails open to the real claude

Status: accepted

`harv shim install` writes a `claude` lookalike — a POSIX `sh` script — into `$HARV_HOME/bin` and
puts that directory first on PATH through a delimited block in the user's shell startup file. On
every invocation the script resolves the real claude from PATH itself, skipping any directory
carrying harv's shim record; hands over to `harv claude` only when a `harvenv.toml` sits at or
above the working directory; and execs the real claude on every other path, including when harv
has gone missing. `HARV_NO_SHIM=1` bypasses it entirely.

Chosen for one property above all: interception must not be able to remove the tool it
intercepts. A shim owns the name `claude` for everything the user runs, so its failure modes are
Claude Code's failure modes. Every branch therefore ends at the real binary — a broken or absent
harv costs isolation, loudly, never the session.

## Considered Options

- **A thin shim that always delegates (`harv shim exec -- "$@"`):** the Manifest discovery rule
  would live in one place instead of two. But every `claude` on the machine, in or out of a
  harvenv project, would pay a runtime start-up it has no use for, and a harv that fails to start
  takes `claude` down with it — the one outcome the shim must not be able to produce.
- **A symlink into a directory already on PATH (`/usr/local/bin/claude`):** no startup files to
  edit. But it needs write access to a system directory, it takes the name machine-wide with no
  per-shell way to opt out, and uninstall would have to guess what it displaced.
- **A shell function or alias instead of a PATH entry:** nothing on disk, and trivially reversed.
  But it is invisible to everything that is not an interactive shell of that exact flavour —
  scripts, `xargs`, editors, other tools — so "a bare `claude` is hermetic" would hold only
  sometimes, which is worse than not holding at all.
- **Recording the real claude's path at install time:** one fewer PATH walk per run. But Claude
  Code's installer repoints `~/.local/bin/claude` at a fresh versioned binary on every upgrade
  (measured: it is a symlink into `~/.local/share/claude/versions/<version>`), so a recorded path
  pins a version and rots at the next release — exactly the acceptance criterion that says
  upgrades must keep working.

## Consequences

- ADR 0001's discovery rule now exists twice: in `findManifest`, and as a directory walk in `sh`.
  They are pinned to agree by a test that runs both over the same fixture tree.
- The Launcher can no longer spawn `claude` by bare name — with a shim installed, that name is
  harv. It resolves past every shim directory and spawns the absolute path it finds, which is
  what keeps `harv claude` from re-entering the shim that invoked it.
- A shim directory is identified by an ownership record rather than by its path, so a second harv
  installation on the same PATH is skipped too, and removal only ever touches a `claude` harv has
  a record of writing.
- Startup-file edits are a marked block, so uninstall returns the file byte for byte. A file that
  did not end in a newline gains one — the single byte uninstall cannot give back.
- ADR 0005's escape hatch survives the Shim: `HARV_NO_SHIM=1 claude` still reaches an un-isolated
  session, so the visible way out of a binding Manifest does not close when interception is on.
- It also inherits ADR 0009: in a project whose Manifest and Lockfile have drifted, a bare `claude`
  now names the drift and stops rather than starting. That is the Launcher's refusal arriving at
  the command people actually type, which is the point of interception — but it is the one case
  where the Shim makes `claude` do less than it did, and the reason the bypass has to exist.
- Windows gets no Shim in this slice: `harv claude` remains the way in there.

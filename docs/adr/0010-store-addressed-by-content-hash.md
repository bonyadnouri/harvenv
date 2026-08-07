# The Store is addressed by a content hash of the materialized tree, not by the commit

Status: accepted

A Store entry lives at `sha256/<shard>/<digest>`, where the digest is computed by harv over the
exact tree a session will load: every file's relative path, its executable bit, and its bytes —
or, for a symlink, its target — fed in sorted order, with `.git` excluded. The Lockfile records
this hash *alongside* the commit SHA rather than instead of it. The commit says which fetch to
perform; the hash says what that fetch must have produced. Chosen because the two questions a
Sync asks are different: "what should I fetch?" is answered by a commit, and "do I already have
it, and is this the right thing?" is answered only by the content.

## Considered Options

- **Address by commit SHA:** free, already unique, and needs no hashing pass. But one commit
  holds many Components — `subdir = "skills/a"` and `subdir = "skills/b"` are different content
  at the same SHA — so the address would have to become `<sha>/<subdir>`, which reintroduces
  path handling into the address and still dedupes nothing across two repositories that vendor
  the same skill. It also cannot verify anything: a rewritten tag or a tampered remote hands
  back the SHA that was asked for, and only the content reveals it.
- **Use git's own tree SHA (`git rev-parse <commit>:<subdir>`):** free and already
  content-addressed. But it is SHA-1, it is defined only for content that came from git — so a
  local path or a future tarball Source would need a second scheme — and reading it requires a
  git repository to still be present at the moment the question is asked, which is exactly what
  the Store does not keep.
- **Hash a tarball of the tree:** one pass, trivially comparable. But tar carries mtimes, uid,
  gid and entry order, all of which differ between two machines that fetched the same commit, so
  the archive would have to be normalized field by field first — which is this scheme, with an
  archive format in the middle.

## Consequences

- Dedup is repository-agnostic: two projects that vendor the same skill through different
  repositories, refs or subdirectories share one Store entry, because they are the same bytes.
- The hash is the integrity check. A fetch that does not reproduce the locked hash fails the
  Sync loudly rather than materializing content nobody pinned.
- Because the address is derived from content rather than from provenance, a Sync can answer
  "already have it" without contacting a remote — which is what makes the second project on a
  machine, and every re-run on the first, perform no network access at all.
- The hashing rules are a format: they are versioned by a `harvenv-tree-v1` prefix, and changing
  what is fed in invalidates every address, so it costs a re-fetch across every project on a
  machine. Anything a session's behaviour depends on has to be inside the hash from the start —
  the executable bit is in for that reason.
- Path Sources are deliberately outside all of this. A local directory is live, so it is locked
  by neither commit nor hash and is materialized straight from where it sits; that is the same
  fact as its non-portability, which Sync warns about by name.

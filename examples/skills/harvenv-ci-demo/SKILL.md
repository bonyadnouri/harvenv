---
name: harvenv-ci-demo
description: Marker skill for harvenv's own CI recipe example. It does nothing and is never invoked — it exists so a sample Manifest has a real git Source to fetch, lock and materialize.
---

# harvenv-ci-demo

This skill is the payload of the sample Manifest in `examples/ci/`, which the
`harvenv` workflow syncs and launches on every push. It is deliberately inert:
what is being demonstrated is the fetch, the pin and the loading, not the
content.

It carries a nested directory and an executable script so that "byte-identical
on a clean machine" is a claim about a tree with structure, and so that the
executable bit — which is inside the Store's content hash (ADR 0010) — has
something to be measured against.

- [reference/notes.md](reference/notes.md)
- [scripts/greet.sh](scripts/greet.sh)

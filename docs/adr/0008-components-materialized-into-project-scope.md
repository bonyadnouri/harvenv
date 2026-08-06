# Components are materialized into project scope; `--plugin-dir` is reserved for real plugins

Status: accepted

Sync materializes the skills, subagents and slash commands a Harvenv declares into the project's
`.claude/` tree — as symlinks into the Store — and the Launcher lets `--setting-sources project`
pick them up. `--plugin-dir` is not used to serve them; it stays for Manifest entries that are
genuinely plugins (ADR 0004's `name@marketplace` pins). Chosen because `--plugin-dir` renames what
it serves: measured on Claude Code 2.1.223, a skill served that way is invocable only as
`<plugin>:<skill>`, and its bare name is absent from the session entirely (spike 0001, finding 3).
Under that mechanism the name a Manifest declares is not the name the session answers to — the
prefix would be a function of how harv happens to package the Store, so repackaging would rename
every skill in every project. Project materialization keeps the bare name, which makes the
Manifest entry, the invocation, and the skill's own published name the same string.

## Considered Options

- **Serve everything from the Store with `--plugin-dir`:** no writes into the project tree at all
  and the Store stays the only copy — but every skill, subagent and command acquires a namespace
  prefix, cross-references between skills break, and the Manifest would have to carry harv's
  plugin grouping as user-visible vocabulary.
- **One synthetic plugin per Harvenv:** collapses the prefix to a single constant
  (`harvenv:grill-with-docs`), so at least it is stable across repackaging — but it is still not
  the name the skill is published and documented under, and every reference to it in a repo's
  `CLAUDE.md` would be wrong.
- **Materialize by copying instead of symlinking:** no reliance on link-following and no symlink
  privilege problems on Windows — but it duplicates bytes per project and quietly breaks the
  Store's dedup promise. Kept as the Windows fallback rather than the default.

## Consequences

- Sync writes into the project's `.claude/` tree, so those paths must be gitignored and Sync must
  refuse to clobber entries it did not create — materialized Components need an ownership marker
  to be safely removable and safely regenerated.
- Symlink-following for project-scope Components is now load-bearing rather than an optimization,
  and is covered by the launch-recipe check. Platforms without unprivileged symlinks degrade to
  copies, which changes only disk usage, not names.
- `--plugin-dir` keeps a real job: Manifest plugin pins load as plugins and keep their namespace,
  which is correct — that prefix is the name they are published under.
- From inside a session a harvenv project is indistinguishable from a hand-rolled `.claude/`
  setup. That makes migration in and out cheap, and leaves the Tripwire as the only thing that
  tells you which kind of session you are in.

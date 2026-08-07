# Doctor reports three statuses, and only a problem fails the command

Status: accepted

`harv doctor` marks every check `ok`, `problem` or `unknown`, and exits non-zero only for a
`problem`. `unknown` is the honest third answer — the question could not be asked on this machine —
and it is reserved for exactly that: a probe session that could not start because there are no
credentials, an MCP server still registering when `init` was emitted (spike 0004, finding 2), a
Claude Code version nothing has measured because `--no-session` was passed. It is printed as
loudly as a problem and it is in the `--json` report, but it does not fail a build.

Chosen because Doctor's value is entirely in its green meaning something, and the two obvious
two-valued designs each destroy that from a different side. The command exists to be run in CI —
the recipe in [docs/ci.md](../ci.md) puts it between the Sync and the launch — and CI is precisely
where "I could not check this" is most common: a runner with no `ANTHROPIC_API_KEY` cannot start
the session ADR 0003's smoke test needs, and a slow one is where a `pending` MCP server is most
likely.

## Considered Options

- **Two statuses, unknown counts as pass:** the simplest gate, and it never fails for the wrong
  reason. But an unmeasured check and a measured one become the same output, so a project whose
  smoke test silently stopped running for a year reads exactly like one where it passes every
  night. The failure is invisible at the only moment it matters, which is the shape harvenv exists
  to remove.
- **Two statuses, unknown counts as fail:** strictest, and never claims anything it did not
  measure. But the first fork's pull request — no secrets, so no session — fails a check about
  Claude Code's flags, and the fix a team reaches for is to stop running Doctor. A gate that
  punishes an honest non-answer trains people to delete it.
- **A `--strict` flag that promotes unknown to problem:** the escape hatch for both, and cheap to
  add. Deferred rather than rejected: it is additive, nothing about this decision blocks it, and
  shipping it now would mean shipping a second contract before anyone has run the first.

## Consequences

- A check's status is derived from its findings and never asserted separately: a `problem` finding
  makes the check a problem, an `unknown` finding makes it unknown, and nothing else can. Adding a
  check means choosing the level of what it reports, not writing a fourth rule.
- Every `problem` carries a hint. That is not a style preference — it is what distinguishes the
  level: a problem is something the reader can act on, and if there is no action, the finding is a
  note or the check is unknown. `scripts/verify-doctor.ts` asserts it over every problem in two
  whole reports.
- The pinned list of verified Claude Code versions is a remark, not a gate. A version harv has
  never measured is reported — as a note when the smoke test passes on it, as `unknown` when
  nothing measured it — but the measurement decides, so a correct new release does not fail
  anyone's build and a bad one is caught on the release rather than on the pin.
- `--json` has to carry the distinction for the exit code to remain readable, so `status` is part
  of the report's contract alongside the fixed check list. A gate that wants the stricter rule can
  write `jq -e '[.checks[].status] | index("unknown") == null'` today.

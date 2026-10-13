# Procedure — test tiers (fast / full)

**Read this when:** you're about to run tests — naming a leaf's test command in
its spawn prompt, or running the round/unit's full-suite proof yourself. The
always-on half of this (fix agents never commit; deterministic checks gate the
model checks) stays resident in ORCHESTRATION.md → *Code review pipeline*; this
file is the tiering mechanics only.

## Declaring the tiers

A project declares two test tiers, however it already configures test running
(a root script, a test-runner config, a line in `conventions.md`) — nothing
here mandates a specific tool or file format:

- **fast** — the logic/unit tests, plus any suite whose declared files/globs
  the change touches.
- **full** — everything.

A project with no declared tiers runs its one test command as both; nothing
below requires retrofitting tiers onto a project that doesn't have them.

## Who runs which

- **Leaves and `fix` agents run the fast tier only.** Name it as their test
  command in the spawn prompt (ORCHESTRATION.md → *Code review pipeline*, step
  0's deterministic gate) — it is what makes their per-change gate cheap
  enough to run on every iteration.
- **The orchestrator runs the full tier once per round/unit**, on a quiet
  machine with no other agents active, before the top-level squash-merge or
  PR. Never inside a leaf's spawn, and never taken into the orchestrator's own
  context whole — redirect to a log and read the tail / grep for failures
  (ORCHESTRATION.md → *Context discipline*).
- A full-tier run with other agents' leaves still active on the same machine
  can fail rows that pass on a quiet run (resource contention, not a
  regression) — rerun once sequentially on a quiet machine before calling a
  failure real.

## The two integration rules

1. **A guarded SKIP is temporary, not a result.** When a leaf can't exercise
   something because a sibling unit it depends on hasn't merged yet, it writes
   a SKIP row that names the dependency — a visible, known gap, not a
   silently thinner test. The orchestrator tracks live guarded-SKIP rows
   (work-log or continue file) and replaces each with a real check once that
   dependency merges. `test-audit`'s `missing` / `uncovered-criterion`
   findings are what catches a SKIP that outlived its dependency, so treat one
   surfaced there as a real finding, not a false positive.
2. **Fix agents never commit; the root commits the batch.** Already the rule
   for the review loop (ORCHESTRATION.md → *Code review pipeline*, step 5) —
   it holds for a full-tier run too: a `fix` agent's edits stay uncommitted
   until the orchestrator makes one commit for the iteration.

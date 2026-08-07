# Procedure — spawning a CHILD ORCHESTRATOR

**Read this when:** you are handing a sub-unit to another orchestrator rather
than to a leaf, and especially when two or more children will run in parallel.
For leaf spawns the resident template in `ORCHESTRATION.md` is sufficient.

**First, confirm the child is warranted.** Leaves are the default; a child
orchestrator needs BOTH of its conditions (ORCHESTRATION.md → *Delegate or
execute*): the sub-unit would itself spawn ≥3 leaves, AND those leaves need file
partitioning or sequencing between them. Parallelism alone is not a reason —
independent tracks that partition by file are parallel *leaves*, and you can
spawn those yourself in one message without paying for a manager. If only one
condition holds, close this file and spawn leaves.

The template is tier-agnostic, but a child-orchestrator spawn carries four things
a leaf spawn does not: **its depth**, **its sibling isolation**, **the seams it
owns vs. consumes**, and **explicit permission to decompose further**.

Condensed from a real run (`spec 7e0e8fb3`, an epic's API-surface spec split into
three phase groups, each handed to its own orchestrator at depth 1). Field order
is invariant-first, per the resident template:

```
## ACTIVE RULES
<global subset verbatim, plus scoped rules matching this subtree>

## RELEVANT WIKI ENTRIES
<section-level citations — the child re-cites a subset to each of its own leaves>

## CONTEXT
- Worktree: <abs path>/.worktrees/4b5455cc_log-read-surface — you and your leaves
  work ONLY here. Absolute paths; never `cd` into another worktree.
- Branch: main--epic/9f319748_public-market-study--spec/7e0e8fb3_api-surface--impl/4b5455cc_log-read-surface
- Parent task: spec 7e0e8fb3 — the public API surface. I am the session root and
  your spawning agent; validate with me, not the user.
- Your task: the event log and the entire read surface — acceptance criteria 2, 3, 5.
- Your agent ID: orchestrator-log-read-c4e802
- Your depth: 1 (your leaves are depth 2; the cap is 4)
- Project wiki: <worktree>/.wiki/ — read only what is cited above, and pass your
  leaves only what each one needs.

**A sibling orchestrator is running in parallel** on .worktrees/9d5d5653_admission-lifecycle
(Phase 3 — queue, admission, cancel). You cannot see each other and must not try.
The file split below is what keeps you apart.

## YOUR SCOPE
**You own, exclusively:** <file/dir list>
**You must NOT touch:** <the sibling's files, shared packages>
**<shared file> is the one real collision risk.** Keep changes there purely
additive and minimal — do not restructure. I resolve the merge.

## THE SEAM WITH <sibling> — build this, they consume it
<the interface, and: keep it tiny and stable. If you conclude it must change
shape, escalate to me rather than redefining it — the sibling is building against
it right now and cannot see you.>

## MANDATE
**You may decide freely:** <the subtree's internal structure> — including **your
leaf decomposition and how many leaves**.
**You MUST escalate to me:** anything touching <shared surface>; any unsettled
spec conflict; a change to the seam above; a defect finding beyond your assigned scope.

**Decompose and spawn.** You are an orchestrator: spawn `implementation` leaves,
each with its own ACTIVE RULES slice, its own cited wiki entries, and a scope that
does not overlap its siblings. Leaves are terminal. Spawn a child orchestrator of
your own per the defaults in your agent definition.
```

Note what makes it work: the parent partitions **files**, not just tasks; names
the one shared file and reserves the merge for itself; makes the cross-sibling
interface an escalation trigger; and states outright that leaf decomposition is
the child's call. That last line is what actually transfers authority — without
it, a child orchestrator tends to do the work itself.

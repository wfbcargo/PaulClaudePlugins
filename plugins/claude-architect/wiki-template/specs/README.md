# Specs

Per-spec notes that outlive the branch: `<8id>_<slug>.md`. The orchestrator writes
one before spawning implementation work; the `spec-audit` agent checks the
implementation against it. Mark a spec `status: abandoned` at the top rather than
deleting it, so future agents see the history.

## Template

```markdown
---
spec_id: <8hex>
status: active | in_progress | implemented | abandoned
gate_profile: content | feature | authority
---
# <Spec name>

## Objective
<the single coherent intent — one checkable objective>

## State
<One line per piece of state this spec introduces or touches: name + owner.
Owner is one of `world` (one per world, host-written), `party` (shared by the
players/processes who hold it), `player`/`owner` (one actor's own record),
`host-only` (never leaves the host), `local` (one process, never synced), or a
named container for a non-game project. Blank is not valid — `/architect`
refuses to spawn implementation while any item here has no owner, and the
`concurrency` review lens checks the shipped code against what you wrote.>

## Acceptance criteria
- <criterion the change is audited against>

## Notes
<anything a future maintainer will want that isn't in the diff>
```

`gate_profile` names the review gate this spec's kind earns (ORCHESTRATION.md →
Code review pipeline → P3): `content` (data/text only) → `test-audit`;
`feature` → `review`/correctness + `test-audit`; `authority` (host authority,
networking, concurrency, saves) → + `review`/concurrency. `architecture-audit`
stays precondition-triggered on top of any profile — it fires when structure
actually moved, regardless of declared kind. Omit the field (or leave the diff
to speak for itself) and the orchestrator falls back to diff-sniffing alone.

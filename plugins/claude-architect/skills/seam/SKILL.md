---
name: seam
description: Design the contract between two containers (or two parallel sub-units) BEFORE either side is built, and write it into the spec so both agents build against identical text. Use when a unit spans two containers, when two parallel siblings must meet at an interface, or when a seam already in flight has to change.
when_to_use: Invoke before spawning any pair of agents whose work must meet — a unit spanning two containers, parallel siblings sharing an interface, or a leaf that returned a `## Structural proposal` asking for a new cross-container edge. Also when a seam already being built against must change shape.
argument-hint: [the two sides that must meet]
effort: high
---

# Design the seam

The sides that must meet: $ARGUMENTS

You are the orchestrator. A seam is the one artifact two isolated agents both
build against, and neither can see the other. If you get it wrong, you find out
at merge — after both sides are written. Ten minutes here is the cheapest
insurance in the framework.

**This is not delegable.** A leaf cannot design a seam, because designing one
requires seeing both sides and a leaf sees one. If a leaf proposes an interface,
treat it as input, not a decision.

## 1. Decide whether there is a seam at all

Before designing one, check you are not manufacturing it:

- **Do both sides really run in parallel?** Sequential phases share a worktree
  and can discover the interface as they go. A seam contract is for agents that
  cannot talk.
- **Would one agent be simpler?** Two containers with a chatty interface between
  them were often one unit. If the seam needs more than a handful of operations,
  that is evidence the split is wrong — reconsider before you formalise it.
- **Does the edge already exist?** If the containers already have a declared
  edge and a public surface, the seam may be "use what is there, add nothing."
  Say that explicitly; it is a valid and cheap answer.

## 2. Design it to be narrow and stable

The properties that matter, in priority order:

1. **Narrow.** The fewest operations that let the consumer do its job. Every
   extra operation is another thing both sides can disagree about.
2. **Stable under implementation change.** If a plausible change to either side's
   internals would alter the signature, the seam is exposing an implementation
   detail. Move the detail behind it.
3. **Data, not objects.** Prefer plain data across a seam over behaviour-carrying
   objects. Data can be constructed by a test, a stub, or the other agent's
   imagination; a live object cannot.
4. **No borrowed types.** A type owned by one side and named in the other's
   signature is a hidden dependency edge — the exact leak that makes a clean
   import graph misleading. Define the seam's own types at the seam.
5. **Explicit failure.** Say what happens when it fails: error shape, whether it
   throws or returns, and what the consumer must handle. Unspecified failure is
   where two agents diverge most reliably, because each invents the convention
   its own side prefers.
6. **No shared mutable state across it.** If both sides write the same thing, it
   is not a seam, it is a collision — go back to step 1.

## 3. Write it down, then hand it over identically

Write the seam into `.wiki/specs/<id>.md` under a `## Seams` heading, and give
**both** agents the identical text in their spawn prompts. Not a paraphrase — the
same bytes. Paraphrasing is how two agents end up with two contracts.

```markdown
## Seams

### `orchestration/auth` -> `engine/token`   (producer: engine/token)

    verifyToken(raw: string): { subject: string; expiresAt: number } | null

- Returns `null` for any invalid token — malformed, expired, or wrong audience.
  It does NOT throw and does NOT distinguish the reasons; the consumer treats
  all of them as unauthenticated.
- `expiresAt` is epoch milliseconds, UTC.
- Pure: no I/O, no clock read beyond expiry comparison, safe to call per-request.

Producer builds this exactly. Consumer builds against it and MUST NOT change it.
Either side believing it is wrong escalates to me — do not renegotiate directly.
```

Then, in each spawn prompt: name which side this agent is (**producer** or
**consumer**), paste the seam block verbatim, and state that a change to it is an
escalation rather than a decision. The consumer may stub the producer's side to
make progress; that stub is scaffolding and must not survive the merge.

## 4. When a seam has to change mid-flight

It happens, and the wrong move is to let one side quietly adapt.

1. **Stop the side that wants the change.** Do not let it "just adjust" — its
   sibling is building against the old text right now.
2. **Decide the new shape yourself**, then update `.wiki/specs/<id>.md`.
3. **Re-brief BOTH sides**, even the one that did not ask. A sibling holding a
   stale contract is the failure you are preventing.
4. If the change is the second one on the same seam, that is a signal the split
   was wrong. Consider collapsing the two units into one rather than negotiating
   a third time.

Record every seam change in your work-log with its cause. Repeat churn on one
seam is the strongest available evidence that two containers want merging — and
it is exactly the signal `containers.yaml` granularity should be tuned on.

## Do not

- Do not spawn either side before the seam text exists. That is the whole point.
- Do not let a leaf invent the far side of an interface it cannot see.
- Do not design a seam for sequential phases — they share a worktree.
- Do not widen a seam to avoid an escalation. A wide seam defers the collision
  rather than removing it, and it defers it to merge.

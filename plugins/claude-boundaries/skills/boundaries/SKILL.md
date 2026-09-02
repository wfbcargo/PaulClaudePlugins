---
name: boundaries
description: Decide which container new code belongs in, and what to do about a boundary violation. Use when placing new code in a repo that has a container map, when the boundary checker reports a violation, when an import you need would be illegal, or when adding a container, a layer, or a cross-container edge. Also for reading the map — which container owns a file, what it may consume, where its public surface is.
---

# Working inside a container map

A repo with `.wiki/containers.yaml` (or `boundaries.yaml`) has declared its
architecture. The checker enforces the half that is mechanical. This skill is
the other half — the judgements it cannot make for you.

Split the work correctly and you spend no tokens on the deterministic part:

| Question | Answered by |
|---|---|
| Does this import violate an edge / surface / direction rule? | the checker — it already told you |
| Is the map itself coherent — DAG, refs, overlaps? | `boundaries.mjs validate` |
| **Which container does this new code belong in?** | **you, before you write it** |
| **Is this code in a legal folder but the wrong one anyway?** | **you, or the `boundary-audit` agent** |

The last row is the residual risk and the reason judgement still matters:
nothing mechanical catches a business rule written into a database adapter with
entirely legal imports.

## First, read the map

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" map            # the graph
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" where <path>   # one file's container, edges, surface
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" check          # the whole repo
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" check --changed
```

`where` is the one to reach for constantly. It answers "what may this file
import?" exactly, which is the question you are actually asking whenever you are
about to add an import.

## Placing new code

Run this per unit of work, and say the answer out loud before writing:

1. **Does it talk to the outside world?** Inbound (HTTP, CLI, queue consumer)
   → the top layer. Outbound (DB, third-party API, token verification) → the
   bottom layer.
2. **Otherwise it is business logic** → the middle. Then: whose capability is
   it? Match an existing container by its `owns:` line. If two containers both
   plausibly own it, the `owns:` lines are too vague — say so.
3. **Within a container:** does it *decide* something (an invariant, a rule, a
   calculation) → the pure sub-path, usually `domain/`. Does it *sequence*
   something (call order, a transaction, a retry) → the rest of the container.
4. **No container fits** → stop. See below.

The trap in step 3 is worth stating plainly, because it is the one that quietly
collapses the architecture: **if you cannot unit-test a business rule without
stubbing an I/O call, the layers have already merged.** A rule that needs data
takes it as an argument. That is what the purity rule is protecting, and why it
is *stricter* than the container's own edges — a container may call the layer
below it, its `domain/` may not.

## When the checker reports a violation

A violation is one of exactly three things. Decide which before touching
anything.

**1. The import is wrong.** Most common. You reached for something convenient
that the architecture routes differently. Use what your container may consume,
or ask the layer above to pass the data down.

**2. The code is in the wrong container.** The import you want is legal
*somewhere*, just not here. Move the code to the container that may hold it.
A `R2-skip` finding is often this: the logic belongs one layer down.

**3. The map is wrong — the edge should exist.** This happens, and it is a real
answer. But it is **a structural decision, not an implementation detail**:

> Say what edge you believe is missing and why, and stop. Do not add the import,
> do not edit the map to make your own change pass, and do not restructure code
> to route around the check. The user decides.

That last rule is not ceremony. A checker an agent may edit constrains nothing,
and an architecture whose boundaries move whenever they are inconvenient is a
directory listing rather than a design.

### What never counts as a fix

- Editing `.wiki/containers.yaml` to permit your own change.
- Adding a path to `test_exempt`, `pure_paths`, or an `external` allowlist to
  silence a finding.
- Re-exporting the forbidden thing through a legal container to launder the
  edge — the reader now cannot see the dependency at all, which is worse than
  the original violation.
- Replacing a static import with a dynamic `import()` or `require()`. The
  checker sees all three, and if it did not, hiding a dependency from the tool
  that documents your architecture would still be the wrong move.

## Adding a container, an edge, or a layer

All three are structural. Propose, do not perform. When you do propose one, say:

- **A new edge:** which container, to which, and what specifically it needs.
  Include why the existing edges cannot carry it — often they can.
- **A new container:** what single capability it owns, in one sentence. If that
  sentence needs an "and", it is two containers or it is none.
- **A new layer:** rare, and it usually means an existing layer was doing two
  jobs. Name both jobs.

Two sizing rules worth applying to any proposal:

- A container is correctly sized when a typical change touches **one or two**.
  If most changes span three or more, the containers are too fine — the edge
  list explodes and one-agent-one-container is gone. Over-bounding costs more
  than under-bounding, because every crossing needs a contract.
- **The graph must stay acyclic.** A cycle is survivable for a human team and
  fatal for parallel agents: if `a → b` and `b → a` are both legal, neither can
  be worked on without the other's contract, so both get invented. When you
  genuinely need bidirectional flow, use an event, a callback, or extract a
  shared third container. `validate` rejects a cyclic map, not just cyclic code.

## Crossing a seam

When work spans two containers, write the signature at the public surface
**before** either side is built, and use the same text for both. Without that,
one side invents a signature and the other guesses at it, and the mismatch
surfaces at integration. This is the tax the container model charges for its
parallelism — pay it up front.

If what you need from another container is not on its public surface, that is a
seam change, not a reason to reach into its internals. Propose the addition.

## Adopting the model in a repo that has none

`node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" suggest` prints a starter
map from the existing tree. Treat every line of it as a question, not an answer:
the `consumes` lists it produces are what the code imports **today**, not what
it should be permitted to. Deleting an edge there is how you decide the
architecture rather than merely record it.

Then: `validate`, then `check`. Expect the first `check` to fail — that is the
map telling you where the architecture and the code already disagree. Fix the
map where it is wrong about intent; leave the findings where the code is wrong,
and work them off deliberately.

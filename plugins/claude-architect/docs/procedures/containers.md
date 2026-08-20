# Procedure — the container model (layers, containers, seams)

**Read this when:** the project has a `.wiki/containers.yaml`, and you are about
to decompose work, assign scope to a sub-agent, or decide where new code goes.
The orchestrator reads it once per session. Leaves do NOT read it — they receive
their container assignment in `## YOUR SCOPE`.

Projects without `.wiki/containers.yaml` are unaffected by everything here.

---

## 1. The model

Three layers, dependency direction strictly downward, no skipping:

```
user            API endpoints, service entry points, CLI, jobs. Calls orchestration only.
  ↓
orchestration   Business logic, grouped into containers by business capability.
  ↓
engine          Operations against 3rd-party systems: DB reads/writes, auth checks, HTTP.
```

A **container** is a folder that owns one business capability inside one layer.
It is the unit of agent assignment. It declares which other containers it may
call, and exposes exactly one importable entry file.

```
src/orchestration/auth/          <- container `orchestration/auth`
    index.ts                     <- the ONLY file another container may import
    usecases/                    <- sequencing, transactions, calls engine
    domain/                      <- pure rules; imports NOTHING outside this folder
```

> **Terminology.** In the C4 model, "container" means a separately deployable
> unit; what this framework calls a container, C4 calls a *component*. Both C4
> and Docker senses are common in training data, so agents receive `layer:` and
> `container:` as structured fields and never as prose to interpret. The project
> glossary must carry this disambiguation.

### The five invariants

1. **Direction.** A container may only consume containers in its own layer or a
   lower one. Never upward.
2. **No skipping.** `user` may not reach `engine` (unless `skip_layers: true`).
3. **Declared edges only.** Intra-layer calls are legal only where listed in
   `consumes`. The container graph must be a **DAG**.
4. **Public surface.** Cross-container imports resolve to the target's surface
   file. Reaching into another container's internals is a violation.
5. **Owned types.** Engine returns its own DTOs; orchestration maps them to
   domain models; user sees orchestration's output shapes. A type crossing two
   layers is a dependency edge even when no function call does.
6. **Purity.** Sub-paths listed in `policy.pure_paths` (`domain` by default)
   import nothing outside themselves — not even the rest of their own container.

### Why `domain/` has to be pure

The orchestration layer merges two roles that classical DDD separates:
*application* (sequencing, transactions, no business rules) and *domain*
(invariants, calculations, no I/O). Merged in one folder they interleave, and the
diagnostic is sharp: **if you cannot unit-test a business rule without stubbing
an engine call, the layers have collapsed.**

`pure_paths` is the fix that keeps three layers rather than four. `domain/`
imports nothing in-repo; a rule that needs data takes it as an argument. Note the
asymmetry — `orchestration/auth` may call `engine/token`, but
`orchestration/auth/domain` may not, so the purity rule is *stricter* than its
own container's edges. External packages are unaffected; only in-repo imports are
checked.

### Why the graph must be acyclic

A cycle is survivable for a human team and fatal for parallel agents: if
`auth -> permissions` and `permissions -> auth` are both legal, neither agent can
be dispatched without the other's contract, and both will invent one. When you
genuinely need bidirectional flow, use an event, a callback, or extract a shared
third container. **The validator rejects a cyclic config, not just cyclic code.**

### Slices — the vertical view

Containers sharing a `slice` key across layers form a feature slice. This gives
two glob views over one tree:

| View | Glob | Use when |
|---|---|---|
| Container | `src/orchestration/auth/**` | parallel work — the default assignment |
| Slice | `src/*/auth/**` | one agent owns a feature end to end |

Engine containers serving several slices are marked `shared: true` and belong to
no slice. Dispatch a slice only when the work is genuinely one sequential unit;
otherwise containers give a finer partition, which is what concurrency needs.

### Granularity

A container is correctly sized when a typical spec touches **one or two**. If
most specs span three or more, the containers are too fine — the edge list
explodes and the one-agent-one-container property is gone. Over-bounding costs
more than under-bounding, because every crossing needs a contract.

---

## 2. What is enforced by machine vs. by judgment

Do not spend model tokens on the deterministic half. An agent that sees a build
failure fixes it; an agent that reads "please don't cross layer boundaries" may
still cross them.

| Question | Answered by |
|---|---|
| Does this import violate an edge / surface / direction rule? | **linter** (`containers.mjs check`) |
| Is the config itself coherent — DAG, refs, overlaps? | **validator** (`containers.mjs validate`) |
| Which container does this new code belong in? | **orchestrator**, at decomposition |
| Is this code in a legal folder but the wrong one anyway? | **`architecture-audit`** |

The last row is the residual risk and the reason the auditor still matters:
nothing mechanical catches a business rule written into `engine/identity-db`
with entirely legal imports.

---

## 3. Dispatch — the orchestrator's use of the map

Container identity changes four things about a spawn.

**a. Scope resolution is a lookup, not a judgment.** `container -> path` gives the
file partition directly, which is what parallel siblings need
(`spawn-child-orchestrator.md` requires partitioning *files*, not tasks). Two
leaves in containers with no edge between them are safe to run concurrently by
construction.

**b. Leaves may not create cross-container edges.** A leaf that needs a new edge
has hit a structural boundary: it records a `## Structural proposal` and proceeds
with the non-structural part, or pauses. **You** decide the edge, update
`containers.yaml`, and re-dispatch. This is what makes the container graph an
invariant rather than a suggestion — the code that connects containers is written
under your authority, never a leaf's.

**c. Seams are contract-first.** When a unit spans two containers, write the
signature at the public surface into `.wiki/specs/<id>.md#seams` **before
spawning either leaf**, and hand both the same text. Without this, agent A
invents a signature and agent B guesses at it, and you find out at merge. This is
the tax the container model charges for its parallelism — pay it up front.

**d. Spawns are tuned per container.** A container may carry an `agent:` block —
model, effort, extra rules. Merge it over the role default: role sets the floor,
container adjusts it.

```
effective model  = container.agent.model  ?? role default
effective effort = container.agent.effort ?? role default
```

Typical shape: `engine/*` containers are mechanical and well-specified (lower
effort); `orchestration/*/domain` is invariant-dense (raise it). Record the
override in your work-log with the container that caused it.

### Scope block for a container-assigned leaf

Fold this into `## YOUR SCOPE` — do not add a new top-level spawn field, since
field order in front of it is what caches across siblings.

```
## YOUR SCOPE
layer: orchestration
container: orchestration/auth
you own: src/orchestration/auth/**
you consume (read, never edit): orchestration/permissions, engine/identity-db
public surface: src/orchestration/auth/index.ts — additions here need my approval
seam contract: .wiki/specs/<id>.md#seams — implement it exactly; do not redesign it
forbidden: any import not in `consumes`; any import of another container's internals
self-check before reporting: node ${CLAUDE_PLUGIN_ROOT}/scripts/containers.mjs check --changed
```

---

## 4. Placement — deciding a container for new work

Run this at classification time, per intent, and say the answer out loud:

1. **Does it talk to the outside world?** Inbound (HTTP, CLI, queue consumer) ->
   `user`. Outbound (DB, 3rd-party API, token verification) -> `engine`.
2. **Otherwise it is business logic** -> `orchestration`. Then: whose capability
   is it? Match an existing container by `owns:`.
3. **Within an orchestration container:** does it decide something (invariant,
   rule, calculation) -> `domain/`. Does it sequence something (call order,
   transaction, retry) -> `usecases/`.
4. **No container fits** -> that is a structural decision. It needs a new
   container in `containers.yaml` plus a `decisions/<NNNN>` ADR, and it is the
   orchestrator's call, never a leaf's.

Resolve an existing file's container with `containers.mjs where <path>`.

---

## 5. Commands

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/containers.mjs validate          # config coherence — DAG, refs, overlaps
node ${CLAUDE_PLUGIN_ROOT}/scripts/containers.mjs check [--changed] # import violations in the code
node ${CLAUDE_PLUGIN_ROOT}/scripts/containers.mjs where <path>      # which container owns a file
node ${CLAUDE_PLUGIN_ROOT}/scripts/containers.mjs scope <id>        # dispatch block for a spawn prompt
node ${CLAUDE_PLUGIN_ROOT}/scripts/containers.mjs emit <target>     # generate linter config
```

`emit` targets `dependency-cruiser` (TS/JS) and `import-linter` (Python).
`check` shells out to whichever is configured. Coverage is not identical between
them — know which half you are getting:

| Invariant | dependency-cruiser | import-linter |
|---|---|---|
| Direction, no-skip, declared edges | yes | yes |
| Public surface | yes | no — contracts are module-level, not file-level |
| Owned types (`import type`) | yes (`tsPreCompilationDeps`) | n/a |
| Purity, cross-container | yes | yes |
| Purity, within own container | yes | **no** |

Python projects therefore get the layer/edge guarantees but must hold the surface
and intra-container purity rules by review. Say so rather than assuming parity.

Two failure modes are worth knowing because both read as "clean":

- **0 modules analysed.** `check` refuses to report a pass and exits 2. Usually
  `policy.root` is wrong or the source extensions don't match.
- **Unresolved imports.** Reported as a `WARN` with a count — an import that
  doesn't resolve matches no rule, so it is unchecked, not clean. Usually a path
  alias missing from the generated resolver options. The container map is the source of
truth; the linter config is generated and should not be hand-edited — regenerate
it whenever `containers.yaml` changes, and commit both.

Calibration matters more than coverage here. A fitness function that is too
strict blocks legitimate change and gets disabled; treat a rejected-but-correct
edge as a **config bug** and update `containers.yaml`, rather than working around
the linter in code.

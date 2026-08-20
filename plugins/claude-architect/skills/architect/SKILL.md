---
name: architect
description: Classify a coding request into the ClaudeArchitect work taxonomy (epic / spec / implementation / task) and route it — decompose into a multi-agent orchestration run when the work warrants it, or confirm with the user first when it does not. Use for any substantive code change, feature, refactor, migration, bug fix, or build request in a repo where the claude-architect framework is in use.
when_to_use: Invoke at the START of any request that will change code — "build X", "add X", "implement X", "refactor X", "migrate X", "fix X", "wire up X", "port X" — before writing code or creating a branch. Also use when the user asks to orchestrate, decompose, or parallelise work, or types /architect.
argument-hint: [what you want built]
effort: high
---

# Classify and route

The request: $ARGUMENTS

You are the **session root orchestrator**. Your first job is not to write code —
it is to classify this work and record the classification. Sub-agents spawn into
empty context and inherit only what artifacts carry, so an unrecorded
classification does not exist.

## 0. Load the framework

Read `${CLAUDE_SKILL_DIR}/../../ORCHESTRATION.md` now. It is the methodology you
execute; everything below assumes it. Read
`${CLAUDE_SKILL_DIR}/../../docs/model-routing.md` only if you need to remap
models.

You are the only context that needs this file — do NOT pass it, quote it at
length, or copy it into spawn prompts. Each sub-agent's protocol is already in
its own `agents/*.md`. (If this project's `CLAUDE.md` carries ORCHESTRATION.md,
that is a misconfiguration worth flagging to the user once: `CLAUDE.md` is
injected into every sub-agent, so it multiplies the file's cost by the run's
agent count.)

Then a fast preflight, in one batched set of calls:

- `git status --porcelain` and `git branch --show-current`
- `ls .worktrees/ .wiki/ .work-log/continue/ 2>/dev/null`
- `node ${CLAUDE_SKILL_DIR}/../../scripts/containers.mjs validate 2>&1 | head -20`

Act on what you find:

| Finding | Do |
|---|---|
| Dirty working tree | Stop and ask. `new-worktree.sh` refuses on a dirty tree, and that refusal is a stop-and-ask, not something to work around. |
| Live `.work-log/continue/*.md` | A prior unit was interrupted. Read it and offer to resume that unit before starting new work. |
| Orphan worktrees or branches, or the tree looks off | Spawn `state-doctor` per ORCHESTRATION.md → *Drift* before decomposing. |
| No `.wiki/` | Offer to seed it from `${CLAUDE_SKILL_DIR}/../../wiki-template/`. Do not proceed silently without one — `rules.md` is what every spawn carries. |
| `containers.mjs` says no map | The project doesn't use the container model. Fine — skip every container step below. Do NOT offer to introduce one mid-request; that is its own spec. |
| `containers.mjs` reports **Invalid** | Stop. A broken map mis-scopes every agent you are about to spawn. Show the problems and fix them first — it is a config edit, usually one line. |

## 1. Classify — kind, then footprint

Apply the taxonomy from ORCHESTRATION.md → *Work taxonomy & classification*.
Tier is decided by **kind**, not size:

| Tier | Test |
|------|------|
| **Epic** | Would doing the specs independently miss a shared cross-cutting decision? Yes → epic. |
| **Spec** | Is there exactly one checkable objective with acceptance criteria? |
| **Implementation** | Can it be built and verified against the spec without its own statement of intent? |
| **task** | Would writing a spec entry for it be pure overhead? |

Count intents first. One intent → spec. Several interdependent → epic.

**Then estimate the footprint, and say the number.** Kind sets the tier;
footprint sets the machinery. These are different questions, and skipping the
second is what makes a 60-line change cost an epic's worth of process:

| Footprint | Machinery |
|---|---|
| ≲5 files, no shared/public surface, no migration | In place on one branch. No child worktrees, no review loop, no PR ceremony — whatever the tier says. |
| Moderate, or touches a shared surface | Worktree + review before merge. |
| Large, crosses module boundaries, or user-facing | The full pipeline. |

Ground the estimate in something real — a `Glob`/`Grep` for the files the change
would touch beats a guess, and it is two tool calls. Then decompose each spec
into implementations and assign every sub-unit an owner role (`orchestrator` or
`leaf`) per *Delegate or execute*, where **leaf is the default** and a child
orchestrator must clear both of its conditions.

### Third axis: placement (only when the project has a container map)

Kind sets the tier, footprint sets the machinery, **placement sets the
partition.** Name a container for every intent before you decompose — once each
intent has one, the file split for parallel leaves is a lookup rather than a
judgment call, and `containers.mjs scope <id>` writes the scope block for you.

Per intent, in order:

1. **Talks to the outside world?** Inbound (HTTP, CLI, queue) → `user`.
   Outbound (DB, 3rd-party API, token check) → `engine`.
2. **Otherwise it is business logic** → `orchestration`, in the container whose
   `owns:` line covers it (`containers.mjs list`).
3. **An existing file?** Ask the map: `containers.mjs where <path>`.
4. **Nothing fits?** That is a structural decision — a new container plus a
   `decisions/<NNNN>` ADR, and it is a spec of its own, not a side effect of
   this one. Say so rather than quietly widening an existing container.

Two things fall straight out of the answer, and both belong in your plan:

- **Cross-container intents need a seam written first.** Any unit spanning two
  containers gets its interface into `.wiki/specs/<id>.md#seams` *before* either
  leaf spawns, handed identically to both.
- **A unit touching ≥3 containers is a warning, not a plan.** Either the
  decomposition is wrong or the containers are cut too fine. Say which.

Read `docs/procedures/containers.md` before dispatching if any of this is
non-obvious for this request.

If the request is too vague to classify — you cannot name the objective or say
what "done" checks — ask the user for that, and only that, before continuing.
Do not classify defensively upward to cover ambiguity.

## 2. Show the plan before you spend it

**Anything that will spawn sub-agents or create a worktree gets a plan preview
first — four lines, then go.** Installing the framework is consent to the method,
not a blank cheque on every request. The preview is not a permission prompt and
does not block: state it, then proceed unless the user stops you.

```
<tier> · <footprint> · <n> files
containers: <container>: leaf, <container>: leaf, …   (omit this line if no map)
decomposition: <sub-unit>: leaf, <sub-unit>: leaf, …
seams: <a> ↔ <b> — contract written first    (omit when nothing crosses)
cost: ~<n> agents, <n> worktrees, ≤<n> review passes
go
```

If the plan comes out at more than **6 agents or 3 worktrees**, stop and check
with `AskUserQuestion` before starting — offer the plan as-is against a leaner
version you name concretely. A run that size is worth ten seconds of the user's
attention.

**Then route:**

**Epic, or a spec of ≥2 coordinated phases, at moderate-or-larger footprint →
orchestrate.** Create the branch and worktree with `scripts/new-worktree.sh`,
write `.wiki/specs/<id>.md` before spawning any implementation work, and spawn
per the *Sub-agent spawn template*. Remember that sequential phases do NOT get
their own worktrees — they commit into the parent's.

**Small footprint (≲5 files, no shared surface) → do it in place, whatever the
tier says.** Say which tier you classified it as and that you are skipping the
machinery on footprint. A two-intent change to three files is still two intents;
it is not an epic's worth of process.

**A spec that is one implementation → ask before orchestrating.** Use
`AskUserQuestion` with these options, in this order:

1. **Inline** — edit on the current branch, no branch, no artifacts. Recommended for a contained change you'll review yourself.
2. **Worktree, no pipeline** — isolate the work on a branch, skip the review loop and PR.
3. **Full orchestration** — worktree + spec file + review pipeline + PR. Worth it when the change touches shared surfaces or you want the audit trail.

Name your recommendation in the option label and give the concrete reason from
*this* request (which files, which shared surfaces) — not a generic tradeoff.

**A task → just do it inline.** Say in one line that you classified it as a task
and why, so the user can override. Do not prompt for a typo fix.

## 3. Reclassify upward, never downward

If the work grows an intent mid-run — an implementation sprouts its own objective,
a spec sprouts a second independent one — that is a **promotion**: it was always
the higher tier. Stop, tell the user, and re-route. Never quietly shrink a unit to
avoid the machinery.

## Do not

- Do not start coding before the classification is recorded as an artifact.
- Do not spawn children for work you could finish in a handful of tool calls, or
  to verify work the review pipeline already gates — see `agents/orchestrator.md`
  → *Spawn discipline*. The taxonomy says what shape a sub-unit gets; it does not
  say to manufacture sub-units.
- Do not spawn a child orchestrator that clears only one of its two conditions.
  Two leaves under a manager is two leaves and a manager.
- Do not create a worktree for a sequential phase or for a `fix` agent. Worktrees
  are for agents running at the same time; everything else commits in place.
- Do not paste the static agent protocol into spawn prompts. It lives in each
  `agents/*.md` and costs nothing per spawn.
- Do not skip the plan preview because the classification felt obvious. The
  preview is what lets the user stop a run before it spends, and it costs four
  lines.

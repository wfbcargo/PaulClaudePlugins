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

Read `${CLAUDE_SKILL_DIR}/../../ORCHESTRATION.md` now, unless this project's
`CLAUDE.md` already carries it. It is the methodology you execute; everything
below assumes it. Read `${CLAUDE_SKILL_DIR}/../../docs/model-routing.md` only if
you need to remap models.

Then a fast preflight, in one batched set of calls:

- `git status --porcelain` and `git branch --show-current`
- `ls .worktrees/ .wiki/ .work-log/continue/ 2>/dev/null`

Act on what you find:

| Finding | Do |
|---|---|
| Dirty working tree | Stop and ask. `new-worktree.sh` refuses on a dirty tree, and that refusal is a stop-and-ask, not something to work around. |
| Live `.work-log/continue/*.md` | A prior unit was interrupted. Read it and offer to resume that unit before starting new work. |
| Orphan worktrees or branches, or the tree looks off | Spawn `state-doctor` per ORCHESTRATION.md → *Drift* before decomposing. |
| No `.wiki/` | Offer to seed it from `${CLAUDE_SKILL_DIR}/../../wiki-template/`. Do not proceed silently without one — `rules.md` is what every spawn carries. |

## 1. Classify

Apply the taxonomy from ORCHESTRATION.md → *Work taxonomy & classification*.
Units are defined by **kind**, not size:

| Tier | Test |
|------|------|
| **Epic** | Would doing the specs independently miss a shared cross-cutting decision? Yes → epic. |
| **Spec** | Is there exactly one checkable objective with acceptance criteria? |
| **Implementation** | Can it be built and verified against the spec without its own statement of intent? |
| **task** | Would writing a spec entry for it be pure overhead? |

Count intents first. One intent → spec. Several interdependent → epic. Then
decompose each spec into implementations and assign every sub-unit an owner role
(`orchestrator` or `leaf`) per *Delegate or execute*.

If the request is too vague to classify — you cannot name the objective or say
what "done" checks — ask the user for that, and only that, before continuing.
Do not classify defensively upward to cover ambiguity.

## 2. Route by tier

**Epic, or a spec that decomposes into ≥2 coordinated phases → orchestrate. Do
not ask.** This is what the framework is for and the user has already opted in by
installing it. State the classification and the decomposition in a few lines,
then execute: create the branch and worktree with `scripts/new-worktree.sh`,
write `.wiki/specs/<id>.md` before spawning any implementation work, and spawn
per the *Sub-agent spawn template*.

**A spec that is one implementation → ask before orchestrating.** The machinery
(worktree, spec file, review loop, PR) is real overhead for a single diff. Use
`AskUserQuestion` with these options, in this order:

1. **Full orchestration** — worktree + spec file + review pipeline + PR. Recommended when the change touches shared surfaces, needs review before merge, or you want the audit trail.
2. **Worktree, no pipeline** — isolate the work on a branch, skip the review loop and PR. Good for solo work you'll review yourself.
3. **Inline** — edit on the current branch, no branch, no artifacts.

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
- Do not paste the static agent protocol into spawn prompts. It lives in each
  `agents/*.md` and costs nothing per spawn.

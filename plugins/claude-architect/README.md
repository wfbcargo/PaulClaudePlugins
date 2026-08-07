# ClaudeArchitect

A multi-agent orchestration framework for [Claude Code](https://claude.com/claude-code).

It treats a coding session like a small engineering org. One long-horizon
**orchestrator** classifies the work, decomposes it into epics / specs /
implementations, isolates concurrent work in **git worktrees**, and drives a
**review + spec-audit + architecture-audit + merge** pipeline before every
squash-merge. Nothing important stays implicit in conversation: it becomes an
artifact (a branch name, a spec file, a work-log entry) that an isolated agent
can pick up cold.

The framework can nest — an orchestrator can spawn another — but it **defaults to
flat**. Managers that write no code are the most expensive thing a run can buy,
so a child orchestrator has to earn itself, and most runs are one orchestrator
plus leaves.

## What's in the box

**Eight role-pinned subagents** (`agents/`), auto-discovered by Claude Code once
installed:

| Agent | Role |
|-------|------|
| `orchestrator` | Team manager, optionally recursive. The only agent with the spawn tool (`Task`/`Agent`) — that grant *is* the orchestrator/leaf boundary. |
| `implementation` | Leaf coding agent for one implementation phase. |
| `fix` | Applies a grouped set of review findings, in the top-level worktree. |
| `review` | Read-only code-quality reviewer; emits structured JSON findings. |
| `spec-audit` | Read-only: does the change match the spec's *intent*? |
| `architecture-audit` | Read-only drift gate: does the change still *fit*, and is the wiki still true? |
| `merge` | Resolves PR conflicts preserving both sides' intent (real merge commits). |
| `state-doctor` | Read-only reconciliation: detects git / wiki / worktree drift. |

**The entry point** — [`/architect`](./skills/architect/SKILL.md). Classification
is step one of every run, and prose in a doc doesn't reliably trigger it: this
skill does. It fires automatically on a substantive change request (or on demand
via `/architect`), loads the methodology from the plugin itself, runs a preflight
for drift and interrupted units, classifies against the taxonomy, and routes.
Tier comes from *kind*; the machinery comes from *footprint*, so a two-intent
change to three files does not buy an epic's worth of process. Anything that
will spawn agents or create worktrees prints a four-line plan preview
(decomposition, agent count, worktree count, review passes) before spending, and
stops to ask if the plan exceeds 6 agents or 3 worktrees. A single implementation
gets an `AskUserQuestion` offering inline / worktree-only / full orchestration. A
trivial task is just done, with the classification stated in one line.

**The methodology that ties them together** — [`ORCHESTRATION.md`](./ORCHESTRATION.md).
Work taxonomy, footprint sizing, branch and worktree policy, the mandatory spawn
template, the review boundaries, the three memory types, and the receipt and
continue-file contracts that keep orchestrator context bounded. The `/architect`
skill reads it in the session root, which is the only context that uses it.
**Do not put it in your `CLAUDE.md`** — that file is injected into every
sub-agent, which multiplies an 8k-token document by the whole run's agent count
for agents whose protocol is already in their own `agents/*.md`.

**At-a-moment procedures** — [`docs/procedures/`](./docs/procedures/): the review
loop, child-orchestrator spawns, state reconciliation, parallel sessions, and
headless operation. Each is read when its trigger fires and not before; the
triggers stay resident in `ORCHESTRATION.md`.

**Mechanical git recipes** — [`scripts/`](./scripts/): `new-worktree.sh`,
`squash-up.sh`, and `worktree-setup.sh`. Prose the orchestrator has to
reconstruct is both expensive and error-prone, so the branch/worktree/squash
sequences are scripts it invokes. `worktree-setup.sh` runs automatically on every
new worktree to link dependency trees and copy env files — without it a fresh
checkout has no `node_modules`, and every leaf either re-installs or fails its
tests for a reason unrelated to its work. Override it per project with
`.claude/worktree-setup.sh`.

**Supporting docs**: [`docs/model-routing.md`](./docs/model-routing.md) (tiering,
fallback, and how to remap models to what you have) and a `.wiki/` starter
skeleton in [`wiki-template/`](./wiki-template/).

**Illustrated overview**: [`docs/framework.html`](./docs/framework.html) — a
single self-contained page covering the run shape, the six process stages, all
eight agent roles with their tiers and tool grants, the review boundaries, and
the tuning knobs. Open it in a browser; it's the fastest way to hand someone the
whole model at once.

## Core ideas

- **Model and effort are two dials on two axes, and both follow role, not depth.**
  *Model* follows whether a mistake is **silent**: orchestration and architecture
  drift are unbounded, and a mangled merge or a missed bug slips through a gate
  unnoticed — those stay top-tier. *Effort* follows how much the agent has to
  derive for itself: an orchestrator invents a decomposition from a mandate
  (`high`); a leaf is handed CONTEXT, SCOPE, ACTIVE RULES and a work log
  (`medium`). Leaves run at medium *deliberately* — lower effort scopes work to
  what was asked, which is the same discipline `## YOUR SCOPE` exists to enforce.
  Have only one model? Point every agent at it and keep the effort split; it
  applies to the highest-volume role, so most of the saving survives.
- **Worktrees buy concurrency, and nothing else — so only concurrent work gets
  one.** A worktree is a fresh checkout with no dependencies and no build cache;
  the create/setup/remove cycle is the largest wall-clock cost in a run. Top-level
  units and parallel siblings get worktrees. Sequential phases and `fix` agents
  commit in place. Worktrees always land flat in the main repo's `.worktrees/` —
  never nested inside each other, which would put a checkout inside a checkout
  and, on Windows, run the combined paths into the 260-char limit. Branch names
  stay `--`-separated by tier (`…--spec/<id>_name--impl/<id>_phase`), so the
  branch name *is* the documentation of where the work sits.
- **Three kinds of memory, chosen by lifecycle — not by topic.** `.wiki/` is
  durable, human-readable, committed project memory. `.work-log/agents/` is
  per-worktree scratch a child writes for its parent, stripped before the PR.
  `.work-log/continue/` is resume state an agent writes for *its own successor*,
  keyed to the unit rather than the agent. Single-writer-per-file means no locks.
- **Context is a budgeted resource, not a virtue.** A child's final message is
  copied verbatim into its parent, so children return a ~15-line *receipt*
  pointing at their work-log rather than narrating it back — and the parent skips
  opening the file entirely when the receipt says there's nothing the diff hides.
  Orchestrators never take output they can't bound (no full test suites or squash
  diffs in the manager's context). Since no agent can measure its own remaining
  context and no parent can observe a running child's, exhaustion is never
  detected: continue files are refreshed at every structural boundary, so a
  compaction or crash lands somewhere already recoverable.
- **Mandate-based escalation.** Every spawn carries a written mandate: what it may
  decide, what it must escalate. Requests bubble to the nearest ancestor whose
  mandate covers them; only the session root ever surfaces to the user.
- **Resident vs. on-demand, split by trigger.** Always-on discipline stays in
  `ORCHESTRATION.md`; procedures move to `docs/procedures/` and are read when
  their trigger fires. The trigger is always the resident half — guidance you
  have to fetch gets followed less reliably than guidance that is simply there,
  so only things needed at a *recognizable moment* get demoted. Spawn-prompt
  field order is invariant-first for the same reason it matters: prompt caching
  works on prefixes, so the bytes shared across sibling spawns go at the front.

## Install

```
/plugin marketplace add wfbcargo/PaulClaudePlugins
/plugin install claude-architect@paul-claude-plugins
```

Then just describe what you want built — `/architect` triggers on its own and
walks the rest, including offering to seed `.wiki/` from `wiki-template/`.

Two things worth doing once, per project:

- **Add `.claude/worktree-setup.sh`** if your project needs more than linked
  dependencies to run its tests in a fresh checkout — a codegen step, a database
  template, a build. It receives `<main-repo-root> <new-worktree-dir>` and
  replaces the built-in defaults.
- **Tune the model IDs and `effort:` levels** in `agents/*.md` to your access —
  see `docs/model-routing.md`.

Do **not** put `ORCHESTRATION.md` in your `CLAUDE.md`. It is read by the session
root, which is the only context that classifies work or decides delegation; every
sub-agent's protocol already lives in its own `agents/*.md`, where it caches.

### If runs feel slow or expensive

Look at wall-clock and token cost separately — they have different causes.
Slowness is usually worktrees (a fresh checkout per unit) and the serial review
loop; cost is usually agent count. In order: check that
`.worktrees/` is flat and not nested, that sequential phases aren't getting their
own worktrees, that `ORCHESTRATION.md` isn't in `CLAUDE.md`, and that child
orchestrators are rare. Then lower `MAX_REVIEW_ITERATIONS` and
`MAX_CONCURRENT_AGENTS`. Model choice is the last dial, not the first.

## Status

`0.3.0`. Extracted from a real project's `.claude/` setup. The agents and the
protocol are what the author actually runs; the model tiers are pinned to the
*design* (silent-failure roles on the top tier, everything else bounded) and are
meant to be remapped to whatever models you have.

MIT licensed.

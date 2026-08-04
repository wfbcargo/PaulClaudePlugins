# ClaudeArchitect

A recursive multi-agent orchestration framework for [Claude Code](https://claude.com/claude-code).

It treats a coding session like a small engineering org. One long-horizon
**orchestrator** classifies the work, decomposes it into epics / specs /
implementations, runs each piece in an **isolated git worktree**, and drives a
**review + spec-audit + architecture-audit + merge** pipeline before every
squash-merge. Nothing important stays implicit in conversation: it becomes an
artifact (a branch name, a spec file, a work-log entry) that an isolated agent
can pick up cold.

## What's in the box

**Eight role-pinned subagents** (`agents/`), auto-discovered by Claude Code once
installed:

| Agent | Role |
|-------|------|
| `orchestrator` | Recursive team manager. The only agent with the spawn tool (`Task`/`Agent`) — that grant *is* the orchestrator/leaf boundary. |
| `implementation` | Leaf coding agent for one implementation phase, in one worktree. |
| `fix` | Applies a grouped set of review findings in an `--additional/` worktree. |
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
Epics and multi-phase specs decompose without asking. A single implementation
gets an `AskUserQuestion` offering full orchestration / worktree-only / inline. A
trivial task is just done, with the classification stated in one line.

**The methodology that ties them together** — [`ORCHESTRATION.md`](./ORCHESTRATION.md).
This is the always-on layer: work taxonomy, branch naming, the mandatory spawn
template, the review boundaries, the three memory types, and the receipt and
continue-file contracts that keep orchestrator context bounded. It is meant to be
resident in your `CLAUDE.md`, so it carries only what shapes every decision.

**At-a-moment procedures** — [`docs/procedures/`](./docs/procedures/): the review
loop, child-orchestrator spawns, state reconciliation, parallel sessions, and
headless operation. Each is read when its trigger fires and not before; the
triggers stay resident in `ORCHESTRATION.md`.

**Mechanical git recipes** — [`scripts/`](./scripts/): `new-worktree.sh` and
`squash-up.sh`. Prose the orchestrator has to reconstruct is both expensive and
error-prone, so the branch/worktree/squash sequences are scripts it invokes.

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
- **Worktree isolation.** Every unit of work gets its own git worktree and
  branch. Branch names are `--`-separated by tier (`…--spec/<id>_name--impl/<id>_phase`)
  so parent and child branches never collide as filesystem paths, and the branch
  name *is* the documentation of where the work sits.
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

Pointing your project's `CLAUDE.md` at `ORCHESTRATION.md` is still worth doing:
it keeps the always-on discipline resident for turns that don't go through the
skill. Tune the model IDs and `effort:` levels in `agents/*.md` to your access —
see `docs/model-routing.md`.

## Status

`0.3.0`. Extracted from a real project's `.claude/` setup. The agents and the
protocol are what the author actually runs; the model tiers are pinned to the
*design* (silent-failure roles on the top tier, everything else bounded) and are
meant to be remapped to whatever models you have.

MIT licensed.

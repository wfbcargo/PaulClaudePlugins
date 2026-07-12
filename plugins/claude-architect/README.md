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
| `orchestrator` | Recursive team manager. The only agent with the `Task` tool — that flag *is* the orchestrator/leaf boundary. |
| `implementation` | Leaf coding agent for one implementation phase, in one worktree. |
| `fix` | Applies a grouped set of review findings in an `--additional/` worktree. |
| `review` | Read-only code-quality reviewer; emits structured JSON findings. |
| `spec-audit` | Read-only: does the change match the spec's *intent*? |
| `architecture-audit` | Read-only drift gate: does the change still *fit*, and is the wiki still true? |
| `merge` | Resolves PR conflicts preserving both sides' intent (real merge commits). |
| `state-doctor` | Read-only reconciliation: detects git / wiki / worktree drift. |

**The methodology that ties them together** — [`ORCHESTRATION.md`](./ORCHESTRATION.md):
work taxonomy, branch naming, the mandatory spawn template, the review pipeline,
the AI-to-AI work-log protocol, state reconciliation, and headless operation.

**Supporting docs**: [`docs/model-routing.md`](./docs/model-routing.md) (tiering,
fallback, and how to remap models to what you have) and a `.wiki/` starter
skeleton in [`wiki-template/`](./wiki-template/).

## Core ideas

- **Model tier follows role, not depth.** Orchestration and architecture
  integrity carry project-wide decisions and run on the top tier; bounded work
  (leaf implementation, code review, merges) runs on a cheaper one. The split
  axis is the blast radius of the decision. Have only one model? Point every
  agent at it — you keep the structure, you lose only the cost optimization.
- **Worktree isolation.** Every unit of work gets its own git worktree and
  branch. Branch names are `--`-separated by tier (`…--spec/<id>_name--impl/<id>_phase`)
  so parent and child branches never collide as filesystem paths, and the branch
  name *is* the documentation of where the work sits.
- **Committed wiki vs. ephemeral work-log.** `.wiki/` is durable, human-readable,
  committed project memory. `.work-log/` is per-worktree AI-to-AI scratch paper,
  stripped before the PR. Single-writer-per-file means no locks.
- **Mandate-based escalation.** Every spawn carries a written mandate: what it may
  decide, what it must escalate. Requests bubble to the nearest ancestor whose
  mandate covers them; only the session root ever surfaces to the user.

## Install

```
/plugin marketplace add wfbcargo/PaulClaudePlugins
/plugin install claude-architect@paul-claude-plugins
```

Then adopt the methodology by pointing your project's `CLAUDE.md` at
`ORCHESTRATION.md` (or pasting in the sections you want), and copy
`wiki-template/` to `.wiki/` at your repo root to bootstrap the project memory.
Tune the model IDs in `agents/*.md` to your access — see `docs/model-routing.md`.

## Status

`0.1.0`. Extracted from a real project's `.claude/` setup. The agents and the
protocol are what the author actually runs; the model tiers are pinned to the
*design* (top tier orchestrates, bounded tier executes) and are meant to be
remapped to whatever models you have.

MIT licensed.

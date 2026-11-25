# Project Wiki

Durable, **committed** project memory. Read by the orchestrator and sub-agents for
context; the `architecture-audit` drift gate checks that these files stay TRUE as
the code changes. Unlike `.work-log/` (per-worktree AI scratch paper, stripped
before PR), the wiki is committed and lives for the life of the project.

Copy this directory to `.wiki/` at your repo root and fill it in.

## Index

| File | What's in it |
| --- | --- |
| [ideas.md](ideas.md) | **Start here.** The app's major concepts, one line each; every spec and decision is filed under at least one. |
| [ideas/](ideas/) | One file per idea: summary, maturity, anchor specs and decisions, what it is, why, open questions, where to start. |
| [architecture.md](architecture.md) | Module layout, boundaries, data flow. |
| [containers.yaml](containers.yaml) | **Optional.** Machine-readable layer/container map: allowed edges, public surface, per-container agent tuning. Delete it if the project doesn't use the container model. |
| [conventions.md](conventions.md) | Coding conventions, naming, formatting decisions. |
| [rules.md](rules.md) | Active project rules (`R-NNN`). Passed to every sub-agent at spawn. |
| [decisions/](decisions/) | ADRs — one file per architectural decision. |
| [gotchas.md](gotchas.md) | Non-obvious pitfalls that bit us once. |
| [glossary.md](glossary.md) | Domain + framework terms. |
| [specs/](specs/) | Per-spec notes that outlive the branch. |
| `graph.json` | **Generated** by `scripts/wiki-graph.mjs --index` once the wiki has content: every node (spec, decision, rule, container, term, gotcha, section) with its file:line, and every link between them. Grep it to find what to read; never edit it. |

## Discipline

Keep it small and accurate. Default is **omit**. If you can't say why a future
agent will need a note, don't add it. When a change alters documented behavior,
update the matching file in the same diff — a stale wiki is worse than none.

The wiki is **read context** — every file an agent reads costs tokens, so each has
a size budget:

| File | Budget |
| --- | --- |
| `rules.md` | ≤ ~15 rules / one screen — **hottest**, passed on every spawn |
| `architecture.md`, `conventions.md` | ~1 screen each; push detail into a `decisions/` ADR |
| `gotchas.md`, `glossary.md` | one line per entry; prune what's no longer true |
| `decisions/<NNNN>` | one decision per file; never merge or renumber |

A file over budget is a signal to consolidate, not to keep appending. Agents read
only the entries their spawn prompt cites — they don't scan the whole wiki (the
`architecture-audit` / `spec-audit` auditors are the deliberate exception).

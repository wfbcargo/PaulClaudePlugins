# Project Wiki

Durable, **committed** project memory. Read by the orchestrator and sub-agents for
context; the `architecture-audit` drift gate checks that these files stay TRUE as
the code changes. Unlike `.work-log/` (per-worktree AI scratch paper, stripped
before PR), the wiki is committed and lives for the life of the project.

Copy this directory to `.wiki/` at your repo root and fill it in.

## Index

| File | What's in it |
| --- | --- |
| [architecture.md](architecture.md) | Module layout, boundaries, data flow. |
| [conventions.md](conventions.md) | Coding conventions, naming, formatting decisions. |
| [rules.md](rules.md) | Active project rules (`R-NNN`). Passed to every sub-agent at spawn. |
| [decisions/](decisions/) | ADRs — one file per architectural decision. |
| [gotchas.md](gotchas.md) | Non-obvious pitfalls that bit us once. |
| [glossary.md](glossary.md) | Domain + framework terms. |
| [specs/](specs/) | Per-spec notes that outlive the branch. |

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

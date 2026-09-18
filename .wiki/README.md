# Project Wiki

Durable, **committed** project memory for this repo. Read by the orchestrator and
sub-agents for context; the `architecture-audit` drift gate checks that these
files stay TRUE as the code changes. Unlike `.work-log/` (per-worktree AI scratch
paper, stripped before PR), this is committed and lives for the life of the
project.

## Index

| File | What's in it |
| --- | --- |
| [rules.md](rules.md) | Active project rules (`R-NNN`). Passed to every sub-agent at spawn. |
| [gotchas.md](gotchas.md) | Non-obvious pitfalls that bit us once. |
| [specs/](specs/) | Per-spec notes that outlive the branch. |

The fixed structure (`plugins/claude-architect/wiki-template/README.md`;
`ORCHESTRATION.md` → PROJECT WIKI) also allows `architecture.md`,
`conventions.md`, `containers.yaml` (optional), `decisions/`, and `glossary.md`.
None of those exist here yet — default is **omit**: add one when a finding is
durable enough to justify it, not before.

## Discipline

Keep it small and accurate. If you can't say why a future agent will need a
note, don't add it. When a change alters documented behavior, update the
matching file in the same diff — a stale wiki is worse than none.

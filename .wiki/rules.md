# Active Project Rules

Flat list, stable IDs. The orchestrator reads this once at session start, caches it
split by `Scope`, and passes each agent only the rules that apply to it (the
`global` subset always; a scoped rule only to matching subtrees). Sub-agents do not
re-read it.

**This file is HOT.** Its cost is paid on every spawn × up to `MAX_CONCURRENT_AGENTS`,
making it the biggest context multiplier in the framework. Keep it to true
project-wide invariants — target **≤ ~15 rules, one screen**. Retire rules that no
longer hold rather than accumulating them.

## R-001: Match the surrounding document's voice
Scope: global
Added: 2026-09-17 | Source: README.md, ORCHESTRATION.md
Dense, declarative, reasons stated inline. No marketing tone, no emoji.

## R-002: Default is omit
Scope: global
Added: 2026-09-17 | Source: ORCHESTRATION.md (PROJECT WIKI, "When agents write to the wiki")
Add a note, doc line, or fix only when you can say why a future agent will need
it. Fixing a named finding does not license improving adjacent prose.

## R-003: Test-invoke an interpreter before trusting `command -v`
Scope: plugins/claude-architect/scripts/**
Added: 2026-09-17 | Source: .wiki/gotchas.md
On Windows Git Bash, `command -v python3` succeeds even for the disabled
Microsoft Store alias, which exits nonzero the moment it actually runs. Test-invoke
each interpreter candidate before relying on a `command -v` hit.

## R-004: Capture per-checkout facts before `cd`-ing to REPO_ROOT
Scope: plugins/claude-architect/scripts/**
Added: 2026-09-17 | Source: .wiki/gotchas.md
A script anchored on `git rev-parse --git-common-dir` is right for repo-global
facts (origin, default branch) and wrong for per-checkout ones (current branch,
`.claude/settings.json`). Read the per-checkout facts from the invocation
directory first.

## R-005: The orchestrator is the sole writer of `.wiki/`
Scope: global
Added: 2026-09-17 | Source: ORCHESTRATION.md (PROJECT WIKI, "When agents write to the wiki")
Leaves — local or remote — never edit `.wiki/` directly. A leaf with a durable
finding appends a `## Wiki proposals` section to its work-log instead; the
orchestrator applies accepted proposals during integration and is the only
allocator of `decisions/<NNNN>` and `R-NNN` numbers.

## R-006: `.wiki/` structure is fixed
Scope: global
Added: 2026-09-17 | Source: ORCHESTRATION.md (PROJECT WIKI, "Structure")
Don't invent new top-level files. Extend an existing one, or add a
`decisions/<NNNN>-<slug>.md` entry.

## R-007: Never reference `ORCHESTRATION.md` from `CLAUDE.md`
Scope: global
Added: 2026-09-17 | Source: ORCHESTRATION.md (header), README.md
`CLAUDE.md` is injected into every sub-agent; residency there multiplies an
8k-token document by the whole run's agent count. `/architect` reads
`ORCHESTRATION.md` once, in the session root — the only context that needs it.

## R-008: Fix agents edit; the orchestrator commits
Scope: global
Added: 2026-09-17 | Source: plugins/claude-architect/docs/procedures/review-loop.md
In the review-fix loop, `fix` agents share the top-level worktree and edit their
assigned files, but never run `git commit` or any batch-wide git operation. The
orchestrator makes one commit per batch once every fix agent in it returns.

## R-009: Worktrees are flat, never nested
Scope: global
Added: 2026-09-17 | Source: plugins/claude-architect/README.md (Core ideas)
Every worktree lands directly under `.worktrees/` in the main repo. Nesting one
inside another puts a checkout inside a checkout and, on Windows, risks the
260-character path limit.

## R-010: A cloud VM only sees the repo's own committed `.claude/settings.json`
Scope: plugins/claude-architect/**
Added: 2026-09-17 | Source: plugins/claude-architect/docs/procedures/remote-execution.md
A plugin enabled only in a user's local `~/.claude/settings.json`, or added but
not committed, is invisible to a remote dispatch. Declaring `claude-architect`
for remote leaves means committing it in the repo's own `.claude/settings.json`.

## R-011: Mechanical git recipes are scripts, not reconstructed prose
Scope: global
Added: 2026-09-17 | Source: ORCHESTRATION.md (PROCEDURES)
Branch/worktree/squash sequences live in `scripts/`. Invoke them; don't
hand-derive the equivalent git commands.

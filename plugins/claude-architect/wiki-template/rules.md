# Active Project Rules

Flat list, stable IDs. The orchestrator reads this once at session start, caches it
split by `Scope`, and passes each agent only the rules that apply to it (the
`global` subset always; a scoped rule only to matching subtrees). Sub-agents do not
re-read it.

**This file is HOT.** Its cost is paid on every spawn × up to `MAX_CONCURRENT_AGENTS`,
making it the biggest context multiplier in the framework. Keep it to true
project-wide invariants — target **≤ ~15 rules, one screen**. If a "rule" isn't an
always-on invariant, it belongs in `conventions.md`/`architecture.md` and reaches
agents as a cited excerpt, not this always-on block. Retire rules that no longer
hold rather than accumulating them.

## R-001: <short rule statement>
Scope: global    <!-- `global` (passed to every agent) OR a path glob, e.g. `src/api/**` -->
Added: <ISO date> | Source: decisions/<NNNN>-<slug>.md
<one-paragraph elaboration — keep it to a couple of lines; this is read on every spawn>

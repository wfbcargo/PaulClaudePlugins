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

<!--
Keep the two rules below ONLY if the project has `containers.yaml`; delete them
otherwise. They are deliberately terse — this file is paid on every spawn, and
the full model lives in the plugin's docs/procedures/containers.md, which the
orchestrator reads once and leaves never read.

## R-002: Stay inside your container
Scope: global
Added: <ISO date> | Source: .wiki/containers.yaml
Write only within the container named in your scope. Import other containers only
where `consumes` allows and only through their public surface. `import type`
counts as an import.

## R-003: Only an orchestrator creates a cross-container edge
Scope: global
Added: <ISO date> | Source: .wiki/containers.yaml
A new edge between containers is a structural decision. Record a
`## Structural proposal` and escalate; never add the import, and never invent an
interface on the far side of a seam.
-->

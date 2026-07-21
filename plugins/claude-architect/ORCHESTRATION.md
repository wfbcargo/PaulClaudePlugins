# ClaudeArchitect — Orchestration Framework

This is the methodology the `claude-architect` agents run inside. The agents are
the moving parts; this document is the machine they assemble into. To adopt the
framework, append the sections you want into your project's `CLAUDE.md` (or point
your `CLAUDE.md` at this file). The agents in `agents/` are auto-discovered by
Claude Code once the plugin is installed; this doc is what teaches the top-level
session how to use them.

The one idea underneath everything: **treat a coding session like a small
engineering org.** One long-horizon manager decomposes the work, hands each piece
to an isolated worker with a written mandate, and integrates the results through a
review pipeline. Nothing important stays implicit in conversation — it becomes an
artifact (a branch, a spec file, a work-log entry) that an isolated agent can read.

---

## TUNING

| Knob | Default | Meaning |
|------|---------|---------|
| `MAX_REVIEW_ITERATIONS` | 5 | Review-loop passes before escalating to a human |
| `MAX_MERGE_ATTEMPTS` | 3 | PR conflict-resolution attempts before escalating |
| `MAX_CONCURRENT_AGENTS` | 20 | Sub-agents alive at once across all worktrees |
| `MAX_CONTEXT_REQUEST_DEPTH` | 4 | Hops a `paused_for_context` request may propagate up before escalating |
| `MAX_ORCHESTRATOR_DEPTH` | 4 | Nested orchestrator levels before forcing flatten/escalate (guard-band under the runtime nested-subagent cap of 5) |

Override per-project in `.claude/settings.json`.

---

## MODEL ROUTING & RECURSIVE ORCHESTRATION

Model tier follows **role, not depth**. A node runs on the top tier iff it
orchestrates a team; on a cheaper tier iff it does bounded work. Orchestrator-ness
is recursive, so the expensive model appears wherever orchestration happens, at
any depth.

| Role | Tier | Notes |
|------|------|-------|
| Orchestrator (session root AND recursive children) | top | Long-horizon team manager. The ONLY agent carrying the `Task` tool — that flag is the orchestrator/leaf boundary. |
| Architecture-integrity audit | top | Read-only drift gate. Runs at structural boundaries only. |
| Implementation / fix (leaf) | bounded | Highest volume; keep it off the top tier. |
| Code review / spec-adherence audit | bounded | Bounded reasoning. |
| Merge | bounded | Semantic conflict resolution. |
| state-doctor | cheap | Read-only diagnostics. |

The split axis is **blast radius of the decision**. Orchestration and
architecture integrity carry project-wide decisions; everything else is bounded.
Concrete model IDs are pinned in each `agents/*.md`. See `docs/model-routing.md`
for the reasoning and for how to remap tiers to the models you have access to
(e.g. collapse everything onto one model if you only have one).

### When to spawn a CHILD orchestrator vs leaves

Spawn a child orchestrator ONLY when ALL hold: the sub-problem decomposes into ≥2
sub-agents that must be coordinated; it carries decisions with blast radius beyond
a single diff (placement, boundaries, sub-structure); and it will outlast one
focused context window. Otherwise spawn leaves directly or do the bounded work in
place. Keep it strict — nesting degrades when overused.

### Depth budget

Runtime hard cap on nested subagents is 5; guard-band at `MAX_ORCHESTRATOR_DEPTH`
(4). Leaves are terminal (no `Task` tool). If a child spawn would exceed the cap,
the decomposition is wrong: flatten (spawn leaves) or escalate.

### Reasoning hygiene

Do NOT instruct any agent to echo, transcribe, or explain its internal reasoning
as response text — on classifier-bearing model tiers this can trip a
`reasoning_extraction` path and cause spurious fallbacks. Agents report **actions
and decisions**, never chain-of-thought. (A work-log "What I did" is
action-reporting and is fine.)

---

## PROJECT WIKI

Every project has a `.wiki/` directory at the repo root. It is **committed** —
unlike `.work-log/` (per-worktree, stripped before PR), the wiki is the durable,
shared memory of the project. Agents read it for context and add to it as they
discover knowledge worth keeping. A starter skeleton lives in this plugin's
`wiki-template/`.

### Structure

```
.wiki/
├── README.md           # Index. Links to everything else.
├── conventions.md      # Coding conventions, naming, formatting decisions.
├── architecture.md     # System layout, module boundaries, data flow.
├── rules.md            # Active project rules. Passed to every sub-agent at spawn.
├── decisions/          # One file per architectural decision (ADR-style).
│   └── <NNNN>-<slug>.md
├── gotchas.md          # Non-obvious pitfalls. Things that bit us once.
├── glossary.md         # Domain terms, acronyms, internal jargon.
└── specs/              # Per-spec notes that outlive the branch.
    └── <8id>_<slug>.md
```

Fixed structure. Don't invent new top-level files; extend existing ones or add a
`decisions/<NNNN>-<slug>.md` entry.

### Size budgets (the wiki is read context, so it has a budget)

Every wiki file an agent might read costs context. Keep them lean:

| File | Budget | When exceeded |
|------|--------|---------------|
| `rules.md` | ~15 rules / one screen (**hottest** — see Active Rules) | Retire stale rules; demote non-invariants to conventions/architecture |
| `architecture.md`, `conventions.md` | ~1 screen each | Push detail into a `decisions/<NNNN>` ADR and link it |
| `gotchas.md`, `glossary.md` | grows slowly; one line per entry | Prune entries no longer true |
| `decisions/<NNNN>` | one decision per file | Never merge or renumber |

Default is **omit** (see "When agents write to the wiki"). A file over budget is a
signal to consolidate, not to keep appending. A stale or bloated wiki is a tax on
every agent that reads it.

### How agents consume the wiki

The orchestrator is the wiki's reader-of-record: it reads what a spawn needs and
passes **section-level citations or short excerpts** in RELEVANT WIKI ENTRIES —
never a bare "read `architecture.md`". Leaf and fix agents read ONLY what they're
handed; they do not scan `.wiki/` to self-orient (missing context → a
`paused_for_context` request, not a full-wiki read). The two auditors are the
deliberate exception — `architecture-audit` and `spec-audit` read whole wiki files
because judging fit/adherence against the whole picture IS their job.

### Active Rules

`.wiki/rules.md` holds active rules in a flat list with stable IDs (`R-001`, …),
each tagged `Scope: global` or `Scope: <path-glob>`. This file is **hot**: its
cost is paid on every spawn × up to `MAX_CONCURRENT_AGENTS`, so it is the single
biggest context multiplier in the framework. Keep it to true project-wide
invariants — target ≤ ~15 rules, one screen. Anything that isn't an always-on
invariant belongs in `conventions.md`/`architecture.md` and reaches agents as a
cited excerpt (RELEVANT WIKI ENTRIES), not the always-on block.

The orchestrator reads this file ONCE at session start and caches it split by
scope: the **global subset** goes verbatim into every spawn's `## ACTIVE RULES`; a
**scoped rule** goes only to agents whose subtree matches its `Scope`. This keeps
each spawn carrying the invariants it needs and nothing more. **Sub-agents do NOT
re-read `rules.md`** — they receive their slice inline. If the file changes
mid-session, refresh the cache; new sub-agents get the update, running ones keep
their list.

### When agents write to the wiki

A wiki update is appropriate when a finding is **durable** (still true in a
month), **non-obvious from the code**, and **project-scoped**. An architectural
decision → a `decisions/<NNNN>-<slug>.md` entry. A new rule → append to
`rules.md`. A "we tried X, it failed because Y" → `gotchas.md`. A clarified
convention → `conventions.md`. A new domain term → `glossary.md`. Wiki edits
happen in the same worktree as the work that produced them and ride the
squash-merge. Default is **omit**: if you can't say why a future agent will need a
note, don't add it.

---

## WORK TAXONOMY & CLASSIFICATION

Every coding request is classified into a tier BEFORE any branch is created.
Classification is the root orchestrator's job and MUST be recorded as an artifact
(the branch tier, plus `.wiki/specs/<id>.md` for a spec). Sub-agents spawn in
isolated context and inherit only what the artifacts and spawn prompt carry — an
unrecorded classification does not exist.

Units are defined by **kind** (the role the work plays), not size.

| Tier | Is | Defining property | Test |
|------|----|--------------------|------|
| **Epic** | coordination across intents | groups ≥2 specs that must be sequenced or integrated | Would doing the specs independently miss a shared cross-cutting decision? No → they're separate specs. |
| **Spec** | a single intent / contract | one coherent objective with acceptance criteria; durable as `.wiki/specs/<id>.md` | Is there exactly one checkable objective? |
| **Implementation** | execution of intent | smallest unit with its own worktree; squashes into its spec as one commit | Can it be built and verified against the spec without its own statement of intent? |
| **task** | trivial change | no intent doc, nothing review-worthy; rare | Would writing a spec entry for it be pure overhead? |

**Classification procedure:** count intents (one → standalone spec; many
interdependent → epic decomposed into specs; trivial → task); decompose each spec
into implementations (sequential `Phase 1, 2, 3` or parallel `Phase 1.1, 1.2`);
emit the artifact (create the branch, write `.wiki/specs/<id>.md` before spawning
implementation work). This taxonomy IS the orchestrate-vs-execute axis: epics and
multi-impl specs are orchestration (top tier); single implementations are
execution (bounded tier). Classifying the work and routing the model are the same
decision.

**Reclassification promotes, never forces.** If an implementation grows its own
intent → it was a spec. If a spec sprouts a second independent objective → it was
an epic. Promotion is a structural decision: a sub-agent proposes it and
escalates; the orchestrator ratifies.

---

## BRANCHING WORKFLOW

All coding work happens in git worktrees under `.worktrees/`, never on the active
branch. Branch from the current active branch (parsed at runtime via
`git branch --show-current`); never hardcode `main`/`develop`.

### Branch naming

Tiers separated by `--`, with `/` only inside tier labels. This prevents git ref
collisions: `some/branch` (a file) and `some/branch--child/name` (a file inside a
`branch--child/` dir) cannot collide at any depth.

| Tier | Pattern |
|------|---------|
| Epic | `<active>--epic/<8id>_<n>` |
| Spec (under epic) | `<epic>--spec/<8id>_<n>` |
| Spec (standalone) | `<active>--spec/<8id>_<n>` |
| Impl | `<spec>--impl/<8id>_<n>` |
| Additional (review fixes / merges) | `<impl>--additional/<n>` |

IDs are 8 random hex chars generated at branch-creation time (`openssl rand -hex 4`).
Use an epic if work needs 3+ specs or sequential decomposition; otherwise a
standalone spec. Standalone specs get the full treatment (worktrees, squash
merges, review, PR).

### Universal merge rule

Squash-merge into parent. Parent = current branch with the last `--` segment
stripped:

```bash
CURRENT=$(git branch --show-current)
MERGE_TARGET="${CURRENT%--*}"
```

Implementation → squash into spec. Spec (child of epic) → squash into epic. Spec
(standalone) and Epic → PR into the active branch (the manual review checkpoint).

### Creating a worktree

```bash
git status                                   # if dirty, stop and ask the user
ACTIVE_BRANCH=$(git branch --show-current)
SPEC_ID=$(openssl rand -hex 4)
SPEC_BRANCH="${ACTIVE_BRANCH}--spec/${SPEC_ID}_<spec-name>"
mkdir -p .worktrees
git worktree add ".worktrees/${SPEC_BRANCH##*/}" -b "${SPEC_BRANCH}"
git -C ".worktrees/${SPEC_BRANCH##*/}" commit --allow-empty \
  -m "spec: Start <n> [target: ${ACTIVE_BRANCH}] [spec-id: ${SPEC_ID}]"
mkdir -p ".worktrees/${SPEC_BRANCH##*/}/.work-log/agents"
```

Record `[target: <branch>]` in the initial commit of every top-level branch —
the PR-creation step reads it to find the merge target. Use
`git -C .worktrees/<name> <cmd>` rather than `cd`-ing in.

### On successful completion (squash up)

Integrate the child work-log BEFORE removing the worktree (removal destroys it),
then:

```bash
git -C "${PARENT_WT}" merge --squash "${CURRENT}"
git -C "${PARENT_WT}" commit -m "<tier>: <description> [<entity>-id: <id>]"
git worktree remove ".worktrees/${CURRENT##*/}" 2>/dev/null || true
git branch -D "${CURRENT}"
```

Every branch created MUST be deleted after squash-merge or PR merge. No stale
branches. `.worktrees/` and `.work-log/` are gitignored; `.wiki/` is NOT — it's
committed.

### Squash-merge conflicts

Don't abort silently. Report the conflicting files and ask: "Resolve and proceed,
or abort?" Only proceed if told to.

---

## SUB-AGENT SPAWN TEMPLATE (mandatory)

The spawn prompt carries ONLY what changes per task — the **dynamic fields** below.
The static protocol every agent follows on every spawn (structural authority,
escalation, context-requests, work-log format, wiki-consumption discipline) lives
in each agent's own definition (`agents/*.md`), which is its system prompt and
costs nothing per-spawn. **Do NOT re-paste that protocol into the spawn prompt** —
duplicating it is the boilerplate tax this template exists to avoid. If you find
yourself writing an `## ESCALATION` or `## STRUCTURAL AUTHORITY` block into a spawn
prompt, stop: it's already in the agent.

```
## CONTEXT
- Branch path / Worktree / Parent task / Your task (one sentence)
- Your agent ID: <role>-<short-context>-<6char-random>
- Your depth: <integer, root orchestrator = 0>
- Project wiki: <repo-root>/.wiki/  (read only the entries cited below; see your agent def)

## ACTIVE RULES
<the GLOBAL rule subset, verbatim from the orchestrator's cached read, PLUS any
scoped rule whose Scope matches this agent's subtree. Not the whole file if the
whole file isn't global — see PROJECT WIKI → Active Rules.>

## RELEVANT WIKI ENTRIES
<SECTION-level citations or short excerpts the spawning agent judged relevant —
"architecture.md#data-flow", or a 2-4 line quote — NOT a bare "read architecture.md".
The agent reads only these; cite them back in your work-log if they influenced you.>

## YOUR SCOPE
<what you may touch, what you may not touch>

## MANDATE (decisions you may make without escalating)
- Subtree you own / You MAY decide / You MUST escalate (to your SPAWNING agent, not the user)
- Decide freely within your mandate; a request bubbles to the nearest ancestor whose mandate covers it.
  Only the session root surfaces to the user.
```

Skipping ACTIVE RULES means the sub-agent runs without project rules; an empty or
whole-file-dump RELEVANT WIKI ENTRIES defeats the point. Keep both tight and
task-specific.

**Mandate = scoped delegation of authority.** It is what makes "validate with the
spawning agent, not the user" a rule instead of a hope. The relationship is
identical at every tier — leaf ⊂ child-orchestrator ⊂ session-root ⊂ user — so the
user is simply the root mandate-holder.

---

## CODE REVIEW PIPELINE

Review runs before every squash-merge. The full Review Agent loop runs before
every PR.

| Merge | Review |
|-------|--------|
| Impl → Spec | Tests + lint. Diff review. Fix before merge. |
| Spec → Epic | Full test suite. Squashed-diff review. Spec-adherence audit. **Architecture-integrity audit** (structural fit + wiki truth). |
| Epic/Spec → Active | **Architecture-integrity audit**, then Review Agent loop until clean. User reviews the PR on GitHub. |

Three read-only audit lenses, each answering a different question:

- **`review`** — code quality. Emits structured JSON findings to
  `.review/iteration-<N>.json` with severity, category, file/lines,
  `suggested_fix`, `auto_fixable`, and a verdict (`clean | needs_fixes |
  needs_human`).
- **`spec-audit`** — does the change match the spec's *intent*? Source of truth:
  `.wiki/specs/<id>.md` + commit messages + PR body. On spec-adherence
  disagreement the auditor wins; on code quality the reviewer wins.
- **`architecture-audit`** — does the change still *fit* the project (placement,
  boundaries, dependency direction), and is the wiki still TRUE? Runs at
  structural boundaries only, which is what keeps it cheap.

### Review Agent loop

1. Tag a pre-review anchor (`git tag review-iN-pre`) for rollback.
2. Spawn a read-only `review` agent → iteration JSON.
3. Triage the verdict: `clean` → exit; `needs_human` → escalate, show the human
   an uncontaminated report, apply NO auto-fixes; `needs_fixes` → step 4;
   `ITERATION >= MAX_REVIEW_ITERATIONS` → escalate ("did not converge").
4. Group findings by locality; per group spawn a `fix` agent in an `--additional/`
   worktree with write access only to its own worktree. Squash each back, re-run
   tests + lint, return to step 1 for iteration N+1.
5. Clean exit: delete review tags, remove `.review/`, proceed to PR.

`auto_fixable: true` requires a mechanical, unambiguous fix with no new product,
architecture, or security decision. Anything involving spec disagreement,
ambiguity, architectural tradeoffs, or a security finding without an obvious
mitigation sets the verdict to `needs_human`.

---

## WORK LOG (AI-to-AI scratch paper)

Every worktree has a `.work-log/` directory used **by the agents in this
top-level unit to pass context to each other.** Not for humans. Not documentation.
It is scratch paper that helps the next agent start with the context the previous
one earned. It is ephemeral: sub-agent work-logs die when their worktree is
removed; the top-level work-log is `rm -rf`'d before the PR push. Durable
knowledge goes to `.wiki/`, not here.

```
.work-log/
├── QUEUE.md          # Top-level only. Sole writer: top-level orchestrator.
├── INDEX.md          # Only if pages/ is non-empty.
├── pages/<topic>.md  # Only if an agent has structured knowledge a future agent will read.
└── agents/<agent-id>.md   # Sole writer: that sub-agent only.
```

**Single-writer per file** — no two agents ever write the same file, so no locks.
Most worktrees only ever have `agents/`. Audience is AI: bullets, fragments,
`file:line` refs, code snippets. No prose, no narration, no "last updated"
metadata.

### Per-agent file

Written once at end of work, before squash-merge:

```markdown
---
agent_id: <full ID>
role: implementation | review | fix | merge | other
status: completed | escalated | failed | paused_for_context
wiki_updates: <list of .wiki/ paths touched, or "none">
---
# <one-line summary>
## What I did
- <factual bullet, 3-5 total, no narration>
## What changed
- <file path>
## What the next agent needs to know
<Omit unless ALL of: a future agent in THIS unit will need it; not visible from
the diff; not durable enough for .wiki/ (if durable, put it there); <10 lines.>
```

### Integration (the bubble-up)

When a sub-agent's branch is about to squash-merge, the parent reads
`agents/<child-id>.md` (and the child's `pages/` if any) BEFORE removal and makes
a judgment per item: **absorb** into its own notes (default), **lift** a
substantial page into its own `pages/`, **promote** durable project-scoped
knowledge to `.wiki/`, or **discard** (the diff already captures it). Then it
appends one line to its own agent file: `integrated <child-id>: <outcome>`.

Siblings benefit from each other's completed work *through the parent*, never by
reading each other directly. Sequential siblings benefit naturally: by the time
sibling N spawns, the parent has integrated 1..N-1 and the spawn template reflects
it. Parallel siblings can't see each other — by design; if they needed to, they
shouldn't be parallel.

### Context requests (request-up, deliver-down)

Sub-agents never read grandparent or higher work-logs. If a sub-agent needs
context that should exist higher but isn't in its spawn prompt, it writes its
agent file with status `paused_for_context`, a `## Context I need` section, and
`context_request_hops: 1`, then exits. The parent answers from its own context /
`.wiki/` by re-spawning a fresh agent with the answer appended, or propagates the
request upward (incrementing hops). At `MAX_CONTEXT_REQUEST_DEPTH` it becomes a
normal escalation — a chain that deep means context was mishandled at spawn time.
Use this only for *missing context*; spec ambiguity or a human decision is a
normal `escalated`, not a context request.

---

## STATE RECONCILIATION

Long multi-agent runs desync git, the wiki, and worktree state. At session start,
after a crash, or when something feels off, spawn the read-only `state-doctor` to
detect drift: orphan worktrees/branches, wiki spec entries whose branch no longer
exists, stale `review-iN-pre` tags, stale `.review/`/`.work-log/` in merged
worktrees, rules with broken `Source:` links, dangling `paused_for_context`
agents. The doctor **proposes** fixes and the user confirms; it never executes
destructive ops and never deletes wiki entries (only reports `status:` updates).

---

## CROSS-SESSION RECONCILIATION

If you run multiple sessions in parallel on one project (e.g. one per terminal
tab), only the **session root** reconciles against shared state — child
orchestrators work within the design their root has reconciled. At session start,
before each top-level integration, and before any structural decision:
`git fetch` the integration branch and reconcile the latest `.wiki/` into the
working design. Build on current reality, not a stale snapshot. Changes to shared
surfaces (top-level architecture, cross-cutting conventions) escalate to the user
— cross-session structural arbitration is the user's mandate, not a session's.

**Shared-namespace numbering.** Globally-sequential `decisions/<NNNN>` filenames
and `R-NNN` rule IDs collide when parallel sessions each grab "the next integer."
Prevent it by partitioning the number space per session: assign each concurrent
session a distinct hundred-block (session 1 → `0100`s / `R-100`s, session 2 →
`0200`s / `R-200`s, …), recorded in the opening commit trailer. The serial low
range `0001–0099` is the single-session default. Numbers are then globally unique
by construction, so the integrator never renumbers at merge. Index/list conflicts
are keep-all: order by number, never drop a side.

---

## HEADLESS OPERATION

When `CLAUDE_HEADLESS=1`, there is no human to prompt. Escalations and refusals
write `.review/HUMAN_REVIEW_NEEDED.md` (or `MERGE_CONFLICT_NEEDS_HUMAN.md`) with
the branch path and what's blocking, then the orchestrator moves to the next
`QUEUE.md` item. The session ends cleanly when the queue is empty and no
sub-agents are running. The user's primary signal next morning is the git log of
squash-merges plus any escalation files — the work-log itself is internal.

If a top-tier agent hits a safety-classifier refusal, treat it exactly like an
`escalated` status; never silently re-submit the identical prompt (it will refuse
again). See `docs/model-routing.md` → MODEL FALLBACK & REFUSALS.

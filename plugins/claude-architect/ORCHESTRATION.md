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

## PROCEDURES (read at the moment named, not up front)

What stays in this document is **always-on discipline**: the rules that shape
every decision whether or not you notice them. What lives below is
**at-a-moment procedure** — read it when its trigger fires, and not before. The
trigger is the resident part; the steps are not.

| Read | When |
|------|------|
| `docs/procedures/review-loop.md` | About to open a PR for a top-level unit |
| `docs/procedures/spawn-child-orchestrator.md` | Handing a sub-unit to an orchestrator, especially with parallel siblings |
| `docs/procedures/state-reconciliation.md` | Session start, after a crash, or the tree feels off |
| `docs/procedures/multi-session.md` | More than one session is running on this repo |
| `docs/procedures/headless.md` | `CLAUDE_HEADLESS=1` |
| `docs/model-routing.md` | Remapping model tiers, or after a classifier refusal |

Mechanical git recipes are `scripts/`, not prose — invoke them rather than
reconstructing the commands:

| Script | Does |
|--------|------|
| `scripts/new-worktree.sh <tier> <slug> [parent]` | Dirty-check, id, branch, worktree, `[target:]` commit, work-log dirs. Prints `branch=` / `worktree=` / `unit_id=` / `target=`. |
| `scripts/squash-up.sh <branch> <msg> [--keep-worktree]` | Squash into the derived parent, commit, remove worktree, delete branch. Exits 2 on conflict having committed nothing. |

---

## TUNING

| Knob | Default | Meaning |
|------|---------|---------|
| `MAX_REVIEW_ITERATIONS` | 5 | Review-loop passes before escalating to a human |
| `MAX_MERGE_ATTEMPTS` | 3 | PR conflict-resolution attempts before escalating |
| `MAX_CONCURRENT_AGENTS` | 20 | Sub-agents alive at once across all worktrees |
| `MAX_CONTEXT_REQUEST_DEPTH` | 4 | Hops a `paused_for_context` request may propagate up before escalating |
| `MAX_ORCHESTRATOR_DEPTH` | 4 | Nested orchestrator levels before forcing flatten/escalate (guard-band under the runtime nested-subagent cap of 5) |
| `MAX_CONTINUATIONS` | 3 | Times one unit may be resumed from a continue file before the decomposition is declared wrong |

Override per-project in `.claude/settings.json`.

---

## MODEL ROUTING & RECURSIVE ORCHESTRATION

Model tier follows **role, not depth**. A node runs on the top tier iff it
orchestrates a team; on a cheaper tier iff it does bounded work. Orchestrator-ness
is recursive, so the expensive model appears wherever orchestration happens, at
any depth.

| Role | Tier | Notes |
|------|------|-------|
| Orchestrator (session root AND recursive children) | top | Long-horizon team manager. The ONLY agent carrying the spawn tool (`Task`/`Agent`) — that grant is the orchestrator/leaf boundary. |
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

### Delegate or execute: child orchestrator vs leaves

This decision is **keyed to the work taxonomy**, not re-derived per task. Defaults:

| The unit an orchestrator owns | Each sub-unit gets | Default |
|-------------------------------|--------------------|---------|
| Epic | a child orchestrator per spec | **yes** |
| Spec decomposing into ≥2 phases with shared files or sequencing | a child orchestrator per phase group | **yes** |
| Spec that is one implementation, or a task | `implementation` / `fix` leaves, or do it in place | **yes** |

Flatten a default `yes` to leaves only when: the subtree is a single diff; the
phases share no files and need no sequencing (they're parallel leaves, not a
team); or a child would exceed the depth cap.

**Nesting to depth 2–3 is the framework working, not a smell.** The failure mode
in practice is the opposite of runaway nesting: a root that keeps every spec for
itself, spawns only leaves, and blows its own context window integrating work it
should have delegated. If a run produced no child orchestrators and the work was
an epic or a multi-phase spec, the decomposition was wrong.

**Delegating is not escalating.** A structural decision *inside* a subtree being
handed to a child is delegated with that child's mandate. Escalation is only for
decisions crossing the orchestrator's own mandate boundary upward. "Too
structural to hand off" means *widen the child's mandate*, not *keep it*.

### Depth budget

Runtime hard cap on nested subagents is 5; guard-band at `MAX_ORCHESTRATOR_DEPTH`
(4). A child's depth is the parent's + 1 and the parent MUST state it in the spawn
prompt. Leaves are terminal (no spawn tool). If a child spawn would exceed the
cap, the decomposition is wrong: flatten (spawn leaves) or escalate.

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

**Classification procedure:**

1. Count intents — one → standalone spec; many interdependent → epic decomposed
   into specs; trivial → task.
2. Decompose each spec into implementations (sequential `Phase 1, 2, 3` or
   parallel `Phase 1.1, 1.2`).
3. **Assign an owner role to every sub-unit: `orchestrator` or `leaf`**, per the
   defaults in *Delegate or execute* above. Write the assignment down — one line
   per sub-unit in the work-log, e.g. `spec 7e0e8fb3 api-surface: orchestrator`.
   This step is not optional and not implicit: a sub-unit with no recorded role
   is a delegation decision that was defaulted past rather than made.
4. Emit the artifact — create the branch, write `.wiki/specs/<id>.md` before
   spawning implementation work.

This taxonomy IS the orchestrate-vs-execute axis: epics and multi-impl specs are
orchestration (top tier); single implementations are execution (bounded tier).
Classifying the work, choosing the owner role, and routing the model are one
decision made once and recorded once.

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

Squash-merge into parent, where parent = the branch with its last `--` segment
stripped. Implementation → squash into spec. Spec (child of epic) → squash into
epic. Spec (standalone) and Epic → PR into the active branch (the manual review
checkpoint).

### Creating and closing units

```
scripts/new-worktree.sh spec my-feature            # → branch= worktree= unit_id= target=
scripts/new-worktree.sh impl phase-one "<spec-branch>"   # parent is the 3rd arg
scripts/squash-up.sh "<branch>" "spec: <desc> [spec-id: <id>]"
```

**Pass the parent branch explicitly for any non-top-level unit.** Omitting it
forks the new branch from whatever HEAD the shell happens to be on rather than
from the unit's actual parent — silent, and it only surfaces at merge time.

`new-worktree.sh` refuses on a dirty tree — that refusal is a stop-and-ask, not
something to work around. It records `[target: <branch>]` in the initial commit
of every top-level branch, which the PR step reads back to find the merge target.

Integrate the child work-log BEFORE `squash-up.sh` — removing the worktree
destroys it. (If the child's receipt said `needs-parent-read: no`, there is
nothing to integrate; call straight through.) On conflict the script exits 2
having committed nothing: report the conflicting paths and ask "resolve and
proceed, or abort?" Never resolve silently.

Every branch created MUST be deleted after squash-merge or PR merge — no stale
branches. Use `git -C .worktrees/<name> <cmd>` rather than `cd`-ing in.
`.worktrees/` and `.work-log/` are gitignored; `.wiki/` is NOT — it's committed.

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

**Field order is load-bearing — do not rearrange it.** Prompt caching works on
prefixes: shared bytes at the FRONT cache across spawns, and everything after the
first differing byte is cold. `ACTIVE RULES` is byte-identical across every spawn
in a session and `RELEVANT WIKI ENTRIES` is often shared across siblings in a
subtree, so both precede the per-agent fields. Leading with `CONTEXT` (unique
agent ID, worktree, task) would make every sibling spawn cold from its first line.

```
## ACTIVE RULES
<the GLOBAL rule subset, verbatim from the orchestrator's cached read, PLUS any
scoped rule whose Scope matches this agent's subtree. Not the whole file if the
whole file isn't global — see PROJECT WIKI → Active Rules.>

## RELEVANT WIKI ENTRIES
<SECTION-level citations or short excerpts the spawning agent judged relevant —
"architecture.md#data-flow", or a 2-4 line quote — NOT a bare "read architecture.md".
The agent reads only these; cite them back in your work-log if they influenced you.>

## CONTEXT
- Branch path / Worktree / Parent task / Your task (one sentence)
- Your agent ID: <role>-<short-context>-<6char-random>
- Your depth: <integer, root orchestrator = 0>
- Project wiki: <repo-root>/.wiki/  (read only the entries cited above; see your agent def)

## YOUR SCOPE
<what you may touch, what you may not touch>

## MANDATE (decisions you may make without escalating)
- Subtree you own / You MAY decide / You MUST escalate (to your SPAWNING agent, not the user)
- Decide freely within your mandate; a request bubbles to the nearest ancestor whose mandate covers it.
  Only the session root surfaces to the user.

## RESUMING  (include ONLY when respawning a unit that returned `exhausted`)
- Continue file: .work-log/continue/<unit-id>.md — read it FIRST; it is your state.
- Continuation <n> of MAX_CONTINUATIONS. Refresh that same file; do not start a new one.
```

Skipping ACTIVE RULES means the sub-agent runs without project rules; an empty or
whole-file-dump RELEVANT WIKI ENTRIES defeats the point. Keep both tight and
task-specific.

The same prefix logic is why the static protocol belongs in the agent definition
rather than the spawn prompt: an agent def is identical across all spawns of that
role, so it caches from the second spawn onward, while a spawn prompt is unique
and cold every time. Bloating the agent def is far cheaper than bloating the
spawn prompt — which is the opposite of the intuition that a system prompt paid
20× must be the expensive one.

**Mandate = scoped delegation of authority.** It is what makes "validate with the
spawning agent, not the user" a rule instead of a hope. The relationship is
identical at every tier — leaf ⊂ child-orchestrator ⊂ session-root ⊂ user — so the
user is simply the root mandate-holder.

**Spawning a child orchestrator** carries four things a leaf spawn does not: its
depth, its sibling isolation, the seams it owns vs. consumes, and explicit
permission to decompose further. Read
`docs/procedures/spawn-child-orchestrator.md` before writing that prompt —
especially when siblings will run in parallel, since the parent must partition
*files*, not just tasks.

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

Before opening a PR for a top-level unit, run the full Review Agent loop —
steps in `docs/procedures/review-loop.md`. Never load a findings file whole:
verdict from the agent's receipt, index for grouping, bodies only inside the
`fix` agents.

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
├── agents/<agent-id>.md    # Sole writer: that sub-agent only.
└── continue/<unit-id>.md   # Resume state for a unit. Sole writer: the agent currently owning it.
```

**Single-writer per file** — no two agents ever write the same file, so no locks.
Most worktrees only ever have `agents/`. Audience is AI: bullets, fragments,
`file:line` refs, code snippets. No prose, no narration, no "last updated"
metadata.

### The three memory types

Everything an agent writes is one of exactly three things. Pick by **who writes,
who reads, when it dies** — never by topic. If a note doesn't fit a row, it's
probably a note that shouldn't be written.

| Type | Writer | Reader | Dies |
|------|--------|--------|------|
| `.wiki/**` | any agent | every future agent, and humans | never (committed) |
| `.work-log/agents/<id>.md` | one child | its parent, at integration | with the worktree |
| `.work-log/continue/<unit>.md` | the agent owning a unit | that unit's **successor agent** | when the unit completes |

Continue files are the odd one: addressed sideways in time rather than upward,
they must outlive their writer but die before the worktree does. Do not use one
where a work-log agent file belongs — parents read `agents/`, successors read
`continue/`.

### Per-agent file

Written once at end of work, before squash-merge:

```markdown
---
agent_id: <full ID>
role: implementation | review | fix | merge | other
status: completed | escalated | failed | paused_for_context | exhausted
wiki_updates: <list of .wiki/ paths touched, or "none">
continuation: <n>            # omit unless this agent resumed from a continue file
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

### Return payload contract (the receipt)

A sub-agent's final response is returned to its parent **verbatim**, so it is
parent context whether or not the parent needs it. Writing a work-log file and
*also* narrating the same content back is paying twice and defeats the entire
disk-based channel.

**Your final response is a receipt pointing at your work-log, not a report.**
Hard cap ~15 lines, no code blocks, no diffs, no restatement of the work:

```
status: completed
work-log: .work-log/agents/<your-id>.md
files: <paths touched, one line>
needs-parent-read: no        # yes ONLY if the line below is non-empty
surprises: <blank, or ONE line: what happened that the diff does not show>
```

The savings exist **only because the parent can then decline to open the file.**
`status: completed` + `needs-parent-read: no` means the parent integrates and
merges without reading anything. So `surprises` is the load-bearing field: set
`needs-parent-read: yes` for a structural proposal, a deviation from the spawn
prompt, a discovered constraint the next sibling must know, or anything the diff
cannot show. Routine completion is not a surprise. Over-flagging costs the
parent its context; under-flagging costs correctness — when genuinely unsure,
flag it.

Non-`completed` statuses (`escalated`, `failed`, `paused_for_context`,
`exhausted`) always imply `needs-parent-read: yes`.

### Continue files (resuming a unit that ran out of room)

An agent cannot measure its own remaining context, and a parent cannot observe a
running child's at all — there is no polling, no interrupt, no handle. So
continuation is **never detected**; it is prepared for continuously.

**Checkpoint rule.** An agent owning a unit writes/refreshes
`.work-log/continue/<unit-id>.md` at every structural boundary: after integrating
a child, before each spawn batch, after each squash-merge. The file is therefore
always current, and a compaction, crash, or kill lands in an already-recoverable
state instead of losing the mandate.

**Contents — state, not story.** The mandate and scope **verbatim** (this is
precisely what compaction destroys), the decomposition with its per-sub-unit
owner-role assignments, done / in-flight / not-started, and open escalations.
No narrative, no reasoning, no history of what was tried. Cap ~100 lines: if
the unit's state doesn't fit, the unit was scoped too large.

**Replace, never append.** A continue file that grows rebuilds the original
problem one level down. Each successor overwrites it.

**Key it to the unit, not the agent.** The reader is a *different* agent than the
writer, so `<unit-id>` (the spec/impl 8-hex id) is the stable handle;
`<agent-id>` is not.

**Location matters.** An orchestrator's continue file lives in the `.work-log/`
of the worktree it will still exist in after the resume. The session root's
belongs at the **repo root** `.work-log/`, never inside a child worktree —
`git worktree remove` would delete the very file the resume depends on.
`.work-log/` is gitignored, so continue files are excluded from commits for free.

**Continuation is recovery, not a scaling strategy.** When a child returns
`status: exhausted`, the parent's default is to **re-decompose the unit into two
smaller children**, not to respawn it with its continue file. Resuming is the
fallback for work that genuinely cannot be split (a long sequential refactor).
Anything else papers over a decomposition that was wrong at spawn time.

**Cap the chain at `MAX_CONTINUATIONS` (3).** Continuation N+1 is written from a
context that already contained continuation N, so fidelity decays with every hop.
Hitting the cap is not a signal to allow a fourth — it means the unit must be
re-decomposed or escalated. The session root is the exception with no parent to
re-decompose it: for the root, resuming from its continue file IS the mechanism,
and `QUEUE.md` + `.wiki/` + the root continue file must together be sufficient to
restart cold.

### Integration (the bubble-up)

When a sub-agent's branch is about to squash-merge, the parent decides from the
child's **receipt** whether to open its work-log at all. `status: completed` with
`needs-parent-read: no` → integrate and merge without reading; that skip is where
the context saving actually lives. Otherwise the parent reads
`agents/<child-id>.md` (and the child's `pages/` if any) BEFORE removal and makes
a judgment per item: **absorb** into its own notes (default), **lift** a
substantial page into its own `pages/`, **promote** durable project-scoped
knowledge to `.wiki/`, or **discard** (the diff already captures it). Then it
appends one line to its own agent file: `integrated <child-id>: <outcome>`.

A child's `continue/` files are never integrated upward — they are addressed to
that unit's own successor and die with the completed unit. A parent reads a
child's continue file in exactly one case: it is respawning that unit.

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

## OPERATING CONDITIONS

Three conditions change how you run. Recognising them is resident; the procedure
for each is not.

**Drift.** Long multi-agent runs desync git, the wiki, and worktree state. At
session start, after a crash, or when something feels off, spawn the read-only
`state-doctor` → `docs/procedures/state-reconciliation.md`. It proposes, the user
confirms; it never executes destructive ops and never deletes wiki entries.

**Parallel sessions.** If more than one session is running on this repo, only the
session root reconciles against shared state, and structural conflicts between
sessions are the user's call, not a session's →
`docs/procedures/multi-session.md` (also the `decisions/<NNNN>` and `R-NNN`
numbering rule, which matters even single-session).

**Headless.** When `CLAUDE_HEADLESS=1` there is no human to prompt: escalations
become files and the queue keeps moving → `docs/procedures/headless.md`. This is
the condition the checkpoint rule exists for, since nobody is watching to restart
an exhausted root.

A safety-classifier refusal on a top-tier agent is an `escalated` status, never a
silent retry of the identical prompt — see `docs/model-routing.md` → MODEL
FALLBACK & REFUSALS.

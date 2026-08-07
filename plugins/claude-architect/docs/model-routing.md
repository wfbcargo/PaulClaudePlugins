# Model & Effort Routing

Two dials, not one. **Model** is chosen by *what a mistake costs*; **effort** is
chosen by *how much of the problem the agent has to work out for itself*. Most
of the spend in a run is decided by the second dial on the highest-volume role.

## TL;DR tiering

| Role | Model | Effort | Why |
|------|-------|--------|-----|
| Orchestrator — session root AND recursive children | `claude-opus-5` | `high` | Long-horizon team manager. A bad decomposition wastes a whole subtree of leaf work, so planning tokens here are the cheapest tokens in the run. Never drop this to medium. |
| Architecture-integrity auditor | `claude-opus-5` | `high` | The drift gate — largest blast radius in the pipeline. Cheap because it is boundary-triggered, not per-iteration; that is what buys it top model *and* high effort. |
| Review Agent | `claude-opus-5` | `medium` | Bounded reasoning, but a missed bug is a **silent** failure that passes the gate. Low-volume (per top-level unit), so the model barely moves the bill — effort is the dial. |
| Merge sub-agent | `claude-opus-5` | `medium` | Same shape: bounded, low-volume, and its failure mode is silent — a mangled merge that still compiles. |
| Spec-adherence auditor | `claude-sonnet-5` | `medium` | Bounded and *checkable*: this change vs this spec's stated intent. A wrong answer surfaces as a disputed finding, not a silent pass. |
| Implementation / fix (leaf) | `claude-sonnet-5` | `medium` | Narrow, well-scoped, **highest volume** (up to `MAX_CONCURRENT_AGENTS`). Dominates spend, so this is the only row where the dials really move the bill. |
| state-doctor | `claude-haiku-4-5` | `low` | Read-only checklist diagnostics. Proposes; never executes. |

The split axis for **model** is *whether a mistake is silent*: orchestration and
architecture drift are unbounded, and a bad merge or a missed bug slips through a
gate unnoticed. Everything whose failure surfaces immediately — a leaf that
misreads its scope, an auditor whose finding you can dispute — runs on the
bounded tier.

The split axis for **effort** is *how much the agent must derive*. An
orchestrator starts from a mandate and must invent a decomposition: high. A leaf
receives `CONTEXT`, `SCOPE`, `ACTIVE RULES`, and a work log — nearly everything
is given, so tight literal execution is exactly what you want: medium.

## Why leaves run at medium, deliberately

Lower effort makes a model follow instructions more literally and scope its work
to what was asked rather than going beyond it. For a general-purpose session
that is a downside. For a leaf agent under an explicit `## YOUR SCOPE` boundary
it is **the desired behaviour** — it is the same discipline the scope block is
trying to enforce, obtained for free. Leaves that gold-plate, refactor
surrounding code, or expand scope are the failure this framework spends review
iterations catching.

If review iterations climb after adopting these defaults, raise the leaf rows
(model first, then effort) rather than raising everything.

## When to reach for `claude-fable-5`

Fable is roughly **2x** the per-token price of Opus 5, and orchestrators are the
longest-lived, largest-context sessions in the framework — so it is an opt-in,
not a default. Use it for the orchestrator (and only the orchestrator) when:

- the epic is genuinely hard to decompose — many interacting specs, unclear seams;
- a previous run produced a decomposition that had to be re-done; or
- the session root is running headless overnight, where a bad plan burns hours
  before anyone notices.

Set it on the *session root only* (via `.claude/settings.json`) and leave the
recursive children on Opus 5, unless the whole subtree is that hard. Fable
requires 30-day data retention and is unavailable to zero-data-retention orgs.

## How the routing resolves

Claude Code resolves a sub-agent's model in this order, first match wins:

1. `CLAUDE_CODE_SUBAGENT_MODEL` environment variable
2. the per-invocation `model` parameter on the spawn
3. the `model:` field in the agent's own `agents/*.md` frontmatter
4. otherwise, inherit the main session's model

Setting `CLAUDE_CODE_SUBAGENT_MODEL` to `inherit` is the same as leaving it
unset — resolution continues to (2) and (3). **A blanket
`CLAUDE_CODE_SUBAGENT_MODEL` overrides every agent file in this plugin and
collapses the whole table above onto one model.** That is a legitimate choice
(see *Remapping* below), but make it deliberately.

`effort:` resolves more simply: the agent's frontmatter overrides the session
effort level; with no frontmatter value the agent inherits the session's.

**Tool-gating is the orchestrator/leaf boundary.** Only `orchestrator.md` lists
the sub-agent spawn tool, so only it can spawn children. Every other agent omits
it and is terminal by construction. Do not add it to a leaf to "let it help" —
that is how you get runaway nesting.

Claude Code has surfaced that tool as `Task` and, in current versions, as
`Agent`. `orchestrator.md` lists **both** so the grant survives either naming
(unrecognized names in a `tools:` list are ignored). This matters because the
failure is silent: an orchestrator that loses the grant does not error — it
quietly behaves like a leaf, does all the work in its own context, and the run
still "succeeds." **If an orchestrator stops spawning anything at all — leaves
included — check this line first.**

Note that **zero child orchestrators is not itself a symptom.** Leaves are the
default (ORCHESTRATION.md → *Delegate or execute*), and most runs should have no
nested orchestrators at all. The signature of a broken grant is an orchestrator
spawning nothing whatsoever and doing every phase in its own context.

## Remapping to the models you have

- **Only one capable model?** Set every agent's `model:` to it and keep the
  `effort:` column as-is. The effort split alone recovers a large share of the
  savings, because it applies to the highest-volume role. This is a perfectly
  reasonable configuration.
- **Two tiers?** Put orchestration + architecture-audit + review + merge on the
  stronger model and the rest on the cheaper one — that is the silent-failure
  boundary described above.
- **Zero-data-retention repos** can't run models with mandatory retention — pin
  such a repo's `settings.json` to a model your policy allows, and do not use
  Fable there.

## Tuning for cost

In descending order of impact:

1. **Agent count**, which is set by the delegation defaults — not by any model
   choice. A child orchestrator that manages two leaves costs more than the two
   leaves do, and writes no code. Leaves are the default for exactly this
   reason; see ORCHESTRATION.md → *Delegate or execute*.
2. **The leaf rows.** `implementation` and `fix` run up to
   `MAX_CONCURRENT_AGENTS` at once and dominate what is left.
3. **Wiki and spawn-prompt size.** `.wiki/rules.md` is paid on every spawn ×
   concurrency; see ORCHESTRATION.md → *Active Rules*. And never let
   `ORCHESTRATION.md` reach `CLAUDE.md` — that multiplies an 8k-token document by
   the whole run's agent count, for agents that need none of it.
4. **Effort on the bounded roles.** Real, but smaller than the above.

Do not tune (2) by lowering the orchestrator — that inverts the leverage.

**Wall-clock is a separate axis from cost, and it is usually worktrees and serial
gates, not tokens.** Fresh worktrees start with no dependencies (see
`scripts/worktree-setup.sh`), and every review iteration is serial by
construction. If runs feel slow rather than expensive, look at
ORCHESTRATION.md → *When a unit gets a worktree* and `MAX_REVIEW_ITERATIONS`
before you touch any model.

## Model fallback & refusals

Some higher-tier models run safety classifiers that can decline a request. A
refusal is NOT an error — it is a successful turn that ends with a refusal stop
reason and a classifier category. Only the agent that hit it falls back; siblings
are unaffected.

- **Interactive:** a flagged request pauses with switch-model / edit-and-retry.
- **Headless (`CLAUDE_HEADLESS=1`):** there's no prompt to show, so the request
  ends the turn with a refusal. Treat this exactly like an `escalated` status:
  write `.review/HUMAN_REVIEW_NEEDED.md` (or `MERGE_CONFLICT_NEEDS_HUMAN.md`)
  with the branch path, the refused task, and the classifier category, notify,
  and move to the next `QUEUE.md` item. **Never silently re-submit the identical
  prompt** — it will refuse again.
- Add a STATE RECONCILIATION check for stuck-on-refusal agents: a benign task
  that was a false-positive flag is a candidate for re-spawn on a model without
  that classifier layer.

## Reasoning hygiene

Instructions that tell an agent to echo, transcribe, or explain its internal
chain-of-thought as response text can trip a `reasoning_extraction` classifier
and cause spurious fallbacks. Keep every agent action/outcome oriented — the
work-log records **what I did / what changed**, never the thought process that
produced it. The shipped agent files already carry a one-line "report actions,
not reasoning" instruction for this reason.

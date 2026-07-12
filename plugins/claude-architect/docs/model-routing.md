# Model Routing

How the model tier is chosen per agent, and how to remap it to what you have.

## TL;DR tiering

| Role | Tier | Why |
|------|------|-----|
| Orchestrator — session root AND recursive children | top | Long-horizon team manager: caches rules, governs concurrency, integrates work-logs, drives the review/merge loops, reconciles design. Recursive: appears wherever a sub-problem is a real team-with-integration problem. |
| Architecture-integrity auditor | top | The drift gate. Read-only, fires at structural boundaries only. Largest blast radius in the pipeline; cheap because it's boundary-triggered, not per-iteration. |
| Review Agent | bounded | Code-quality review is local/bounded and parallelizes cheaply across iterations. |
| Spec-adherence auditor | bounded | Bounded: this change vs this spec's intent. |
| Merge sub-agent | bounded | Semantic conflict resolution; high-stakes but bounded. |
| Implementation / fix (leaf) | bounded | Narrow, well-scoped, **highest volume** (up to `MAX_CONCURRENT_AGENTS`). Dominates spend, so keep it off the top tier. |
| state-doctor | cheap | Read-only diagnostics. |

Net: **the top tier owns the project-wide / long-horizon decisions
(orchestration + architecture integrity); the bounded tier owns the local ones
(code review, spec adherence, merges, leaf implementation).** The split axis is
the *blast radius of the decision*.

## How the routing resolves

- **Orchestrator** = the main session model. The `"model"` in `.claude/settings.json`
  sets what every top-level-unit session starts on.
- **Leaf default** = `CLAUDE_CODE_SUBAGENT_MODEL`. Any sub-agent without an
  explicit model inherits this.
- **Per-role overrides** = the `model:` field in each `agents/*.md`. The audit /
  orchestrator roles pin the top tier; everything else inherits the leaf default
  or pins the cheap tier.

**Tool-gating is the orchestrator/leaf boundary.** Only `orchestrator.md` lists
the `Task` tool, so only it can spawn children. Every other agent omits `Task`
and is terminal by construction. Do not add `Task` to a leaf to "let it help" —
that is how you get runaway nesting.

## Remapping to the models you have

The agent files ship with concrete IDs (`claude-fable-5` for the top tier,
`claude-opus-4-8` for bounded, `claude-sonnet-4-6` for the cheap diagnostic
role). Adjust them to your access and budget:

- **Only one capable model?** Set every agent's `model:` to it. The framework
  still works — you lose the cost optimization, not the structure. This is a
  perfectly reasonable default and is exactly how the author runs it on a machine
  without separate-tier access.
- **Two tiers?** Put orchestration + architecture-audit on your stronger model
  and everything else on the cheaper one.
- **Zero-data-retention repos** can't run models with mandatory retention — pin
  such a repo's `settings.json` to a model your policy allows.

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

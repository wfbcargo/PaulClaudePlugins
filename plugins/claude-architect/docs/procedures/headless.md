# Procedure — headless operation

**Read this when:** `CLAUDE_HEADLESS=1`. There is no human to prompt.

Escalations and refusals write `.review/HUMAN_REVIEW_NEEDED.md` (or
`MERGE_CONFLICT_NEEDS_HUMAN.md`) naming the branch path and what is blocking,
then the orchestrator moves to the next `QUEUE.md` item. The session ends cleanly
when the queue is empty and no sub-agents are running.

The user's primary signal next morning is the git log of squash-merges plus any
escalation files. The work-log is internal and is not a report.

## Checkpointing matters more here than anywhere else

Nobody is watching to restart a root that runs out of room mid-queue. Keep the
root continue file at the **repo-root** `.work-log/continue/` current at every
structural boundary, so a fresh root can be started against the same repo and
pick the queue up cold. `QUEUE.md` + `.wiki/` + that file are the whole handoff.

## Refusals

If a top-tier agent hits a safety-classifier refusal, treat it exactly like an
`escalated` status. Never silently re-submit the identical prompt — it will
refuse again. See `docs/model-routing.md` → MODEL FALLBACK & REFUSALS.

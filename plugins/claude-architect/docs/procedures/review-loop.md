# Procedure — Review Agent loop

**Read this when:** you are about to open a PR for a top-level unit (epic, or
standalone spec). The per-merge review boundaries and the three audit lenses stay
resident in `ORCHESTRATION.md`; this is the loop mechanics only.

1. Tag a pre-review anchor (`git tag review-i<N>-pre`) for rollback.
2. Spawn a read-only `review` agent → `.review/iteration-<N>.json`.
3. Triage from the agent's **receipt** — its `verdict` line, not the findings:
   - `clean` → exit to step 5.
   - `needs_human` → escalate. Show the human an uncontaminated report and apply
     NO auto-fixes.
   - `needs_fixes` → step 4.
   - `N >= MAX_REVIEW_ITERATIONS` → escalate ("did not converge").
4. Read only the findings **index** from the JSON (id, file, severity) — not the
   `suggested_fix` bodies. Group by locality; per group spawn a `fix` agent in an
   `--additional/` worktree with write access only to that worktree, passing it
   its finding IDs. Each `fix` agent reads its own findings out of the report
   itself. Squash each back, re-run tests + lint, return to step 1 for N+1.
5. Clean exit: delete the review tags, remove `.review/`, proceed to PR.

`auto_fixable: true` requires a mechanical, unambiguous fix with no new product,
architecture, or security decision. Anything involving spec disagreement,
ambiguity, architectural tradeoffs, or a security finding without an obvious
mitigation sets the verdict to `needs_human`.

**Context note.** Steps 3 and 4 are where this loop can quietly cost you the
orchestrator: the findings file is the largest artifact in the pipeline and it is
regenerated every iteration. Never load it whole. Verdict from the receipt,
index for grouping, bodies only in the `fix` agents.

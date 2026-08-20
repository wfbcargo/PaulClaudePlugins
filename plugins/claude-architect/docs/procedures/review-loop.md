# Procedure — Review Agent loop

**Read this when:** you are about to open a PR for a top-level unit (epic, or
standalone spec). The per-merge review boundaries and the three audit lenses stay
resident in `ORCHESTRATION.md`; this is the loop mechanics only.

**Scale to footprint first.** A small-footprint unit (≲5 files, no shared
surface) does not run this loop — tests, lint, and a diff read are the gate. This
loop is for units whose footprint earned it.

1. Tag a pre-review anchor (`git tag review-i<N>-pre`) for rollback.
2. **Pick the lens set from the diff**, then spawn it **in one message** so it
   runs concurrently. Preconditions are in ORCHESTRATION.md → *Code review
   pipeline*; check them against the squashed diff, not against the task
   description.
   - `review` with `dimension: correctness` → always.
   - `review` with `dimension: concurrency | security | performance` → one spawn
     each, only for dimensions whose precondition fired.
   - `spec-audit` → always.
   - `architecture-audit`, `test-audit` → only if their preconditions fired.

   Each writes its own report file. Record the lenses you skipped and why — a
   skip is a decision, and an unrecorded one is a decision you defaulted past.
   On iterations N≥2, re-run only the lenses that returned `needs_fixes`; a lens
   that came back `clean` on a diff the `fix` agents only narrowed stays clean,
   and re-running the whole set every pass is the loop's biggest avoidable cost.
3. Triage from the agents' **receipts** — their `verdict` lines, not the findings:
   - `clean` → exit to step 6.
   - `needs_human` → escalate. Show the human an uncontaminated report and apply
     NO auto-fixes.
   - `needs_fixes` → step 4.
   - `N >= MAX_REVIEW_ITERATIONS` → escalate ("did not converge").
4. **Severity floor.** If no finding is `blocker` or `major`, the loop is done:
   record the remaining minors in the work-log (or as PR comments) and exit to
   step 6. Another serial iteration to clear nits costs more than the nits do,
   and the human is about to read this PR anyway.
5. Read only the findings **index** from each JSON (id, file, severity) — not the
   `suggested_fix` bodies. Group by **locality across all reports**: findings
   from different dimensions on the same file belong to ONE `fix` agent, because
   two agents editing one file collide no matter which lens found the problem.
   Finding ids are dimension-prefixed (`corr-1`, `sec-2`, `test-3`) so they stay
   unique across files; pass each `fix` agent its ids **and the report path each
   id lives in**. Per group spawn a `fix` agent **in the top-level worktree, not
   a new one** (see ORCHESTRATION.md); each reads its own findings out of the
   reports itself. Fix agents edit but do NOT commit. When the batch returns,
   make ONE commit, re-run tests + lint, and return to step 1 for N+1.

   Watch for **contradictory findings across dimensions** — `performance` asking
   to cache what `concurrency` just flagged as shared mutable state is the
   classic pair. Two lenses disagreeing is a design question, not a fix: resolve
   it yourself or escalate it as `needs_human`. Never hand both findings to one
   `fix` agent and let it pick.
6. Clean exit: delete the review tags, remove `.review/`, proceed to PR.

`auto_fixable: true` requires a mechanical, unambiguous fix with no new product,
architecture, or security decision. Anything involving spec disagreement,
ambiguity, architectural tradeoffs, or a security finding without an obvious
mitigation sets the verdict to `needs_human`.

**Context note.** Steps 3 and 5 are where this loop can quietly cost you the
orchestrator: the findings file is the largest artifact in the pipeline and it is
regenerated every iteration. Never load it whole. Verdict from the receipt,
index for grouping, bodies only in the `fix` agents.

**Latency note.** Every iteration is serial by construction — tag, review, fix,
re-test — so each one is wall-clock added to the critical path with the user
waiting. That is why `MAX_REVIEW_ITERATIONS` defaults to 2 and why the severity
floor exists. A finding set that survives two passes is one a human should look
at, not one to spend a third pass on.

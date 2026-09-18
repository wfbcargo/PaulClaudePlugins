# 534990eb — Remote (cloud) execution for claude-architect

## Objective

Let the orchestrator place `implementation` leaves on Anthropic-managed cloud VMs
(`isolation: remote`) instead of local worktrees, without breaking the wiki, the
work-log roll-up, or the squash-merge chain. Default OFF. Designed so that
allowing non-leaf roles later is a config change, not a rewrite.

## Acceptance criteria

1. `REMOTE_EXECUTION=off` changes no branch, worktree, script or dispatch
   behaviour — every remote mechanism stays dormant and local runs take exactly
   the paths they took before.

   **The wiki-writer policy (S3) is the deliberate exception and is NOT gated by
   this knob.** It changes how local leaves behave too, because its reason is
   concurrency rather than location: parallel leaves cannot see each other's
   in-flight `decisions/<NNNN>` and `R-NNN` allocations whether they run on this
   machine or on a VM. Gating it on `REMOTE_EXECUTION` would leave the race in
   place for exactly the configuration most people run. Recorded here because an
   earlier wording of this criterion said "byte-for-byte", which S3 contradicts;
   the spec-adherence audit caught it and S3 is what was built.
2. A remote leaf's code, work-log, and wiki proposals all reach the parent
   branch without the leaf ever writing to the orchestrator's filesystem.
3. No two concurrent leaves can collide on `.wiki/` numbering.
4. Every script is exercisable locally with no cloud access.

## Environment finding (Phase 0, 2026-09-17)

`isolation: remote` is present in Claude Code v2.1.275 (agent frontmatter accepts
`worktree|remote`; the Agent tool exposes it) but is **gated off for this
account**. A probe dispatched with `isolation: remote` silently fell back to a
local worktree (`spawnedWithWorktree: true`).

The gate requires ALL of: claude.ai auth; not already inside a cloud session;
`hasUsedRemoteSession` true **for the project**; `hasRemoteEnvironment` true
(global); and the server-side `tengu_neapolitan` feature flag.

This account has `hasRemoteEnvironment: true` but `hasUsedRemoteSession` is unset
across all 45 known projects.

**Correction (post-PR):** this section originally said creating a cloud session
with `claude --cloud` would set the project flag. It does not. The flag's only
writer is called from exactly one place, with `{project:false, global:false}`, so
in v2.1.275 no user action sets it. Verified by creating a session from this repo
and diffing `~/.claude.json` before and after: the file was rewritten, the flag
was not added, and no backup has ever carried it. Remote agents are therefore a
rollout gate on this build, not a setup step. Cloud *sessions* work on this
account — only the Agent tool's `isolation: remote` integration is closed.

**Consequence:** the transport, protocol, and policy are built and testable now;
end-to-end verification waits on the gate. Fallback is safe — an ungated remote
dispatch degrades to a local worktree rather than failing.

## Seams (contract — both sides build against this text)

### S1. Work-log export path
Remote leaves write `.work-log-export/<agent-id>.md`, **committed** on their own
branch. Local leaves are unchanged (`.work-log/agents/<agent-id>.md`, gitignored).
`squash-up.sh --from-origin` deletes `.work-log-export/` as part of the squash
commit, so it never reaches a PR.

### S2. Receipt
Unchanged fields, plus `branch:` for remote leaves only.

**For a remote leaf the receipt is written as the FIRST block of its export log,
not only as a final message.** A remote launch "counts as spawned but never
reports an outcome" — the parent gets a `remote_launched` handle immediately and
may never receive the leaf's final text. The committed export log is therefore
the only channel the orchestrator can rely on, and the receipt must be inside it.
A local leaf is unchanged: its receipt is its final message.

    status: completed
    work-log: .work-log-export/<your-id>.md
    branch: <the branch you pushed>          # remote leaves only
    files: <paths touched, one line>
    needs-parent-read: no
    surprises: <blank, or ONE line>

### S3. Wiki proposals — applies to ALL leaves, local and remote
Leaves NEVER write `.wiki/`. A leaf with durable knowledge appends one section to
its work-log and sets `needs-parent-read: yes`:

    ## Wiki proposals
    - target: rules.md | conventions.md | architecture.md | gotchas.md | glossary.md | decisions/
      kind: append | amend | new-decision
      title: <required for decisions/, omitted otherwise>
      body: |
        <the exact text to add, <=10 lines>
      why-durable: <one line: why a future agent needs this>

Omit the whole section when there is nothing to propose (default is omit, as before).

The **orchestrator is the sole writer of `.wiki/`**. It applies accepted proposals
on the parent branch during integration and allocates every `decisions/<NNNN>`
and `R-NNN` number itself. A rejected proposal is one line in the orchestrator's
own agent file: `rejected wiki proposal from <child-id>: <reason>`.

The two auditors (`architecture-audit`, `spec-audit`) and `state-doctor` are
read-only and unaffected.

### S4. Branch and base contract for a remote leaf
A remote agent's base is the session's current branch **only if that branch is
pushed to origin**, else the repository default branch. There is no per-agent base
parameter. Therefore:

- Orchestrator, before dispatch: `git push -u origin <base>`
- Remote leaf, first action: `git fetch origin && git checkout -B <assigned-branch> origin/<base>`
- Remote leaf, last action: commit, then `git push -u origin <assigned-branch>`
- Assigned branch follows the existing scheme unchanged: `<base>--impl/<8id>_<slug>`

### S5. No cross-VM context requests
A cloud session cannot message its parent, and a permission prompt with no client
puts it in `requires_action` and errors. `paused_for_context` is therefore
UNAVAILABLE to a remote leaf. A remote leaf missing context writes
`status: failed` with a `## Context I need` section and exits; the orchestrator
re-dispatches with the answer appended.

### S6. Tuning knobs (added to ORCHESTRATION.md -> TUNING)

| Knob | Default | Meaning |
|------|---------|---------|
| `REMOTE_EXECUTION` | `off` | `off` / `leaf` / `subtree`. `subtree` is v2 and rejected in v1. |
| `MAX_CONCURRENT_REMOTE_AGENTS` | 6 | Separate budget from `MAX_CONCURRENT_AGENTS`, which is disk-bound. |
| `REMOTE_LEAF_TIMEOUT_MIN` | 45 | Watchdog before a leaf is declared lost and re-dispatched. |

### S7. Script surface (exact names and printed `key=value` lines)

| Script | Prints |
|---|---|
| `remote-preflight.sh` | `remote_available=`, `reason=`, `origin=`, `default_branch=`, `base_pushed=`, `plugin_declared=`, `setup_script=` |
| `remote-dispatch.sh <tier> <slug> <parent>` | `base=`, `branch=`, `unit_id=`, `export_dir=` (a directory — no agent id exists yet) |
| `remote-collect.sh <branch>` | `fetched=`, `export_log=`, `commits=`, `status=` |
| `squash-up.sh <branch> <msg> [--from-origin] [--keep-worktree]` | `merged=`, `into=`, `parent_worktree=`; or `merged=none`, `status=empty-after-strip` with exit 3 |

### S8. Eligibility predicate (v1)
A unit may be dispatched remotely only when ALL hold: role is `implementation`;
`REMOTE_EXECUTION=leaf`; the repo has a GitHub `origin`; the base branch is
pushed; the project declares the plugin in its `.claude/settings.json`. `fix`,
`review`, `merge`, and the audit roles are LOCAL-ONLY in v1 — `fix` permanently,
because it edits the top-level worktree without committing and that model cannot
cross a machine boundary.

Remote cannot nest: inside a cloud session `isolation: remote` degrades to a local
agent. That is why v1 is leaf-only, and why v2 (`subtree`) is the coherent next
step rather than "more remote leaves".

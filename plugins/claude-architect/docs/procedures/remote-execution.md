# Procedure — remote (cloud) execution

**Read this when:** you are about to dispatch an `implementation` leaf and
`REMOTE_EXECUTION` is not `off`, or a dispatched remote leaf has just returned.
The knobs and script names stay resident in `ORCHESTRATION.md` → TUNING /
PROCEDURES; this is the dispatch mechanics and the environment facts an
orchestrator gets wrong otherwise.

## Eligibility (check every one before dispatching remotely)

A unit goes remote only when ALL hold:

- role is `implementation` — `fix`, `review`, `merge`, and the audit roles are
  LOCAL-ONLY. `fix` permanently: it edits the top-level worktree without
  committing, and that model cannot cross a machine boundary.
- `REMOTE_EXECUTION=leaf` (`subtree` is v2 and rejected outright in v1)
- the repo has a GitHub `origin`
- the base branch is pushed to that origin
- the project declares this plugin in its `.claude/settings.json`

Any one false → dispatch local, same as today. Run `scripts/remote-preflight.sh`
to check all five in one call; do not re-derive them by hand.

## Dispatch sequence

1. **Preflight.** `scripts/remote-preflight.sh` prints `remote_available=`,
   `reason=`, `origin=`, `default_branch=`, `base_pushed=`, `plugin_declared=`,
   `setup_script=`. `remote_available=no` → fall back to a local worktree and
   record `reason=` in your work-log; do not retry remote for this unit.
2. **Push the base.** A remote agent's base is the session's current branch
   *only if it is pushed* — else the repo default branch, silently. Before
   dispatch: `git push -u origin <base>`. Skipping this does not error; it
   quietly bases the leaf on the wrong branch (see *Silent failure modes*
   below).
3. **Dispatch.** `scripts/remote-dispatch.sh <tier> <slug> <parent>` with
   `isolation: remote` on the Agent call. Prints `base=`, `branch=`, `unit_id=`,
   `export_log=`. The leaf's own first action is
   `git fetch origin && git checkout -B <assigned-branch> origin/<base>`; its
   last is `git push -u origin <assigned-branch>`. Spawn prompt is otherwise
   the same template as a local leaf.
4. **Collect.** `scripts/remote-collect.sh <branch>` fetches the pushed branch
   and prints `fetched=`, `export_log=`, `commits=`, `status=`. Read the
   leaf's receipt from its export log exactly as you would a local
   `.work-log/agents/<id>.md` — the contract is identical, plus the
   `branch:` line.
5. **Integrate.** `scripts/squash-up.sh <branch> <msg> --from-origin`. The
   `--from-origin` flag is what tells the script the branch lives on the
   remote, not in a local worktree it can `cd` into; it also deletes
   `.work-log-export/` as part of the squash commit so it never reaches a PR.

## A remote leaf returns `failed` for missing context

`paused_for_context` is unavailable to a remote leaf — a cloud session cannot
message its parent, and a permission prompt with no client puts the session in
`requires_action` and errors out instead of pausing. A remote leaf missing
context instead writes `status: failed` with a `## Context I need` section to
its export log, then exits.

**Re-dispatch, never resume.** There is no continue file to hand back into
step 3 — repeat the dispatch sequence from step 2 with the missing context
appended to the spawn prompt. Treat it as a fresh unit, not a continuation;
`MAX_CONTINUATIONS` does not apply here because there is nothing being
continued.

## Watchdog

`REMOTE_LEAF_TIMEOUT_MIN` (default 45, see ORCHESTRATION.md → TUNING) bounds
how long you wait on `remote-collect.sh` before declaring a leaf lost. Past the
timeout: treat it as `failed` with no context request — re-dispatch fresh per
above. A lost remote leaf leaves no local process to inspect, so there is
nothing to diagnose before re-dispatching.

## Environment facts

**Remote cannot nest.** Inside a cloud session, `isolation: remote` degrades to
a local agent — there is no VM-inside-VM. This is why v1 is leaf-only (leaves
never spawn) and why `subtree` is the coherent v2 step rather than "more remote
leaves": a subtree needs an orchestrator on the VM, which today's nesting limit
forbids.

**An ungated account degrades silently.** `isolation: remote` on an account
that hasn't cleared the gate (claude.ai auth, not already in a cloud session,
`hasUsedRemoteSession` set for THIS project, `hasRemoteEnvironment` set
globally, and a server-side feature flag) falls back to an ordinary local
worktree without an error. `hasUsedRemoteSession` is per-project and is set only
when a cloud session has been created from that project, so a repo that has
never had one cannot dispatch remotely no matter how the account is configured.
The server-side flag cannot be observed locally at all. **A
successful dispatch is therefore not proof of remote execution** — check
`remote-preflight.sh`'s `remote_available=` before trusting that a leaf ran on
a VM rather than next to you.

**The base-branch rule fails silently too.** There is no per-agent base parameter
exists. If the base isn't pushed when the leaf starts, it bases itself on the
repo default branch instead — no error, just a leaf building on the wrong
commit. Pushing the base before dispatch (step 2 above) is the only guard.

**Rate-limit-bound, not disk-bound.** A cloud session shares this account's
rate limits but costs no separate local compute or disk. That is why
`MAX_CONCURRENT_REMOTE_AGENTS` is a budget separate from
`MAX_CONCURRENT_AGENTS`: the local knob exists because concurrent worktrees
thrash a machine's disk, and that ceiling says nothing about how many cloud
sessions this account's rate limit can sustain at once.

**Plugins install from the repo, not from you.** The VM installs plugins only
from the repo's own `.claude/settings.json` — never from the user-level
settings your local session runs with. A plugin only present in your user
settings is invisible to a remote leaf; if remote dispatch behaves as though
the plugin isn't installed, this is the first thing to check.

**Sessions expire; in-flight work does not survive that.** A cloud session
times out on inactivity, and any background work still running inside it at
that point is not restored on the next dispatch. A remote leaf's checkpoint
discipline is therefore the export log it commits as it goes, not an
assumption that the session will still be there to ask.

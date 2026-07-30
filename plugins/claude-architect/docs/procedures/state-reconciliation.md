# Procedure — state reconciliation

**Read this when:** starting a session, recovering from a crash, or something
about the tree feels off.

Long multi-agent runs desync git, the wiki, and worktree state. Spawn the
read-only `state-doctor`; it **proposes** fixes and the user confirms. It never
executes destructive ops and never deletes wiki entries — only reports `status:`
field updates for you or the user to apply.

## Drift checklist

- Orphan worktrees or branches (no live unit owns them).
- Wiki spec entries whose branch no longer exists.
- Stale `review-i<N>-pre` tags left by a loop that exited badly.
- Stale `.review/` or `.work-log/` inside already-merged worktrees.
- Rules with broken `Source:` links.
- Dangling `paused_for_context` agents — a request nobody answered.

## Continue-file drift

- `continue/<unit>.md` for a unit whose branch is already **merged** → stale; the
  unit finished and nobody cleaned up.
- An agent file with `status: exhausted` whose unit has **no** continue file →
  unrecoverable; the checkpoint rule was not followed. Worth fixing upstream.
- A continue file at or past `MAX_CONTINUATIONS` → the unit needs
  re-decomposition, not another resume.
- A continue file whose mtime is far behind its unit's latest commit → the
  strongest available exhaustion signal. An agent that kept working while its
  checkpoint went stale is exactly the case `status: exhausted` fails to catch,
  because a compacted agent does not know it was compacted.

A live continue file for a unit whose branch still exists is a **recovery asset,
not drift**. Report it; never propose deleting it.

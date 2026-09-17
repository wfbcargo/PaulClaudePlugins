#!/usr/bin/env bash
# Prepare a remote (cloud) unit: push its base to origin and derive its id and
# branch. Creates NO worktree and NO local branch — a remote leaf's own first
# action is `git fetch origin && git checkout -B <branch> origin/<base>` (see
# docs/procedures/remote-execution.md), so there is nothing for this machine to
# check out.
#
#   scripts/remote-dispatch.sh <tier> <slug> <parent-branch>
#
#   tier    impl only in v1 — remote dispatch is restricted to the
#           `implementation` role; `subtree` (non-leaf remote) is v2.
#   slug    short kebab name for the unit
#   parent  the branch the remote leaf will branch from — REQUIRED here,
#           unlike new-worktree.sh, because there is no per-agent base
#           parameter: the cloud runtime picks the session's current branch
#           if (and only if) it is pushed, so pushing PARENT here IS what
#           makes it the remote leaf's base.
#
# Pushing the base is the whole point of this script: an unpushed base falls
# back to the repo's default branch, silently running the remote agent
# against the wrong code. Refuses loudly rather than dispatching against
# nothing.
set -euo pipefail

TIER="${1:?tier required: impl (the only tier eligible for remote in v1)}"
SLUG="${2:?slug required}"
PARENT="${3:?parent branch required — remote-dispatch has no implicit current-branch default, see header}"

if [ "$TIER" != "impl" ]; then
  echo "refusing: tier '$TIER' is not remote-eligible — v1 restricts remote dispatch to 'impl' (implementation leaves); fix/review/merge/audit roles are local-only" >&2
  exit 1
fi

# Anchor on the MAIN repo root, never the caller's worktree — see
# new-worktree.sh for why (--git-common-dir vs --show-toplevel).
REPO_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
cd "$REPO_ROOT"

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
case "$ORIGIN_URL" in
  *github.com*) : ;;
  *)
    echo "refusing: no GitHub origin (origin=${ORIGIN_URL:-none}) — remote dispatch requires a GitHub origin" >&2
    exit 1
    ;;
esac

if ! git show-ref --verify --quiet "refs/heads/${PARENT}"; then
  echo "refusing: no local branch '${PARENT}' to push as the remote base" >&2
  exit 1
fi

# A remote leaf can only ever see committed history. If PARENT is dirty in
# whatever worktree has it checked out, that uncommitted work will not reach
# the remote leaf — warn, but this is not this script's business to block.
DIRTY_PARENT="$(git worktree list --porcelain | awk -v b="refs/heads/${PARENT}" '
  /^worktree /{wt=substr($0,10)} /^branch /{if ($2==b) print wt}')"
if [ -n "$DIRTY_PARENT" ] && [ -n "$(git -C "$DIRTY_PARENT" status --porcelain)" ]; then
  echo "warning: '${PARENT}' has uncommitted changes in ${DIRTY_PARENT} — they will NOT reach the remote leaf" >&2
fi

echo "pushing base '${PARENT}' to origin..." >&2
git push -u origin "${PARENT}:${PARENT}" >&2

UNIT_ID="$(openssl rand -hex 4)"
BRANCH="${PARENT}--${TIER}/${UNIT_ID}_${SLUG}"

# The directory a remote leaf commits its work-log export into. Not a
# discovered file — remote-collect.sh reports the actual path it finds once
# the leaf has pushed; this is the convention to hand the spawned leaf.
EXPORT_LOG=".work-log-export"

echo "base=${PARENT}"
echo "branch=${BRANCH}"
echo "unit_id=${UNIT_ID}"
echo "export_log=${EXPORT_LOG}"

#!/usr/bin/env bash
# Squash-merge a completed unit into its parent branch, then clean up.
#
#   scripts/squash-up.sh <branch> <commit-message> [--keep-worktree]
#
# Integrate the child's work-log BEFORE calling this — removing the worktree
# destroys it. (Per the receipt contract: if the child returned
# `needs-parent-read: no`, there is nothing to integrate and you may call
# straight through.)
#
# On conflict this stops having committed nothing: report the conflicting paths
# to the user and ask before proceeding. Never resolve silently.
set -euo pipefail

BRANCH="${1:?branch required}"
MESSAGE="${2:?commit message required}"
KEEP="${3:-}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Parent = current branch with the last `--` segment stripped.
PARENT="${BRANCH%--*}"
[ "$PARENT" != "$BRANCH" ] || { echo "refusing: '$BRANCH' has no --parent segment" >&2; exit 1; }

wt_for() {
  git worktree list --porcelain | awk -v b="refs/heads/$1" '
    /^worktree /{wt=substr($0,10)}
    /^branch /{if ($2==b) print wt}'
}

PARENT_WT="$(wt_for "$PARENT")"
[ -n "$PARENT_WT" ] || { echo "refusing: no worktree has '$PARENT' checked out" >&2; exit 1; }

if ! git -C "$PARENT_WT" merge --squash "$BRANCH"; then
  echo "CONFLICT — nothing was committed. Conflicting paths:" >&2
  git -C "$PARENT_WT" diff --name-only --diff-filter=U >&2
  echo "Ask the user: resolve and proceed, or abort?" >&2
  echo "To back out: git -C '$PARENT_WT' reset --merge" >&2
  exit 2
fi

git -C "$PARENT_WT" commit -q -m "$MESSAGE"

if [ "$KEEP" != "--keep-worktree" ]; then
  CHILD_WT="$(wt_for "$BRANCH")"
  [ -n "$CHILD_WT" ] && git worktree remove "$CHILD_WT" --force
  git branch -D "$BRANCH" >/dev/null
fi

echo "merged=${BRANCH}"
echo "into=${PARENT}"
echo "parent_worktree=${PARENT_WT}"

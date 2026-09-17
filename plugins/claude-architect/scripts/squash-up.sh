#!/usr/bin/env bash
# Squash-merge a completed unit into its parent branch, then clean up.
#
#   scripts/squash-up.sh <branch> <commit-message> [--from-origin] [--keep-worktree]
#
# Integrate the child's work-log BEFORE calling this — removing the worktree
# destroys it. (Per the receipt contract: if the child returned
# `needs-parent-read: no`, there is nothing to integrate and you may call
# straight through.)
#
# --from-origin   BRANCH is a remote leaf's branch (see remote-dispatch.sh /
#                 remote-collect.sh): squash origin/<branch> instead of a
#                 local ref, since a remote leaf never has a local worktree
#                 or branch here to begin with. On success the remote branch
#                 is deleted from origin instead of the (nonexistent) local
#                 worktree/branch teardown. .work-log-export/ — the remote
#                 leaf's committed work-log — is dropped from the index
#                 before the commit so it never reaches a PR.
# --keep-worktree Skip teardown: the local worktree+branch normally, or with
#                 --from-origin the remote branch on origin instead — same
#                 "leave the unit alone" meaning, applied to whichever of the
#                 two actually exists in that mode.
#
# On conflict this stops having committed nothing: report the conflicting paths
# to the user and ask before proceeding. Never resolve silently.
set -euo pipefail

BRANCH="${1:?branch required}"
MESSAGE="${2:?commit message required}"
shift 2

FROM_ORIGIN=""
KEEP=""
for ARG in "$@"; do
  case "$ARG" in
    --from-origin) FROM_ORIGIN=1 ;;
    --keep-worktree) KEEP="--keep-worktree" ;;
    *) echo "unknown flag: $ARG" >&2; exit 1 ;;
  esac
done

# Main repo root, not the caller's worktree — see new-worktree.sh for why.
REPO_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
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

if [ -n "$FROM_ORIGIN" ]; then
  if ! git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" >&2; then
    echo "refusing: could not fetch '${BRANCH}' from origin" >&2
    exit 1
  fi
  MERGE_REF="refs/remotes/origin/${BRANCH}"
else
  MERGE_REF="$BRANCH"
fi

if ! git -C "$PARENT_WT" merge --squash "$MERGE_REF"; then
  echo "CONFLICT — nothing was committed. Conflicting paths:" >&2
  git -C "$PARENT_WT" diff --name-only --diff-filter=U >&2
  echo "Ask the user: resolve and proceed, or abort?" >&2
  echo "To back out: git -C '$PARENT_WT' reset --merge" >&2
  exit 2
fi

if [ -n "$FROM_ORIGIN" ] && [ -e "$PARENT_WT/.work-log-export" ]; then
  git -C "$PARENT_WT" rm -r --cached --quiet -- .work-log-export
  rm -rf "$PARENT_WT/.work-log-export"
fi

git -C "$PARENT_WT" commit -q -m "$MESSAGE"

if [ "$KEEP" != "--keep-worktree" ]; then
  if [ -n "$FROM_ORIGIN" ]; then
    git push origin --delete "$BRANCH" >&2 || \
      echo "warning: could not delete remote branch '${BRANCH}' — delete it by hand" >&2
  else
    CHILD_WT="$(wt_for "$BRANCH")"
    [ -n "$CHILD_WT" ] && git worktree remove "$CHILD_WT" --force
    git branch -D "$BRANCH" >/dev/null
  fi
fi

echo "merged=${BRANCH}"
echo "into=${PARENT}"
echo "parent_worktree=${PARENT_WT}"

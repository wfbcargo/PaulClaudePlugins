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
#                 before the commit so it never reaches a PR. If that was the
#                 branch's ONLY content (a pure escalation or failure, per
#                 remote-implementation.md — a leaf commits and pushes just
#                 the work-log when it has no code changes), there is
#                 nothing left to merge: no empty commit (a squash commit
#                 would falsely claim code landed) and no branch deletion
#                 (it is the only copy of the log left, and remote-collect.sh
#                 can already read it from the ref without merging) — see
#                 exit code 3 below.
# --keep-worktree Skip teardown: the local worktree+branch normally, or with
#                 --from-origin the remote branch on origin instead — same
#                 "leave the unit alone" meaning, applied to whichever of the
#                 two actually exists in that mode.
#
# On conflict this stops having committed nothing: report the conflicting paths
# to the user and ask before proceeding. Never resolve silently.
#
# Exit codes:
#   0  merged and committed. Prints merged=/into=/parent_worktree=.
#   1  usage error or a refusal before anything was touched (bad flag, no
#      such worktree, fetch failure, etc).
#   2  merge conflict — nothing was committed. Conflicting paths and a
#      back-out command are printed; ask the user before proceeding.
#   3  --from-origin only: after stripping .work-log-export/ there was
#      nothing left to merge (an escalation/failure branch). Nothing was
#      committed, origin/<branch> is left intact. Prints merged=none and
#      status=empty-after-strip — go read the log via remote-collect.sh,
#      then re-dispatch the unit; this is a normal outcome, not an error.
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
  git -C "$PARENT_WT" rm -r --cached --quiet --ignore-unmatch -- .work-log-export
  rm -rf "$PARENT_WT/.work-log-export"
fi

# A remote leaf that had no code changes (a pure escalation or failure) still
# commits and pushes just its work-log export, per remote-implementation.md —
# so after stripping .work-log-export/ above, there may be nothing left
# staged. That branch is not a unit to merge: fabricating an empty commit
# would put a lie in the parent's history (a squash commit implying code
# landed), and deleting origin/${BRANCH} would destroy the only copy of the
# log — remote-collect.sh can already read it from the ref without merging.
# Back out and hand it back to the orchestrator instead of committing.
if [ -n "$FROM_ORIGIN" ] && git -C "$PARENT_WT" diff --cached --quiet; then
  git -C "$PARENT_WT" reset --merge >&2
  echo "note: nothing to merge after stripping .work-log-export/ — export-log-only branch (a pure escalation or failure). Leaving origin/${BRANCH} intact; read the log via remote-collect.sh, then re-dispatch the unit." >&2
  echo "merged=none"
  echo "status=empty-after-strip"
  exit 3
fi

git -C "$PARENT_WT" commit -q -m "$MESSAGE"

if [ "$KEEP" != "--keep-worktree" ]; then
  if [ -n "$FROM_ORIGIN" ]; then
    # `--delete refs/heads/<b>` rather than `--delete <b>`: the branch name is
    # self-reported by the leaf and a leading `-` would otherwise be parsed as
    # an option. Only reached after the commit above succeeded, so this can
    # never fire on the empty-after-strip (exit 3) path.
    git push origin --delete "refs/heads/${BRANCH}" >&2 || \
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

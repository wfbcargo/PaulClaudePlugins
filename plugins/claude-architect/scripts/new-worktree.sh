#!/usr/bin/env bash
# Create the worktree + branch for one unit of work.
#
#   scripts/new-worktree.sh <tier> <slug> [parent-branch]
#
#   tier    epic | spec | impl | additional
#   slug    short kebab name for the unit
#   parent  defaults to the current branch (never hardcode main/develop)
#
# Refuses to run on a dirty tree — stop and ask the user instead.
# Prints key=value lines so the caller parses rather than re-derives.
set -euo pipefail

TIER="${1:?tier required: epic|spec|impl|additional}"
SLUG="${2:?slug required}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Ephemeral framework dirs are excluded: they are meant to be gitignored, and a
# project that hasn't got round to it should not be blocked from every spawn.
DIRTY="$(git status --porcelain -- . \
  ':(exclude).worktrees' ':(exclude).work-log' ':(exclude).review')"
if [ -n "$DIRTY" ]; then
  echo "refusing: working tree is dirty — commit, stash, or ask the user" >&2
  echo "$DIRTY" >&2
  exit 1
fi

PARENT="${3:-$(git branch --show-current)}"
[ -n "$PARENT" ] || { echo "refusing: detached HEAD, cannot derive parent" >&2; exit 1; }

case "$TIER" in
  epic|spec|impl)
    UNIT_ID="$(openssl rand -hex 4)"
    BRANCH="${PARENT}--${TIER}/${UNIT_ID}_${SLUG}"
    WT_NAME="${UNIT_ID}_${SLUG}"
    ;;
  additional)
    # Sequential under the parent, not hex: <parent>--additional/<n>
    N=1
    while git show-ref --verify --quiet "refs/heads/${PARENT}--additional/${N}"; do
      N=$((N + 1))
    done
    UNIT_ID="$N"
    BRANCH="${PARENT}--additional/${N}"
    WT_NAME="${PARENT##*/}--additional-${N}"
    ;;
  *)
    echo "unknown tier: $TIER" >&2; exit 1 ;;
esac

WT_DIR=".worktrees/${WT_NAME}"
mkdir -p .worktrees
# Start point is PARENT explicitly — without it the new branch would fork from
# whatever HEAD this shell happens to be on, not from the unit's actual parent.
git worktree add "$WT_DIR" -b "$BRANCH" "$PARENT" >&2

# [target: ...] is read back by the PR step to find the merge target.
git -C "$WT_DIR" commit --allow-empty -q \
  -m "${TIER}: start ${SLUG} [target: ${PARENT}] [${TIER}-id: ${UNIT_ID}]"

mkdir -p "$WT_DIR/.work-log/agents" "$WT_DIR/.work-log/continue"

echo "branch=${BRANCH}"
echo "worktree=${REPO_ROOT}/${WT_DIR}"
echo "unit_id=${UNIT_ID}"
echo "target=${PARENT}"

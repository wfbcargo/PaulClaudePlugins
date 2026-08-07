#!/usr/bin/env bash
# Create the worktree + branch for one unit of work.
#
#   scripts/new-worktree.sh <tier> <slug> [parent-branch]
#
#   tier    epic | spec | impl | additional
#   slug    short kebab name for the unit
#   parent  defaults to the current branch (never hardcode main/develop)
#
# A worktree is not free — see ORCHESTRATION.md → "When a unit gets a worktree".
# Only call this for a unit that needs FILESYSTEM ISOLATION: a top-level unit, or
# a leaf that runs CONCURRENTLY with a sibling. Sequential phases commit into
# their parent's worktree and never call this script.
#
# Refuses to run on a dirty tree — stop and ask the user instead.
# Prints key=value lines so the caller parses rather than re-derives.
set -euo pipefail

TIER="${1:?tier required: epic|spec|impl|additional}"
SLUG="${2:?slug required}"

# Anchor on the MAIN repo root, never the caller's worktree. `--show-toplevel`
# resolves to the linked worktree when this runs from inside one, which nests
# .worktrees/ inside .worktrees/ — a checkout inside a checkout, and on Windows
# a fast route past the 260-char path limit. `--git-common-dir` always points at
# the main repo's .git, so every worktree lands flat at the top no matter who
# calls this.
REPO_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
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

# A fresh worktree has no dependencies, no venv, no build cache — so without this
# every leaf either re-installs from scratch or fails its tests for a reason that
# has nothing to do with its work. Non-fatal: a project with no deps needs none
# of it, and a setup failure should not block the unit.
SETUP="$(dirname "$0")/worktree-setup.sh"
if [ -x "$SETUP" ] || [ -f "$SETUP" ]; then
  sh "$SETUP" "$REPO_ROOT" "$REPO_ROOT/$WT_DIR" >&2 || \
    echo "warning: worktree setup failed — deps may be missing in $WT_DIR" >&2
fi

echo "branch=${BRANCH}"
echo "worktree=${REPO_ROOT}/${WT_DIR}"
echo "unit_id=${UNIT_ID}"
echo "target=${PARENT}"

#!/usr/bin/env bash
# Fetch a remote leaf's branch from origin and report what came back, before
# the orchestrator decides whether to squash-up.sh --from-origin it.
#
#   scripts/remote-collect.sh <branch>
#
# Read-only against the working tree: fetches into refs/remotes/origin/*,
# never checks anything out and never writes .work-log-export/ to disk —
# that arrives naturally as part of the squash-merge in squash-up.sh, which
# is also what strips it back out before a PR. This script only tells you
# whether it is there and whether there is anything to squash.
set -euo pipefail

BRANCH="${1:?branch required}"

# Anchor on the MAIN repo root, never the caller's worktree — see
# new-worktree.sh for why.
REPO_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
cd "$REPO_ROOT"

# Parent = current branch with the last `--` segment stripped, same
# derivation as squash-up.sh — a remote leaf's export log and commit count
# are both read relative to the base it actually branched from.
PARENT="${BRANCH%--*}"
[ "$PARENT" != "$BRANCH" ] || { echo "refusing: '$BRANCH' has no --parent segment" >&2; exit 1; }

FETCHED="no"
STATUS="missing"
COMMITS=0
EXPORT_LOG="none"

if git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" >&2; then
  FETCHED="yes"
else
  echo "fetch failed — '${BRANCH}' is not (yet) on origin" >&2
fi

if [ "$FETCHED" = "yes" ]; then
  # Best-effort: bring the parent ref up to date too so the ahead-count is
  # against real content, not a stale cache. Non-fatal if it fails — a
  # standalone spec/epic base that was pushed once and never re-fetched
  # still has SOME ref to diff against.
  # refs/heads/ prefix, as above: a branch legitimately named `--upload-pack=x--y`
  # passes `git check-ref-format`, and PARENT is derived from the leaf's own
  # self-reported branch. Unprefixed it would reach git in option position.
  git fetch origin "+refs/heads/${PARENT}:refs/remotes/origin/${PARENT}" >&2 || true

  if git rev-parse -q --verify "refs/remotes/origin/${PARENT}" >/dev/null; then
    BASE_REF="refs/remotes/origin/${PARENT}"
  elif git show-ref --verify --quiet "refs/heads/${PARENT}"; then
    BASE_REF="refs/heads/${PARENT}"
  else
    BASE_REF=""
    echo "warning: could not resolve parent ref '${PARENT}' — commit count may read 0" >&2
  fi

  if [ -n "$BASE_REF" ]; then
    COMMITS="$(git rev-list --count "${BASE_REF}..refs/remotes/origin/${BRANCH}" 2>/dev/null || echo 0)"
  fi

  if [ "$COMMITS" -gt 0 ]; then
    STATUS="ok"
  else
    STATUS="empty"
  fi

  # Report the path, don't print the contents — the orchestrator decides
  # whether to open it. `ls-tree` reads the fetched ref directly, no
  # checkout needed.
  FOUND="$(git ls-tree -r --name-only "refs/remotes/origin/${BRANCH}" -- .work-log-export 2>/dev/null | head -1)"
  [ -n "$FOUND" ] && EXPORT_LOG="$FOUND"
fi

echo "fetched=${FETCHED}"
echo "export_log=${EXPORT_LOG}"
echo "commits=${COMMITS}"
echo "status=${STATUS}"

#!/usr/bin/env bash
# Make a freshly-created worktree usable: dependencies, env files, build caches.
#
#   scripts/worktree-setup.sh <main-repo-root> <new-worktree-dir>
#
# Called automatically by new-worktree.sh. Never fatal — a project with no
# dependencies needs none of this, and a setup failure must not block the unit.
#
# A fresh `git worktree add` checks out tracked files only. Everything a test run
# actually needs — node_modules, .venv, .env, build caches — is gitignored and
# therefore absent. Without this step every leaf agent either re-installs from
# scratch (the single largest wall-clock cost in a multi-worktree run) or fails
# its tests for a reason that has nothing to do with its work.
#
# PROJECT OVERRIDE: if the repo has `.claude/worktree-setup.sh`, that runs
# INSTEAD of the built-in defaults below. It receives the same two arguments.
# Use it for anything project-specific — prisma generate, a build step, a
# database template copy.
set -uo pipefail

MAIN="${1:?main repo root required}"
WT="${2:?worktree dir required}"

if [ -f "$MAIN/.claude/worktree-setup.sh" ]; then
  sh "$MAIN/.claude/worktree-setup.sh" "$MAIN" "$WT"
  exit $?
fi

# Link a directory from the main checkout into the worktree. A link, not a copy:
# node_modules can be gigabytes, and N copies of it is the cost this script
# exists to remove.
#
# Order matters, and it is Windows that decides it. Git Bash's `ln -s` does NOT
# fail on Windows without developer mode — it silently makes a full recursive
# COPY and exits 0, which is the one outcome we are trying to avoid and the one
# an exit-code check cannot see. So try the junction first where cmd.exe exists,
# and verify every result with `-L` rather than trusting the exit code.
link_dir() {
  src="$MAIN/$1"
  dst="$WT/$1"
  [ -d "$src" ] || return 0
  [ -e "$dst" ] && return 0
  mkdir -p "$(dirname "$dst")"

  # A directory junction needs no elevation and looks like a real directory to
  # every tool that will read it.
  if command -v cmd.exe >/dev/null 2>&1; then
    if cmd.exe //c mklink //J "$(cygpath -w "$dst" 2>/dev/null || echo "$dst")" \
                              "$(cygpath -w "$src" 2>/dev/null || echo "$src")" >/dev/null 2>&1 \
       && [ -d "$dst" ]; then
      echo "junctioned $1" >&2; return 0
    fi
    rm -rf "$dst" 2>/dev/null
  fi

  if ln -s "$src" "$dst" 2>/dev/null && [ -L "$dst" ]; then
    echo "linked $1" >&2; return 0
  fi
  rm -rf "$dst" 2>/dev/null

  # Last resort. Correct, just not cheap — say so, because on a big dependency
  # tree this is where the wall-clock went.
  cp -r "$src" "$dst" 2>/dev/null && echo "copied $1 (no link support — this is slow)" >&2
}

# Env and local-config files are small, and a LINK would make one leaf's edit
# visible to every sibling. Copy them.
copy_file() {
  [ -f "$MAIN/$1" ] || return 0
  [ -e "$WT/$1" ] && return 0
  mkdir -p "$(dirname "$WT/$1")"
  cp "$MAIN/$1" "$WT/$1" 2>/dev/null && echo "copied $1" >&2
}

# Dependency trees and build caches: shared, because they are derived from
# committed manifests and are identical across siblings.
for d in node_modules .venv venv vendor .next/cache target/debug .gradle \
         .pnpm-store bower_components Pods; do
  link_dir "$d"
done

# Local config: copied, because a leaf may legitimately need its own.
for f in .env .env.local .env.development .env.test \
         .claude/settings.local.json; do
  copy_file "$f"
done

exit 0

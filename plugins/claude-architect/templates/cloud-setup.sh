#!/usr/bin/env bash
# Cloud-environment setup script — the remote analogue of scripts/worktree-setup.sh.
#
# Commit this file to the repo at .claude/cloud-setup.sh — that committed copy
# is the version-controlled source of truth (reviewable and diffable like any
# other script) and is also what scripts/remote-preflight.sh checks for when it
# reports setup_script=. Committing it is NOT enough to run it: claude.ai/code
# never reads or executes a file from the repo for this purpose. Paste the same
# body into the "Setup script" field of the environment dialog at
# claude.ai/code (Settings -> Environments, or when creating one) — that pasted
# copy is what actually executes. Keep the two in sync by hand; nothing
# enforces that they match. Claude Code runs the pasted script once, before the
# session's Claude Code process starts, then snapshots the filesystem. Every
# session dispatched into that environment for roughly the next seven days reuses
# the snapshot instead of re-running this script — so what it installs is what
# every remote leaf gets, and it is paid for once, not per leaf.
#
# Budget: this step must finish in about five minutes. A toolchain that takes
# longer belongs in a prebuilt base image, if your environment lets you choose
# one, not in this script.
#
# What the snapshot keeps and what it doesn't:
#   - Files on disk: YES — node_modules, .venv, downloaded models, build caches.
#   - Running processes, open ports, background daemons: NO — anything started
#     here is gone by the time a session resumes the snapshot. A dev server or
#     watcher that must be running at session start belongs in a SessionStart
#     hook in the repo's .claude/settings.json instead (see
#     project-settings.json and this directory's README) — that hook
#     runs on every session, local and cloud, whereas this script runs once per
#     snapshot and only on the VM.
#
# Detect, don't assume: a fresh environment has no foreknowledge of this
# project's toolchain, so each block below checks for its own manifest file
# before reaching for an installer. Delete whichever blocks don't apply here,
# and add your own — this script exists to show the shape, not to guess your
# stack.

set -euo pipefail

echo "== cloud-setup starting: $(date -u +%FT%TZ) =="

if [ -f package.json ]; then
  echo "-- node project detected"
  if [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then
    npm ci --prefer-offline --no-audit --no-fund
  elif command -v npm >/dev/null 2>&1; then
    npm install --no-audit --no-fund
  fi
fi

if [ -f requirements.txt ]; then
  echo "-- python project detected (requirements.txt)"
  command -v pip >/dev/null 2>&1 && pip install -r requirements.txt
fi

if [ -f pyproject.toml ] && [ ! -f requirements.txt ]; then
  echo "-- python project detected (pyproject.toml)"
  command -v pip >/dev/null 2>&1 && pip install -e .
fi

if [ -f Gemfile ]; then
  echo "-- ruby project detected"
  command -v bundle >/dev/null 2>&1 && bundle install
fi

if [ -f go.mod ]; then
  echo "-- go project detected"
  command -v go >/dev/null 2>&1 && go mod download
fi

echo "== cloud-setup done: $(date -u +%FT%TZ) =="

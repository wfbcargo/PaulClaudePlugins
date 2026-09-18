#!/usr/bin/env bash
# Cloud-environment setup script: provisions the VM's TOOLCHAIN, nothing else.
#
# Commit this file at .claude/cloud-setup.sh — that copy is the reviewable
# source of truth and what scripts/remote-preflight.sh reports as
# setup_script_committed=. Committing it does NOT run it: only the body pasted
# into the environment's "Setup script" field executes (claude.ai/code or the
# Desktop Code tab -> environment dropdown above the message box -> gear icon
# on the environment). Keep the two in sync by hand; nothing checks that they
# match.
#
# Three facts shape everything below:
#   - It runs BEFORE Claude Code launches, and NOT in the repo: the working
#     directory has no checkout, so `npm ci` here fails EUSAGE even with a
#     committed lockfile. Project dependencies belong in templates/cloud-install.sh,
#     run from a SessionStart hook that gets $CLAUDE_PROJECT_DIR.
#   - A non-zero exit stops the session from starting, and an environment is
#     account-wide, not per repo — a failure here blocks every repo that uses
#     it. So no `set -e`, and every step degrades instead of failing. Prefer one
#     environment per repo.
#   - It runs once, then the filesystem is snapshotted and reused by every
#     session in that environment for about seven days. Files survive; running
#     processes do not. Keep it under about five minutes.
#
# The VM ships Node 20/21/22 (22 on PATH), Python, and common package managers;
# ask a cloud session to run `check-tools` for the exact list. Add a block only
# for a toolchain that is missing or the wrong version.

set -uo pipefail

# --- Node at a pinned version, installed beside the VM's own ----------------
# Set to the version local development runs (e.g. 24.18.0); empty skips this.
# Installs to /opt/node<major> without touching PATH, so other repos in this
# environment keep the default. cloud-install.sh puts it first on PATH for
# this repo's sessions, via CLAUDE_ENV_FILE.
NODE_VERSION=""

if [ -n "$NODE_VERSION" ]; then
  node_dir="/opt/node${NODE_VERSION%%.*}"
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) arch="" ;;
  esac
  if [ -z "$arch" ]; then
    echo "cloud-setup: unknown arch $(uname -m); skipping Node $NODE_VERSION"
  elif [ ! -x "$node_dir/bin/node" ]; then
    mkdir -p "$node_dir"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
      | tar -xJ -C "$node_dir" --strip-components=1 \
      || { echo "cloud-setup: Node $NODE_VERSION download failed; sessions fall back to the VM default"; rm -rf "$node_dir"; }
  fi
  "$node_dir/bin/node" --version 2>/dev/null || true
fi

# --- apt packages the base image lacks --------------------------------------
# Runs as root on Ubuntu 24.04. Example: apt-get install -y shellcheck
# apt-get update -qq && apt-get install -y -qq <package> || true

exit 0

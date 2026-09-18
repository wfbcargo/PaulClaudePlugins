#!/usr/bin/env bash
# Install project dependencies in a cloud session. Copy to scripts/cloud-install.sh
# and run it from the SessionStart hook in templates/project-settings.json.
#
# Why a hook and not the environment's setup script: the setup script runs
# outside the repo, before Claude Code launches, so it cannot find a lockfile.
# A SessionStart hook runs in both local and cloud sessions with
# $CLAUDE_PROJECT_DIR set to the repo root, so this script scopes itself to the
# cloud with CLAUDE_CODE_REMOTE. The cost: dependencies are not in the
# environment snapshot, so each NEW cloud session installs once; a resumed
# session skips it through the freshness check below.
#
# Always exits 0 so the session starts, but reports a failed install on stdout,
# which reaches Claude's context: a leaf must not run tests believing the
# dependencies are there.

# Local sessions keep whatever the developer installed.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
# Not `${CLAUDE_PROJECT_DIR:?}`: a failed :? expansion exits 1 before `||` runs.
[ -n "${CLAUDE_PROJECT_DIR:-}" ] && cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# --- toolchain PATH ----------------------------------------------------------
# Match NODE_VERSION's major in .claude/cloud-setup.sh; empty keeps the VM
# default. Set before the freshness check: a resumed session needs the PATH as
# much as a new one. CLAUDE_ENV_FILE is sourced into every later Bash call.
NODE_MAJOR=""
if [ -n "$NODE_MAJOR" ]; then
  node_bin="/opt/node${NODE_MAJOR}/bin"
  if [ -x "$node_bin/node" ]; then
    export PATH="$node_bin:$PATH"
    [ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PATH=\"$node_bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
  else
    echo "cloud-install: $node_bin is missing, so this session runs on Node $(node --version 2>/dev/null), not $NODE_MAJOR. Check the environment's Setup script field matches .claude/cloud-setup.sh."
  fi
fi

# --- dependencies ------------------------------------------------------------
TMP_DIR="${TMPDIR:-/tmp}"
LOG="$TMP_DIR/cloud-install.log"

# install_deps <lockfile> <command...>
# Runs the command when <lockfile> exists, then stamps success in the temp dir.
# A stamp the lockfile is not newer than means this VM already installed this
# lockfile, so a resumed session skips; a lockfile changed by a checkout
# re-installs. Asked as "lock not newer than stamp", not "stamp newer than
# lock": bash 3.2 compares whole seconds, and a stamp written in the same
# second as the lockfile would otherwise re-install on every resume. The temp
# dir is the right home: it lives exactly as long as the VM, and nothing in it
# can be committed by a leaf's `git add`.
install_deps() {
  local lock="$1"; shift
  local stamp="$TMP_DIR/cloud-install.${lock//\//_}.done"
  [ -f "$lock" ] || return 0
  [ -f "$stamp" ] && ! [ "$lock" -nt "$stamp" ] && return 0
  if "$@" >>"$LOG" 2>&1; then
    touch "$stamp"
    echo "cloud-install: $* succeeded."
  else
    echo "cloud-install: $* FAILED; dependencies are missing or partial. Read $LOG before running builds or tests."
  fi
}

install_deps package-lock.json npm ci --no-audit --no-fund
install_deps pnpm-lock.yaml    pnpm install --frozen-lockfile
install_deps requirements.txt  pip install -r requirements.txt

exit 0

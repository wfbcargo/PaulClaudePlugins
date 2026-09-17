#!/usr/bin/env bash
# Diagnose whether a remote (cloud) leaf could run from here, and if not, why.
#
#   scripts/remote-preflight.sh
#
# Pure diagnostic: touches no state, ALWAYS exits 0 — a failed check is a
# printed `reason=`, never a script failure. See
# docs/procedures/remote-execution.md for the keys, and its "Environment facts"
# section for what the gate actually requires.
set -uo pipefail
# (no -e: every check below degrades to a reason, nothing here should abort)

# CURRENT_BRANCH and .claude/ config are per-CHECKOUT facts — they must come
# from wherever this script was actually invoked (a spec/impl worktree, most
# of the time), captured BEFORE we cd anywhere else. Getting this backwards
# silently checks the wrong branch's push status and the wrong .claude/
# settings.json (verified against this very repo: run from a worktree on an
# unpushed spec branch, `cd`-ing to REPO_ROOT first made base_pushed read
# "yes" because it was actually asking about the MAIN checkout's branch).
INVOKE_DIR="$(pwd)"
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || true)"

# Anchor on the MAIN repo root for repo-GLOBAL facts only (origin URL, the
# default-branch ref, ~/.claude.json's project key — verified to be the main
# checkout's path, not a worktree's) — never the caller's worktree for
# THESE, see new-worktree.sh for why (--git-common-dir vs --show-toplevel).
REPO_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
cd "$REPO_ROOT" || REPO_ROOT="$INVOKE_DIR"

# ---------------------------------------------------------------------------
# git-visible facts — no interpreter needed for any of these.
# ---------------------------------------------------------------------------

ORIGIN="$(git remote get-url origin 2>/dev/null || true)"

DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
DEFAULT_BRANCH="${DEFAULT_BRANCH#origin/}"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="unknown"

BASE_PUSHED="no"
if [ -n "$ORIGIN" ] && [ -n "$CURRENT_BRANCH" ]; then
  if git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
    BASE_PUSHED="yes"
  fi
fi

SETUP_SCRIPT="no"
[ -f "$INVOKE_DIR/.claude/cloud-setup.sh" ] && SETUP_SCRIPT="yes"

# ---------------------------------------------------------------------------
# ~/.claude.json + .claude/settings.json — need a JSON parser. Try python3,
# then python (the Windows Store "python3" shim exists on PATH but exits
# nonzero the moment it's actually invoked — command -v alone lies about it,
# so every candidate is test-invoked before being trusted), then node, else
# degrade to reason=unknown rather than failing (per the contract).
# ---------------------------------------------------------------------------

find_python() {
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c "" >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

CLAUDE_JSON="$HOME/.claude.json"
SETTINGS_JSON="$INVOKE_DIR/.claude/settings.json"

# Project key in ~/.claude.json uses forward slashes even on Windows
# (verified against a real ~/.claude.json: the key is the drive-letter
# Windows-style path, e.g. "C:/Users/you/repo", not the msys POSIX path this
# shell sees). `pwd -W` gives that form under Git Bash; elsewhere it doesn't
# exist and REPO_ROOT (already POSIX-style) is the only candidate anyway.
REPO_ROOT_WIN="$(pwd -W 2>/dev/null || true)"

read -r -d '' PARSE_PY <<'PYEOF' || true
import json, sys

def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

claude_json_path, settings_path = sys.argv[1], sys.argv[2]
project_keys = [k for k in sys.argv[3:] if k]

d = load(claude_json_path)
if d is None:
    print("parse_ok=no")
else:
    oauth = d.get("oauthAccount")
    print("oauth=" + ("yes" if isinstance(oauth, dict) and oauth else "no"))
    print("has_remote_env=" + ("yes" if d.get("hasRemoteEnvironment") is True else "no"))
    projects = d.get("projects", {}) or {}
    used, matched = False, "not-found"
    for k in project_keys:
        if k in projects:
            matched = k
            used = projects[k].get("hasUsedRemoteSession") is True
            break
    print("has_used_remote_session=" + ("yes" if used else "no"))
    print("project_key=" + matched)
    print("parse_ok=yes")

s = load(settings_path)
if s is None:
    print("plugin_declared=no")
else:
    enabled = s.get("enabledPlugins", {}) or {}
    marketplaces = s.get("extraKnownMarketplaces", []) or []
    has_plugin = False
    if isinstance(enabled, dict):
        for k, v in enabled.items():
            if isinstance(k, str) and k.split("@", 1)[0] == "claude-architect" and v is True:
                has_plugin = True
                break
    # extraKnownMarketplaces has shown up as both a list and an object keyed
    # by marketplace name (see wiki-template/project-settings.template.json)
    # — accept either, "declared" just means non-empty.
    has_marketplace = isinstance(marketplaces, (list, dict)) and len(marketplaces) > 0
    print("plugin_declared=" + ("yes" if (has_plugin and has_marketplace) else "no"))
PYEOF

read -r -d '' PARSE_NODE <<'NODEEOF' || true
const fs = require("fs");

function load(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    return null;
  }
}

const [claudeJsonPath, settingsPath, ...projectKeys] = process.argv.slice(1);

const d = load(claudeJsonPath);
if (d === null) {
  console.log("parse_ok=no");
} else {
  const oauth = d.oauthAccount;
  console.log("oauth=" + (oauth && typeof oauth === "object" && Object.keys(oauth).length ? "yes" : "no"));
  console.log("has_remote_env=" + (d.hasRemoteEnvironment === true ? "yes" : "no"));
  const projects = d.projects || {};
  let used = false, matched = "not-found";
  for (const k of projectKeys) {
    if (!k) continue;
    if (Object.prototype.hasOwnProperty.call(projects, k)) {
      matched = k;
      used = projects[k].hasUsedRemoteSession === true;
      break;
    }
  }
  console.log("has_used_remote_session=" + (used ? "yes" : "no"));
  console.log("project_key=" + matched);
  console.log("parse_ok=yes");
}

const s = load(settingsPath);
if (s === null) {
  console.log("plugin_declared=no");
} else {
  const enabled = s.enabledPlugins || {};
  const marketplaces = s.extraKnownMarketplaces || [];
  let hasPlugin = false;
  if (enabled && typeof enabled === "object") {
    for (const [k, v] of Object.entries(enabled)) {
      if (typeof k === "string" && k.split("@")[0] === "claude-architect" && v === true) {
        hasPlugin = true;
        break;
      }
    }
  }
  // extraKnownMarketplaces has shown up as both a list and an object keyed
  // by marketplace name (see wiki-template/project-settings.template.json)
  // — accept either, "declared" just means non-empty.
  const hasMarketplace = marketplaces && typeof marketplaces === "object" &&
    Object.keys(marketplaces).length > 0;
  console.log("plugin_declared=" + (hasPlugin && hasMarketplace ? "yes" : "no"));
}
NODEEOF

PARSER="none"
PARSE_OUT=""
if PY="$(find_python)"; then
  PARSER="python ($PY)"
  PARSE_OUT="$("$PY" -c "$PARSE_PY" "$CLAUDE_JSON" "$SETTINGS_JSON" "$REPO_ROOT_WIN" "$REPO_ROOT" 2>/dev/null || true)"
elif command -v node >/dev/null 2>&1 && node -e "" >/dev/null 2>&1; then
  PARSER="node"
  PARSE_OUT="$(node -e "$PARSE_NODE" "$CLAUDE_JSON" "$SETTINGS_JSON" "$REPO_ROOT_WIN" "$REPO_ROOT" 2>/dev/null || true)"
fi
# Both interpreters print \n, but on Windows a text-mode stdout turns that
# into \r\n — strip it, or every value below silently fails to match (e.g.
# "yes\r" != "yes").
PARSE_OUT="${PARSE_OUT//$'\r'/}"
echo "parser=${PARSER}" >&2

OAUTH="no"; HAS_REMOTE_ENV="no"; HAS_USED_REMOTE_SESSION="no"
PROJECT_KEY="not-found"; PARSE_OK="no"; PLUGIN_DECLARED="no"
if [ -n "$PARSE_OUT" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      oauth) OAUTH="$v" ;;
      has_remote_env) HAS_REMOTE_ENV="$v" ;;
      has_used_remote_session) HAS_USED_REMOTE_SESSION="$v" ;;
      project_key) PROJECT_KEY="$v" ;;
      parse_ok) PARSE_OK="$v" ;;
      plugin_declared) PLUGIN_DECLARED="$v" ;;
    esac
  done <<EOF
$PARSE_OUT
EOF
fi
echo "project_key=${PROJECT_KEY} (matched against ~/.claude.json's \"projects\")" >&2

# ---------------------------------------------------------------------------
# Compose the verdict. Order matters — earliest matching reason wins.
# ---------------------------------------------------------------------------

REASON="ok"
if [ -n "${CLAUDE_CODE_REMOTE:-}" ]; then
  REASON="inside-cloud-session"
elif [ "$PARSER" = "none" ] || [ "$PARSE_OK" != "yes" ]; then
  REASON="unknown"
elif [ "$OAUTH" != "yes" ]; then
  REASON="not-logged-in"
elif [ -z "$ORIGIN" ]; then
  REASON="no-origin"
elif [[ "$ORIGIN" != *github.com* ]]; then
  REASON="origin-not-github"
elif [ "$HAS_REMOTE_ENV" != "yes" ]; then
  REASON="gate-off:no-remote-environment"
elif [ "$HAS_USED_REMOTE_SESSION" != "yes" ]; then
  REASON="gate-off:never-used-cloud-session"
fi

REMOTE_AVAILABLE="no"
[ "$REASON" = "ok" ] && REMOTE_AVAILABLE="yes"

if [ "$REASON" = "ok" ]; then
  echo "note: every LOCAL condition passes, but a server-side feature flag" >&2
  echo "  also gates this and cannot be observed from here — the only proof" >&2
  echo "  is a remote dispatch that does not silently fall back to a local" >&2
  echo "  worktree (spawnedWithWorktree: true in the result means it fell back)." >&2
fi

echo "remote_available=${REMOTE_AVAILABLE}"
echo "reason=${REASON}"
echo "origin=${ORIGIN:-none}"
echo "default_branch=${DEFAULT_BRANCH}"
echo "base_pushed=${BASE_PUSHED}"
echo "plugin_declared=${PLUGIN_DECLARED}"
echo "setup_script=${SETUP_SCRIPT}"

exit 0

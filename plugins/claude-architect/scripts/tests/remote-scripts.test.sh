#!/usr/bin/env bash
# Regression harness for the remote-execution scripts. bash + git only.
#
#   bash remote-scripts.test.sh
#
# Everything runs against a throwaway repo whose "origin" is a LOCAL bare repo
# living under a directory literally named `github.com` — that one trick makes
# the whole flow offline-testable: the scripts' `*github.com*` origin check
# passes, `git ls-remote` / `push` / `fetch` / `push --delete` all work, and
# nothing ever touches the network or a real remote.
#
# ~/.claude.json is injected by overriding HOME, which is the only input the
# preflight parser reads that is not derivable from the fixture repo.
set -uo pipefail

# Defaults to the scripts/ directory this file lives under, so the harness runs
# with no arguments from anywhere. Override SCRIPTS to test a copy elsewhere.
SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DOCS="$(cd "$SCRIPTS/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL %s\n     want: %s\n     got:  %s\n' "$1" "$2" "$3"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

git_q() { git -C "$1" "${@:2}" >/dev/null 2>&1; }

# --- fixture ---------------------------------------------------------------
mkfixture() {
  FX="$TMP/fx"; rm -rf "$FX"; mkdir -p "$FX/github.com"
  git init -q --bare -b main "$FX/github.com/origin.git"
  git init -q -b main "$FX/repo"
  git -C "$FX/repo" config user.email t@t
  git -C "$FX/repo" config user.name t
  git -C "$FX/repo" config core.autocrlf false
  echo hi > "$FX/repo/a.txt"
  mkdir -p "$FX/repo/.claude"
  printf '%s' '{"enabledPlugins":{"claude-architect@paul":true},"extraKnownMarketplaces":{"paul":{}}}'     > "$FX/repo/.claude/settings.json"
  git_q "$FX/repo" add -A; git_q "$FX/repo" commit -m init
  git_q "$FX/repo" remote add origin "$FX/github.com/origin.git"
  git_q "$FX/repo" push -u origin main
  git_q "$FX/repo" remote set-head origin -a
  git_q "$FX/repo" branch unpushed
  REPO="$FX/repo"
  RK="$(cd "$REPO" && { pwd -W 2>/dev/null || pwd; })"   # ~/.claude.json project key
}

home_with() { # $1 = name, $2 = json body
  mkdir -p "$TMP/$1"; printf '%s' "$2" > "$TMP/$1/.claude.json"; echo "$TMP/$1"
}

key() { grep -E "^$2=" <<<"$1" | head -1 | cut -d= -f2-; }

# ===========================================================================
# T1 — remote-preflight.sh verdict ladder. Every reason=, including the seven
#      that have never run on a real machine. A wrong remote_available=yes is
#      the worst outcome in this diff, so this table is the load-bearing test.
# ===========================================================================
mkfixture
J_OK="{\"oauthAccount\":{\"a\":1},\"hasRemoteEnvironment\":true,\"projects\":{\"$RK\":{\"hasUsedRemoteSession\":true}}}"
H_OK="$(home_with h_ok "$J_OK")"

pf() { ( cd "$REPO" && env HOME="$1" ${2:+CLAUDE_CODE_REMOTE=1} bash "$SCRIPTS/remote-preflight.sh" 2>/dev/null ); }

OUT="$(pf "$H_OK")"
is "T1.1 all local conditions pass -> reason=ok" "ok" "$(key "$OUT" reason)"
is "T1.1 ... and remote_available=yes"           "yes" "$(key "$OUT" remote_available)"

OUT="$(pf "$H_OK" inside)"
is "T1.2 CLAUDE_CODE_REMOTE set -> inside-cloud-session" "inside-cloud-session" "$(key "$OUT" reason)"

OUT="$(pf "$(home_with h_bad '{ not json')")"
is "T1.3 unparseable ~/.claude.json -> unknown" "unknown" "$(key "$OUT" reason)"
OUT="$(pf "$TMP/h_absent")"
is "T1.4 missing ~/.claude.json -> unknown"     "unknown" "$(key "$OUT" reason)"

OUT="$(pf "$(home_with h_noauth "{\"hasRemoteEnvironment\":true,\"projects\":{\"$RK\":{\"hasUsedRemoteSession\":true}}}")")"
is "T1.5 no oauthAccount -> not-logged-in" "not-logged-in" "$(key "$OUT" reason)"

OUT="$(pf "$(home_with h_noenv "{\"oauthAccount\":{\"a\":1},\"projects\":{\"$RK\":{\"hasUsedRemoteSession\":true}}}")")"
is "T1.6 hasRemoteEnvironment absent -> gate-off:no-remote-environment" \
   "gate-off:no-remote-environment" "$(key "$OUT" reason)"

OUT="$(pf "$(home_with h_nosess "{\"oauthAccount\":{\"a\":1},\"hasRemoteEnvironment\":true,\"projects\":{\"$RK\":{}}}")")"
is "T1.7 hasUsedRemoteSession absent -> gate-off:never-used-cloud-session" \
   "gate-off:never-used-cloud-session" "$(key "$OUT" reason)"

# project key must match THIS repo, not just any project in the file
OUT="$(pf "$(home_with h_otherproj "{\"oauthAccount\":{\"a\":1},\"hasRemoteEnvironment\":true,\"projects\":{\"/some/other/repo\":{\"hasUsedRemoteSession\":true}}}")")"
is "T1.8 hasUsedRemoteSession set for a DIFFERENT project -> gate-off" \
   "gate-off:never-used-cloud-session" "$(key "$OUT" reason)"

git_q "$REPO" remote set-url origin "$TMP/elsewhere/origin.git"
OUT="$(pf "$H_OK")"
is "T1.9 non-github origin -> origin-not-github" "origin-not-github" "$(key "$OUT" reason)"
git_q "$REPO" remote remove origin
OUT="$(pf "$H_OK")"
is "T1.10 no origin -> no-origin" "no-origin" "$(key "$OUT" reason)"
is "T1.10 ... default_branch degrades to 'unknown'" "unknown" "$(key "$OUT" default_branch)"
git_q "$REPO" remote add origin "$FX/github.com/origin.git"
git_q "$REPO" fetch origin; git_q "$REPO" remote set-head origin -a

# --- the false positive -----------------------------------------------------
# docs/procedures/remote-execution.md says a unit goes remote only when ALL of
# five conditions hold, and that preflight "check[s] all five in one call".
# base_pushed and plugin_declared are printed but NOT in the verdict ladder.
git_q "$REPO" checkout unpushed
OUT="$(pf "$H_OK")"
is "T1.11 unpushed base is detected"  "no" "$(key "$OUT" base_pushed)"
is "T1.11 ... but deliberately does NOT gate (remote-dispatch pushes it)" "ok" "$(key "$OUT" reason)"
git_q "$REPO" checkout main

rm -f "$REPO/.claude/settings.json"; git_q "$REPO" add -A; git_q "$REPO" commit -m "drop settings"
OUT="$(pf "$H_OK")"
is "T1.12 no .claude/settings.json -> plugin_declared=no" "no" "$(key "$OUT" plugin_declared)"
is "T1.12 ... and must NOT say remote_available=yes"      "no" "$(key "$OUT" remote_available)"
is "T1.12 ... and reason names it"  "plugin-not-declared" "$(key "$OUT" reason)"

mkdir -p "$REPO/.claude"
cat > "$REPO/.claude/settings.json" <<'EOF'
{"enabledPlugins":{"claude-architect@paul":true},"extraKnownMarketplaces":{"paul":{"source":{}}}}
EOF
git_q "$REPO" add -A; git_q "$REPO" commit -m s1
OUT="$(pf "$H_OK")"
is "T1.13 declared plugin + object-shaped marketplaces -> plugin_declared=yes" \
   "yes" "$(key "$OUT" plugin_declared)"
cat > "$REPO/.claude/settings.json" <<'EOF'
{"enabledPlugins":{"claude-architect@paul":true},"extraKnownMarketplaces":[]}
EOF
git_q "$REPO" add -A; git_q "$REPO" commit -m s2
OUT="$(pf "$H_OK")"
is "T1.14 plugin declared but NO marketplace -> plugin_declared=no" \
   "no" "$(key "$OUT" plugin_declared)"
cat > "$REPO/.claude/settings.json" <<'EOF'
{"enabledPlugins":{"claude-architect@paul":true},"extraKnownMarketplaces":{"paul":{}}}
EOF
git_q "$REPO" add -A; git_q "$REPO" commit -m s3

# an UNCOMMITTED local edit must not be trusted: the VM clones HEAD
printf '%s' '{"enabledPlugins":{},"extraKnownMarketplaces":[]}' > "$REPO/.claude/settings.json"
OUT="$(pf "$H_OK")"
is "T1.14b working-tree edits are ignored; HEAD decides" "yes" "$(key "$OUT" plugin_declared)"
git_q "$REPO" checkout -- .claude/settings.json

touch "$REPO/.claude/cloud-setup.sh"
OUT="$(pf "$H_OK")"
is "T1.15 an UNCOMMITTED cloud-setup.sh does not count (a VM clones)" "no" "$(key "$OUT" setup_script)"
git_q "$REPO" add -A; git_q "$REPO" commit -m "add cloud-setup"
OUT="$(pf "$H_OK")"
is "T1.15 ... a committed one does" "yes" "$(key "$OUT" setup_script)"

is "T1.16 preflight always exits 0" "0" "$( ( cd "$REPO" && env HOME="$TMP/h_absent" bash "$SCRIPTS/remote-preflight.sh" >/dev/null 2>&1 ); echo $? )"

# ===========================================================================
# T2 — squash-up.sh: the local path must not have changed meaning, and
#      --from-origin must leave the parent worktree committed and clean.
# ===========================================================================
mkfixture
git_q "$REPO" worktree add -b "main--impl/aaa1_local" "$TMP/wt" main
git -C "$TMP/wt" config user.email t@t; git -C "$TMP/wt" config user.name t
echo local > "$TMP/wt/d.txt"; git_q "$TMP/wt" add -A; git_q "$TMP/wt" commit -m leaf
OUT="$( cd "$REPO" && bash "$SCRIPTS/squash-up.sh" "main--impl/aaa1_local" "impl: local" 2>/dev/null )"
is "T2.1 local squash-up (2 args) still merges"    "main--impl/aaa1_local" "$(key "$OUT" merged)"
is "T2.1 ... into the derived parent"              "main" "$(key "$OUT" into)"
is "T2.1 ... and tears the child branch down"      "" "$(git -C "$REPO" branch --list 'main--impl/*')"

git_q "$REPO" worktree add -b "main--impl/aaa2_keep" "$TMP/wt2" main
git -C "$TMP/wt2" config user.email t@t; git -C "$TMP/wt2" config user.name t
echo k > "$TMP/wt2/e.txt"; git_q "$TMP/wt2" add -A; git_q "$TMP/wt2" commit -m leaf2
( cd "$REPO" && bash "$SCRIPTS/squash-up.sh" "main--impl/aaa2_keep" "impl: keep" --keep-worktree >/dev/null 2>&1 )
is "T2.2 --keep-worktree (3rd positional, as before) keeps the branch" \
   "kept" "$(git -C "$REPO" show-ref --verify --quiet refs/heads/main--impl/aaa2_keep && echo kept || echo gone)"

( cd "$REPO" && bash "$SCRIPTS/squash-up.sh" "main--impl/x_y" "m" --keep-workree >/dev/null 2>&1 )
is "T2.3 a typo'd flag refuses (exit 1) before touching git" "1" "$?"
is "T2.3 ... and left the parent worktree clean" "" "$(git -C "$REPO" status --porcelain)"

# --- --from-origin round trip ------------------------------------------------
mkfixture
BR="main--impl/cafe01_widget"
git clone -q "$FX/github.com/origin.git" "$TMP/leaf"
git -C "$TMP/leaf" config user.email t@t; git -C "$TMP/leaf" config user.name t
git_q "$TMP/leaf" checkout -B "$BR" origin/main
echo work > "$TMP/leaf/b.txt"
mkdir -p "$TMP/leaf/.work-log-export"; echo "status: complete" > "$TMP/leaf/.work-log-export/cafe01.md"
git_q "$TMP/leaf" add -A; git_q "$TMP/leaf" commit -m "leaf"; git_q "$TMP/leaf" push -u origin "$BR"

OUT="$( cd "$REPO" && bash "$SCRIPTS/squash-up.sh" "$BR" "impl: widget" --from-origin 2>/dev/null )"
is "T2.4 --from-origin merges a branch with no local ref" "$BR" "$(key "$OUT" merged)"
is "T2.4 ... work-log-export is not in the commit" "" \
   "$(git -C "$REPO" ls-tree -r --name-only HEAD | grep work-log-export)"
is "T2.4 ... work-log-export is not left on disk" "0" \
   "$( [ -e "$REPO/.work-log-export" ] && echo 1 || echo 0 )"
is "T2.4 ... the leaf's code IS in the commit" "b.txt" \
   "$(git -C "$REPO" ls-tree -r --name-only HEAD | grep b.txt)"
is "T2.4 ... parent worktree is clean" "" "$(git -C "$REPO" status --porcelain)"
is "T2.4 ... remote branch deleted from origin" "" \
   "$(git -C "$REPO" ls-remote --heads origin "$BR")"

# --- the bug: a stale UNTRACKED .work-log-export/ in the parent worktree ------
# `[ -e ]` tests the filesystem but `git rm --cached` needs it in the INDEX.
# Today this dies exit 128 AFTER `merge --squash` has staged the leaf's work,
# leaving the parent worktree half-merged — the exact state the script's own
# header promises never to happen.
BR2="main--impl/cafe02_nolog"
git_q "$TMP/leaf" fetch origin
git_q "$TMP/leaf" checkout -B "$BR2" origin/main
echo more > "$TMP/leaf/c.txt"; git_q "$TMP/leaf" add -A
git_q "$TMP/leaf" commit -m "leaf2"; git_q "$TMP/leaf" push -u origin "$BR2"
mkdir -p "$REPO/.work-log-export"; echo stale > "$REPO/.work-log-export/old.md"
( cd "$REPO" && bash "$SCRIPTS/squash-up.sh" "$BR2" "impl: nolog" --from-origin >/dev/null 2>&1 )
RC=$?
is "T2.5 stale untracked .work-log-export must not abort the squash" "0" "$RC"
is "T2.5 ... and must not leave a staged, uncommitted parent worktree" "" \
   "$(git -C "$REPO" status --porcelain --untracked-files=no)"

# --- the escalation shape: a branch carrying ONLY a work-log ------------------
# remote-implementation.md tells a leaf that returned `failed`/`escalated` to
# commit and push just its export log. After the strip there is nothing to
# merge. That must NOT be an error (the failure path would stall) and must NOT
# look like success (the escalation would be silently dropped): exit 3, no
# commit, and the branch preserved because it is the only copy of that log.
BR3="main--impl/cafe03_esc"
git_q "$TMP/leaf" fetch origin
git_q "$TMP/leaf" checkout -B "$BR3" origin/main
rm -rf "$TMP/leaf/.work-log-export"; mkdir -p "$TMP/leaf/.work-log-export"
printf 'status: failed
## Context I need
the seam contract
' > "$TMP/leaf/.work-log-export/cafe03.md"
git_q "$TMP/leaf" add -A; git_q "$TMP/leaf" commit -m "escalation"
git_q "$TMP/leaf" push -u origin "$BR3"
HEAD_BEFORE="$(git -C "$REPO" rev-parse HEAD)"
OUT="$( cd "$REPO" && bash "$SCRIPTS/squash-up.sh" "$BR3" "impl: esc" --from-origin 2>/dev/null )"
RC=$?
is "T2.6 an export-log-only branch exits 3"            "3" "$RC"
is "T2.6 ... reports merged=none"                      "none" "$(key "$OUT" merged)"
is "T2.6 ... reports status=empty-after-strip"         "empty-after-strip" "$(key "$OUT" status)"
is "T2.6 ... creates no commit on the parent"          "$HEAD_BEFORE" "$(git -C "$REPO" rev-parse HEAD)"
is "T2.6 ... leaves the parent worktree clean"         "" "$(git -C "$REPO" status --porcelain --untracked-files=no)"
is "T2.6 ... PRESERVES the branch (only copy of the log)" "$BR3" \
   "$(git -C "$REPO" ls-remote --heads origin "$BR3" | sed 's#.*refs/heads/##')"

# ===========================================================================
# T3 — dispatch -> collect round trip, and the branch-name convention that
#      three separate scripts independently re-derive with ${BRANCH%--*}.
# ===========================================================================
mkfixture
OUT="$( cd "$REPO" && bash "$SCRIPTS/remote-dispatch.sh" impl widget main 2>/dev/null )"
DBR="$(key "$OUT" branch)"
is "T3.1 dispatch prints base="        "main" "$(key "$OUT" base)"
is "T3.1 ... and the export dir"       ".work-log-export" "$(key "$OUT" export_dir)$(key "$OUT" export_log)"
is "T3.1 ... branch derives back to its parent" "main" "${DBR%--*}"
is "T3.1 ... base was actually pushed" "refs/heads/main" \
   "$(git -C "$REPO" ls-remote --heads origin main | awk '{print $2}')"

( cd "$REPO" && bash "$SCRIPTS/remote-dispatch.sh" subtree foo main >/dev/null 2>&1 )
is "T3.2 non-impl tier refuses" "1" "$?"
( cd "$REPO" && bash "$SCRIPTS/remote-dispatch.sh" impl foo nosuchbranch >/dev/null 2>&1 )
is "T3.3 unpushable/missing parent refuses" "1" "$?"
git_q "$REPO" remote set-url origin "$TMP/elsewhere.git"
( cd "$REPO" && bash "$SCRIPTS/remote-dispatch.sh" impl foo main >/dev/null 2>&1 )
is "T3.4 non-github origin refuses before pushing" "1" "$?"
git_q "$REPO" remote set-url origin "$FX/github.com/origin.git"

# A slug containing `--` would corrupt every ${BRANCH%--*} derivation. The
# remedy chosen is REFUSAL rather than sanitising: silently rewriting the
# caller's slug would produce a branch name they did not ask for and cannot
# predict, and the unit id is already opaque enough without that.
BEFORE="$(git -C "$FX/github.com/origin.git" for-each-ref --format='%(refname)' | wc -l)"
( cd "$REPO" && bash "$SCRIPTS/remote-dispatch.sh" impl 'my--slug' main >/dev/null 2>&1 )
is "T3.5 a slug containing -- refuses" "1" "$?"
( cd "$REPO" && bash "$SCRIPTS/remote-dispatch.sh" impl '-leading' main >/dev/null 2>&1 )
is "T3.5 ... a slug starting with - refuses" "1" "$?"
AFTER="$(git -C "$FX/github.com/origin.git" for-each-ref --format='%(refname)' | wc -l)"
is "T3.5 ... and neither refusal created a ref on origin" "$BEFORE" "$AFTER"

git clone -q "$FX/github.com/origin.git" "$TMP/leaf3"
git -C "$TMP/leaf3" config user.email t@t; git -C "$TMP/leaf3" config user.name t
BR3="main--impl/beef03_x"
git_q "$TMP/leaf3" checkout -B "$BR3" origin/main
mkdir -p "$TMP/leaf3/.work-log-export"; echo "status: failed" > "$TMP/leaf3/.work-log-export/beef03.md"
git_q "$TMP/leaf3" add -A; git_q "$TMP/leaf3" commit -m x; git_q "$TMP/leaf3" push -u origin "$BR3"
OUT="$( cd "$REPO" && bash "$SCRIPTS/remote-collect.sh" "$BR3" 2>/dev/null )"
is "T3.6 collect finds the pushed branch"  "yes" "$(key "$OUT" fetched)"
is "T3.6 ... reports the export log path"  ".work-log-export/beef03.md" "$(key "$OUT" export_log)"
is "T3.6 ... counts commits vs the base"   "1" "$(key "$OUT" commits)"
is "T3.6 ... status=ok"                    "ok" "$(key "$OUT" status)"

OUT="$( cd "$REPO" && bash "$SCRIPTS/remote-collect.sh" "main--impl/0000_ghost" 2>/dev/null )"
is "T3.7 a branch never pushed -> status=missing, exit 0" "missing" "$(key "$OUT" status)"
( cd "$REPO" && bash "$SCRIPTS/remote-collect.sh" main >/dev/null 2>&1 )
is "T3.8 a branch with no --parent segment refuses" "1" "$?"

# a leaf that pushed the base unchanged is 'empty', and must be
# distinguishable from a base ref that simply could not be resolved
BR4="main--impl/beef04_noop"
git_q "$TMP/leaf3" push origin "origin/main:refs/heads/$BR4"
OUT="$( cd "$REPO" && bash "$SCRIPTS/remote-collect.sh" "$BR4" 2>/dev/null )"
is "T3.9 a leaf that committed nothing -> status=empty" "empty" "$(key "$OUT" status)"

# ===========================================================================
# T4 — the key=value contract. These scripts' stdout IS their API; four
#      documents promise callers exactly which keys appear.
# ===========================================================================
mkfixture
keys_of() { grep -oE '^[a-z_]+=' | sed 's/=$//' | sort -u | tr '\n' ' '; }
DOCTEXT="$(cat "$DOCS/ORCHESTRATION.md" "$DOCS/docs/procedures/remote-execution.md")"

OUT="$( cd "$REPO" && env HOME="$TMP/h_absent" bash "$SCRIPTS/remote-preflight.sh" 2>/dev/null | keys_of )"
is "T4.1 preflight stdout keys" \
   "base_pushed default_branch origin plugin_declared reason remote_available setup_script " "$OUT"
OUT="$( cd "$REPO" && bash "$SCRIPTS/remote-dispatch.sh" impl w main 2>/dev/null | keys_of )"
is "T4.2 dispatch stdout keys" "base branch export_dir unit_id " "$OUT"
OUT="$( cd "$REPO" && bash "$SCRIPTS/remote-collect.sh" "main--impl/0_x" 2>/dev/null | keys_of )"
is "T4.3 collect stdout keys" "commits export_log fetched status " "$OUT"

MISSING=""
for k in remote_available reason origin default_branch base_pushed plugin_declared setup_script \
         base branch unit_id export_log fetched commits status merged into parent_worktree; do
  PAT='`'"$k"'=`'
  case "$DOCTEXT" in *"$PAT"*) : ;; *) MISSING="$MISSING $k" ;; esac
done
is "T4.4 every emitted key is named in ORCHESTRATION.md / remote-execution.md" "" "$MISSING"

# diagnostics must stay OFF stdout, or they corrupt the caller's parse
OUT="$( cd "$REPO" && env HOME="$TMP/h_absent" bash "$SCRIPTS/remote-preflight.sh" 2>/dev/null | grep -cE '^(parser|project_key|note)' )"
is "T4.5 parser=/project_key=/note go to stderr, not stdout" "0" "$OUT"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

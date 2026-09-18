# Gotchas

Non-obvious pitfalls. One entry per thing that bit us once.

- **Windows Git Bash: `command -v python3` lies.** It succeeds even when
  `python3` is the Microsoft Store's disabled alias, which exits 49 the moment
  it is actually invoked. Test-invoke (`python3 -c "" >/dev/null 2>&1`) before
  trusting a `command -v` hit for `python3`/`python`. Any cross-platform script
  that parses JSON via python hits this silently and misreports as "no
  interpreter".

- **REPO_ROOT-anchored scripts must read per-checkout facts BEFORE `cd`-ing.**
  Every script here anchors on `git rev-parse --git-common-dir` and `cd`s to the
  main repo root, which is correct for repo-global facts (origin URL,
  default-branch ref) and wrong for per-checkout ones. `git branch
  --show-current` and `.claude/settings.json` read from REPO_ROOT report the
  MAIN checkout, not the worktree the script was invoked from. Capture those
  before the `cd`. This bit `remote-preflight.sh`, which reported
  `base_pushed=yes` for an unpushed spec branch because it was really asking
  about `main`.

- **`isolation: remote` degrades silently.** On an account that has not cleared
  the cloud-execution gate, a remote dispatch becomes an ordinary local worktree
  agent with no error. A successful spawn is not proof of remote execution —
  check `spawnedWithWorktree` in the subagent metadata, or run
  `scripts/remote-preflight.sh` first.

- **`hasUsedRemoteSession` is set by `claude --cloud` only when the GitHub App
  check passes (v2.1.276).** The flag's writer has two callers: one passes
  `{project:false}`, and the `--cloud` creation path passes
  `{project: repoDetected && preflight !== "github_preflight_failed"}`. That
  check asks Anthropic, not GitHub, and an App installed on GitHub but unlinked
  on Anthropic's side fails it silently: the session runs from an uploaded
  bundle and the flag never lands. v2.1.275 was concluded to have "no user
  action sets it" from a `--cloud` run that, by the same mechanism, most likely
  just failed the check. Read every call site AND the condition on its
  arguments, and confirm the branch taken with `--debug`, before promising how
  a flag gets set.

- **A cloud environment's setup script runs outside the repo.** It runs before
  Claude Code launches with no checkout in its working directory, so
  `npm ci` there fails `EUSAGE` despite a committed lockfile; and it is
  account-wide, so a non-zero exit blocks every repo using the environment.
  Project dependencies go in a SessionStart hook (`$CLAUDE_PROJECT_DIR`), which
  is what `templates/cloud-install.sh` is.

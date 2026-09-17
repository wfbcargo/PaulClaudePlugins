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

- **`hasUsedRemoteSession` is per-project.** The cloud gate requires it set for
  the specific project, and it is set only when a cloud session has been created
  from that project. An account fully configured everywhere else still cannot
  dispatch remotely from a repo that has never had one.

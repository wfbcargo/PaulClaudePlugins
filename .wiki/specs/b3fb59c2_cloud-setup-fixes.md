# b3fb59c2 — Cloud setup that works on a real project

## Objective

A project that follows `templates/` gets a cloud environment that starts, installs
its dependencies and runs on the intended toolchain, and `remote-preflight.sh`
names the real blocker when remote leaves are unavailable. Every item below
failed, or misled, while configuring the first real consumer (SalesGenius, an npm
workspaces monorepo) on Claude Code 2.1.276.

## Acceptance criteria

1. `templates/project-settings.json` loads with no permission-rule warnings on
   2.1.276: only `Edit(path)` rules for file writes, no `MultiEdit`.
2. Pasting `templates/cloud-setup.sh` into an environment cannot stop a session
   from starting: it never exits non-zero and does not assume the repo is its
   working directory.
3. Project dependencies install from a SessionStart hook template that runs
   only in cloud sessions, resolves the repo through `$CLAUDE_PROJECT_DIR`, and
   carries a toolchain PATH into the session through `CLAUDE_ENV_FILE`.
4. No document points at "Settings -> Environments".
5. `remote-preflight.sh` reports `setup_script_committed=` (what it can see)
   instead of `setup_script=` (which implied the pasted field was checked), and
   reports `github_app=` plus the reason `gate-off:github-app-not-linked` when
   the latest `claude --cloud --debug` log shows the App check failing.
6. A remote leaf never reports a pass it read from truncated output.
7. `scripts/tests/remote-scripts.test.sh` covers every new preflight key and
   reason, and passes.

## Findings this spec encodes (2.1.276, 2026-09-18)

- The environment setup script runs before Claude Code launches, outside the
  repo: `npm ci` there failed `EUSAGE` although the lockfile was committed. The
  environment is account-wide, so a failing script blocks every repo using it.
- `--cloud` sets `hasUsedRemoteSession` for the project iff its GitHub check
  passes: `e7n(id, src, {project: repoDetected && preflight !== "github_preflight_failed"})`.
  That check asks Anthropic (`/api/oauth/organizations/<org>/code/repos/<o>/<r>`),
  not GitHub. A 200 with `status: null` means the App is installed on GitHub but
  not linked to the Claude account: every session silently bundles, the flag is
  never set. `--debug` logs `GitHub app is not installed on <o>/<r> (status is null)`
  then `Bundling (reason: github_preflight_failed)`. Not end-to-end verified: the
  check never passed on the test account, so a flag flip was never observed.
- A bare `Bash` allow rule in project settings is discarded at load:
  `Ignoring dangerous permission Bash(*) from .claude\settings.json (bypasses classifier)`.
- A cloud session reported "zero errors across all 12 packages" from
  `npm run typecheck | tail -50` on a 21-package repo; the pipe also replaced
  npm's exit code with tail's.

## Out of scope

The CLI transport (`claude --cloud` dispatch while `isolation: remote` is gated)
is a separate spec: it depends on a spike that has not run.

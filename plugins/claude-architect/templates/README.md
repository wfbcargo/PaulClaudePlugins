# Remote (cloud) execution templates

Three files. None is part of `.wiki/` — don't copy this directory there. None is
needed unless the project intends to let the orchestrator dispatch
`implementation` leaves onto Anthropic-managed cloud VMs (`REMOTE_EXECUTION=leaf`;
see `docs/procedures/remote-execution.md`).

| File | Goes where | What it's for |
| --- | --- | --- |
| [project-settings.json](project-settings.json) | Merged into the repo's own `.claude/settings.json`, **committed** | Declares the `paul-claude-plugins` marketplace and enables `claude-architect`, because a cloud VM installs plugins only from the repo it clones — never from your `~/.claude/settings.json`. Registers the SessionStart hook that runs `cloud-install.sh`. Grants the permission rules a remote leaf needs to run unattended: a cloud session has no client to answer a permission prompt, so an uncovered tool call puts the session in `requires_action` and the leaf is lost. |
| [cloud-install.sh](cloud-install.sh) | **Committed** at `scripts/cloud-install.sh` | Installs project dependencies at session start, in cloud sessions only. |
| [cloud-setup.sh](cloud-setup.sh) | **Committed** at `.claude/cloud-setup.sh`, AND its body pasted into the environment's Setup script field | Provisions the VM's toolchain (a pinned Node, an apt package) before Claude Code starts. Toolchain only — never project dependencies. |

## Setup script vs. SessionStart hook

They run at different times, in different places, and the split between them is
the thing most likely to go wrong:

| | `cloud-setup.sh` (setup script) | `cloud-install.sh` (SessionStart hook) |
| --- | --- | --- |
| Runs | once per environment snapshot (~7 days), before Claude Code launches | every session start and resume, after Claude Code launches |
| Working directory | **not the repo** — no checkout, no lockfile | the repo, via `$CLAUDE_PROJECT_DIR` |
| Scope | every repo using the environment | this repo, local and cloud (the script exits early unless `CLAUDE_CODE_REMOTE=true`) |
| Non-zero exit | the session fails to start | the session starts anyway |
| Result kept | in the snapshot | for the life of the VM |

So `npm ci` in the setup script fails `EUSAGE` even with a committed lockfile,
and one failing command there blocks every repo in the environment. The
template never exits non-zero for that reason. Give each repo its own
environment so a toolchain choice for one cannot reach another.

**Where the setup script lives.** Nothing reads the committed
`.claude/cloud-setup.sh`; only the pasted field executes. Open claude.ai/code or
the Desktop app's Code tab, click the environment name above the message box,
hover an environment and click its gear (or **Add cloud environment**). Keep the
field and the committed file in sync by hand; `remote-preflight.sh` reports
`setup_script_committed=`, which is all it can see.

**Toolchain versions.** The VM ships Node 20/21/22 with 22 on `PATH`. To match
local development, set `NODE_VERSION` in `cloud-setup.sh` (installs beside the
VM's own at `/opt/node<major>`, leaving `PATH` alone for other repos) and the
same major as `NODE_MAJOR` in `cloud-install.sh`, which prepends it to `PATH` and
writes that to `CLAUDE_ENV_FILE` so every later Bash call in the session sees
it. Verify from a session with `node --version`.

## Permissions

**`deny` is the load-bearing half, and it is listed first deliberately.** `deny`
beats `allow`, so the block refuses writes to `.claude/**` — the very file that
grants these permissions — plus reads and writes of `.env*` and key material,
and force-pushes. Without it, a leaf acting on a prompt it should not have
trusted can widen its own permissions, and the change reaches every
collaborator on merge. File-write rules are `Edit(path)` only: Claude Code
matches path rules for every file-editing tool through `Edit`, and warns that
`Write(path)` and `MultiEdit(path)` rules match nothing.

**`allow` is command-scoped on purpose.** Claude Code discards a bare `Bash`
allow rule from project settings at load — `--debug` logs `Ignoring dangerous
permission Bash(*) from .claude/settings.json (bypasses classifier)` — so the
broad rule never granted anything. The template allows the git commands the
remote protocol runs (fetch, checkout, add, commit, push, plus read-only
status/diff/log); add your project's own — `Bash(npm run typecheck:*)`,
`Bash(npm test:*)` — once you know which commands its leaves run.

**The block applies locally too — decide before you commit it.**
`.claude/settings.json` is read by every session in the repo, not only by cloud
ones: its `allow` rules skip prompts for a human's session too, and its `deny`
rules bind that session as well. There is no way to scope a rule in that file to
cloud sessions. A project unwilling to change its local permissions should drop
the `permissions` key and dispatch remote leaves under a permission mode that
already covers them.

**Claude cannot install these files for you, by design.** `Edit(.claude/**)`
and the auto-mode classifier both refuse a session writing its own
configuration. Stage the files outside `.claude/` and copy them in yourself,
then commit and push — the preflight checks and the VM both read the committed
tree, not the working copy.

## Prerequisites outside the repo

- **The Claude GitHub App, linked to your Claude account.** `claude --cloud`
  asks Anthropic whether the App is installed on the repo. If Anthropic has no
  record of it — including when GitHub shows it installed — the session
  silently uploads a bundle of your local repo instead of cloning, and the
  project never becomes eligible for `isolation: remote`. Diagnose with
  `claude --cloud "<task>" --debug`; see `docs/procedures/remote-execution.md`
  → *Environment facts*.
- **A reachable marketplace.** The marketplace source must be on the VM's
  network allowlist (a public GitHub URL, as in the template, is).
- **The plugin declared in the repo's own settings**, committed. A plugin
  enabled only in `~/.claude/settings.json` is invisible to a cloud session,
  and is the most likely reason a remote dispatch behaves as though the
  framework isn't installed.

Declaring the plugin is only the project-side half of eligibility; the base
branch must also be pushed to a GitHub `origin`, and `REMOTE_EXECUTION=leaf` is
a run-time knob — see `docs/procedures/remote-execution.md` → *Eligibility*.

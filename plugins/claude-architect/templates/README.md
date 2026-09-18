# Remote (cloud) execution templates

Two files. Neither is part of `.wiki/` — don't copy this directory there.
Neither is needed unless the project intends to let the orchestrator dispatch
`implementation` leaves onto Anthropic-managed cloud VMs (`REMOTE_EXECUTION=leaf`;
see `docs/procedures/remote-execution.md`).

| File | Goes where | What it's for |
| --- | --- | --- |
| [project-settings.json](project-settings.json) | Merged into the repo's own `.claude/settings.json`, **committed** | Declares the `paul-claude-plugins` marketplace and enables `claude-architect`, because a cloud VM installs plugins only from the repo it clones — never from your `~/.claude/settings.json`. Also grants the permission rules a remote leaf needs to run unattended: a cloud session has no client to answer a permission prompt, so an uncovered tool call puts the session in `requires_action` and the leaf is lost. |
| [cloud-setup.sh](cloud-setup.sh) | **Committed** at `.claude/cloud-setup.sh`, AND its body pasted into the environment dialog at claude.ai/code | The remote analogue of `scripts/worktree-setup.sh`: provisions the VM itself (dependencies, toolchains) before Claude Code starts. |

**Both halves matter for `cloud-setup.sh`, and they do different jobs.**
Committing it at `.claude/cloud-setup.sh` makes it reviewable and diffable like
any other script, and it's what `scripts/remote-preflight.sh` checks for when
it reports `setup_script=`. But committing it does not make it run — claude.ai/code
never reads or executes a file from the cloned repo for this purpose. What
actually executes is whatever is pasted into the "Setup script" field of the
environment dialog (Settings -> Environments, or when creating one). Keep the
committed file and the pasted text in sync by hand; nothing enforces that they
match. Claude Code runs the pasted script once, before the session's Claude
Code process starts, then snapshots the filesystem. Every session dispatched
into that environment for roughly the next seven days reuses the snapshot
instead of re-running the script, so what it installs is what every remote
leaf gets, and it is paid for once, not per leaf.

Declaring the plugin is only part of eligibility. A project can receive a remote
leaf only when, in addition, the repo has a GitHub `origin` and the base branch
is pushed to it before dispatch — that's the project-side half of the
eligibility predicate. The other half (`REMOTE_EXECUTION=leaf`, which roles may
go remote) is a run-time knob and role restriction, not something a project
declares; it lives in `ORCHESTRATION.md` and `docs/procedures/remote-execution.md`.

Per-session project setup (`npm install`, a dev-database migration — anything
that must run at the START of every session, local or cloud) belongs in a
`SessionStart` hook in `.claude/settings.json`, not in either file above: a
hook is the one mechanism that runs on both sides, whereas `cloud-setup.sh`
touches only the VM, and only once per snapshot.
`project-settings.json` ships without one — what a session needs to
bootstrap is specific to the project, not something a generic template should
guess at.

**`deny` is the load-bearing half, and it is listed first deliberately.** `deny`
beats `allow`, so the block refuses writes to `.claude/**` — the very file that
grants these permissions — plus reads and writes of `.env*` and key material,
and force-pushes. Without it, a leaf acting on a prompt it should not have
trusted can widen its own permissions, and the change reaches every
collaborator on merge. `allow` still lists bare `Bash`, which is
allow-everything rather than "what a remote leaf needs": narrow it to
command-scoped `Bash(<cmd>:*)` rules once you know which commands your
project's leaves actually run. The `deny` entries are what make the broad
`allow` survivable in the meantime.

**The `permissions` block applies locally too — decide before you commit it.**
`.claude/settings.json` is read by every session in the repo, not only by
cloud ones, so allowing `Bash`, `Write` and `Edit` there means any Claude session
a human opens in this project also runs those without prompting — and the `deny`
entries equally constrain that human's session. There is no way to scope a
permission rule in that file to cloud sessions only. The block is in the
template because without it a remote leaf's first uncovered tool call puts its
session in `requires_action` with no client to answer, and the leaf is simply
lost — but that is a reason to adopt it deliberately, not silently. A project
unwilling to widen its local permissions should delete the `permissions` key
from the template and instead dispatch remote leaves under a permission mode
that already covers them, accepting that local sessions keep prompting as
before.

Two failure modes are worth knowing before you rely on this: the marketplace
source must be reachable from the cloud VM's network allowlist (a public GitHub
URL, as above, is); and the plugin must be declared in the **repo's**
`.claude/settings.json` specifically — a plugin enabled only in your own
`~/.claude/settings.json` is invisible to a cloud session, and is the most
likely reason a remote dispatch behaves as though the framework isn't installed
at all.

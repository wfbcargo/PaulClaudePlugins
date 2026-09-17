# Project Wiki

Durable, **committed** project memory. Read by the orchestrator and sub-agents for
context; the `architecture-audit` drift gate checks that these files stay TRUE as
the code changes. Unlike `.work-log/` (per-worktree AI scratch paper, stripped
before PR), the wiki is committed and lives for the life of the project.

Copy this directory to `.wiki/` at your repo root and fill it in.

## Index

| File | What's in it |
| --- | --- |
| [architecture.md](architecture.md) | Module layout, boundaries, data flow. |
| [containers.yaml](containers.yaml) | **Optional.** Machine-readable layer/container map: allowed edges, public surface, per-container agent tuning. Delete it if the project doesn't use the container model. |
| [conventions.md](conventions.md) | Coding conventions, naming, formatting decisions. |
| [rules.md](rules.md) | Active project rules (`R-NNN`). Passed to every sub-agent at spawn. |
| [decisions/](decisions/) | ADRs — one file per architectural decision. |
| [gotchas.md](gotchas.md) | Non-obvious pitfalls that bit us once. |
| [glossary.md](glossary.md) | Domain + framework terms. |
| [specs/](specs/) | Per-spec notes that outlive the branch. |

## Remote (cloud) execution templates

Two more files live in this directory, alongside the wiki content above — neither
is part of `.wiki/`, and neither is needed unless the project intends to let the
orchestrator dispatch `implementation` leaves onto Anthropic-managed cloud VMs
(`REMOTE_EXECUTION=leaf`; see `docs/procedures/remote-execution.md`).

| File | Goes where | What it's for |
| --- | --- | --- |
| [project-settings.template.json](project-settings.template.json) | Merged into the repo's own `.claude/settings.json`, **committed** | Declares the `paul-claude-plugins` marketplace and enables `claude-architect`, because a cloud VM installs plugins only from the repo it clones — never from your `~/.claude/settings.json`. Also grants the permission rules a remote leaf needs to run unattended: a cloud session has no client to answer a permission prompt, so an uncovered tool call puts the session in `requires_action` and the leaf is lost. |
| [cloud-setup.sh.template](cloud-setup.sh.template) | Pasted into the environment dialog at claude.ai/code, **not committed, not run by this framework** | The remote analogue of `scripts/worktree-setup.sh`: provisions the VM itself (dependencies, toolchains) before Claude Code starts. Runs once per environment and must finish in about five minutes; the filesystem is then snapshotted and reused for about a week, so what it installs is what every leaf dispatched into that environment gets. |

Declaring the plugin is only part of eligibility. A project can receive a remote
leaf only when, in addition, the repo has a GitHub `origin` and the base branch
is pushed to it before dispatch — that's the project-side half of the
eligibility predicate. The other half (`REMOTE_EXECUTION=leaf`, which roles may
go remote) is a run-time knob and role restriction, not something a project
declares; it lives in `ORCHESTRATION.md` and `docs/procedures/remote-execution.md`.

Per-session project setup (`npm install`, a dev-database migration — anything
that must run at the START of every session, local or cloud) belongs in a
`SessionStart` hook in `.claude/settings.json`, not in either template above: a
hook is the one mechanism that runs on both sides, whereas `cloud-setup.sh`
touches only the VM, and only once per snapshot.
`project-settings.template.json` ships without one — what a session needs to
bootstrap is specific to the project, not something a generic template should
guess at.

**The `permissions.allow` block applies locally too — decide before you commit
it.** `.claude/settings.json` is read by every session in the repo, not only by
cloud ones, so allowing `Bash`, `Write` and `Edit` there means any Claude session
a human opens in this project also runs those without prompting. There is no way
to scope a permission rule in that file to cloud sessions only. The block is in
the template because without it a remote leaf's first uncovered tool call puts
its session in `requires_action` with no client to answer, and the leaf is simply
lost — but that is a reason to adopt it deliberately, not silently. A project
unwilling to widen its local permissions should delete the `permissions` key from
the template and instead dispatch remote leaves under a permission mode that
already covers them, accepting that local sessions keep prompting as before.

Two failure modes are worth knowing before you rely on this: the marketplace
source must be reachable from the cloud VM's network allowlist (a public GitHub
URL, as above, is); and the plugin must be declared in the **repo's**
`.claude/settings.json` specifically — a plugin enabled only in your own
`~/.claude/settings.json` is invisible to a cloud session, and is the most
likely reason a remote dispatch behaves as though the framework isn't installed
at all.

## Discipline

Keep it small and accurate. Default is **omit**. If you can't say why a future
agent will need a note, don't add it. When a change alters documented behavior,
update the matching file in the same diff — a stale wiki is worse than none.

The wiki is **read context** — every file an agent reads costs tokens, so each has
a size budget:

| File | Budget |
| --- | --- |
| `rules.md` | ≤ ~15 rules / one screen — **hottest**, passed on every spawn |
| `architecture.md`, `conventions.md` | ~1 screen each; push detail into a `decisions/` ADR |
| `gotchas.md`, `glossary.md` | one line per entry; prune what's no longer true |
| `decisions/<NNNN>` | one decision per file; never merge or renumber |

A file over budget is a signal to consolidate, not to keep appending. Agents read
only the entries their spawn prompt cites — they don't scan the whole wiki (the
`architecture-audit` / `spec-audit` auditors are the deliberate exception).

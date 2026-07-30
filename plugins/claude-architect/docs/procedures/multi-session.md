# Procedure — parallel sessions on one project

**Read this when:** more than one Claude Code session is running against this
repo (e.g. one per terminal tab). If you are the only session, ignore all of it
except the numbering default.

Only the **session root** reconciles against shared state — child orchestrators
work within the design their root has already reconciled.

## Reconcile points

At session start, before each top-level integration, and before any structural
decision: `git fetch` the integration branch and reconcile the latest `.wiki/`
(architecture, decisions, conventions, rules) into the working design. Build on
current reality, not the snapshot you started with.

Changes to shared surfaces — top-level architecture, cross-cutting conventions —
escalate to the user. Cross-session structural arbitration is the user's mandate,
not a session's.

## Shared-namespace numbering

Globally-sequential `decisions/<NNNN>` filenames and `R-NNN` rule IDs collide
when parallel sessions each grab "the next integer." Partition the number space
instead: assign each concurrent session a distinct hundred-block (session 1 →
`0100`s / `R-100`s, session 2 → `0200`s / `R-200`s, …), recorded in the opening
commit trailer.

The serial low range `0001–0099` / `R-001`–`R-099` is the single-session default.

Numbers are then globally unique by construction, so the integrator never
renumbers at merge. Index and list conflicts are **keep-all**: order by number,
never drop a side.

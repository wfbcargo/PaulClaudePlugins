# Glossary

Domain terms, acronyms, and internal jargon. Also a good home for framework terms
so a new agent (or human) can decode the branch names and work-log.

- **`.wiki/`** — committed, durable project memory (this directory).
- **`.work-log/`** — per-worktree, AI-to-AI scratch paper; stripped before PR.
- **epic / spec / implementation / task** — work tiers by kind (coordination /
  single intent / execution / trivial). Drive branch naming and model routing.
- **drift gate** — the read-only `architecture-audit` pass at structural
  boundaries that checks placement, boundaries, missing ADRs, and wiki truth.

Container-model terms — keep these if the project has `containers.yaml`, delete
them if it does not:

- **layer** — `user` / `orchestration` / `engine`. Dependency direction runs
  strictly downward and skipping is forbidden.
- **container** — a folder owning one business capability inside one layer, with
  declared edges and a single public entry file. **The unit of agent
  assignment.** NOT the C4 sense (a deployable unit — that is a *component* here)
  and NOT the Docker sense. Both other meanings are common; this one is ours.
- **slice** — containers sharing a `slice` key across layers, i.e. the vertical
  feature view over the same tree.
- **seam** — the interface where two containers meet. Written into the spec
  before either side is built, and owned by the orchestrator, never a leaf.
- **surface** — the one file another container may import from (`index.ts` by
  default). Everything else in a container is private to it.
- **<your domain term>** — <definition>

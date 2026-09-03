# claude-boundaries

Declare your architecture's layers, containers and contracts in one file. The
plugin turns that file into a check that runs with **no project dependencies**,
and wires it into hooks so every coding agent working in the repo inherits the
rules — states them at session start, gets a violating edit handed straight back,
and cannot finish a turn while a violation stands.

```
/plugin marketplace add wfbcargo/PaulClaudePlugins
/plugin install claude-boundaries@paul-claude-plugins
```

Then, in a repo: `/boundaries:init`.

Projects with no map are unaffected by all of it — every hook is a silent no-op.

## Why

The usual ways of holding an architecture together both fail, in opposite ways.
A README saying "the domain layer must not import the database" is read once and
outlived by the first deadline. A linter rule is real but invisible to the agent
writing the code, which finds out at build time if it runs the build at all.

An agent that sees a build failure fixes it. An agent that reads "please don't
cross layer boundaries" may cross them anyway. So: state the rules in the
agent's context, check every edit against them mechanically, and refuse to let a
turn end dirty. Nothing here relies on the agent choosing to care.

## The model

Layers, ordered top-down, with dependency direction running downward and no
skipping. The default three, top to bottom: **surface** (the doorways in and
out — HTTP handlers, CLI commands, queue consumers), **orchestration** (the
business logic, grouped by capability), and **engine** (the granular connectors
to other systems — database, third-party APIs, auth, storage). You name your
own; these are the starting point. Inside a layer, a **container** is one folder
— or one workspace package — that owns one capability, declares which other
containers it may call, and exposes exactly one importable entry file.

```
src/orchestration/auth/          <- container `orchestration/auth`
    index.ts                     <- the ONLY file another container may import
    usecases/                    <- sequencing, transactions, calls the layer below
    domain/                      <- pure rules; imports NOTHING outside this folder
```

> **Terminology.** In C4, "container" means a separately deployable unit; what
> this plugin calls a container, C4 calls a *component*. Both that sense and
> Docker's are common in training data, so agents receive `layer:` and
> `container:` as structured fields and never as prose to interpret.

Two topologies, because real repos come in two shapes:

| | `folders` | `packages` |
|---|---|---|
| A container is | a folder under `policy.root` | a workspace package |
| Imports cross by | relative path or alias | the package name |
| Extra rules | — | R6 (no relative escape), R8 (manifest agreement) |

## The rules

| | Rule |
|---|---|
| **R1** | **Direction** — never import an upper layer |
| **R2** | **No skipping** — the top layer may not reach the bottom directly |
| **R3** | **Declared edges** — the target must be listed in `consumes` |
| **R4** | **Public surface** — a cross-container import lands on the entry file, not internals |
| **R5** | **Purity** — a `pure_paths` folder imports nothing outside itself, not even the rest of its own container |
| **R6** | **Escape** — a relative import may not leave its own package (`packages`) |
| **R7** | **External** — third-party imports obey the layer's `external:` rule |
| **R8** | **Manifest** — package.json dependencies agree with the map (`packages`) |
| **R9** | **Owned types** — `import type` is an edge like any other |

Plus **R0**, the fail-closed guard: source that belongs to no container. That
one is not pedantry. An unclassified package is also an unclassified import
*target*, so anything may import it with no edge to check — which makes it the
one reliable way to launder a forbidden dependency past every other rule.

One import produces **one** finding, most-specific first. Reporting a relative
cross-layer import into a private file as four violations tells the reader
nothing the first one did, and an agent handed four findings tries to fix four
things.

### Why `domain/` has to be pure

The middle layer merges two roles that classical DDD separates: *application*
(sequencing, transactions, no business rules) and *domain* (invariants,
calculations, no I/O). Merged in one folder they interleave, and the diagnostic
is sharp: **if you cannot unit-test a business rule without stubbing an I/O
call, the layers have collapsed.**

`pure_paths` is what keeps three layers rather than four. Note the asymmetry —
`orchestration/auth` may call `engine/token`, but `orchestration/auth/domain`
may not. The purity rule is *stricter* than its own container's edges.

### Why the graph must be acyclic

A cycle is survivable for a human team and fatal for parallel agents: if
`auth → permissions` and `permissions → auth` are both legal, neither agent can
be dispatched without the other's contract, and both will invent one. `validate`
rejects a cyclic map, not just cyclic code.

## What runs, and when

| Hook | Fires | Does |
|---|---|---|
| `SessionStart` | every session | States the layer order, the rules and the escalation path as context. Config parse only. |
| `PostToolUse` | `Edit`/`Write`/`MultiEdit`/`NotebookEdit` | Re-reads the edited file, checks it, and on a violation exits 2 with the reason and the container's legal targets. |
| `Stop` / `SubagentStop` | turn end | `check --changed`; blocks while a violation stands. |

Design notes worth knowing:

- **PostToolUse, not PreToolUse deny.** An `Edit` gives a hook only the old and
  new strings, so a pre-check has to reconstruct the resulting file and denies
  wrongly whenever it gets that wrong. A wrong deny wedges the agent with no way
  forward — worse than a violation that lives for one turn. Reading the file
  after the write is exact.
- **The Stop gate yields on the second pass.** If the agent has already been
  blocked once and the findings still stand, it is allowed to stop, with the
  findings reported. Blocking forever on something it cannot fix is a hang, and
  the user should be the one deciding what happens next.
- **Every hook fails open.** Missing map, unparseable map, checker throws → exit
  0, silence. A boundary checker that can wedge a session because its own config
  has a typo gets uninstalled, and then it enforces nothing at all.

## Commands

```
/boundaries:init      propose a map from the tree, then agree it with the user
/boundaries:check     run the check and triage the findings
/boundaries:map       the graph, and what each container may consume
```

And the CLI, which needs nothing installed:

```
node <plugin>/scripts/boundaries.mjs validate          # map coherence: DAG, refs, overlaps
node <plugin>/scripts/boundaries.mjs check [--changed] [--file <p>] [--json]
node <plugin>/scripts/boundaries.mjs where <path>      # a file's container, edges, surface
node <plugin>/scripts/boundaries.mjs scope <id>        # a `## YOUR SCOPE` block for a spawn
node <plugin>/scripts/boundaries.mjs map | list | brief
node <plugin>/scripts/boundaries.mjs suggest           # a starter map for an unmapped repo
node <plugin>/scripts/boundaries.mjs emit [target]     # a linter config for your CI
```

Exit codes: `0` clean, `1` violations, `2` misconfiguration. **A check that
scanned zero files exits 2, never 0** — a map pointing somewhere the code is not
is a broken configuration wearing a green tick, and that is worse than a red one
because nobody investigates it. For the same reason an import that resolves to
nothing is reported: it matched no rule, so it is *unchecked*, not clean.

## The checker

Self-contained, so a hook can run on a fresh clone with nothing installed:

- **Import extraction** is a character scanner, not a regex. It blanks every
  comment, string, template literal (interpolation included) and regex literal
  before matching, so a specifier inside a comment is not an import and a
  multi-line `import { … } from '…'` is. Both directions of that mistake are
  invisible: a missed import is a violation that passes, a hallucinated one is
  correct code that gets blocked. Where the project has `typescript` installed,
  the compiler API is used instead — same output, better oracle.
- **Resolution** handles relative paths, `tsconfig`/`jsconfig` `paths` aliases
  (following `extends`), and workspace package names from `pnpm-workspace.yaml`
  or package.json `workspaces`. Subpaths are stripped before lookup, so
  `@app/kernel/dist/x.js` lands in the same container as `@app/kernel` — a deep
  import cannot evade the edge check.
- **Python** gets the same treatment via its own scanner, docstrings included.

`emit` generates a `dependency-cruiser` or `import-linter` config from the same
map for your CI. Coverage is not identical — import-linter contracts are
module-level, so the public-surface rule and within-container purity are not
expressible there. The built-in checker covers both, and the hooks use it.

## Using it with `claude-architect`

The schema is a strict **superset** of that plugin's `.wiki/containers.yaml`,
discovered at the same path first, and the keys added here sit where its loader
ignores them. **One file serves both plugins** — there is no second config to
keep in sync. A test in this repo's suite loads that plugin's own template
unchanged, so the claim stays true rather than aspirational.

The division of labour, if you run both: `claude-architect` uses the map to
*dispatch* — container to file partition, per-container spawn tuning, seams
written before parallel agents start. `claude-boundaries` uses it to *enforce*.
Neither requires the other.

## Configuration

`.wiki/containers.yaml`, `.claude/boundaries.yaml`, or `boundaries.yaml`, first
one found walking up. Start from `templates/containers.folders.yaml` or
`templates/containers.packages.yaml`, both of which are commented at length.

Beyond the obvious keys:

| Key | Default | |
|---|---|---|
| `policy.topology` | `folders` | `folders` \| `packages` |
| `policy.pure_paths` | `[]` | sub-paths that may import nothing outside themselves |
| `policy.type_imports` | `edge` | `ignore` to stop counting `import type` |
| `policy.unclassified` | `warn` / `error` | error under `packages`; that is the fail-closed default |
| `policy.relative_escape` | `allow` / `forbid` | forbid under `packages` |
| `policy.unresolved` | `warn` | `error` to fail on imports the resolver could not follow |
| `policy.test_exempt` | test globs | exempt from **R7 only** — R1–R6 still apply to tests |
| `layer.external` / `container.external` | `any` | `none` \| `any` \| `[allowlist]` |

That last one is the strongest rule available and the one worth reaching for
deliberately. `external: none` says a container depends on nothing third-party
at all, and it is checked **at the import site**, regardless of which dependency
map — if any — declares the package. A `devDependency` resolves, compiles and
ships exactly like a runtime dependency, so a manifest was never a sound place
to enforce this alone. R8 checks the manifest too; both halves, because either
alone has a hole.

## Tests

```
cd plugins/claude-boundaries && npm test
```

71 tests, no dependencies. Each rule is asserted to fire on the violation **and**
to stay quiet on the nearest legal thing to it — a rule that fires on
legitimate code gets the whole check switched off, and a checker nobody runs
enforces less than no checker at all, because everyone believes it is running.

MIT licensed.

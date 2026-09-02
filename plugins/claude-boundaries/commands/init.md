---
description: Set up a container map for this repo — propose one from the tree, then agree it with the user.
---

Adopt the boundary model in this repo. This is a design conversation with a
generated starting point, not a scaffold you fill in silently.

**1. Check whether a map already exists.**

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" validate
```

If one loads, say so and stop — the user wants to edit it, not replace it.

**2. Propose one.**

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" suggest
```

This reads the tree and prints a candidate map. Every line of it is a question:

- The layer assignments are guesses from directory names. Confirm each.
- **The `consumes` lists are what the code imports today, not what it should be
  permitted to.** This is the important part. Deleting an edge here is how the
  user decides the architecture rather than merely records the current mess.
- Each `owns:` is a TODO. One sentence, one capability. If a sentence needs an
  "and", it is two containers or it is none.

**3. Work through it with the user.** Ask about the edges that look wrong to
you, and about any container whose capability you cannot state in one sentence.
Present the layer order explicitly and confirm it — top-down, and getting it
backwards inverts every rule.

**4. Write `.wiki/containers.yaml`** (or `boundaries.yaml` at the root if there
is no `.wiki/`), then:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" validate
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" check
```

**Expect the first `check` to fail.** That is the map telling you where the
architecture and the code already disagree — it is the point of the exercise,
not a setback. Report the findings grouped by rule, and ask the user which are
map errors (fix now) and which are real debt (leave, and work off deliberately).
Do not weaken the map to make the first run green.

**5. Offer CI.** `boundaries.mjs emit` writes a dependency-cruiser or
import-linter config from the same map, so the project's own pipeline enforces
it without routing through the plugin.

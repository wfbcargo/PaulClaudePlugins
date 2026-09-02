---
description: Check the repo for layer, container and contract boundary violations.
---

Run the boundary check and report what it finds.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" check $ARGUMENTS
```

Useful arguments: `--changed` (only files this branch touched), `--json`.

Then, for each finding, decide which of the three cases it is — a wrong import,
code in the wrong container, or a genuinely missing edge — using the
`boundaries` skill. Fix the first two. For the third, say what edge you believe
is missing and why, and stop: changing the map is the user's decision.

If the check exits 2, the map is broken or points somewhere the code is not.
That is not a pass with warnings; fix it before reading anything else.

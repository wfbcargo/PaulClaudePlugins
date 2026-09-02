---
description: Show this repo's layer and container graph, and what each may consume.
---

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" map
```

If the user named a file or directory, also run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/boundaries.mjs" where <path>
```

Report the graph as-is. Do not editorialise about the architecture unless asked —
and if you do have an observation about placement, offer it separately rather
than mixing it into the map.

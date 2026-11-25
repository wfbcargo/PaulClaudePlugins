# Ideas

The handful of concepts this app is built from, and the place to start: pick the idea a piece of work belongs to,
open its file, and follow its reading list down to the specs, decisions, rules, containers and gotchas. Every spec
and decision is filed under at least one idea; work that fits none is a new idea (agreed with the user) or a sign it
is off course.

One line per idea: `- [Name](ideas/<slug>.md) (maturity): summary`. Each file follows
[`ideas/_example.md`](ideas/_example.md).

`node <claude-architect>/scripts/wiki-graph.mjs --ideas` prints every idea with its state; `--idea <slug>` prints one
idea's reading list.

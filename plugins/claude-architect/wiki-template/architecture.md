# Architecture

> Describe the system as it *is*. The `architecture-audit` agent flags any section
> the code has made stale, and any structural change made without a matching ADR.

## Layout

```
<top-level module tree — where things live and why>
```

## Boundaries & dependency direction

- <which modules may depend on which; what's forbidden>

<!-- If the project uses the container model, replace the bullet above with a
     SHORT prose summary and let `containers.yaml` carry the detail. The YAML is
     the source of truth because it is parsed; this section exists so a human
     (and the architecture-audit agent) can read the intent in one screen. Do not
     duplicate the edge list here — it will go stale, and a stale map that still
     looks authoritative is worse than no map.

## Layers & containers

Direction is strictly downward, no skipping:
`user` -> `orchestration` -> `engine`.

- **user** — <what lives here>
- **orchestration** — <what lives here; transaction boundaries live here>
- **engine** — <what lives here; returns its own DTOs, never domain models>

Containers are folders inside a layer, one per business capability, each with a
single public entry file. Allowed edges, per-container agent tuning, and slice
alignment are declared in [`containers.yaml`](containers.yaml) and enforced by
`containers.mjs check`. Adding an edge or a container is an ADR-worthy decision.
-->


## Data flow

- <how data moves through the system, at a glance>

## History

- <notable removed/relocated sections and the commit they live at>

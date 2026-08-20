// Load, normalize and validate .wiki/containers.yaml.
//
// This is the half that MUST be custom: it reasons about the config itself
// (direction, DAG, overlaps, dangling refs). Import resolution — the part that
// actually reads code — is delegated to dependency-cruiser / import-linter,
// which already handle re-exports, barrels and dynamic imports.

import { readFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseYaml, YamlError } from './yaml.mjs';

export const CONFIG_PATH = join('.wiki', 'containers.yaml');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const INTRA = ['none', 'declared'];

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** True when `child` is inside `parent` (or equal). Segment-aware: src/ab is not under src/a. */
function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + '/');
}

export function findConfig(startDir = process.cwd()) {
  let dir = norm(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = posix.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadModel(configPath) {
  let raw;
  try {
    raw = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err instanceof YamlError) throw new ConfigError([`${configPath} ${err.message}`]);
    throw err;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError([`${configPath}: expected a mapping at the top level`]);
  }

  const problems = [];
  const warnings = [];

  if (raw.version !== 1) problems.push(`version must be 1 (got ${JSON.stringify(raw.version)})`);

  // ---- layers -------------------------------------------------------------
  const layers = [];
  const layerIndex = new Map();
  if (!Array.isArray(raw.layers) || raw.layers.length === 0) {
    problems.push('`layers` must be a non-empty list, ordered top-down');
  } else {
    raw.layers.forEach((entry, i) => {
      const l = typeof entry === 'string' ? { id: entry } : entry || {};
      if (!l.id) return problems.push(`layers[${i}]: missing \`id\``);
      if (layerIndex.has(l.id)) return problems.push(`duplicate layer \`${l.id}\``);
      const intra = l.intra_layer ?? 'none';
      if (!INTRA.includes(intra)) {
        problems.push(`layer \`${l.id}\`: intra_layer must be one of ${INTRA.join(' | ')}`);
      }
      layerIndex.set(l.id, i);
      layers.push({ id: l.id, index: i, intra_layer: intra, role: l.role ?? null });
    });
  }

  // ---- policy -------------------------------------------------------------
  const p = raw.policy || {};
  const policy = {
    root: norm(p.root ?? 'src'),
    skip_layers: p.skip_layers === true,
    public_surface: [].concat(p.public_surface ?? ['index.ts']).filter(Boolean).map(String),
    language: p.language ?? null,
    // Sub-paths inside a container that may not import anything outside
    // themselves. This is what keeps business rules separable from I/O
    // sequencing: without it, `orchestration/*` merges the application and
    // domain roles and you can no longer unit-test a rule without stubs.
    pure_paths: [].concat(p.pure_paths ?? []).filter(Boolean).map((s) => norm(s)),
  };
  for (const pure of policy.pure_paths) {
    if (pure.startsWith('/') || pure.includes('..')) {
      problems.push(`policy.pure_paths: \`${pure}\` must be a relative sub-path inside a container`);
    }
  }
  if (policy.public_surface.length === 0) problems.push('policy.public_surface must name at least one file');

  // ---- containers ---------------------------------------------------------
  const containers = [];
  const byId = new Map();
  const list = Array.isArray(raw.containers) ? raw.containers : [];
  if (list.length === 0) problems.push('`containers` must be a non-empty list');

  list.forEach((entry, i) => {
    const c = entry || {};
    if (!c.id) return problems.push(`containers[${i}]: missing \`id\``);
    if (byId.has(c.id)) return problems.push(`duplicate container \`${c.id}\``);
    if (!c.path) return problems.push(`container \`${c.id}\`: missing \`path\``);

    const parts = String(c.id).split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      problems.push(`container \`${c.id}\`: id must be \`<layer>/<name>\``);
    } else if (layerIndex.size && !layerIndex.has(parts[0])) {
      problems.push(`container \`${c.id}\`: unknown layer \`${parts[0]}\``);
    }

    const path = norm(c.path);
    if (!isUnder(path, policy.root)) {
      problems.push(`container \`${c.id}\`: path \`${path}\` is outside policy.root \`${policy.root}\``);
    }

    // Python module names cannot contain hyphens. A generated contract naming
    // `myapp.user.http-api` matches nothing, so import-linter would report a
    // clean run over rules that can never fire — a silent false negative.
    if (policy.language === 'python' && /-/.test(path)) {
      problems.push(`container \`${c.id}\`: path \`${path}\` contains a hyphen, which is not a legal Python module name — use underscores`);
    }

    const shared = c.shared === true;
    const slice = c.slice == null ? null : String(c.slice);
    if (shared && slice) {
      problems.push(`container \`${c.id}\`: cannot be both \`shared\` and in slice \`${slice}\``);
    }

    let agent = null;
    if (c.agent != null) {
      if (typeof c.agent !== 'object' || Array.isArray(c.agent)) {
        problems.push(`container \`${c.id}\`: \`agent\` must be a mapping`);
      } else {
        const unknown = Object.keys(c.agent).filter((k) => !['model', 'effort', 'notes'].includes(k));
        if (unknown.length) {
          problems.push(`container \`${c.id}\`: unknown agent key(s) ${unknown.join(', ')} — expected model / effort / notes`);
        }
        if (c.agent.effort != null && !EFFORTS.includes(c.agent.effort)) {
          problems.push(`container \`${c.id}\`: agent.effort must be one of ${EFFORTS.join(' | ')}`);
        }
        agent = { model: c.agent.model ?? null, effort: c.agent.effort ?? null, notes: c.agent.notes ?? null };
      }
    }

    const consumes = c.consumes == null ? [] : [].concat(c.consumes).map(String);
    const container = {
      id: c.id, path, layer: parts[0], slice, shared, agent, consumes,
      owns: c.owns ?? null,
      surface: policy.public_surface.map((f) => `${path}/${f}`),
    };
    byId.set(c.id, container);
    containers.push(container);
  });

  // ---- path overlap -------------------------------------------------------
  for (let i = 0; i < containers.length; i++) {
    for (let j = i + 1; j < containers.length; j++) {
      const [a, b] = [containers[i], containers[j]];
      if (isUnder(a.path, b.path) || isUnder(b.path, a.path)) {
        problems.push(`containers \`${a.id}\` and \`${b.id}\` have overlapping paths (\`${a.path}\` / \`${b.path}\`) — a file must resolve to exactly one container`);
      }
    }
  }

  // ---- edges: existence, direction, skipping, intra-layer ------------------
  for (const c of containers) {
    for (const target of c.consumes) {
      const t = byId.get(target);
      if (!t) {
        problems.push(`container \`${c.id}\`: consumes unknown container \`${target}\``);
        continue;
      }
      if (t.id === c.id) {
        problems.push(`container \`${c.id}\`: consumes itself`);
        continue;
      }
      const from = layerIndex.get(c.layer);
      const to = layerIndex.get(t.layer);
      if (from == null || to == null) continue;
      const delta = to - from;
      if (delta < 0) {
        problems.push(`container \`${c.id}\` -> \`${t.id}\`: upward dependency (${c.layer} may not consume ${t.layer})`);
      } else if (delta === 0) {
        const layer = layers[from];
        if (layer.intra_layer !== 'declared') {
          problems.push(`container \`${c.id}\` -> \`${t.id}\`: layer \`${layer.id}\` sets intra_layer: none, so containers in it may not call each other`);
        }
      } else if (delta > 1 && !policy.skip_layers) {
        problems.push(`container \`${c.id}\` -> \`${t.id}\`: skips ${delta - 1} layer(s) and policy.skip_layers is false`);
      }
    }
  }

  // ---- the graph must be a DAG -------------------------------------------
  // A cycle is fatal specifically for parallel dispatch: neither container can
  // be handed to an agent without the other's contract already existing.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(containers.map((c) => [c.id, WHITE]));
  const stack = [];
  const reported = new Set();
  const visit = (id) => {
    color.set(id, GREY);
    stack.push(id);
    for (const target of byId.get(id)?.consumes ?? []) {
      if (!byId.has(target)) continue;
      const state = color.get(target);
      if (state === GREY) {
        const cycle = stack.slice(stack.indexOf(target)).concat(target);
        const key = [...cycle].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          problems.push(`dependency cycle: ${cycle.join(' -> ')} — break it with an event, a callback, or a shared third container`);
        }
      } else if (state === WHITE) {
        visit(target);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const c of containers) if (color.get(c.id) === WHITE) visit(c.id);

  // ---- slice alignment (advisory) -----------------------------------------
  const slices = new Map();
  for (const c of containers) {
    if (!c.slice) continue;
    if (!slices.has(c.slice)) slices.set(c.slice, []);
    slices.get(c.slice).push(c);
  }
  // A one-member slice is legal and common (a capability with no engine
  // partner), so it is not worth a warning — noisy advisories get ignored, and
  // an ignored validator is worse than a quiet one.
  const unassigned = containers.filter((c) => !c.slice && !c.shared && c.layer !== layers[0]?.id);
  for (const c of unassigned) {
    warnings.push(`container \`${c.id}\` has no \`slice\` and is not \`shared\` — it cannot be reached by slice dispatch`);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    configPath, layers, layerIndex, policy, containers, byId,
    slices, warnings,
    /** Containers this one may legally import from. */
    allowed(id) {
      const c = byId.get(id);
      return c ? c.consumes.map((t) => byId.get(t)).filter(Boolean) : [];
    },
    /** Which container owns a repo-relative file path, or null. */
    locate(filePath) {
      const f = norm(filePath);
      return containers.find((c) => isUnder(f, c.path)) ?? null;
    },
    sliceGlob(name) {
      const members = slices.get(name) ?? [];
      return members.map((c) => `${c.path}/**`);
    },
  };
}

export { norm, isUnder };

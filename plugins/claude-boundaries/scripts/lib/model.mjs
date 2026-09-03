// Load, normalise and validate the container map.
//
// This is the half that reasons about the *config* — direction, DAG, overlaps,
// dangling refs — as opposed to rules.mjs, which reasons about the *code*. A
// cyclic or incoherent map is rejected here, before a single file is scanned,
// because a validator that runs over a broken map reports a meaningless pass.
//
// The schema is a strict superset of claude-architect's `.wiki/containers.yaml`:
// every key that plugin understands means the same thing here, and the keys
// added below sit in places its loader ignores. One file can serve both.

import { readFileSync, existsSync } from 'node:fs';
import { join, posix, resolve as resolvePath, dirname, relative } from 'node:path';
import { parseYaml, YamlError } from './yaml.mjs';

/** Config locations, in search order. The first is claude-architect's. */
export const CONFIG_PATHS = [
  join('.wiki', 'containers.yaml'),
  join('.claude', 'boundaries.yaml'),
  'boundaries.yaml',
];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const INTRA = ['none', 'declared'];
const TOPOLOGIES = ['folders', 'packages'];
const TYPE_IMPORTS = ['edge', 'ignore'];
const UNRESOLVED = ['warn', 'error'];

const EXT_BY_LANGUAGE = {
  typescript: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
  python: ['.py', '.pyi'],
};

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** True when `child` is inside `parent` (or equal). Segment-aware: src/ab is not under src/a. */
export function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + '/');
}

/** Compile a `**`/`*`/`?` glob into an anchored regex over a `/`-separated path. */
export function globToRegExp(glob) {
  let out = '';
  const g = norm(glob);
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        // `**/` may match zero segments, so `**/*.test.*` also matches a
        // top-level `x.test.ts`. Without this a root-level test file is
        // silently non-exempt.
        if (g[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { out += '[^/]'; continue; }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function findConfig(startDir = process.cwd()) {
  let dir = norm(resolvePath(startDir));
  for (;;) {
    for (const rel of CONFIG_PATHS) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = posix.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `external:` says which bare (third-party) specifiers a container may import.
 *   none        nothing at all — the "this layer depends on nothing" rule
 *   any         unrestricted (the default; connectors exist to wrap an SDK)
 *   [a, b]      exactly these package names, subpaths included
 */
function parseExternal(value, where, problems) {
  if (value == null) return null;
  if (value === 'any' || value === 'none') return value;
  if (Array.isArray(value)) return value.map(String);
  problems.push(`${where}: \`external\` must be \`none\`, \`any\`, or a list of package names`);
  return null;
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
  // The map sits at `<root>/.wiki/containers.yaml` or `<root>/boundaries.yaml`;
  // either way the repo root is the directory holding the containing folder.
  // Resolve first: `configPath` may arrive relative, and a suffix test against
  // an unresolved path silently picks the wrong root.
  const absConfig = norm(resolvePath(configPath));
  const nested = CONFIG_PATHS.map(norm).some((c) => c.includes('/') && absConfig.endsWith(`/${c}`));
  const root = norm(nested ? dirname(dirname(absConfig)) : dirname(absConfig));

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
      layers.push({
        id: l.id,
        index: i,
        intra_layer: intra,
        role: l.role ?? null,
        external: parseExternal(l.external, `layer \`${l.id}\``, problems) ?? 'any',
      });
    });
  }

  // ---- policy -------------------------------------------------------------
  const p = raw.policy || {};
  const topology = p.topology ?? 'folders';
  if (!TOPOLOGIES.includes(topology)) {
    problems.push(`policy.topology must be one of ${TOPOLOGIES.join(' | ')} (got ${JSON.stringify(topology)})`);
  }
  const language = p.language ?? 'typescript';
  const policy = {
    topology,
    root: norm(p.root ?? 'src'),
    package_roots: [].concat(p.package_roots ?? ['packages/*', 'apps/*']).filter(Boolean).map(norm),
    skip_layers: p.skip_layers === true,
    public_surface: [].concat(p.public_surface ?? ['index.ts']).filter(Boolean).map(String),
    pure_paths: [].concat(p.pure_paths ?? []).filter(Boolean).map((s) => norm(s)),
    language,
    type_imports: p.type_imports ?? 'edge',
    test_exempt: [].concat(p.test_exempt ?? ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test_*.py'])
      .filter(Boolean).map(String),
    unresolved: p.unresolved ?? 'warn',
    // Source that belongs to no container. Fail-closed by default under
    // `packages`, where an unclassified package is also an unclassified import
    // *target* and can be used to launder an edge; advisory under `folders`,
    // where partial adoption of the map is normal and erroring on every
    // unmapped file would make the check unusable on day one.
    unclassified: p.unclassified ?? (topology === 'packages' ? 'error' : 'warn'),
    // Whether a relative import may leave its own container. Under `packages`
    // it must not — that is exactly how a package.json dependency graph gets
    // bypassed. Under `folders` a cross-container import is ordinarily
    // relative, so forbidding it would ban legal code.
    relative_escape: p.relative_escape ?? (topology === 'packages' ? 'forbid' : 'allow'),
    extensions: EXT_BY_LANGUAGE[language] ?? EXT_BY_LANGUAGE.typescript,
  };
  if (!TYPE_IMPORTS.includes(policy.type_imports)) {
    problems.push(`policy.type_imports must be one of ${TYPE_IMPORTS.join(' | ')}`);
  }
  if (!UNRESOLVED.includes(policy.unresolved)) {
    problems.push(`policy.unresolved must be one of ${UNRESOLVED.join(' | ')}`);
  }
  if (!['error', 'warn', 'ignore'].includes(policy.unclassified)) {
    problems.push('policy.unclassified must be one of error | warn | ignore');
  }
  if (!['allow', 'forbid'].includes(policy.relative_escape)) {
    problems.push('policy.relative_escape must be one of allow | forbid');
  }
  if (!EXT_BY_LANGUAGE[language]) {
    problems.push(`policy.language must be one of ${Object.keys(EXT_BY_LANGUAGE).join(' | ')} (got ${JSON.stringify(language)})`);
  }
  for (const pure of policy.pure_paths) {
    if (pure.startsWith('/') || pure.includes('..')) {
      problems.push(`policy.pure_paths: \`${pure}\` must be a relative sub-path inside a container`);
    }
  }
  if (policy.public_surface.length === 0) problems.push('policy.public_surface must name at least one file');
  const testExemptRes = policy.test_exempt.map(globToRegExp);

  // ---- containers ---------------------------------------------------------
  const containers = [];
  const byId = new Map();
  const byPackage = new Map();
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
    // In `packages` topology a container is a workspace package and lives
    // wherever the workspace puts it — `policy.root` does not apply.
    if (topology === 'folders' && !isUnder(path, policy.root)) {
      problems.push(`container \`${c.id}\`: path \`${path}\` is outside policy.root \`${policy.root}\``);
    }

    // Python module names cannot contain hyphens. A generated contract naming
    // `myapp.surface.http-api` matches nothing, so import-linter would report a
    // clean run over rules that can never fire — a silent false negative.
    if (language === 'python' && /-/.test(path)) {
      problems.push(`container \`${c.id}\`: path \`${path}\` contains a hyphen, which is not a legal Python module name — use underscores`);
    }

    // In `packages` topology every container needs the name other packages
    // import it by. Read it off the package manifest when the map is silent —
    // duplicating it in both files is how the two drift apart.
    let pkgName = c.package == null ? null : String(c.package);
    if (topology === 'packages' && !pkgName) {
      const manifest = join(root, path, 'package.json');
      if (existsSync(manifest)) {
        try { pkgName = JSON.parse(readFileSync(manifest, 'utf8')).name ?? null; } catch { pkgName = null; }
      }
      if (!pkgName) {
        problems.push(`container \`${c.id}\`: topology is \`packages\` but no package name — add \`package:\` or a readable ${path}/package.json`);
      }
    }
    if (pkgName && byPackage.has(pkgName)) {
      problems.push(`containers \`${byPackage.get(pkgName).id}\` and \`${c.id}\` both claim package \`${pkgName}\``);
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
      package: pkgName,
      external: parseExternal(c.external, `container \`${c.id}\``, problems),
      owns: c.owns ?? null,
      surface: policy.public_surface.map((f) => `${path}/${f}`),
    };
    byId.set(c.id, container);
    if (pkgName) byPackage.set(pkgName, container);
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
  // A cycle is survivable for a human team and fatal for parallel agents: if
  // both directions are legal, neither container can be handed to an agent
  // without the other's contract already existing, and both will invent one.
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

  // ---- slices (advisory) --------------------------------------------------
  const slices = new Map();
  for (const c of containers) {
    if (!c.slice) continue;
    if (!slices.has(c.slice)) slices.set(c.slice, []);
    slices.get(c.slice).push(c);
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    // Displayed in every violation message, so keep it repo-relative.
    configPath: norm(relative(root, absConfig)), configAbs: absConfig, root, layers, layerIndex, policy, containers, byId, byPackage,
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

    /** The `pure_paths` sub-path a file sits under, or null. */
    pureRoot(filePath) {
      const f = norm(filePath);
      const c = this.locate(f);
      if (!c) return null;
      const hit = policy.pure_paths.find((pure) => isUnder(f, `${c.path}/${pure}`));
      return hit ? `${c.path}/${hit}` : null;
    },

    /** The effective third-party rule for a container: its own, else its layer's. */
    externalPolicy(container) {
      if (container.external != null) return container.external;
      return layers[layerIndex.get(container.layer)]?.external ?? 'any';
    },

    isTestFile(filePath) {
      const f = norm(filePath);
      return testExemptRes.some((re) => re.test(f));
    },

    sliceGlob(name) {
      return (slices.get(name) ?? []).map((c) => `${c.path}/**`);
    },
  };
}

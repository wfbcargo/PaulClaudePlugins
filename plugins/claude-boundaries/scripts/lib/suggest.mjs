// Propose a starter container map by reading the tree.
//
// This is deliberately a *proposal*, printed rather than written. Naming the
// layers and deciding which capability a folder owns is a judgement about the
// architecture, and a map generated from whatever shape the code has today
// would only re-describe the mess it is meant to constrain. What a machine can
// do usefully is the inventory: what the units are, what they already import,
// and which of those edges would be illegal under a plausible layer order.
//
// `/boundaries:init` takes this output and works through it with the user.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { norm } from './model.mjs';

const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '__pycache__', '.venv', 'venv']);
const LAYER_HINTS = [
  [/^(api|http|rest|graphql|routes?|controllers?|handlers?|cli|cmd|web|ui|jobs?|workers?|consumers?)$/i, 'surface'],
  [/^(services?|usecases?|application|core|domain|features?|modules?)$/i, 'orchestration'],
  [/^(db|database|repositories|repos?|store|storage|clients?|adapters?|infra|infrastructure|gateways?|connectors?|integrations?)$/i, 'engine'],
];

const dirs = (root, rel) => {
  try {
    return readdirSync(join(root, rel), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => (rel ? `${rel}/${e.name}` : e.name));
  } catch { return []; }
};

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function guessLayer(path) {
  const segments = norm(path).split('/');
  for (const seg of segments) {
    for (const [re, layer] of LAYER_HINTS) if (re.test(seg)) return layer;
  }
  return null;
}

export function suggest(root) {
  const out = [];
  const workspaceDirs = [];
  for (const glob of ['packages', 'apps', 'libs', 'services']) {
    for (const d of dirs(root, glob)) {
      if (existsSync(join(root, d, 'package.json'))) workspaceDirs.push(d);
      else workspaceDirs.push(...dirs(root, d).filter((n) => existsSync(join(root, n, 'package.json'))));
    }
  }

  if (workspaceDirs.length >= 2) {
    out.push('# Proposed container map — topology: packages');
    out.push('#');
    out.push('# This repo looks like a workspace, so each package is a container. Review every');
    out.push('# line: the layer order below is a guess from directory names, and the `consumes`');
    out.push('# lists are what the code imports TODAY, not what it should be allowed to.');
    out.push('# Deleting an edge here is how you decide the architecture rather than record it.');
    out.push('');
    out.push('version: 1');
    out.push('');
    out.push('layers:');
    out.push('  - id: core          # depends on nothing');
    out.push('    external: none');
    out.push('    intra_layer: none');
    out.push('  - id: contracts     # shared interfaces');
    out.push('    intra_layer: none');
    out.push('  - id: engine        # talks to the outside world');
    out.push('    intra_layer: none');
    out.push('  - id: app           # composition roots');
    out.push('    intra_layer: none');
    out.push('');
    out.push('policy:');
    out.push('  topology: packages');
    out.push(`  package_roots: [${[...new Set(workspaceDirs.map((d) => `${d.split('/').slice(0, -1).join('/') || d.split('/')[0]}/*`))].join(', ')}]`);
    out.push('  public_surface: [src/index.ts]');
    out.push('  language: typescript');
    out.push('');
    out.push('containers:');
    for (const dir of workspaceDirs) {
      const pkg = readJson(join(root, dir, 'package.json'));
      const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.peerDependencies });
      const internal = deps.filter((d) => workspaceDirs.some((w) => readJson(join(root, w, 'package.json'))?.name === d));
      out.push(`  - id: ${guessLayer(dir) ?? 'engine'}/${dir.split('/').pop()}`);
      out.push(`    path: ${dir}`);
      if (pkg?.name) out.push(`    package: "${pkg.name}"`);
      out.push(`    owns: TODO — one business capability, in one sentence.`);
      out.push('    consumes:' + (internal.length ? '' : ' []'));
      for (const d of internal) {
        const w = workspaceDirs.find((x) => readJson(join(root, x, 'package.json'))?.name === d);
        out.push(`      - ${guessLayer(w) ?? 'engine'}/${w.split('/').pop()}   # currently imported`);
      }
    }
    return out.join('\n');
  }

  const srcRoot = ['src', 'lib', 'app'].find((d) => existsSync(join(root, d))) ?? 'src';
  const top = dirs(root, srcRoot);
  out.push('# Proposed container map — topology: folders');
  out.push('#');
  out.push(`# Found ${top.length} top-level folder(s) under ${srcRoot}/. Each is a candidate container.`);
  out.push('# A container is correctly sized when a typical change touches one or two; if most');
  out.push('# changes span three or more, they are too fine.');
  out.push('#');
  out.push('# Assign each to a layer, then write its `consumes` list by DECIDING what it may');
  out.push('# call — not by copying what it calls now.');
  out.push('');
  out.push('version: 1');
  out.push('');
  out.push('layers:');
  out.push('  - id: surface        # entry points: HTTP, CLI, queue consumers, cron');
  out.push('    intra_layer: none');
  out.push('  - id: orchestration  # business logic, grouped by capability');
  out.push('    intra_layer: declared');
  out.push('  - id: engine         # operations against 3rd-party systems');
  out.push('    intra_layer: none');
  out.push('');
  out.push('policy:');
  out.push('  topology: folders');
  out.push(`  root: ${srcRoot}`);
  out.push('  public_surface: [index.ts]');
  out.push('  pure_paths: [domain]');
  out.push('  language: typescript');
  out.push('');
  out.push('containers:');
  for (const d of top) {
    const nested = dirs(root, d);
    const layer = guessLayer(d);
    out.push(`  - id: ${layer ?? 'orchestration'}/${d.split('/').pop()}`);
    out.push(`    path: ${d}`);
    out.push('    owns: TODO — one business capability, in one sentence.');
    out.push('    consumes: []');
    if (!layer) out.push(`    # layer is a guess; ${nested.length} sub-folder(s) here — split if it owns more than one capability`);
  }
  return out.join('\n');
}

// The config is rejected before any file is scanned, because a check that runs
// over an incoherent map produces a meaningless verdict — usually a green one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cleanup, model, configProblems, FOLDER_MAP } from './helpers.mjs';

after(cleanup);

const has = (problems, needle) => {
  assert.ok(problems, 'expected the config to be rejected, but it loaded');
  assert.ok(problems.some((p) => p.includes(needle)),
    `no problem mentioned ${JSON.stringify(needle)}:\n${problems.join('\n')}`);
};

const withMap = (yaml) => makeRepo({ '.wiki/containers.yaml': yaml });

test('the baseline map loads', () => {
  const m = model(withMap(FOLDER_MAP));
  assert.equal(m.containers.length, 4);
  assert.equal(m.layers.length, 3);
  assert.equal(m.configPath, '.wiki/containers.yaml', 'the path is displayed repo-relative');
});

test('a cyclic graph is rejected', () => {
  // Fatal specifically for parallel agents: neither container can be dispatched
  // without the other's contract, so both invent one.
  has(configProblems(withMap(`
version: 1
layers:
  - id: orchestration
    intra_layer: declared
policy: { root: src }
containers:
  - id: orchestration/a
    path: src/a
    consumes: [orchestration/b]
  - id: orchestration/b
    path: src/b
    consumes: [orchestration/a]
`)), 'dependency cycle');
});

test('an upward declared edge is rejected in the config, not merely in the code', () => {
  has(configProblems(withMap(`
version: 1
layers:
  - id: surface
  - id: engine
policy: { root: src }
containers:
  - id: surface/api
    path: src/api
    consumes: []
  - id: engine/db
    path: src/db
    consumes: [surface/api]
`)), 'upward dependency');
});

test('overlapping container paths are rejected', () => {
  has(configProblems(withMap(`
version: 1
layers: [{ id: engine }]
policy: { root: src }
containers:
  - id: engine/a
    path: src/shared
    consumes: []
  - id: engine/b
    path: src/shared/nested
    consumes: []
`)), 'overlapping paths');
});

test('a dangling `consumes` reference is rejected', () => {
  has(configProblems(withMap(`
version: 1
layers: [{ id: engine }]
policy: { root: src }
containers:
  - id: engine/a
    path: src/a
    consumes: [engine/nope]
`)), 'unknown container');
});

test('an intra-layer edge needs the layer to allow it', () => {
  has(configProblems(withMap(`
version: 1
layers:
  - id: engine
    intra_layer: none
policy: { root: src }
containers:
  - id: engine/a
    path: src/a
    consumes: [engine/b]
  - id: engine/b
    path: src/b
    consumes: []
`)), 'intra_layer: none');
});

test('a container path outside policy.root is rejected under `folders`', () => {
  has(configProblems(withMap(`
version: 1
layers: [{ id: engine }]
policy: { root: src }
containers:
  - id: engine/a
    path: lib/a
    consumes: []
`)), 'outside policy.root');
});

test('a hyphenated path is rejected for Python, where it can never match', () => {
  // import-linter contracts name modules; `myapp.http-api` matches nothing, so
  // the rules would pass over code they can never see.
  has(configProblems(withMap(`
version: 1
layers: [{ id: engine }]
policy:
  root: src
  language: python
containers:
  - id: engine/http-api
    path: src/http-api
    consumes: []
`)), 'not a legal Python module name');
});

test('an unknown enum value is rejected rather than silently defaulted', () => {
  has(configProblems(withMap(FOLDER_MAP.replace('topology: folders', 'topology: monorepo'))), 'policy.topology');
  has(configProblems(withMap(FOLDER_MAP.replace('  language: typescript', '  language: rust'))), 'policy.language');
  has(configProblems(withMap(`
version: 1
layers:
  - id: engine
    external: sometimes
policy: { root: src }
containers:
  - id: engine/a
    path: src/a
    consumes: []
`)), '`external` must be');
});

test('a version other than 1 is rejected', () => {
  has(configProblems(withMap(FOLDER_MAP.replace('version: 1', 'version: 2'))), 'version must be 1');
});

test('policy defaults follow the topology', () => {
  const folders = model(withMap(FOLDER_MAP));
  assert.equal(folders.policy.unclassified, 'warn');
  assert.equal(folders.policy.relative_escape, 'allow',
    'cross-container imports under `folders` are ordinarily relative');

  const packages = model(makeRepo({
    '.wiki/containers.yaml': `
version: 1
layers: [{ id: core }]
policy: { topology: packages }
containers:
  - id: core/a
    path: packages/a
    package: "@x/a"
    consumes: []
`,
  }));
  assert.equal(packages.policy.unclassified, 'error',
    'an unclassified package is also an unclassified import target');
  assert.equal(packages.policy.relative_escape, 'forbid');
});

test('the package name is read off package.json when the map is silent', () => {
  const m = model(makeRepo({
    '.wiki/containers.yaml': `
version: 1
layers: [{ id: core }]
policy: { topology: packages }
containers:
  - id: core/a
    path: packages/a
    consumes: []
`,
    'packages/a/package.json': '{ "name": "@x/inferred" }',
  }));
  assert.equal(m.byId.get('core/a').package, '@x/inferred');
});

test('a packages container with no discoverable name is rejected', () => {
  has(configProblems(withMap(`
version: 1
layers: [{ id: core }]
policy: { topology: packages }
containers:
  - id: core/a
    path: packages/a
    consumes: []
`)), 'no package name');
});

test('claude-architect\'s own template still loads unchanged', () => {
  // The schema is advertised as a superset. If a map written for that plugin
  // stops loading here, one file can no longer serve both and the promise in
  // the README is false.
  const m = model(withMap(`
version: 1
layers:
  - id: surface
    intra_layer: none
    role: Entry points.
  - id: orchestration
    intra_layer: declared
    role: Business logic.
  - id: engine
    intra_layer: none
    role: Third-party systems.
policy:
  root: src
  skip_layers: false
  public_surface: [index.ts]
  language: typescript
  pure_paths: [domain]
containers:
  - id: surface/http-api
    path: src/surface/http-api
    slice: null
    owns: REST surface.
    consumes: [orchestration/auth]
  - id: orchestration/auth
    path: src/orchestration/auth
    slice: auth
    owns: Session lifecycle.
    consumes: [engine/identity-db]
    agent:
      effort: high
      notes: Invariant-dense.
  - id: engine/identity-db
    path: src/engine/identity-db
    shared: true
    owns: Identity CRUD.
    consumes: []
    agent:
      effort: low
`));
  assert.equal(m.containers.length, 3);
  assert.equal(m.byId.get('orchestration/auth').agent.effort, 'high');
  assert.equal(m.byId.get('engine/identity-db').shared, true);
  assert.equal(m.policy.topology, 'folders', 'topology defaults to the model that plugin assumes');
});

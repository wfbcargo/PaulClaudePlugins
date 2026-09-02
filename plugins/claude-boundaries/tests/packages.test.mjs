// `packages` topology — a workspace where each container is an npm package.
//
// Every case here is one AgentNexus's hand-written `tools/check-boundaries.mjs`
// found the hard way and locked in its own test file. They are reproduced
// because each is an evasion that reads as clean: the check passes, and the
// architecture is broken anyway.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cleanup, checkRepo } from './helpers.mjs';

after(cleanup);

// Layers are ordered TOP-DOWN, so the composition root comes first and the
// zero-dependency package comes last — the reverse of how a dependency list
// reads. Getting this backwards makes every legal edge look upward.
const MAP = `
version: 1
layers:
  - id: app
    intra_layer: none
  - id: kernel
    intra_layer: none
    external: none
  - id: contracts
    intra_layer: none
  - id: core
    intra_layer: none
    external: none
policy:
  topology: packages
  package_roots: [packages/*, apps/*]
  public_surface: [src/index.ts]
  skip_layers: true
  language: typescript
containers:
  - id: core/core
    path: packages/core
    consumes: []
  - id: contracts/contracts
    path: packages/contracts
    consumes: [core/core]
  - id: kernel/kernel
    path: packages/kernel
    consumes: [core/core, contracts/contracts]
  - id: app/hub
    path: apps/hub
    consumes: [core/core, contracts/contracts, kernel/kernel]
`;

const pkg = (name, deps = {}) => JSON.stringify({ name, dependencies: deps }, null, 2);

const base = {
  '.wiki/containers.yaml': MAP,
  'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*', 'apps/*'] }),
  'packages/core/package.json': pkg('@x/core'),
  'packages/core/src/index.ts': 'export const id = 1;',
  'packages/contracts/package.json': pkg('@x/contracts', { '@x/core': 'workspace:*', zod: '^4' }),
  'packages/contracts/src/index.ts': 'import { id } from "@x/core";\nexport const schema = id;',
  'packages/kernel/package.json': pkg('@x/kernel', { '@x/core': 'workspace:*', '@x/contracts': 'workspace:*' }),
  'packages/kernel/src/index.ts': 'import { schema } from "@x/contracts";\nexport const kernel = schema;',
  'packages/kernel/src/internal.ts': 'export const helper = 1;',
  'apps/hub/package.json': pkg('@x/hub', { '@x/kernel': 'workspace:*' }),
  'apps/hub/src/index.ts': 'import { kernel } from "@x/kernel";\nexport const hub = kernel;',
};

const repo = (overrides) => checkRepo(makeRepo({ ...base, ...overrides }));

test('the baseline workspace is clean', () => {
  const r = repo({});
  assert.deepEqual(r.rules, []);
  assert.ok(r.scanned >= 5);
});

test('a workspace package name resolves to its container', () => {
  // The whole topology rests on this: without name -> directory resolution
  // every cross-package import would be external and no edge would ever be
  // checked. A green run under a broken resolver is the worst outcome here.
  assert.deepEqual(
    repo({ 'packages/core/src/index.ts': 'import { kernel } from "@x/kernel";\nexport const id = kernel;' }).rules,
    ['R1-direction'],
  );
});

test('R7 external — core takes no third-party import, whatever the manifest says', () => {
  // AgentNexus's finding: the manifest check alone missed a store under
  // devDependencies, which resolves, compiles and ships exactly like a runtime
  // dependency. So the import site is checked regardless of any manifest.
  assert.deepEqual(
    repo({
      'packages/core/package.json': JSON.stringify({ name: '@x/core', devDependencies: { 'better-sqlite3': '^9' } }),
      'packages/core/src/index.ts': 'import db from "better-sqlite3";\nexport const id = db;',
    }).rules,
    ['R7-external'],
    'a devDependency-backed import is still an import',
  );
  assert.deepEqual(
    repo({ 'packages/core/src/index.ts': 'import x from "undeclared-anywhere";\nexport const id = x;' }).rules,
    ['R7-external'],
    'an import declared in no dependency map at all is still an import',
  );
  assert.deepEqual(
    repo({ 'packages/core/src/index.ts': 'import { randomUUID } from "node:crypto";\nexport const id = randomUUID;' }).rules,
    [],
    'node: built-ins ship with the runtime',
  );
});

test('R8 manifest — a peerDependency on a forbidden package is caught', () => {
  const r = repo({
    'packages/kernel/package.json': JSON.stringify({
      name: '@x/kernel',
      dependencies: { '@x/core': 'workspace:*', '@x/contracts': 'workspace:*' },
      peerDependencies: { pg: '^8' },
    }),
  });
  assert.deepEqual(r.rules, ['R8-manifest']);
  assert.match(r.findings[0].message, /external: none/);
});

test('R8 manifest — a declared workspace dependency that the map does not allow is caught', () => {
  // The manifest and the map are two statements of the same fact. They may not
  // differ, even when no file has yet acted on the disagreement.
  const r = repo({
    'packages/contracts/package.json': pkg('@x/contracts', { '@x/core': 'workspace:*', '@x/kernel': 'workspace:*' }),
  });
  assert.deepEqual(r.rules, ['R8-manifest']);
  assert.match(r.findings[0].message, /not in its `consumes`/);
});

test('R8 manifest — devDependencies are deliberately not merged in', () => {
  // Every package in a workspace declares vitest and typescript; folding them
  // into this check would false-positive on all of them and the check would be
  // switched off. R7 answers the runtime question at the import site instead.
  assert.deepEqual(
    repo({
      'packages/kernel/package.json': JSON.stringify({
        name: '@x/kernel',
        dependencies: { '@x/core': 'workspace:*', '@x/contracts': 'workspace:*' },
        devDependencies: { vitest: '^4', typescript: '^5' },
      }),
    }).rules,
    [],
  );
});

test('R4 surface — a deep subpath import lands in the right container, not "unknown"', () => {
  // `@x/kernel/dist/internal.js` must resolve to the same container as
  // `@x/kernel`, or a subpath specifier evades the group check entirely.
  const r = repo({
    'apps/hub/src/index.ts': 'import { helper } from "@x/kernel/src/internal";\nexport const hub = helper;',
  });
  assert.deepEqual(r.rules, ['R4-surface']);
});

test('R6 escape — a relative import out of a package is caught under `packages`', () => {
  // This is the evasion that makes every manifest-level guarantee meaningless:
  // it bypasses the package.json dependency graph entirely.
  const r = repo({
    'apps/hub/src/index.ts': 'import { kernel } from "../../../packages/kernel/src/index";\nexport const hub = kernel;',
  });
  assert.deepEqual(r.rules, ['R6-escape']);
});

test('R6 escape — a relative import inside the same package is fine', () => {
  assert.deepEqual(
    repo({ 'packages/kernel/src/index.ts': 'import { helper } from "./internal";\nexport const kernel = helper;' }).rules,
    [],
  );
});

test('R0 — an unclassified workspace package fails closed', () => {
  // The dangerous half is not that it goes unscanned: it is that it becomes an
  // unclassified import *target*, so anything may import it with no edge to
  // check. A `packages/storage` nobody mapped, depended on by the kernel,
  // passes every other rule in the file.
  const r = repo({
    'packages/storage/package.json': pkg('@x/storage', { pg: '^8' }),
    'packages/storage/src/index.ts': 'import pg from "pg";\nexport const store = pg;',
  });
  assert.ok(r.rules.includes('R0-unclassified'));
  assert.match(r.findings.find((f) => f.rule === 'R0-unclassified').message, /not in the container map/);
});

test('R0 — importing an unclassified package is caught, not laundered through it', () => {
  // The edge rules have nothing to compare against here — there is no container
  // on the far end — so if the unclassified guard did not fire, this import
  // would be the way to reach anything at all from anywhere.
  const r = repo({
    'packages/storage/package.json': pkg('@x/storage'),
    'packages/storage/src/index.ts': 'export const store = 1;',
    'packages/core/src/index.ts': 'import { store } from "@x/storage";\nexport const id = store;',
  });
  assert.ok(r.rules.includes('R0-unclassified-target'));
});

test('R0 — the unclassified package is caught even when nothing imports it yet', () => {
  const r = repo({ 'packages/storage/package.json': pkg('@x/storage') });
  assert.ok(r.rules.includes('R0-unclassified'),
    'an unmapped package must not sit unnoticed until someone happens to import it');
});

test('files outside src/ and with non-.ts extensions are still scanned', () => {
  // A kernel file living outside `src/`, or written as `.mts`, is still a file
  // whose imports the check must see.
  assert.deepEqual(
    repo({ 'packages/kernel/tools/gen.mjs': 'import pg from "pg";\nexport const gen = pg;' }).rules,
    ['R7-external'],
  );
});

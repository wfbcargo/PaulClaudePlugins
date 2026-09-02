// Exit codes and the guards that stop a broken run from wearing a green tick.
//
// 0 clean, 1 violations, 2 misconfiguration. The third is the one that earns
// its keep: a check that scanned nothing has not passed, it has failed to run,
// and the two must never look the same from CI.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRepo, cleanup, FOLDER_MAP } from './helpers.mjs';

after(cleanup);

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'boundaries.mjs');

function run(cwd, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

const clean = () => makeRepo({
  '.wiki/containers.yaml': FOLDER_MAP,
  'src/user/api/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const routes = login;',
  'src/orchestration/auth/index.ts': 'export const login = 1;',
  'src/orchestration/billing/index.ts': 'export const charge = 1;',
  'src/engine/db/index.ts': 'export const find = 1;',
});

test('check exits 0 on a clean repo and 1 on a violating one', () => {
  const ok = run(clean(), ['check']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /no boundary violations/);
  assert.match(ok.out, /file\(s\) scanned/, 'the count is stated, so a zero-file pass is visible');

  const bad = run(makeRepo({
    '.wiki/containers.yaml': FOLDER_MAP,
    'src/user/api/index.ts': 'export const routes = 1;',
    'src/orchestration/auth/index.ts': 'export const login = 1;',
    'src/orchestration/billing/index.ts': 'export const charge = 1;',
    'src/engine/db/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const find = login;',
  }), ['check']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /R1-direction/);
});

test('a check that scans zero files exits 2, never 0', () => {
  // The map points somewhere the code is not — a misconfiguration wearing a
  // green tick, which is worse than a red one because nobody investigates it.
  const empty = makeRepo({
    '.wiki/containers.yaml': FOLDER_MAP,
    'lib/elsewhere/index.ts': 'export const x = 1;',
  });
  const r = run(empty, ['check']);
  assert.equal(r.code, 2);
  assert.match(r.out, /Scanned 0 source files/);
  assert.match(r.out, /Refusing to report a pass/);
});

test('an invalid map exits 2 with every problem, not just the first', () => {
  const r = run(makeRepo({
    '.wiki/containers.yaml': `
version: 1
layers: [{ id: engine }]
policy: { root: src }
containers:
  - id: engine/a
    path: src/a
    consumes: [engine/ghost]
  - id: engine/b
    path: src/a/nested
    consumes: []
`,
  }), ['validate']);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown container/);
  assert.match(r.out, /overlapping paths/);
});

test('no map at all exits 2 and says how to start one', () => {
  const r = run(makeRepo({ 'src/index.ts': 'export const x = 1;' }), ['check']);
  assert.equal(r.code, 2);
  assert.match(r.out, /No container map found/);
  assert.match(r.out, /boundaries:init/);
});

test('--json emits machine-readable findings and still exits 1', () => {
  const r = run(makeRepo({
    '.wiki/containers.yaml': FOLDER_MAP,
    'src/user/api/index.ts': 'export const routes = 1;',
    'src/orchestration/auth/index.ts': 'export const login = 1;',
    'src/orchestration/billing/index.ts': 'export const charge = 1;',
    'src/engine/db/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const find = login;',
  }), ['check', '--json']);
  assert.equal(r.code, 1);
  const payload = JSON.parse(r.out);
  assert.equal(payload.findings.length, 1);
  assert.equal(payload.findings[0].rule, 'R1-direction');
  assert.equal(payload.findings[0].from, 'engine/db');
  assert.equal(payload.findings[0].to, 'orchestration/auth');
});

test('where resolves a file to its container and reports an unmapped one', () => {
  const root = clean();
  const hit = run(root, ['where', 'src/orchestration/auth/index.ts']);
  assert.equal(hit.code, 0);
  assert.match(hit.out, /container: orchestration\/auth/);
  assert.match(hit.out, /consumes:  engine\/db/);

  const miss = run(root, ['where', 'src/nowhere/x.ts']);
  assert.equal(miss.code, 1, 'an unclassified file is a non-zero answer, not an error');
  assert.match(miss.out, /unclassified/);
});

test('scope prints a spawn block naming what the container may consume', () => {
  const r = run(clean(), ['scope', 'orchestration/auth']);
  assert.equal(r.code, 0);
  assert.match(r.out, /## YOUR SCOPE/);
  assert.match(r.out, /you own: src\/orchestration\/auth\/\*\*/);
  assert.match(r.out, /you consume \(read, never edit\): engine\/db/);
  assert.match(r.out, /propose it and stop/);
});

test('map and brief render without a map-specific crash', () => {
  const root = clean();
  assert.equal(run(root, ['map']).code, 0);
  const brief = run(root, ['brief']);
  assert.equal(brief.code, 0);
  assert.match(brief.out, /downward only/);
});

test('emit writes a dependency-cruiser config generated from the map', () => {
  const root = clean();
  const r = run(root, ['emit', 'dependency-cruiser']);
  assert.equal(r.code, 0);
  assert.match(r.out, /\.dependency-cruiser\.json/);
  const cfg = JSON.parse(execFileSync(process.execPath,
    ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', join(root, '.dependency-cruiser.json')],
    { encoding: 'utf8' }));
  assert.ok(cfg.forbidden.length > 0);
  assert.ok(cfg.forbidden.some((f) => f.name.includes('undeclared')));
});

test('an unknown command exits 2 rather than doing something arbitrary', () => {
  const r = run(clean(), ['destroy']);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown command/);
});

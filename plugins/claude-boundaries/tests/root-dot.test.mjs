// A map rooted at the repository itself: `policy.root: .`, with containers in
// root-level folders (a Next.js `app/`, `lib/`, `components/`). Before 0.1.1
// every container was rejected as "outside policy.root `.`", because `.` never
// prefixes `app/` the way `src` prefixes `src/app`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRepo, cleanup, configProblems, checkRepo } from './helpers.mjs';
import { isUnder } from '../scripts/lib/model.mjs';

after(cleanup);

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'boundaries.mjs');

function run(cwd, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

const rootMap = (root) => `
version: 1
layers:
  - id: surface
    intra_layer: none
  - id: ui
    intra_layer: none
  - id: engine
    intra_layer: none
policy:
  topology: folders
  root: ${root}
  skip_layers: true
  public_surface: [index.ts]
  language: typescript
containers:
  - id: surface/app
    path: app
    consumes: [ui/y, engine/x]
  - id: ui/y
    path: components/y
    consumes: [engine/x]
  - id: engine/x
    path: lib/x
    consumes: []
`;

const repo = (root, extra = {}) => makeRepo({
  '.wiki/containers.yaml': rootMap(root),
  'app/index.ts': 'import { Y } from "../components/y/index";\nimport { x } from "../lib/x/index";\nexport const page = [Y, x];',
  'components/y/index.ts': 'import { x } from "../../lib/x/index";\nexport const Y = x;',
  'lib/x/index.ts': 'export const x = 1;',
  // Hidden directories are never mapped source: build output and other
  // checkouts would otherwise be walked, and reported, from a root of `.`.
  '.next/server/chunk.ts': 'import { page } from "../../app/index";\nexport const c = page;',
  '.worktrees/other/lib/x/index.ts': 'import { page } from "../../../../app/index";\nexport const x = page;',
  ...extra,
});

test('isUnder treats `.` and `` as the repo root', () => {
  assert.ok(isUnder('app', '.'));
  assert.ok(isUnder('lib/x', ''));
  assert.ok(!isUnder('src/ab', 'src/a'), 'segment-aware matching is unchanged');
});

for (const root of ['.', './']) {
  test(`a map with policy.root \`${root}\` loads`, () => {
    assert.equal(configProblems(repo(root)), null);
  });
}

test('validate and check accept policy.root `.`', () => {
  const dir = repo('.');
  const v = run(dir, ['validate']);
  assert.equal(v.code, 0, v.out);
  const c = run(dir, ['check']);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /no boundary violations/);
  assert.match(c.out, /3 file\(s\) scanned/, 'exactly the three container files, nothing from .next or .worktrees');
});

test('a root of `.` still catches a violation, and flags root-level unmapped source', () => {
  const r = checkRepo(repo('.', {
    'lib/x/index.ts': 'import { Y } from "../../components/y/index";\nexport const x = Y;',
    'next.config.ts': 'export default {};',
  }));
  assert.ok(r.rules.includes('R1-direction'), r.rules.join(', '));
  const unmapped = r.warnings.filter((w) => w.rule === 'R0-unclassified').map((w) => w.file);
  assert.deepEqual(unmapped, ['next.config.ts'], 'hidden directories are not walked for unclassified files either');
});

test('where locates files under a repo-root map', () => {
  const w = run(repo('.'), ['where', 'components/y/index.ts']);
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /container: ui\/y/);
});

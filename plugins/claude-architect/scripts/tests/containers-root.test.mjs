// containers.mjs with a map rooted at the repository itself: `policy.root: .`
// and containers in root-level folders (`app/`, `lib/x`, `components/y`).
// Before 0.9.2 `validate` rejected every container as "outside policy.root `.`".
//
//   node --test "plugins/claude-architect/scripts/tests/*.test.mjs"
//
// The `check` case needs dependency-cruiser. Point CLAUDE_ARCHITECT_DEPCRUISE
// at a node_modules directory that has it installed, or the case is skipped.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isUnder } from '../containers/model.mjs';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'containers.mjs');
const roots = [];
after(() => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

const MAP = `
version: 1
layers:
  - id: surface
    intra_layer: none
  - id: ui
    intra_layer: none
  - id: engine
    intra_layer: none
policy:
  root: .
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

function repo(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'containers-root-'));
  roots.push(root);
  const files = {
    '.wiki/containers.yaml': MAP,
    'app/index.ts': 'import { Y } from "../components/y/index";\nimport { x } from "../lib/x/index";\nexport const page = [Y, x];\n',
    'components/y/index.ts': 'import { x } from "../../lib/x/index";\nexport const Y = x;\n',
    'lib/x/index.ts': 'export const x = 1;\n',
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body, 'utf8');
  }
  return root;
}

function run(cwd, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('isUnder treats `.` and `` as the repo root', () => {
  assert.ok(isUnder('app', '.'));
  assert.ok(isUnder('lib/x', ''));
  assert.ok(!isUnder('src/ab', 'src/a'), 'segment-aware matching is unchanged');
});

test('validate accepts policy.root `.`', () => {
  const v = run(repo(), ['validate']);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /3 containers/);
});

test('where locates a root-level file', () => {
  const w = run(repo(), ['where', 'components/y/index.ts']);
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /container: ui\/y/);
});

test('emit writes rules that match root-level paths', () => {
  const dir = repo();
  const e = run(dir, ['emit', 'dependency-cruiser']);
  assert.equal(e.code, 0, e.out);
  const body = readFileSync(join(dir, '.dependency-cruiser.generated.cjs'), 'utf8');
  const rules = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)).forbidden;
  const engine = rules.find((r) => r.name === 'boundary-engine-x');
  assert.ok(new RegExp(engine.from.path).test('lib/x/index.ts'));
  assert.ok(new RegExp(engine.to.path).test('components/y/index.ts'));
  assert.ok(!body.includes('^\\\\./'), 'no rule is anchored on a literal `./`');
});

test('emit import-linter refuses a repo-root map instead of naming `.` the root package', () => {
  const r = run(repo(), ['emit', 'import-linter']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Python package directory/);
});

const depcruise = process.env.CLAUDE_ARCHITECT_DEPCRUISE;
test('check runs dependency-cruiser over the container paths and catches a violation',
  { skip: depcruise ? false : 'set CLAUDE_ARCHITECT_DEPCRUISE to a node_modules with dependency-cruiser' }, () => {
    const link = (dir) => symlinkSync(depcruise, join(dir, 'node_modules'), 'junction');

    const ok = repo();
    link(ok);
    assert.equal(run(ok, ['emit', 'dependency-cruiser']).code, 0);
    const clean = run(ok, ['check']);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /no boundary violations/);

    const bad = repo({ 'lib/x/index.ts': 'import { Y } from "../../components/y/index";\nexport const x = Y;\n' });
    link(bad);
    assert.equal(run(bad, ['emit', 'dependency-cruiser']).code, 0);
    const v = run(bad, ['check']);
    assert.equal(v.code, 1, v.out);
    assert.match(v.out, /boundary-engine-x/);
  });

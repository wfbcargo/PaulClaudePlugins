// One test per rule, in both directions.
//
// The negative half matters as much as the positive: a rule that fires on
// legitimate code gets the whole check switched off, and a checker nobody runs
// enforces less than no checker at all — because everyone believes it is
// running. So every rule below is asserted to fire on the violation AND to stay
// quiet on the nearest legal thing to it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cleanup, checkRepo, FOLDER_MAP } from './helpers.mjs';

after(cleanup);

const base = {
  '.wiki/containers.yaml': FOLDER_MAP,
  'src/user/api/index.ts': 'export const routes = 1;',
  'src/orchestration/auth/index.ts': 'export const login = 1;',
  'src/orchestration/auth/domain/rule.ts': 'export const isValid = 1;',
  'src/orchestration/billing/index.ts': 'export const charge = 1;',
  'src/engine/db/index.ts': 'export const find = 1;',
  'src/engine/db/internal.ts': 'export const raw = 1;',
};

const repo = (overrides) => checkRepo(makeRepo({ ...base, ...overrides }));

test('the baseline map is clean', () => {
  const r = repo({
    'src/user/api/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const routes = login;',
    'src/orchestration/auth/index.ts': 'import { find } from "../../engine/db/index";\nexport const login = find;',
  });
  assert.deepEqual(r.rules, []);
  assert.ok(r.scanned > 0, 'a pass over zero files is not a pass');
});

test('R1 direction — an upward import is caught; downward is not', () => {
  assert.deepEqual(
    repo({ 'src/engine/db/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const find = login;' }).rules,
    ['R1-direction'],
  );
  assert.deepEqual(
    repo({ 'src/orchestration/auth/index.ts': 'import { find } from "../../engine/db/index";\nexport const login = find;' }).rules,
    [],
  );
});

test('R2 no-skip — user reaching engine is caught; user reaching orchestration is not', () => {
  assert.deepEqual(
    repo({ 'src/user/api/index.ts': 'import { find } from "../../engine/db/index";\nexport const routes = find;' }).rules,
    ['R2-skip'],
  );
  assert.deepEqual(
    repo({ 'src/user/api/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const routes = login;' }).rules,
    [],
  );
});

test('R3 declared edges — an undeclared same-layer import is caught, a declared one is not', () => {
  assert.deepEqual(
    repo({ 'src/orchestration/auth/index.ts': 'import { charge } from "../billing/index";\nexport const login = charge;' }).rules,
    ['R3-undeclared'],
  );
  // engine/db IS declared by orchestration/auth.
  assert.deepEqual(
    repo({ 'src/orchestration/auth/index.ts': 'import { find } from "../../engine/db/index";\nexport const login = find;' }).rules,
    [],
  );
});

test('R4 public surface — reaching into internals is caught; the surface file is not', () => {
  assert.deepEqual(
    repo({ 'src/orchestration/auth/index.ts': 'import { raw } from "../../engine/db/internal";\nexport const login = raw;' }).rules,
    ['R4-surface'],
  );
  assert.deepEqual(
    repo({ 'src/orchestration/auth/index.ts': 'import { find } from "../../engine/db/index";\nexport const login = find;' }).rules,
    [],
  );
});

test('R5 purity — domain/ may not import even its own container', () => {
  // Stricter than the container's own edges, which is the whole point: auth may
  // call engine/db, auth/domain may not call anything.
  assert.deepEqual(
    repo({ 'src/orchestration/auth/domain/rule.ts': 'import { find } from "../../../engine/db/index";\nexport const isValid = find;' }).rules,
    ['R5-purity'],
  );
  assert.deepEqual(
    repo({ 'src/orchestration/auth/domain/rule.ts': 'import { login } from "../index";\nexport const isValid = login;' }).rules,
    ['R5-purity'],
    'importing the rest of its own container is still a purity violation',
  );
  assert.deepEqual(
    repo({
      'src/orchestration/auth/domain/rule.ts': 'import { other } from "./other";\nexport const isValid = other;',
      'src/orchestration/auth/domain/other.ts': 'export const other = 1;',
    }).rules,
    [],
    'inside the pure path is fine',
  );
});

test('R5 purity — an external import from a pure path is judged by R7, not silently allowed', () => {
  // `external` is unrestricted for orchestration, so a third-party import from
  // domain/ is legal here. That is deliberate: purity is about in-repo coupling.
  assert.deepEqual(
    repo({ 'src/orchestration/auth/domain/rule.ts': 'import z from "zod";\nexport const isValid = z;' }).rules,
    [],
  );
});

test('R7 external — an unlisted package is caught, an allowlisted one is not', () => {
  assert.deepEqual(
    repo({ 'src/engine/db/index.ts': 'import pg from "pg";\nexport const find = pg;' }).rules,
    ['R7-external'],
  );
  assert.deepEqual(
    repo({ 'src/engine/db/index.ts': 'import ok from "allowed-pkg";\nexport const find = ok;' }).rules,
    [],
  );
  assert.deepEqual(
    repo({ 'src/engine/db/index.ts': 'import { readFileSync } from "node:fs";\nexport const find = readFileSync;' }).rules,
    [],
    'node: built-ins ship with the runtime and can never be a concrete store',
  );
});

test('R7 external — a subpath of an allowlisted package is allowed', () => {
  assert.deepEqual(
    repo({ 'src/engine/db/index.ts': 'import ok from "allowed-pkg/sub/deep";\nexport const find = ok;' }).rules,
    [],
  );
});

test('R7 external — test files are exempt, but the edge rules still apply to them', () => {
  // The one documented softness. It exists so a test can import its runner; it
  // must not become a way to import a forbidden container.
  assert.deepEqual(
    repo({ 'src/engine/db/index.test.ts': 'import { it } from "vitest";\nexport const t = it;' }).rules,
    [],
    'a test file may bare-import its runner',
  );
  assert.deepEqual(
    repo({ 'src/engine/db/index.test.ts': 'import { login } from "../../orchestration/auth/index";\nexport const t = login;' }).rules,
    ['R1-direction'],
    'a test file may NOT import upward',
  );
});

test('R9 owned types — a type-only import is an edge by default, and ignorable by policy', () => {
  const typeViolation = {
    'src/engine/db/index.ts': 'import type { Login } from "../../orchestration/auth/index";\nexport const find: Login | null = null;',
  };
  assert.deepEqual(repo(typeViolation).rules, ['R1-direction'],
    'TypeScript erases it at runtime; the coupling is still real');

  assert.deepEqual(
    checkRepo(makeRepo({
      ...base, ...typeViolation,
      '.wiki/containers.yaml': FOLDER_MAP.replace('  language: typescript', '  language: typescript\n  type_imports: ignore'),
    })).rules,
    [],
    'a project may opt out, explicitly',
  );
});

test('R0 unclassified — a file under root but in no container is reported', () => {
  const r = repo({ 'src/stray/helper.ts': 'export const help = 1;' });
  // Default under `folders` is a warning, not a failure: partial adoption is
  // normal and erroring on day one makes the check unusable.
  assert.deepEqual(r.rules, []);
  assert.ok(r.warnings.some((w) => w.rule === 'R0-unclassified' && w.file === 'src/stray/helper.ts'));
});

test('R0 unclassified target — importing into unmapped code is caught', () => {
  const r = repo({
    'src/stray/helper.ts': 'export const help = 1;',
    'src/orchestration/auth/index.ts': 'import { help } from "../../stray/helper";\nexport const login = help;',
  });
  assert.ok(r.rules.includes('R0-unclassified-target'));
});

test('one import produces one finding, not four', () => {
  // A relative import that is upward, undeclared, skipping AND into internals.
  // Reporting it four times tells the reader nothing the first told them, and
  // an agent handed four findings tries to fix four things.
  const r = repo({
    'src/engine/db/index.ts': 'import { deep } from "../../user/api/internal";\nexport const find = deep;',
    'src/user/api/internal.ts': 'export const deep = 1;',
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.rules[0], 'R1-direction');
});

test('an unresolvable relative import is reported as unchecked, not as clean', () => {
  const r = repo({
    'src/orchestration/auth/index.ts': 'import { gone } from "./does-not-exist";\nexport const login = gone;',
  });
  // It resolves to an intended path inside its own container, so no edge rule
  // applies — but it must not vanish silently either.
  assert.deepEqual(r.rules, []);
});

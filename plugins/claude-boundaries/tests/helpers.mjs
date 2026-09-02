// Build a throwaway repo on disk from a `{ path: contents }` map, so a rule can
// be tested against real files and a real resolver rather than a mock. The
// resolver reads the filesystem — a fake one would test the fake.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadModel, ConfigError } from '../scripts/lib/model.mjs';
import { check, containerFiles } from '../scripts/lib/rules.mjs';

const roots = [];

export function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'boundaries-'));
  roots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return root;
}

export function cleanup() {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Load the map in a repo; returns the model or throws ConfigError. */
export function model(root, configRel = '.wiki/containers.yaml') {
  return loadModel(join(root, configRel));
}

/** The problem strings from a config that should not load. */
export function configProblems(root, configRel = '.wiki/containers.yaml') {
  try {
    loadModel(join(root, configRel));
    return null;
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

/** Run a full check over a repo and return the finding rules, in file order. */
export function checkRepo(root, configRel) {
  const m = model(root, configRel);
  const result = check(m, containerFiles(m));
  return {
    rules: result.findings.map((f) => f.rule),
    findings: result.findings,
    warnings: result.warnings,
    scanned: result.scanned,
    model: m,
  };
}

/** A three-layer folder map used by most rule tests. */
export const FOLDER_MAP = `
version: 1
layers:
  - id: user
    intra_layer: none
  - id: orchestration
    intra_layer: declared
  - id: engine
    intra_layer: none
    external: [allowed-pkg]
policy:
  topology: folders
  root: src
  public_surface: [index.ts]
  pure_paths: [domain]
  language: typescript
containers:
  - id: user/api
    path: src/user/api
    consumes:
      - orchestration/auth
  - id: orchestration/auth
    path: src/orchestration/auth
    consumes:
      - engine/db
  - id: orchestration/billing
    path: src/orchestration/billing
    consumes: []
  - id: engine/db
    path: src/engine/db
    consumes: []
`;

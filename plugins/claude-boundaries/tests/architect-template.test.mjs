// The claude-boundaries schema is a strict superset of claude-architect's
// container map: one file is meant to drive both plugins — architect dispatches
// the work, boundaries enforces the edges. This guards that promise by loading
// the sibling plugin's SHIPPED template through THIS checker's loader, which
// runs the full coherence pass (layer order, resolvable edges, acyclic graph)
// and throws ConfigError on any problem. If the two schemas ever drift, this
// test goes red before the claim in the docs does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadModel } from '../scripts/lib/model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHITECT_TEMPLATE = join(HERE, '..', '..', 'claude-architect', 'wiki-template', 'containers.yaml');

test("claude-architect's own container map validates under this checker (one file, two plugins)", () => {
  const model = loadModel(ARCHITECT_TEMPLATE); // throws ConfigError if invalid
  const ids = model.layers.map((l) => l.id);
  assert.ok(model.layers.length >= 1, 'has layers');
  assert.ok(ids.includes('surface'), 'shares the surface layer with the boundaries default');
  assert.ok(model.containers.length >= 1, 'has containers');
});

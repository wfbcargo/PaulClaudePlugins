// The scanner's job is to be un-fool-able. Every case below is one an agent or
// a code generator writes routinely, and getting any of them wrong is invisible
// in both directions: a missed import is a violation that passes, and a
// hallucinated one is correct code that gets blocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTs } from '../scripts/lib/scan-ts.mjs';
import { scanPy } from '../scripts/lib/scan-py.mjs';

const specs = (src) => scanTs(src).map((i) => i.specifier);

test('finds the ordinary forms', () => {
  assert.deepEqual(specs(`import { a } from "./a";`), ['./a']);
  assert.deepEqual(specs(`import a from './a';`), ['./a']);
  assert.deepEqual(specs(`import * as a from "./a";`), ['./a']);
  assert.deepEqual(specs(`import "./side-effect";`), ['./side-effect']);
  assert.deepEqual(specs(`import def, * as ns from "mixed";`), ['mixed']);
});

test('finds re-exports, dynamic imports and require', () => {
  assert.deepEqual(specs(`export * from "./re";`), ['./re']);
  assert.deepEqual(specs(`export { x } from "./re2";`), ['./re2']);
  assert.deepEqual(specs(`const m = await import("dyn");`), ['dyn']);
  assert.deepEqual(specs(`const r = require("req");`), ['req']);
});

test('spans a multi-line import statement', () => {
  // The single most common real-world shape, and the one a line-based regex
  // silently misses — which would make every violation inside a formatted
  // import list invisible.
  assert.deepEqual(specs('import {\n  a,\n  b as c,\n} from "../deep/b";'), ['../deep/b']);
});

test('records type-only imports as such', () => {
  const [imp] = scanTs(`import type { T } from "@scope/types";`);
  assert.equal(imp.specifier, '@scope/types');
  assert.equal(imp.typeOnly, true);
  assert.equal(scanTs(`import { T } from "@scope/types";`)[0].typeOnly, false);
});

test('is not fooled by comments', () => {
  assert.deepEqual(specs(`// import { x } from "commented";`), []);
  assert.deepEqual(specs(`/* import { x } from "blocked"; */`), []);
  assert.deepEqual(specs(`/**\n * import x from "docblock";\n */\nimport y from "real";`), ['real']);
});

test('is not fooled by string or template literals', () => {
  assert.deepEqual(specs(`const s = 'import x from "stringy"';`), []);
  assert.deepEqual(specs('const t = `import y from "templated"`;'), []);
  assert.deepEqual(specs('const t = `a ${ 1 + 2 } import z from "interp" b`;'), []);
  // A real import AFTER a template with interpolation: the scanner has to come
  // back out of the template correctly or it swallows the rest of the file.
  assert.deepEqual(specs('const t = `x ${ y } z`;\nimport a from "after";'), ['after']);
});

test('is not fooled by regex literals or apostrophes in comments', () => {
  assert.deepEqual(specs(`const re = /import x from "regexy"/;`), []);
  // An unbalanced apostrophe in a comment must not swallow the next line.
  assert.deepEqual(specs(`// it's a comment\nimport a from "after";`), ['after']);
  assert.deepEqual(specs(`const d = 10 / 2; const e = 4 / 2;\nimport a from "after";`), ['after']);
});

test('ignores import-like property access', () => {
  assert.deepEqual(specs(`obj.import = "not-an-import";`), []);
  assert.deepEqual(specs(`const o = { export: "no" };`), []);
});

test('an ASI-terminated statement does not claim the next one\'s specifier', () => {
  const found = scanTs('export const q = 1\nimport a from "real";');
  assert.deepEqual(found.map((f) => f.specifier), ['real']);
  assert.equal(found[0].kind, 'static');
});

test('reports the line the specifier is on', () => {
  const found = scanTs('const x = 1;\n\nimport a from "./a";');
  assert.equal(found[0].line, 3);
});

test('python: finds imports and ignores docstrings and comments', () => {
  const src = [
    '"""',
    'import os_in_docstring',
    '"""',
    '# import os_in_comment',
    'import os',
    'import a.b.c as abc',
    'from .sibling import thing',
    'from ..parent.mod import other',
    'from x.y import z',
    'import p, q',
  ].join('\n');
  assert.deepEqual(scanPy(src).map((i) => i.specifier).sort(),
    ['.sibling', '..parent.mod', 'a.b.c', 'os', 'p', 'q', 'x.y'].sort());
});

// Extract the module specifiers of a Python source file.
//
// Same contract and same discipline as scan-ts.mjs: blank every comment and
// string literal first (triple-quoted ones included, which is where a naive
// line-based scanner goes wrong — a docstring containing `import os` is not an
// import), then match import statements on what is left.
//
// Specifiers are returned in Python's own vocabulary: `os.path`, `.sibling`,
// `..parent.thing`. resolve.mjs turns them into repo paths.

/** @typedef {{ specifier: string, line: number, typeOnly: boolean, kind: string }} Import */

/**
 * Replace comments and string literals with spaces, preserving length and
 * newlines so offsets still map onto the original.
 */
export function blankNonCode(text) {
  const out = Array.from(text);
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch.repeat(3), i);
      const delim = triple ? ch.repeat(3) : ch;
      let j = i + delim.length;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text.startsWith(delim, j)) break;
        if (!triple && text[j] === '\n') break;
        j += 1;
      }
      blank(i, Math.min(j + delim.length, text.length));
      i = j + delim.length;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const MODULE = '[A-Za-z_][A-Za-z0-9_]*(?:\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*)*';

/**
 * @param {string} text
 * @returns {Import[]}
 */
export function scanPy(text) {
  const blanked = blankNonCode(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);

  /** @type {Import[]} */
  const found = [];
  const add = (specifier, offset, kind) => {
    const s = specifier.replace(/\s+/g, '');
    if (s) found.push({ specifier: s, line: lineAt(lineStarts, offset), typeOnly: false, kind });
  };

  // `from x.y import z`, `from . import z`, `from ..pkg import z`
  const fromRe = new RegExp(`(^|[\\n;])[ \\t]*from[ \\t]+(\\.*\\s*(?:${MODULE})?)[ \\t]+import\\b`, 'g');
  let m;
  while ((m = fromRe.exec(blanked)) !== null) add(m[2], m.index, 'from');

  // `import x.y`, `import x as z`, `import a, b`
  const importRe = new RegExp(`(^|[\\n;])[ \\t]*import[ \\t]+(${MODULE}(?:[ \\t]+as[ \\t]+[A-Za-z_][A-Za-z0-9_]*)?(?:[ \\t]*,[ \\t]*${MODULE}(?:[ \\t]+as[ \\t]+[A-Za-z_][A-Za-z0-9_]*)?)*)`, 'g');
  while ((m = importRe.exec(blanked)) !== null) {
    for (const part of m[2].split(',')) {
      add(part.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/, ''), m.index, 'import');
    }
  }

  found.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
  return found;
}

// Extract the module specifiers of a TypeScript / JavaScript source file.
//
// A regex over raw text is not good enough here, and the failure is specific: a
// specifier written inside a comment or a string is not an import, and an
// import written after an unterminated-looking `'` in a comment still is one. A
// checker that reports either wrongly is worse than no checker, because both
// directions are invisible — one blocks correct code, the other passes a
// violation.
//
// So this is a character scanner. It walks the source once, tracking whether it
// is inside a line comment, a block comment, a string, a template literal (with
// nested `${}` interpolation), or a regex literal, and produces a *blanked*
// copy of the text: every such region replaced by spaces of equal length, so
// offsets and line numbers still line up exactly with the original. Import
// forms are then matched on the blanked copy, where they can only be real code.
//
// When the target project has `typescript` installed, `scanWithTypeScript`
// gives the same shape from the real compiler API. The scanner below stays the
// tested default so the plugin works in a repo with nothing installed.

/**
 * @typedef {{ specifier: string, line: number, typeOnly: boolean, kind: string }} Import
 */

const QUOTES = new Set(['"', "'"]);

/**
 * Decide whether a `/` at index `i` starts a regex literal rather than
 * division. The standard heuristic: look back at the last significant
 * character. After a value (identifier, `)`, `]`, number) it is division;
 * otherwise it opens a regex.
 */
function regexAllowedAt(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  if (j < 0) return true;
  const ch = text[j];
  if (ch === ')' || ch === ']' || ch === '}') return false;
  if (/[A-Za-z0-9_$]/.test(ch)) {
    // A keyword may still be followed by a regex: `return /x/`, `typeof /x/`.
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k -= 1;
    const word = text.slice(k + 1, j + 1);
    return ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
            'case', 'do', 'else', 'yield', 'await'].includes(word);
  }
  return true;
}

/**
 * Replace every comment, string, template and regex literal with spaces,
 * preserving length and newlines so positions map 1:1 onto the original.
 * Exported for tests — this is the load-bearing half of the scanner.
 */
export function blankNonCode(text) {
  const out = Array.from(text);
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  let i = 0;
  // Template literals nest: `a${ `b` }c`. Track the brace depth at which each
  // open template sits so `}` returns to the right one.
  const templates = [];
  let braceDepth = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (QUOTES.has(ch)) {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote || text[j] === '\n') break;
        j += 1;
      }
      // Blank the contents but KEEP the quote characters: the import matchers
      // below need them to find the specifier's extent in the original text.
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      templates.push(braceDepth);
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '`') { templates.pop(); blank(i + 1, j); i = j + 1; break; }
        if (text[j] === '$' && text[j + 1] === '{') {
          blank(i + 1, j);
          i = j + 2;
          braceDepth += 1;
          break;
        }
        j += 1;
      }
      if (j >= text.length) { blank(i + 1, text.length); i = text.length; }
      continue;
    }
    if (ch === '{') { braceDepth += 1; i += 1; continue; }
    if (ch === '}') {
      braceDepth -= 1;
      // Closing an interpolation returns us to the enclosing template literal.
      if (templates.length && templates[templates.length - 1] === braceDepth) {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === '`') { templates.pop(); blank(i + 1, j); i = j + 1; break; }
          if (text[j] === '$' && text[j + 1] === '{') { blank(i + 1, j); i = j + 2; braceDepth += 1; break; }
          j += 1;
        }
        if (j >= text.length) { blank(i + 1, text.length); i = text.length; }
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && regexAllowedAt(text, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) { blank(i + 1, j); i = j + 1; continue; }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Line number (1-based) of a character offset. */
function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Walk forward from just after an `import` / `export` keyword and return the
 * offset of the specifier's opening quote, or -1.
 *
 * Imports routinely span lines (`import {\n  a,\n  b,\n} from 'x'`), so this
 * cannot be a single-line regex. It tracks bracket depth and stops at the first
 * `;` at depth 0, or at a line break that clearly begins a new statement —
 * which is what keeps an `export const x = 1` with no semicolon from reaching
 * forward and claiming the *next* statement's specifier.
 */
function findSpecifierQuote(blanked, from, isExport) {
  let depth = 0;
  let i = from;
  let sawFrom = false;

  // `import 'side-effect'` — the specifier is the first thing after the keyword.
  if (!isExport) {
    let j = i;
    while (j < blanked.length && /\s/.test(blanked[j])) j += 1;
    if (QUOTES.has(blanked[j])) return j;
  }

  while (i < blanked.length) {
    const ch = blanked[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; i += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; i += 1; continue; }
    if (ch === ';' && depth === 0) return -1;
    if (ch === '\n' && depth === 0) {
      // A new statement on the next line ends this one (ASI). `from` on its own
      // line is legal, so only bail when the next token starts a statement.
      const rest = blanked.slice(i + 1);
      const next = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest);
      if (next && ['import', 'export', 'const', 'let', 'var', 'function', 'class',
                   'return', 'async', 'interface', 'enum', 'declare'].includes(next[1])) {
        return -1;
      }
      i += 1;
      continue;
    }
    if (depth === 0 && !sawFrom && blanked.startsWith('from', i) &&
        !/[A-Za-z0-9_$]/.test(blanked[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(blanked[i + 4] ?? '')) {
      sawFrom = true;
      i += 4;
      continue;
    }
    if (sawFrom && QUOTES.has(ch)) return i;
    i += 1;
  }
  return -1;
}

/**
 * @param {string} text  file contents
 * @returns {Import[]}
 */
export function scanTs(text) {
  const blanked = blankNonCode(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);

  /** @type {Import[]} */
  const found = [];
  const seen = new Set();

  // The closing quote is located in the BLANKED text, where the string's
  // contents are spaces — so the next quote character is necessarily the
  // terminator and an escape sequence cannot mislead us. The specifier itself
  // is then sliced out of the original.
  const record = (quoteIdx, kind, typeOnly) => {
    if (quoteIdx < 0) return;
    const quote = blanked[quoteIdx];
    const end = blanked.indexOf(quote, quoteIdx + 1);
    if (end === -1) return;
    const specifier = text.slice(quoteIdx + 1, end);
    if (!specifier || seen.has(quoteIdx)) return;
    seen.add(quoteIdx);
    found.push({ specifier, line: lineAt(lineStarts, quoteIdx), typeOnly, kind });
  };

  // Statement-position `import` / `export` only, so a property access like
  // `x.import` or an object key named `export` cannot start a match.
  const stmt = /(^|[;{}()\n])[ \t]*(import|export)\b/g;
  let m;
  while ((m = stmt.exec(blanked)) !== null) {
    const keyword = m[2];
    const after = m.index + m[0].length;
    // `import(` here is a dynamic import in statement position — the dedicated
    // pattern below handles it, and treating it as static would misreport kind.
    if (/^\s*\(/.test(blanked.slice(after))) continue;
    const typeOnly = /^\s+type\b/.test(blanked.slice(after));
    record(findSpecifierQuote(blanked, after, keyword === 'export'),
           keyword === 'export' ? 'reexport' : 'static', typeOnly);
  }

  for (const [kind, re] of [['dynamic', /\bimport\s*\(\s*(['"])/g], ['require', /\brequire\s*\(\s*(['"])/g]]) {
    re.lastIndex = 0;
    while ((m = re.exec(blanked)) !== null) record(m.index + m[0].length - 1, kind, false);
  }

  found.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
  return found;
}

/**
 * Same output shape via the TypeScript compiler API, used when `typescript`
 * resolves from the project being checked. Returns null when it does not, so
 * the caller falls back to `scanTs`.
 * @param {string} text
 * @param {string} filePath
 * @param {any} ts  the `typescript` module
 * @returns {Import[]}
 */
export function scanWithTypeScript(text, filePath, ts) {
  const kindFor = (f) =>
    f.endsWith('.tsx') ? ts.ScriptKind.TSX
    : f.endsWith('.jsx') ? ts.ScriptKind.JSX
    : /\.(m|c)?js$/.test(f) ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;

  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kindFor(filePath));
  /** @type {Import[]} */
  const found = [];
  const push = (node, specifier, typeOnly, kind) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ specifier, line: line + 1, typeOnly, kind });
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = Boolean(node.importClause?.isTypeOnly || node.isTypeOnly);
      push(node, node.moduleSpecifier.text, typeOnly, ts.isExportDeclaration(node) ? 'reexport' : 'static');
    } else if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const req = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((dynamic || req) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        push(node, node.arguments[0].text, false, dynamic ? 'dynamic' : 'require');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

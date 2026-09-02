// Minimal YAML-subset parser for the container map.
//
// Node ships no YAML parser and this plugin must run in a repo with no
// dependencies installed, so we support exactly the subset the schema uses:
//
//   key: value            scalars (bare, 'single', "double", int, true/false, null)
//   key:                  nested block map or block sequence
//   - item                sequence of scalars
//   - key: value          sequence of maps (continuation lines align under the key)
//   key: [a, b]           inline flow sequence
//   key: { a: 1, b: 2 }   inline flow map (one level, scalar values only)
//   # comment             whole-line and trailing
//
// Anything outside that subset throws with a line number rather than being
// silently misread — a config that parses wrong is worse than one that fails.
// This is a vendored copy: claude-boundaries carries no runtime dependency on
// any other plugin, so the two parsers are allowed to diverge.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.\-\/]*):(?:\s+(.*))?$/;

function stripComment(raw) {
  let out = '';
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    // A '#' starts a comment only at line start or after whitespace, so a
    // value like `#internal/alias` survives.
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

/** Split on a delimiter at depth 0, respecting quotes and nested brackets. */
function splitTop(text, delim) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === delim && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function scalar(text, lineNo) {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError('unterminated flow sequence', lineNo);
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTop(inner, ',').map((p) => scalar(p, lineNo));
  }
  if (t.startsWith('{')) {
    // Flow maps are supported for one common case — `agent: { effort: low }` —
    // because rejecting it produces a baffling error in an otherwise valid file.
    if (!t.endsWith('}')) throw new YamlError('unterminated flow mapping', lineNo);
    const inner = t.slice(1, -1).trim();
    if (inner === '') return {};
    const out = {};
    for (const pair of splitTop(inner, ',')) {
      const idx = pair.indexOf(':');
      if (idx < 0) throw new YamlError(`flow mapping entry ${JSON.stringify(pair.trim())} is missing ":"`, lineNo);
      out[pair.slice(0, idx).trim().replace(/^["']|["']$/g, '')] = scalar(pair.slice(idx + 1), lineNo);
    }
    return out;
  }
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
      (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    return t.slice(1, -1);
  }
  return t;
}

function tokenize(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (/^\s*$/.test(raw)) return;
    const content = stripComment(raw);
    if (content.trim() === '') return;
    if (/^\t/.test(raw)) throw new YamlError('tabs are not valid indentation', idx + 1);
    lines.push({ indent: content.length - content.trimStart().length, text: content.trim(), no: idx + 1 });
  });
  return lines;
}

function parseNode(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  return lines[start].text.startsWith('- ') || lines[start].text === '-'
    ? parseSeq(lines, start, indent)
    : parseMap(lines, start, indent);
}

function parseMap(lines, start, indent) {
  const out = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.text.startsWith('- ')) break;
    const m = KEY_RE.exec(line.text);
    if (!m) throw new YamlError(`expected "key: value", got ${JSON.stringify(line.text)}`, line.no);
    const [, key, rest] = m;
    if (rest === undefined || rest === '') {
      const next = lines[i + 1];
      // A block child is either indented further, or a sequence at the same
      // indent (the common `key:` / `- item` layout).
      if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) {
        const [value, consumed] = parseNode(lines, i + 1, next.indent);
        out[key] = value;
        i = consumed;
      } else {
        out[key] = null;
        i += 1;
      }
    } else {
      out[key] = scalar(rest, line.no);
      i += 1;
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new YamlError(`unexpected indentation under ${JSON.stringify(lines[i].text)}`, lines[i].no);
  }
  return [out, i];
}

function parseSeq(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
    const line = lines[i];
    const rest = line.text.slice(2).trim();
    if (KEY_RE.test(rest)) {
      // Map item: re-present this line as the item's first key, indented to
      // where that key actually starts, then parse the item as a normal map.
      const childIndent = indent + 2;
      const rewritten = [{ indent: childIndent, text: rest, no: line.no }, ...lines.slice(i + 1)];
      const [value, consumed] = parseMap(rewritten, 0, childIndent);
      out.push(value);
      i = i + consumed;
    } else {
      out.push(scalar(rest, line.no));
      i += 1;
    }
  }
  return [out, i];
}

export function parseYaml(text) {
  const lines = tokenize(text);
  if (lines.length === 0) return null;
  if (lines[0].indent !== 0) throw new YamlError('document must start at column 0', lines[0].no);
  const [value, consumed] = parseNode(lines, 0, 0);
  if (consumed !== lines.length) {
    throw new YamlError(`unparsed content: ${JSON.stringify(lines[consumed].text)}`, lines[consumed].no);
  }
  return value;
}

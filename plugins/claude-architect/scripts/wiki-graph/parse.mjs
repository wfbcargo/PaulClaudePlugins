// Reads a Claude Architect `.wiki/` into a graph: one node per thing the wiki
// names (spec, decision, rule, container, layer, glossary term, gotcha, page
// section) and one edge per reference between them, typed where the wiki says
// how two things relate (builds_on, amends, supersedes, source, consumes).
//
// No dependencies. Everything is read from the files; nothing is guessed from
// prose beyond the ID shapes the framework itself uses:
//   spec / epic   8 hex digits (`specs/<id>_slug.md`, "spec 1db403e5")
//   decision      `ADR 0001`, `decisions/0001-...md`, or a bare 0NNN after
//                 Amends / superseded by / ... inside a decision
//   rule          `R-001`
//   container     an id from containers.yaml, or a path under one in backticks
//
// An ID that is referenced but has no file becomes a ghost node, so the graph
// shows what the wiki points at but never wrote down.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, posix } from 'node:path';
import { parseYaml } from '../containers/yaml.mjs';

const SPEC_FILE = /^([0-9a-f]{8})(?:_|$)/;
const ADR_FILE = /^(\d{4})-/;
const ADR_NUM = /\b0\d{3}\b/g;
const RULE_REF = /\bR-(\d{3})\b/g;
const ADR_REF = /\bADRs?\s+((?:0\d{3})(?:(?:\s*(?:,|and|&|\/)\s*|\s+)0\d{3})*)/g;
const SPEC_REF = /\b(?:spec|specs|epic|spec-id:|spec_id:)\s*\[?`?([0-9a-f]{8})\b/gi;
const HEX8 = /\b[0-9a-f]{8}\b/g;
const MD_LINK = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;
const TICK_PATH = /`((?:[\w.@-]+\/)+[\w.@*-]*)`/g;
const BOLD = /\*\*([^*]{2,60})\*\*/g;

// Relation words that name an edge type when an ID follows them in the same sentence.
// `dir: 'in'` means the referenced thing is the subject ("amended by 0017": 0017 amends this).
const RELATIONS = [
  { re: /\bsuperseded by\b/i, type: 'supersedes', dir: 'in' },
  { re: /\bsupersedes\b/i, type: 'supersedes', dir: 'out' },
  { re: /\bamended by\b/i, type: 'amends', dir: 'in' },
  { re: /\bamends\b/i, type: 'amends', dir: 'out' },
  { re: /\bextended by\b/i, type: 'extends', dir: 'in' },
  { re: /\bextends\b/i, type: 'extends', dir: 'out' },
  { re: /\brefined by\b/i, type: 'refines', dir: 'in' },
  { re: /\brefines\b/i, type: 'refines', dir: 'out' },
  { re: /\bbuilds on\b/i, type: 'builds_on', dir: 'out' },
  { re: /\breplaces\b/i, type: 'supersedes', dir: 'out' },
];

const slug = (s) => s.toLowerCase().replace(/[`*_()[\]]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const firstHeading = (md) => (md.match(/^#\s+(.+)$/m) || [])[1]?.trim();
const clean = (s) => s.replace(/\*\*|`|\[|\]\([^)]*\)|\]/g, '').trim();

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function frontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: md.slice(m[0].length) };
}

/** Split markdown into `## ` sections: [{ heading, text, line }]. Text before the first is `heading: null`. */
function sections(md, level = 2) {
  const mark = '#'.repeat(level) + ' ';
  const out = [];
  let cur = { heading: null, lines: [], line: 1 };
  let fence = false;
  md.split(/\r?\n/).forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    if (!fence && l.startsWith(mark)) {
      out.push(cur);
      cur = { heading: l.slice(mark.length).trim(), lines: [l], line: i + 1 };
    } else cur.lines.push(l);
  });
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n'), line: s.line }));
}

/** Top-level `- ` bullets with their indented continuation lines. */
function bullets(md) {
  const out = [];
  let cur = null;
  let fence = false;
  let heading = null;
  md.split(/\r?\n/).forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    if (fence) { if (cur) cur.lines.push(l); return; }
    if (/^#{2,3}\s/.test(l)) { heading = l.replace(/^#+\s*/, '').trim(); cur = null; return; }
    if (/^- /.test(l)) { cur = { lines: [l], line: i + 1, heading }; out.push(cur); return; }
    if (cur && (/^\s+\S/.test(l))) { cur.lines.push(l); return; }
    cur = null;
  });
  return out.map((b) => ({ text: b.lines.join('\n'), line: b.line, heading: b.heading }));
}

export function parseWiki(wikiDir, { name } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const files = walk(wikiDir).map((p) => ({ abs: p, rel: relative(wikiDir, p).split('\\').join('/') }));
  const mdFiles = files.filter((f) => f.rel.endsWith('.md'));

  const add = (n) => {
    const prev = nodes.get(n.id);
    if (prev && !prev.ghost) return prev;
    const node = { ...prev, ...n, ghost: false };
    nodes.set(n.id, node);
    return node;
  };
  const ghost = (id, kind, label) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label, ghost: true, body: '' });
    return nodes.get(id);
  };
  const link = (from, to, type, extra) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}|${type}`;
    const e = edges.get(key);
    if (e) { e.weight++; return; }
    edges.set(key, { from, to, type, weight: 1, ...extra });
  };

  // ---- known IDs first, so a bare mention can be resolved -----------------
  const specIds = new Set();
  const adrIds = new Set();
  for (const f of mdFiles) {
    const parts = f.rel.split('/');
    if (parts[0] === 'specs' && parts.length > 1) {
      const m = parts[1].match(SPEC_FILE);
      if (m) specIds.add(m[1]);
    }
    if (parts[0] === 'decisions' && parts.length === 2) {
      const m = parts[1].match(ADR_FILE);
      if (m) adrIds.add(m[1]);
    }
  }
  const fileNode = new Map(); // wiki-relative md path -> node id

  // ---- containers.yaml ----------------------------------------------------
  const containers = [];
  const cy = files.find((f) => f.rel === 'containers.yaml');
  if (cy) {
    let doc = null;
    try { doc = parseYaml(readFileSync(cy.abs, 'utf8')); } catch (err) {
      console.error(`wiki-graph: containers.yaml did not parse (${err.message}); skipping it`);
    }
    if (doc) {
      (doc.layers || []).forEach((l, i) => add({
        id: `layer:${l.id}`, kind: 'layer', label: l.id, title: `Layer: ${l.id}`, file: 'containers.yaml',
        body: `# Layer \`${l.id}\`\n\n${l.role || ''}\n\n- intra_layer: ${l.intra_layer ?? '—'}\n- order: ${i + 1} of ${doc.layers.length} (top to bottom)`,
        order: i,
      }));
      (doc.layers || []).slice(1).forEach((l, i) => link(`layer:${doc.layers[i].id}`, `layer:${l.id}`, 'above'));
      for (const c of doc.containers || []) {
        containers.push(c);
        const layer = c.layer || String(c.id).split('/')[0];
        add({
          id: `ctr:${c.id}`, kind: 'container', label: c.id, title: `Container: ${c.id}`, file: 'containers.yaml',
          layer, path: c.path,
          body: `# Container \`${c.id}\`\n\n${c.owns || ''}\n\n- path: \`${c.path || '—'}\`\n- layer: ${layer}` +
            (c.consumes?.length ? `\n- consumes: ${c.consumes.map((x) => '`' + x + '`').join(', ')}` : ''),
        });
        if (nodes.has(`layer:${layer}`)) link(`ctr:${c.id}`, `layer:${layer}`, 'in_layer');
      }
      for (const c of doc.containers || []) for (const t of c.consumes || []) link(`ctr:${c.id}`, `ctr:${t}`, 'consumes');
    }
  }
  const ctrIds = containers.map((c) => String(c.id)).sort((a, b) => b.length - a.length);
  const ctrPaths = containers.filter((c) => c.path).map((c) => ({ id: c.id, path: String(c.path).replace(/\/$/, '') }))
    .sort((a, b) => b.path.length - a.path.length);
  const ctrRe = ctrIds.length
    ? new RegExp(`(?<![\\w/-])(${ctrIds.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w/-])`, 'g')
    : null;

  // ---- reference scanning -------------------------------------------------
  /** Every ID-shaped reference in `text`, from node `fromId`. */
  function scan(fromId, text, srcRel, { relations = false, stateTable = false } = {}) {
    const seen = [];
    const hit = (to, type = 'mentions') => { link(fromId, to, type); seen.push(to); };

    for (const m of text.matchAll(RULE_REF)) hit(nodes.has(`rule:R-${m[1]}`) ? `rule:R-${m[1]}` : ghost(`rule:R-${m[1]}`, 'rule', `R-${m[1]}`).id);
    for (const m of text.matchAll(ADR_REF)) for (const n of m[1].match(ADR_NUM)) hit(adr(n));
    for (const m of text.matchAll(SPEC_REF)) hit(spec(m[1].toLowerCase()));
    for (const m of text.matchAll(HEX8)) if (specIds.has(m[0])) hit(`spec:${m[0]}`);
    for (const m of text.matchAll(MD_LINK)) {
      const target = posix.normalize(posix.join(posix.dirname(srcRel), m[1]));
      const id = fileNode.get(target) || resolveFile(target);
      if (id) hit(id, 'links');
    }
    if (ctrRe) for (const m of text.matchAll(ctrRe)) hit(`ctr:${m[1]}`, stateTable ? 'state_in' : 'mentions');
    for (const m of text.matchAll(TICK_PATH)) {
      const p = m[1];
      const c = ctrPaths.find((c) => p === c.path || p.startsWith(c.path + '/'));
      if (c) hit(`ctr:${c.id}`, 'code_in');
    }
    if (relations) relationEdges(fromId, text);
    return seen;
  }

  function adr(n) { return adrIds.has(n) ? `adr:${n}` : ghost(`adr:${n}`, 'decision', `ADR ${n}`).id; }
  function spec(id) { return specIds.has(id) ? `spec:${id}` : ghost(`spec:${id}`, 'spec', id).id; }
  function resolveFile(rel) {
    const parts = rel.split('/');
    if (parts[0] === 'decisions') { const m = (parts[1] || '').match(ADR_FILE); if (m) return adr(m[1]); }
    if (parts[0] === 'specs') { const m = (parts[1] || '').match(SPEC_FILE); if (m) return spec(m[1]); }
    return null;
  }

  /** Typed edges from relation words: "Amends 0005 (tenancy) and 0018", "superseded by 0008". */
  function relationEdges(fromId, text) {
    for (const sentence of text.split(/(?<=[.;])\s+|\n(?=\s*[-#|])/)) {
      for (const r of RELATIONS) {
        const m = sentence.match(r.re);
        if (!m) continue;
        const tail = sentence.slice(m.index + m[0].length);
        const stop = tail.search(/\b(?:superseded|supersedes|amended|amends|extended|extends|refined|refines|builds on|replaces)\b/i);
        // "its decision 0076" names another project's decision log, not this wiki's ADR.
        const scope = (stop > 0 ? tail.slice(0, stop) : tail).replace(/\bdecision\s+0\d{3}\b/gi, '');
        const ids = [];
        for (const n of scope.match(ADR_NUM) || []) ids.push(adr(n));
        for (const s of scope.match(HEX8) || []) if (specIds.has(s) || /spec|epic/i.test(scope)) ids.push(spec(s));
        for (const to of ids) r.dir === 'out' ? link(fromId, to, r.type) : link(to, fromId, r.type);
      }
    }
  }

  // ---- files --------------------------------------------------------------
  const ideaSections = []; // [{ id, members, rel }] from ideas.md
  const specDocs = new Map(); // spec id -> [{ rel, md }]
  const pending = []; // [nodeId, text, rel, opts] scanned after every node exists

  for (const f of mdFiles) {
    const md = readFileSync(f.abs, 'utf8');
    const parts = f.rel.split('/');
    const specM = parts[0] === 'specs' && parts[1] ? parts[1].match(SPEC_FILE) : null;
    const adrM = parts[0] === 'decisions' && parts.length === 2 ? parts[1].match(ADR_FILE) : null;

    if (specM) {
      if (!specDocs.has(specM[1])) specDocs.set(specM[1], []);
      specDocs.get(specM[1]).push({ rel: f.rel, md });
      fileNode.set(f.rel, `spec:${specM[1]}`);
      continue;
    }
    if (adrM) {
      const n = adrM[1];
      const title = firstHeading(md) || basename(f.rel, '.md');
      const status = (md.match(/^-\s*Status:\s*(.+)$/m) || [])[1] || '';
      const date = (md.match(/^-\s*Date:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1];
      add({
        id: `adr:${n}`, kind: 'decision', label: `ADR ${n}`, title: title.replace(/^(?:ADR\s*)?\d{4}\s*[—–:.-]\s*/i, ''), file: f.rel,
        status: (status.match(/^(proposed|accepted|superseded|abandoned|deprecated|rejected)/i) || [])[1]?.toLowerCase() || 'unknown',
        statusLine: status, date, body: md,
      });
      fileNode.set(f.rel, `adr:${n}`);
      pending.push([`adr:${n}`, md, f.rel, { relations: true }]);
      continue;
    }

    // An idea: `ideas/<slug>.md`, frontmatter for machines (summary, maturity, builds_on, anchor specs and
    // decisions), a body for readers (what it is, why, open questions, where to start). `_`-prefixed files
    // and a README are not ideas (the template ships `_example.md`). Anchors resolve after every file is read.
    if (parts[0] === 'ideas' && parts.length === 2 && !/^(_|readme\.md$)/i.test(parts[1])) {
      const { fm, body } = frontmatter(md);
      const key = slug(fm.idea || basename(parts[1], '.md'));
      const id = `idea:${key}`;
      const name = clean(firstHeading(body) || key);
      const list = (v) => (v || '').replace(/^\[|\]$/g, '');
      const members = { specs: list(fm.specs), decisions: list(fm.decisions), rules: list(fm.rules), containers: list(fm.containers), 'builds on': list(fm.builds_on) };
      add({
        id, kind: 'idea', label: name, title: name, file: f.rel, body: md, slug: key, members,
        summary: fm.summary, maturity: (fm.maturity || '').toLowerCase() || undefined,
      });
      fileNode.set(f.rel, id);
      ideaSections.push({ id, members, rel: f.rel });
      pending.push([id, body, f.rel]);
      continue;
    }

    // A page: the index, rules, glossary, gotchas, architecture, conventions, any README...
    const pageId = `page:${f.rel}`;
    const title = firstHeading(md) || f.rel;
    add({ id: pageId, kind: 'page', label: f.rel.replace(/\.md$/, ''), title, file: f.rel, body: md });
    fileNode.set(f.rel, pageId);
    const base = f.rel.toLowerCase();

    if (base === 'rules.md') {
      for (const s of sections(md)) {
        const m = s.heading?.match(/^R-(\d{3}):?\s*(.*)$/);
        if (!m) continue;
        const id = `rule:R-${m[1]}`;
        add({
          id, kind: 'rule', label: `R-${m[1]}`, title: clean(m[2]), file: f.rel, line: s.line, body: s.text,
          scope: (s.text.match(/^Scope:\s*(.+)$/m) || [])[1],
          date: (s.text.match(/^Added:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1],
        });
        link(id, pageId, 'part_of');
        const src = (s.text.match(/Source:\s*(.+)$/m) || [])[1];
        if (src) for (const p of src.split(/[,;]\s*/)) {
          const t = resolveFile(posix.normalize(p.trim().replace(/^\.wiki\//, '').replace(/[`)]/g, '')));
          if (t) link(id, t, 'source');
        }
        pending.push([id, s.text.replace(/^Source:.*$/m, ''), f.rel]);
      }
    } else if (base === 'glossary.md') {
      for (const b of bullets(md)) {
        const m = b.text.match(/^- \*\*([^*]+)\*\*\s*(\([^)]*\))?/);
        if (!m) continue;
        const label = m[1].trim();
        const id = `term:${slug(label)}`;
        if (nodes.has(id)) continue;
        add({ id, kind: 'term', label, title: label, group: b.heading, file: f.rel, line: b.line, body: b.text, aliases: label.split(/\s*\/\s*/) });
        link(id, pageId, 'part_of');
        pending.push([id, b.text, f.rel, { terms: true }]);
      }
    } else if (base === 'gotchas.md') {
      bullets(md).forEach((b, i) => {
        const bold = b.text.match(/^- \*\*([^*]+)\*\*/);
        const label = clean(bold ? bold[1] : b.text.slice(2).split(/[.;:—]/)[0]).replace(/:$/, '').slice(0, 70);
        const id = `gotcha:${i + 1}`;
        add({ id, kind: 'gotcha', label, title: label, group: b.heading, file: f.rel, line: b.line, body: b.text });
        link(id, pageId, 'part_of');
        pending.push([id, b.text, f.rel]);
      });
    } else {
      const secs = sections(md);
      pending.push([pageId, secs[0].text, f.rel]);
      for (const s of secs.slice(1)) {
        const id = `sec:${f.rel}#${slug(s.heading)}`;
        add({ id, kind: 'section', label: clean(s.heading).slice(0, 60), title: clean(s.heading), file: f.rel, line: s.line, body: s.text });
        link(id, pageId, 'part_of');
        pending.push([id, s.text, f.rel]);
      }
      continue;
    }
    // rules / glossary / gotchas: the page's own intro
    pending.push([pageId, sections(md)[0].text, f.rel]);
  }

  // ---- specs: one node per id, every file under it a document of that spec --
  for (const [sid, docs] of specDocs) {
    docs.sort((a, b) => (frontmatter(b.md).fm.spec_id ? 1 : 0) - (frontmatter(a.md).fm.spec_id ? 1 : 0) || a.rel.localeCompare(b.rel));
    const { fm, body } = frontmatter(docs[0].md);
    const title = (firstHeading(body) || docs[0].rel).replace(/\s*\((spec|epic)\)\s*$/i, '')
      .replace(new RegExp(`^(?:spec|epic)?\\s*${sid}\\s*[—–:-]\\s*`, 'i'), '');
    const id = `spec:${sid}`;
    add({
      id, kind: 'spec', label: sid, title, file: docs[0].rel, fm,
      status: (fm.status || '').split(/[\s(;,]/)[0].toLowerCase() || undefined, statusLine: fm.status,
      epic: /\(epic\)/i.test(firstHeading(body) || '') || fm.tier === 'epic',
      docs: docs.map((d) => ({ file: d.rel, title: firstHeading(frontmatter(d.md).body) || basename(d.rel), body: d.md })),
      body: docs[0].md,
    });
    for (const d of docs) {
      const { fm: dfm, body: dbody } = frontmatter(d.md);
      for (const [k, v] of Object.entries(dfm)) {
        if (k === 'spec_id' || !v) continue;
        const type = k === 'builds_on' ? 'builds_on' : /^(depends|depends_on|follows|after)$/.test(k) ? 'depends_on' : null;
        if (!type) continue;
        for (const s of v.match(HEX8) || []) link(id, spec(s), type);
        for (const m of v.matchAll(/(?:ADR\s*)?\b(0\d{3})\b/g)) link(id, adr(m[1]), type);
      }
      for (const s of sections(dbody)) {
        pending.push([id, s.text, d.rel, { stateTable: /^state\b/i.test(s.heading || ''), relations: s.heading === null }]);
      }
    }
  }

  // ---- ideas: members point at the idea they belong to --------------------
  const ideaByName = new Map(ideaSections.map((s) => [nodes.get(s.id).label.toLowerCase(), s.id]));
  for (const { id, members } of ideaSections) {
    const list = (k) => (members[k] || '').split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);
    for (const s of (members.specs || '').match(HEX8) || []) link(spec(s), id, 'in_idea');
    for (const n of (members.decisions || '').match(ADR_NUM) || []) link(adr(n), id, 'in_idea');
    for (const m of (members.rules || '').matchAll(RULE_REF)) {
      const r = `rule:R-${m[1]}`;
      link(nodes.has(r) ? r : ghost(r, 'rule', `R-${m[1]}`).id, id, 'in_idea');
    }
    for (const c of list('containers')) if (nodes.has(`ctr:${c.replace(/`/g, '')}`)) link(`ctr:${c.replace(/`/g, '')}`, id, 'in_idea');
    // builds_on names other ideas by slug (or by name).
    for (const x of list('builds on')) {
      const other = nodes.has(`idea:${slug(x)}`) ? `idea:${slug(x)}` : ideaByName.get(x.toLowerCase());
      if (other && other !== id) link(id, other, 'builds_on');
      else if (!other) { ghost(`idea:${slug(x)}`, 'idea', x); link(id, `idea:${slug(x)}`, 'builds_on'); }
    }
  }

  for (const [id, text, rel, opts] of pending) scan(id, text, rel, opts);

  // ---- glossary terms named in bold inside another entry or doc --------------
  const termByName = new Map();
  for (const n of nodes.values()) if (n.kind === 'term') for (const a of n.aliases) termByName.set(a.toLowerCase(), n.id);
  for (const n of nodes.values()) {
    if (n.ghost || n.kind === 'page') continue;
    const text = n.docs ? n.docs.map((d) => d.body).join('\n') : n.body || '';
    for (const m of text.matchAll(BOLD)) {
      const t = termByName.get(clean(m[1]).toLowerCase().replace(/\s*\(.*\)$/, ''));
      if (t && t !== n.id) link(n.id, t, 'uses_term');
    }
  }

  // ---- tidy ---------------------------------------------------------------
  const nodeList = [...nodes.values()];
  const deg = new Map();
  for (const e of edges.values()) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
  for (const n of nodeList) n.degree = deg.get(n.id) || 0;

  // With ideas in use, every written spec and decision should sit under at least one,
  // and every idea file should be listed in the ideas.md index.
  const filed = new Set([...edges.values()].filter((e) => e.type === 'in_idea').map((e) => e.from));
  const unfiled = ideaSections.length
    ? nodeList.filter((n) => !n.ghost && (n.kind === 'spec' || n.kind === 'decision') && !filed.has(n.id)).map((n) => n.id).sort()
    : [];
  const listedFrom = new Set([...edges.values()].filter((e) => e.from === 'page:ideas.md' && e.type === 'links').map((e) => e.to));
  const unlisted = ideaSections.map((s) => s.id).filter((id) => !listedFrom.has(id)).sort();
  const ideas = ideaSections.map((s) => readingList(nodes.get(s.id), nodes, [...edges.values()]));

  return {
    meta: {
      name: name || basename(dirname(wikiDir.replace(/[\\/]$/, ''))) || 'wiki',
      unfiled,
      unlisted,
      generated: new Date().toISOString(),
      counts: Object.fromEntries([...new Set(nodeList.map((n) => n.kind))].map((k) => [k, nodeList.filter((n) => n.kind === k && !n.ghost).length])),
      ghosts: nodeList.filter((n) => n.ghost).length,
      edges: edges.size,
    },
    nodes: nodeList,
    edges: [...edges.values()],
    ideas,
  };
}

// ---- an idea's reading list ---------------------------------------------------
// The anchors (what the idea file names) and everything one typed link away from them, grouped by kind and
// ordered for reading: anchors first (specs in flight before finished ones), then related nodes by how many
// anchors point at them. Worked out, never written by hand, so it cannot go stale.
const GROUPS = ['spec', 'decision', 'rule', 'container', 'section', 'gotcha', 'term'];
const SPEC_ORDER = ['in_progress', 'active', 'in_review', 'implemented', 'draft', 'built', 'shipped', 'merged'];
const ADR_ORDER = ['accepted', 'proposed', 'unknown', 'superseded', 'deprecated', 'abandoned', 'rejected'];
function readingList(idea, nodes, edges) {
  const anchors = edges.filter((e) => e.type === 'in_idea' && e.to === idea.id).map((e) => nodes.get(e.from));
  const anchorSet = new Set(anchors);
  const hits = new Map(); // node -> weight (anchors linking to it)
  const touch = (n) => {
    if (!n || anchorSet.has(n) || !GROUPS.includes(n.kind)) return;
    hits.set(n, (hits.get(n) || 0) + 1);
  };
  for (const a of anchors) {
    const seen = new Set();
    for (const e of edges) {
      if (e.type === 'part_of' || e.type === 'in_idea') continue;
      const other = e.from === a.id ? nodes.get(e.to) : e.to === a.id ? nodes.get(e.from) : null;
      if (other && !seen.has(other)) { seen.add(other); touch(other); }
    }
  }
  const rank = (n) => (n.kind === 'spec' ? SPEC_ORDER : n.kind === 'decision' ? ADR_ORDER : []).indexOf(n.status ?? '');
  const order = (a, b) => (rank(a) < 0 ? 99 : rank(a)) - (rank(b) < 0 ? 99 : rank(b)) || a.id.localeCompare(b.id);
  const read = {};
  for (const k of GROUPS) {
    const own = anchors.filter((n) => n.kind === k).sort(order).map((n) => [n.id, 'anchor']);
    const rel = [...hits].filter(([n]) => n.kind === k).sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id)).map(([n, w]) => [n.id, w]);
    if (own.length || rel.length) read[k] = own.concat(rel);
  }
  const specs = anchors.filter((n) => n.kind === 'spec');
  const status = {};
  for (const s of specs) status[s.ghost ? 'unwritten' : s.status || 'no status'] = (status[s.ghost ? 'unwritten' : s.status || 'no status'] || 0) + 1;
  const open = anchors.filter((n) => (n.kind === 'decision' && n.status === 'proposed') || (n.kind === 'spec' && n.status === 'draft')).map((n) => n.id).sort();
  const dates = anchors.map((n) => n.date).filter(Boolean).sort();
  return {
    id: idea.id, name: idea.label, file: idea.file, summary: idea.summary, maturity: idea.maturity,
    builds_on: edges.filter((e) => e.from === idea.id && e.type === 'builds_on').map((e) => e.to).sort(),
    built_on_by: edges.filter((e) => e.to === idea.id && e.type === 'builds_on' && e.from.startsWith('idea:')).map((e) => e.from).sort(),
    state: { specs: status, open, last_decision: dates[dates.length - 1] },
    read,
  };
}

/**
 * The graph as a committed index: no bodies, no timestamp, sorted, one node or edge per line, so it diffs cleanly,
 * `--check` can compare it byte for byte, and `grep <id>` on it returns the node and every link it has.
 */
export function toIndex(graph) {
  const keep = ['kind', 'label', 'title', 'file', 'line', 'status', 'date', 'scope', 'group', 'layer', 'path', 'epic', 'ghost'];
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => {
    const o = { id: n.id };
    for (const k of keep) if (n[k] !== undefined && n[k] !== false && n[k] !== '') o[k] = n[k];
    if (n.docs?.length > 1) o.files = n.docs.map((d) => d.file);
    return o;
  });
  const edges = [...graph.edges].sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to))
    .map((e) => [e.from, e.type, e.to, e.weight]);
  return [
    '{',
    `"version": 1,`,
    `"about": "Generated by claude-architect scripts/wiki-graph.mjs --index. Do not edit; regenerate. Nodes: id, kind, file:line. Edges: [from, type, to, weight].",`,
    `"counts": ${JSON.stringify({ ...graph.meta.counts, ghost: graph.meta.ghosts, edges: edges.length })},`,
    `"unfiled": ${JSON.stringify(graph.meta.unfiled || [])},`,
    `"unlisted": ${JSON.stringify(graph.meta.unlisted || [])},`,
    '"ideas": [',
    (graph.ideas || []).slice().sort((a, b) => a.id.localeCompare(b.id)).map((i) => JSON.stringify(i)).join(',\n'),
    '],',
    '"nodes": [',
    nodes.map((n) => JSON.stringify(n)).join(',\n'),
    '],',
    '"edges": [',
    edges.map((e) => JSON.stringify(e)).join(',\n'),
    ']',
    '}',
    '',
  ].join('\n');
}

export function findWiki(start) {
  let dir = start;
  for (;;) {
    if (basename(dir) === '.wiki' && existsSync(dir)) return dir;
    if (existsSync(join(dir, '.wiki'))) return join(dir, '.wiki');
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

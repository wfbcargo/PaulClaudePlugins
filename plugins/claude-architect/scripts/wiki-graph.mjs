#!/usr/bin/env node
// wiki-graph — the `.wiki/` as a graph: an index agents can traverse, and a page people can walk.
//
//   node wiki-graph.mjs [wiki-dir] [--out page.html] [--open]   draw the page
//   node wiki-graph.mjs [wiki-dir] --index [graph.json]          write the index
//   node wiki-graph.mjs [wiki-dir] --check [graph.json]          exit 1 if the index is stale
//   node wiki-graph.mjs [wiki-dir] --node <id> [--hops N]        print a node's links (spec:1db403e5, adr:0017, R-012)
//   node wiki-graph.mjs [wiki-dir] --ideas                       every idea in a line, and what no idea holds
//   node wiki-graph.mjs [wiki-dir] --idea <slug> [--all]         one idea's reading list, top down
//
// wiki-dir defaults to the nearest `.wiki/` at or above the current directory.
// Every idea (`ideas/<slug>.md`), spec, decision, rule, container,
// layer, glossary term, gotcha and page section is a node; every reference between them is an edge, typed where the
// wiki says how two things relate (builds_on, amends, supersedes, source,
// consumes, state_in, code_in) and `mentions` otherwise. An ID referenced with
// no file of its own is a ghost node.
//
// --index  writes .wiki/graph.json by default: no bodies, no timestamp, sorted,
//          one node or edge per line, so it diffs cleanly and `grep <id>` on it
//          returns the node and every link it has. Regenerate it whenever the
//          wiki changes; --check is the gate that it was.
// --out    the page defaults to <wiki-dir>/../.wiki-graph.html (outside the
//          wiki); it embeds every page's text and needs no network or install.
// --json   also write the full graph, bodies included, for other tools.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseWiki, findWiki, toIndex } from './wiki-graph/parse.mjs';

// U+2028/2029 end a line inside an inline script. Built from char codes so no editor writes the raw characters.
const LINE_SEPARATORS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const take = (k, optionalValue) => {
  const i = args.indexOf(k);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (optionalValue && (v === undefined || v.startsWith('--') || !/\.json$/i.test(v))) { args.splice(i, 1); return true; }
  args.splice(i, 2);
  return v;
};
const flag = (k) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };

if (flag('--help') || flag('-h')) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trim());
  process.exit(0);
}
const out = take('--out');
const json = take('--json');
const name = take('--name');
const index = take('--index', true);
const check = take('--check', true);
const nodeId = take('--node');
const hops = Number(take('--hops') || 1);
const open = flag('--open');
const ideas = flag('--ideas');
const ideaKey = take('--idea');
const all = flag('--all');
const wiki = args[0] ? resolve(args[0]) : findWiki(process.cwd());
if (!wiki || !existsSync(wiki)) { console.error('wiki-graph: no .wiki/ found here or above; pass the wiki directory'); process.exit(2); }
const indexPath = (v) => resolve(typeof v === 'string' ? v : join(wiki, 'graph.json'));

const graph = parseWiki(wiki, { name });
const summary = () => {
  const c = graph.meta.counts;
  return `${graph.nodes.length} nodes (${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')}; ${graph.meta.ghosts} referenced but unwritten), ${graph.edges.length} edges`;
};

const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const stateLine = (i) => {
  const s = Object.entries(i.state.specs).map(([k, v]) => `${v} ${k}`).join(', ');
  return [s && `specs: ${s}`, i.state.open.length && `open: ${i.state.open.map((id) => byId.get(id).label).join(', ')}`, i.state.last_decision && `last decision ${i.state.last_decision}`].filter(Boolean).join(' · ');
};

if (ideas) {
  if (!graph.ideas.length) { console.log('wiki-graph: no ideas yet (no .wiki/ideas/<slug>.md files)'); process.exit(0); }
  for (const i of graph.ideas) {
    console.log(`${i.id}${i.maturity ? `  [${i.maturity}]` : ''}  ${i.name} — ${i.summary || '(no summary)'}`);
    console.log(`  ${stateLine(i) || 'no specs yet'}${i.builds_on.length ? `  · builds on ${i.builds_on.map((x) => x.slice(5)).join(', ')}` : ''}`);
  }
  const u = graph.meta.unfiled, l = graph.meta.unlisted;
  console.log(u.length ? `\nin no idea (${u.length}): ${u.map((id) => byId.get(id).label).join(', ')}` : '\nevery spec and decision is in an idea');
  if (l.length) console.log(`not listed in ideas.md (${l.length}): ${l.join(', ')}`);
  console.log(`\nnext: --idea <slug> for one idea's reading list`);
  process.exit(0);
}

if (ideaKey) {
  const key = ideaKey.replace(/^idea:/, '');
  const i = graph.ideas.find((x) => x.id === `idea:${key}`) || graph.ideas.find((x) => x.name.toLowerCase() === key.toLowerCase());
  if (!i) { console.error(`wiki-graph: no idea ${ideaKey}; --ideas lists them`); process.exit(1); }
  const where = (n) => (n.ghost ? '(not written)' : `.wiki/${n.file}${n.line ? ':' + n.line : ''}`);
  console.log(`${i.name}  [${i.maturity || 'no maturity'}]  .wiki/${i.file}`);
  if (i.summary) console.log(i.summary);
  console.log(stateLine(i));
  if (i.builds_on.length) console.log(`builds on: ${i.builds_on.join(', ')}`);
  if (i.built_on_by.length) console.log(`built on by: ${i.built_on_by.join(', ')}`);
  const NAMES = { spec: 'Specs', decision: 'Decisions', rule: 'Rules', container: 'Containers', section: 'Wiki sections', gotcha: 'Gotchas', term: 'Terms' };
  for (const [k, list] of Object.entries(i.read)) {
    // Without --all: every anchor, and related nodes that two or more anchors point at (at most 8).
    const anchors = list.filter(([, w]) => w === 'anchor');
    const related = list.filter(([, w]) => w !== 'anchor');
    const shown = all ? related : related.filter(([, w]) => w >= 2).slice(0, 8);
    console.log(`\n${NAMES[k]}`);
    for (const [id, w] of anchors.concat(shown)) {
      const n = byId.get(id);
      const tag = w === 'anchor' ? '*' : `${w}`;
      console.log(`  ${tag.padStart(2)}  ${n.id}  ${n.title && n.title !== n.label ? n.title : n.label}${n.status ? `  [${n.status}]` : ''}  ${where(n)}`);
    }
    if (shown.length < related.length) console.log(`      +${related.length - shown.length} more linked from one anchor (--all)`);
  }
  console.log('\n* anchor (named by the idea); a number is how many anchors link to it');
  process.exit(0);
}

if (check) {
  const p = indexPath(check);
  const want = toIndex(graph);
  if (!existsSync(p)) { console.error(`wiki-graph: no index at ${p}; run with --index`); process.exit(1); }
  const have = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  if (have !== want) {
    const a = new Set(have.split('\n')), b = new Set(want.split('\n'));
    const gone = [...a].filter((l) => !b.has(l)).length, added = [...b].filter((l) => !a.has(l)).length;
    console.error(`wiki-graph: ${relative(process.cwd(), p) || p} is stale (${added} lines new, ${gone} gone since it was written); run with --index`);
    process.exit(1);
  }
  console.log(`wiki-graph: index is current (${summary()})`);
  process.exit(0);
}

if (nodeId) {
  const norm = (s) => (/^R-\d{3}$/i.test(s) ? `rule:${s.toUpperCase()}` : /^\d{4}$/.test(s) || /^ADR\s*\d{4}$/i.test(s) ? `adr:${s.match(/\d{4}/)[0]}`
    : /^[0-9a-f]{8}$/.test(s) ? `spec:${s}` : s);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const start = byId.get(norm(nodeId)) || graph.nodes.find((n) => n.label === nodeId);
  if (!start) { console.error(`wiki-graph: no node ${nodeId}`); process.exit(1); }
  const where = (n) => (n.ghost ? '(not written)' : `.wiki/${n.file}${n.line ? ':' + n.line : ''}`);
  const title = (n) => `${n.id}  ${n.title && n.title !== n.label ? n.title : n.label}`;
  console.log(`${title(start)}  ${where(start)}${start.status ? `  [${start.status}]` : ''}`);
  const seen = new Set([start.id]);
  let frontier = [start];
  for (let d = 1; d <= hops && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      const rows = [];
      for (const e of graph.edges) {
        const outgoing = e.from === n.id, incoming = e.to === n.id;
        if (!outgoing && !incoming) continue;
        const m = byId.get(outgoing ? e.to : e.from);
        if (seen.has(m.id) || (d > 1 && e.type === 'part_of')) continue;
        seen.add(m.id); next.push(m);
        rows.push(`${'  '.repeat(d)}${outgoing ? '→' : '←'} ${e.type.padEnd(10)} ${title(m)}  ${where(m)}`);
      }
      if (d > 1 && rows.length) console.log(`${'  '.repeat(d - 1)}via ${n.id}`);
      rows.sort().forEach((r) => console.log(r));
    }
    frontier = next.filter((m) => m.kind !== 'page');
  }
  process.exit(0);
}

if (index) {
  const p = indexPath(index);
  writeFileSync(p, toIndex(graph));
  console.log(`wiki-graph: ${summary()}`);
  console.log(`wiki-graph: wrote ${p}`);
}
if (json) writeFileSync(resolve(json), JSON.stringify(graph, null, 2));
if (!index || out || open) {
  const target = resolve(out || join(wiki, '..', '.wiki-graph.html'));
  const template = readFileSync(join(here, 'wiki-graph', 'viewer.html'), 'utf8');
  // `</` would end the inline <script>; in JSON `<\/` reads back as the same text.
  const data = JSON.stringify(graph).replace(/<\//g, '<\\/').replace(LINE_SEPARATORS, (c) => '\\u' + c.charCodeAt(0).toString(16));
  writeFileSync(target, template.replace('/*__WIKI_GRAPH__*/null', () => data));
  if (!index) console.log(`wiki-graph: ${summary()}`);
  console.log(`wiki-graph: wrote ${target}`);
  if (open) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [target]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  }
}

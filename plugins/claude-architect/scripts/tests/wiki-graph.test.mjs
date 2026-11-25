// wiki-graph.mjs over a small wiki: the typed edges the framework's own formats name,
// ghosts for IDs with no file, and the committed index's --check gate.
//
//   node --test "plugins/claude-architect/scripts/tests/*.test.mjs"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseWiki, toIndex } from '../wiki-graph/parse.mjs';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'wiki-graph.mjs');
const root = mkdtempSync(join(tmpdir(), 'wiki-graph-'));
after(() => rmSync(root, { recursive: true, force: true }));

const wiki = join(root, '.wiki');
const w = (rel, text) => { mkdirSync(dirname(join(wiki, rel)), { recursive: true }); writeFileSync(join(wiki, rel), text); };
w('README.md', '# Project Wiki\n\nSee [rules](rules.md).\n');
w('containers.yaml', `version: 1
layers:
  - id: user
    intra_layer: none
  - id: engine
    intra_layer: none
policy:
  topology: folders
  root: src
containers:
  - id: user/web
    path: src/web
    owns: The app.
    consumes:
      - engine/db
  - id: engine/db
    path: src/db
    owns: The database.
`);
w('decisions/0001-one-store.md', '# 0001 — One store\n\n- Status: superseded by 0003\n- Date: 2026-01-02\n\nUses `src/db/client.ts`.\n');
w('decisions/0002-tenants.md', '# 0002 — Tenants\n\n- Status: accepted (spec aaaa1111). Amends 0001 (storage) and 0003.\n- Date: 2026-01-03\n');
w('decisions/0003-d1.md', '# 0003: D1\n\n- Status: accepted\n\nThe harness keeps its decision 0076 elsewhere.\n');
w('rules.md', '# Rules\n\n## R-001: The store is the only writer\nScope: global\nAdded: 2026-01-02 | Source: decisions/0003-d1.md\nSee ADR 0003.\n');
w('specs/aaaa1111_store.md', '---\nspec_id: aaaa1111\nstatus: built\nbuilds_on: bbbb2222\n---\n# Spec aaaa1111 — The store (spec)\n\n## State\n| State | Owner |\n|---|---|\n| rows | `engine/db` |\n\nFollows R-001 and spec cccc3333. Touches `src/web/app.tsx`.\n');
w('specs/aaaa1111_store/notes.md', '# Notes\n\nSee ADR 0002.\n');
w('specs/bbbb2222_base.md', '---\nspec_id: bbbb2222\nstatus: active (Paul, 2026-01-01)\n---\n# The base\n');
w('glossary.md', '# Glossary\n\n## Core\n\n- **Store** — where rows live (ADR 0003).\n- **Row** — one thing in the **Store**.\n');
w('gotchas.md', '# Gotchas\n\n- **The store is slow on Windows:** see R-001.\n  It wraps.\n- Plain gotcha naming spec aaaa1111.\n');
w('architecture.md', '# Architecture\n\n## Layout\n\n`user/web` consumes engine/db.\n');
w('ideas.md', '# Ideas\n\n- [Storage](ideas/storage.md) (settled): Where rows live.\n');
w('ideas/storage.md', '---\nidea: storage\nsummary: Where rows live.\nmaturity: settled\nspecs: aaaa1111, dddd4444\ndecisions: ADR 0001, ADR 0003\nrules: R-001\ncontainers: engine/db\n---\n'
  + '# Storage, the one store\n\n## What it is\nThe **Store**.\n\n## Start here\n1. ADR 0003\n');
w('ideas/tenancy.md', '---\nidea: tenancy\nsummary: Who owns what.\nmaturity: emerging\nbuilds_on: storage\ndecisions: [ADR 0002]\n---\n# Tenancy\n');
w('ideas/_example.md', '---\nidea: example\nspecs: bbbb2222\n---\n# Example\n');

const g = parseWiki(wiki);
const has = (from, type, to) => g.edges.some((e) => e.from === from && e.type === type && e.to === to);
const node = (id) => g.nodes.find((n) => n.id === id);

test('nodes: one per spec (every file under it a document), decision, rule, container, term, gotcha, section', () => {
  assert.equal(node('spec:aaaa1111').docs.length, 2);
  assert.equal(node('spec:aaaa1111').title, 'The store');
  assert.equal(node('spec:bbbb2222').status, 'active');
  assert.equal(node('adr:0001').status, 'superseded');
  assert.equal(node('adr:0003').title, 'D1');
  assert.equal(node('rule:R-001').scope, 'global');
  assert.ok(node('ctr:user/web') && node('layer:engine'));
  assert.ok(node('term:store') && node('term:row'));
  assert.equal(g.nodes.filter((n) => n.kind === 'gotcha').length, 2);
  assert.equal(node('gotcha:1').label, 'The store is slow on Windows');
  assert.ok(node('sec:architecture.md#layout'));
});

test('typed edges come from the formats the framework writes', () => {
  assert.ok(has('spec:aaaa1111', 'builds_on', 'spec:bbbb2222'), 'frontmatter builds_on');
  assert.ok(has('adr:0003', 'supersedes', 'adr:0001'), '"superseded by" points from the new decision');
  assert.ok(has('adr:0002', 'amends', 'adr:0001') && has('adr:0002', 'amends', 'adr:0003'), '"Amends 0001 (...) and 0003"');
  assert.ok(has('rule:R-001', 'source', 'adr:0003'), 'rule Source:');
  assert.ok(has('ctr:user/web', 'consumes', 'ctr:engine/db') && has('ctr:user/web', 'in_layer', 'layer:user'));
  assert.ok(has('spec:aaaa1111', 'state_in', 'ctr:engine/db'), 'a container named in the State table');
  assert.ok(has('spec:aaaa1111', 'code_in', 'ctr:user/web'), 'a path under a container');
  assert.ok(has('adr:0001', 'code_in', 'ctr:engine/db'));
  assert.ok(has('spec:aaaa1111', 'mentions', 'adr:0002'), "a spec's second document counts as the spec");
  assert.ok(has('term:row', 'uses_term', 'term:store'), 'a bold term inside another entry');
  assert.ok(has('gotcha:2', 'mentions', 'spec:aaaa1111') && has('gotcha:1', 'mentions', 'rule:R-001'));
  assert.ok(has('page:README.md', 'links', 'page:rules.md'), 'markdown link');
});

test('ideas: one file each, anchors point at their idea, builds_on by slug, and what is missing is listed', () => {
  const s = node('idea:storage');
  assert.equal(s.kind, 'idea');
  assert.equal(s.label, 'Storage, the one store');
  assert.equal(s.maturity, 'settled');
  for (const m of ['spec:aaaa1111', 'adr:0001', 'adr:0003', 'rule:R-001', 'ctr:engine/db']) assert.ok(has(m, 'in_idea', 'idea:storage'), m);
  assert.ok(has('adr:0002', 'in_idea', 'idea:tenancy'), 'a bracketed list');
  assert.ok(has('idea:tenancy', 'builds_on', 'idea:storage'));
  assert.equal(node('spec:dddd4444')?.ghost, true, 'an unwritten anchor is a ghost');
  assert.equal(node('idea:example'), undefined, 'an _-prefixed file is not an idea');
  assert.ok(has('idea:storage', 'uses_term', 'term:store'), 'the body is scanned like any page');
  assert.ok(has('idea:storage', 'mentions', 'adr:0003'), 'Start here links');
  assert.deepEqual(g.meta.unfiled, ['spec:bbbb2222']);
  assert.deepEqual(g.meta.unlisted, ['idea:tenancy'], 'an idea file with no line in ideas.md');
});

test('ideas: the reading list and state are worked out from the graph', () => {
  const i = g.ideas.find((x) => x.id === 'idea:storage');
  assert.deepEqual(i.read.spec.slice(0, 2), [['spec:aaaa1111', 'anchor'], ['spec:dddd4444', 'anchor']], 'anchors first');
  assert.ok(i.read.spec.some(([id, w]) => id === 'spec:bbbb2222' && w >= 1), 'a spec an anchor builds on');
  assert.ok(i.read.decision.some(([id, w]) => id === 'adr:0002' && w >= 1), 'a decision that amends an anchor');
  assert.ok(i.read.container.some(([id]) => id === 'ctr:user/web'), 'a container an anchor touches code in');
  assert.ok(i.read.gotcha.some(([id]) => id === 'gotcha:1'), 'a gotcha naming an anchor rule');
  assert.deepEqual(i.state.specs, { built: 1, unwritten: 1 });
  assert.equal(i.state.last_decision, '2026-01-02');
  assert.deepEqual(g.ideas.find((x) => x.id === 'idea:tenancy').built_on_by, []);
  assert.deepEqual(i.built_on_by, ['idea:tenancy']);
  const index = JSON.parse(toIndex(g));
  assert.equal(index.ideas.length, 2);
  assert.deepEqual(index.unlisted, ['idea:tenancy']);
});

test('CLI: --ideas is every idea in two lines; --idea is one reading list with file:line', () => {
  const all = execFileSync(process.execPath, [CLI, wiki, '--ideas'], { encoding: 'utf8' });
  assert.match(all, /^idea:storage +\[settled\] +Storage, the one store — Where rows live\./m);
  assert.match(all, /in no idea \(1\): bbbb2222/);
  assert.match(all, /not listed in ideas\.md \(1\): idea:tenancy/);
  const one = execFileSync(process.execPath, [CLI, wiki, '--idea', 'storage', '--all'], { encoding: 'utf8' });
  assert.match(one, /^Specs\n +\* +spec:aaaa1111 +The store +\[built\] +\.wiki\/specs\/aaaa1111_store\.md$/m);
  assert.match(one, /built on by: idea:tenancy/);
  assert.equal(spawnSync(process.execPath, [CLI, wiki, '--idea', 'nope']).status, 1);
});

test('an ID with no file is a ghost; another project\'s "decision NNNN" is not an ADR', () => {
  assert.equal(node('spec:cccc3333')?.ghost, true);
  assert.equal(node('adr:0076'), undefined);
});

test('the index is deterministic and has no bodies', () => {
  const a = toIndex(g), b = toIndex(parseWiki(wiki));
  assert.equal(a, b);
  assert.ok(!a.includes('where rows live'), 'no page text in the index');
  const parsed = JSON.parse(a);
  assert.equal(parsed.nodes.length, g.nodes.length);
  assert.deepEqual(parsed.nodes.find((n) => n.id === 'spec:aaaa1111').files, ['specs/aaaa1111_store.md', 'specs/aaaa1111_store/notes.md']);
});

test('CLI: --index writes .wiki/graph.json, --check passes, then fails once the wiki moves', () => {
  execFileSync(process.execPath, [CLI, wiki, '--index'], { encoding: 'utf8' });
  assert.ok(readFileSync(join(wiki, 'graph.json'), 'utf8').includes('"spec:aaaa1111"'));
  assert.equal(spawnSync(process.execPath, [CLI, wiki, '--check']).status, 0);
  appendFileSync(join(wiki, 'gotchas.md'), '- A new gotcha about R-001.\n');
  const r = spawnSync(process.execPath, [CLI, wiki, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale/);
});

// squash-up.sh keeps the index current: two sibling units each change the wiki, so their graph.json
// files conflict at the second squash; the script regenerates it instead of stopping.
const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
test('squash-up.sh regenerates .wiki/graph.json and never stops on it', { skip: !bash && 'bash not runnable' }, () => {
  const SQUASH = join(dirname(CLI), 'squash-up.sh');
  const repo = join(root, 'repo');
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  mkdirSync(join(repo, '.wiki', 'decisions'), { recursive: true });
  writeFileSync(join(repo, '.wiki', 'rules.md'), '# Rules\n\n## R-001: One\nScope: global\n');
  writeFileSync(join(repo, '.wiki', 'gotchas.md'), '# Gotchas\n\n- First, see R-001.\n');
  execFileSync(process.execPath, [CLI, join(repo, '.wiki'), '--index']);
  git(repo, 'init', '-q', '-b', 'work');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const child = (slug, file, text) => {
    const wt = join(root, `wt-${slug}`);
    git(repo, 'worktree', 'add', '-q', '-b', `work--${slug}`, wt);
    mkdirSync(dirname(join(wt, '.wiki', file)), { recursive: true });
    writeFileSync(join(wt, '.wiki', file), text);
    execFileSync(process.execPath, [CLI, join(wt, '.wiki'), '--index']);
    git(wt, 'add', '-A');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', slug);
  };
  child('a', 'decisions/0001-a.md', '# 0001 — A\n\n- Status: accepted\n');
  child('b', 'gotchas.md', '# Gotchas\n\n- First, see R-001.\n- Second, see ADR 0001.\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const b of ['work--a', 'work--b']) {
    const r = spawnSync('bash', [SQUASH, b, `squash ${b}`], { cwd: repo, encoding: 'utf8', env });
    assert.equal(r.status, 0, `${b}: ${r.stderr}`);
    if (b === 'work--b') assert.match(r.stderr, /graph\.json conflicted; regenerated/, 'the second squash took the conflict path');
  }
  assert.equal(spawnSync(process.execPath, [CLI, join(repo, '.wiki'), '--check']).status, 0, 'index matches the merged wiki');
  const index = readFileSync(join(repo, '.wiki', 'graph.json'), 'utf8');
  assert.ok(index.includes('["gotcha:2","mentions","adr:0001",1]'), 'a link that exists only once both units are in');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('CLI: --node lists links with file:line; the page embeds the graph', () => {
  const out = execFileSync(process.execPath, [CLI, wiki, '--node', 'R-001'], { encoding: 'utf8' });
  assert.match(out, /^rule:R-001 .*\.wiki\/rules\.md:3/m);
  assert.match(out, /→ source\s+adr:0003/);
  const page = join(root, 'page.html');
  execFileSync(process.execPath, [CLI, wiki, '--out', page]);
  const html = readFileSync(page, 'utf8');
  assert.ok(!html.includes('/*__WIKI_GRAPH__*/null'), 'data was injected');
  assert.ok(html.includes('"spec:aaaa1111"'));
});

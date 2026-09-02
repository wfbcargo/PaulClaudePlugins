#!/usr/bin/env node
// claude-boundaries — the container map CLI.
//
//   validate                 config coherence: direction, DAG, refs, overlaps
//   check [--changed]        boundary violations in the code
//        [--file <p>]        one file only (what the PostToolUse hook runs)
//        [--json]            machine-readable findings
//   where <path>...          which container owns a file
//   scope <container-id>     the `## YOUR SCOPE` block for a spawn prompt
//   map                      the layer / container graph
//   list [--slices]          the container / slice inventory
//   brief                    the short form injected into an agent's context
//   suggest                  propose a starter map for an unmapped repo
//   emit [target]            generate a dependency-cruiser / import-linter config
//
// Exit codes: 0 clean, 1 violations found, 2 bad config or usage.

import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { findConfig, loadModel, ConfigError, norm, CONFIG_PATHS } from './lib/model.mjs';
import { check, containerFiles, listSourceFiles } from './lib/rules.mjs';
import { createResolver } from './lib/resolve.mjs';
import { emit, TARGETS, targetForLanguage } from './lib/emit.mjs';
import { suggest } from './lib/suggest.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = new Map(argv.filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const args = argv.slice(1).filter((a) => !a.startsWith('--'));
// `--file a --file b` arrives as positional pairs; accept both spellings.
const flagValues = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
  }
  return out;
};
const positional = args.filter((a) => !flagValues('file').includes(a));

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

function open({ quiet = false } = {}) {
  const configPath = findConfig();
  if (!configPath) {
    if (quiet) process.exit(0);
    die(`No container map found (looked for ${CONFIG_PATHS.join(', ')} up from ${process.cwd()}).\n` +
        'This project has not adopted the boundary model. To start one:\n' +
        '  /boundaries:init          — propose a map from the existing tree\n' +
        `  or copy a template from <plugin>/templates/ to .wiki/containers.yaml`);
  }
  try {
    return loadModel(configPath);
  } catch (err) {
    if (err instanceof ConfigError) die(`Invalid ${norm(configPath)}:\n${err.message}`);
    throw err;
  }
}

/** Files changed vs. the merge-base, plus staged and untracked. */
function changedFiles(root) {
  const run = (a) => {
    try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }); } catch { return ''; }
  };
  const mergeBase = run(['merge-base', 'HEAD', 'origin/HEAD']).trim();
  const out = [
    run(['diff', '--name-only', mergeBase || 'HEAD']),
    run(['diff', '--name-only', '--cached']),
    run(['ls-files', '--others', '--exclude-standard']),
  ].join('\n');
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean).map(norm));
}

// ---------------------------------------------------------------------------

function cmdValidate() {
  const model = open();
  console.log(`OK  ${model.configPath}`);
  console.log(`    topology ${model.policy.topology}, ${model.layers.length} layers, ` +
              `${model.containers.length} containers, ` +
              `${model.containers.reduce((n, c) => n + c.consumes.length, 0)} declared edges, ` +
              `${model.slices.size} slices`);
  for (const w of model.warnings) console.log(`WARN ${w}`);
  process.exit(0);
}

function cmdCheck() {
  const model = open({ quiet: flags.has('quiet') });
  const explicit = flagValues('file').map(norm);
  let files;
  let subject;

  if (explicit.length) {
    // Hooks hand us absolute paths; the model speaks repo-relative.
    files = explicit.map((f) => {
      const n = norm(f);
      return n.startsWith(`${model.root}/`) ? n.slice(model.root.length + 1) : n;
    });
    subject = ' in the named file(s)';
  } else if (flags.has('changed')) {
    // An empty intersection is not a shortcut to success: the manifest and
    // unclassified checks are cheap and still run over the whole map.
    const changed = changedFiles(model.root);
    files = containerFiles(model).filter((f) => changed.has(f));
    subject = ' in changed files';
  } else {
    files = containerFiles(model);
    subject = '';
  }

  const result = check(model, files, { resolver: createResolver(model) });

  // A scan that saw nothing must never read as a pass. If a full check found no
  // files at all, the map points somewhere the code isn't — that is a broken
  // configuration wearing a green tick, which is worse than a red one.
  if (!explicit.length && !flags.has('changed') && result.scanned === 0) {
    die(`Scanned 0 source files under ${model.containers.length} container path(s).\n` +
        'That is a misconfiguration, not a clean result — check that the container `path:` values\n' +
        `and policy.language (${model.policy.language}) match where the code actually is.\n` +
        'Refusing to report a pass.');
  }

  if (flags.has('json')) {
    console.log(JSON.stringify({
      config: model.configPath, scanned: result.scanned,
      findings: result.findings, warnings: result.warnings,
    }, null, 2));
    process.exit(result.findings.length ? 1 : 0);
  }

  for (const w of result.warnings) {
    console.error(`WARN ${w.file}${w.line ? `:${w.line}` : ''}  [${w.rule}]\n     ${w.message}`);
  }

  if (!result.findings.length) {
    console.log(`OK  no boundary violations${subject} — ${result.scanned} file(s) scanned.`);
    process.exit(0);
  }

  console.log(`\n${result.findings.length} boundary violation(s)${subject}:\n`);
  for (const f of result.findings) {
    console.log(`  ${f.file}${f.line ? `:${f.line}` : ''}   [${f.rule}]`);
    console.log(`    ${f.message}\n`);
  }
  console.log('A violation is either misplaced code or a missing edge. If the edge is genuinely\n' +
              'correct, that is a structural decision: propose it and update the map — do not\n' +
              'work around the checker in code.');
  process.exit(1);
}

function cmdWhere() {
  const model = open();
  if (!positional.length) die('usage: boundaries.mjs where <path>...');
  let missing = 0;
  for (const arg of positional) {
    const rel = norm(arg).startsWith(`${model.root}/`) ? norm(arg).slice(model.root.length + 1) : norm(arg);
    const c = model.locate(rel);
    if (!c) {
      missing += 1;
      console.log(`${rel}\n  container: (unclassified — outside every declared container path)`);
      continue;
    }
    const pure = model.pureRoot(rel);
    console.log(
      `${rel}\n  container: ${c.id}\n  layer:     ${c.layer}` +
      (c.slice ? `\n  slice:     ${c.slice}` : '') +
      (c.package ? `\n  package:   ${c.package}` : '') +
      `\n  consumes:  ${c.consumes.join(', ') || '(nothing)'}` +
      `\n  surface:   ${c.surface.join(', ')}` +
      `\n  external:  ${JSON.stringify(model.externalPolicy(c))}` +
      (pure ? `\n  PURE:      under \`${pure}/\` — imports nothing outside it, not even the` +
              `\n             rest of this container. Take data as an argument instead.` : ''));
  }
  process.exit(missing ? 1 : 0);
}

function cmdScope() {
  const model = open();
  const id = positional[0];
  if (!id) die(`usage: boundaries.mjs scope <container-id>\nknown: ${[...model.byId.keys()].join(', ')}`);
  const c = model.byId.get(id);
  if (!c) die(`unknown container \`${id}\`\nknown: ${[...model.byId.keys()].join(', ')}`);

  const allowed = model.allowed(id);
  const lines = [
    '## YOUR SCOPE',
    `layer: ${c.layer}`,
    `container: ${c.id}`,
    `you own: ${c.path}/**`,
  ];
  if (c.owns) lines.push(`this container owns: ${c.owns}`);
  lines.push(
    `you consume (read, never edit): ${allowed.map((a) => a.id).join(', ') || '(nothing — this container is a leaf of the graph)'}`,
    `public surface: ${c.surface.join(', ')} — additions here need approval`,
    `third-party imports: ${JSON.stringify(model.externalPolicy(c))}`,
    'forbidden: any import not listed above; any import of another container\'s internals;',
    '  creating a new cross-container edge (propose it and stop, do not add the import)',
    `self-check before reporting: node <plugin>/scripts/boundaries.mjs check --changed`,
  );
  console.log(lines.join('\n'));

  if (c.agent && (c.agent.model || c.agent.effort || c.agent.notes)) {
    console.log('\n# dispatch hints (apply to the spawn, not the prompt body):');
    if (c.agent.model) console.log(`#   model:  ${c.agent.model}`);
    if (c.agent.effort) console.log(`#   effort: ${c.agent.effort}`);
    if (c.agent.notes) console.log(`#   notes:  ${c.agent.notes}`);
  }
}

function cmdList() {
  const model = open();
  if (flags.has('slices')) {
    for (const [name, members] of model.slices) {
      console.log(`${name}\n  ${members.map((m) => m.id).join('\n  ')}`);
    }
    const shared = model.containers.filter((c) => c.shared);
    if (shared.length) console.log(`(shared)\n  ${shared.map((c) => c.id).join('\n  ')}`);
    return;
  }
  for (const c of model.containers) {
    const tags = [c.slice && `slice:${c.slice}`, c.shared && 'shared',
                  c.package, c.agent?.effort && `effort:${c.agent.effort}`].filter(Boolean);
    console.log(`${c.id.padEnd(32)} ${c.path}${tags.length ? `  [${tags.join(' ')}]` : ''}`);
    if (c.consumes.length) console.log(`${''.padEnd(32)}   -> ${c.consumes.join(', ')}`);
  }
}

function cmdMap() {
  const model = open();
  console.log(`${model.configPath}  (topology: ${model.policy.topology})\n`);
  for (const layer of model.layers) {
    const members = model.containers.filter((c) => c.layer === layer.id);
    const ext = layer.external === 'any' ? '' : `  external: ${JSON.stringify(layer.external)}`;
    console.log(`${layer.id}${layer.role ? `  — ${layer.role}` : ''}${ext}`);
    for (const c of members) {
      console.log(`  ${c.id.padEnd(30)} ${c.path}/`);
      for (const t of c.consumes) console.log(`  ${''.padEnd(30)}   -> ${t}`);
    }
    if (layer.index < model.layers.length - 1) console.log('  |');
  }
  console.log(`\ndirection: downward only${model.policy.skip_layers ? '' : ', no skipping'}` +
              `${model.policy.pure_paths.length ? `; pure: ${model.policy.pure_paths.join(', ')}/` : ''}`);
}

/** The compact form a coding agent gets at session start. Kept deliberately short. */
function cmdBrief() {
  const model = open({ quiet: true });
  const order = model.layers.map((l) => l.id).join(' > ');
  const lines = [
    `Architecture boundaries are enforced in this repo (claude-boundaries, ${model.configPath}).`,
    `Layers, top to bottom: ${order}. ${model.containers.length} containers.`,
    '',
    'Rules that apply to every import you write:',
    '- Dependency direction runs downward only. Never import an upper layer.',
    model.policy.skip_layers ? '- Layers may be skipped in this project.' : `- No skipping a layer.`,
    '- A container may only import what its `consumes` list names.',
    `- Cross-container imports must land on the public surface (${model.policy.public_surface.join(', ')}), never internals.`,
  ];
  if (model.policy.pure_paths.length) {
    lines.push(`- \`${model.policy.pure_paths.join('/`, `')}/\` sub-paths import nothing outside themselves — take data as an argument.`);
  }
  const restricted = model.containers.filter((c) => model.externalPolicy(c) !== 'any');
  if (restricted.length) {
    lines.push(`- Third-party imports are restricted in: ${restricted.map((c) => c.id).join(', ')}.`);
  }
  lines.push(
    '',
    'A violating edit is reported straight back to you, and you cannot finish a turn while one stands.',
    'If a new container or a new edge is genuinely the right answer, that is a structural decision:',
    'say so and stop — update the map with the user, do not add the import.',
    '',
    `Look up any file with: node "${process.env.CLAUDE_PLUGIN_ROOT ?? '<plugin>'}/scripts/boundaries.mjs" where <path>`,
  );
  console.log(lines.join('\n'));
}

function cmdSuggest() {
  const model = findConfig() ? open() : null;
  if (model) {
    console.log(`A map already exists at ${model.configPath}. Edit it rather than regenerating.`);
    process.exit(0);
  }
  console.log(suggest(process.cwd()));
}

function cmdEmit() {
  const model = open();
  const target = positional[0] || targetForLanguage(model.policy.language);
  if (!target) {
    die(`Cannot pick an emit target for policy.language ${JSON.stringify(model.policy.language)}.\n` +
        `Name one explicitly: ${Object.keys(TARGETS).join(' | ')}`);
  }
  let result;
  try { result = emit(model, target); } catch (err) { die(err.message); }
  writeFileSync(join(model.root, result.file), result.body, 'utf8');
  console.log(`wrote ${result.file}  (${result.ruleCount} rules from ${model.containers.length} containers)`);
  console.log('Generated artifact — commit it, but edit the container map and regenerate rather than\n' +
              'editing it directly. This exists for your CI; the hooks use the built-in checker.');
}

// ---------------------------------------------------------------------------

const commands = {
  validate: cmdValidate, check: cmdCheck, where: cmdWhere, scope: cmdScope,
  list: cmdList, map: cmdMap, brief: cmdBrief, suggest: cmdSuggest, emit: cmdEmit,
};

if (!command || flags.has('help') || !commands[command]) {
  const usage = [
    'usage: boundaries.mjs <command>',
    '',
    '  validate                 config coherence: direction, DAG, refs, overlaps',
    '  check [--changed]        boundary violations in the code',
    '        [--file <path>]    one file only',
    '        [--json]           machine-readable findings',
    '  where <path>...          which container owns a file',
    '  scope <container-id>     the `## YOUR SCOPE` block for a spawn prompt',
    '  map                      the layer / container graph',
    '  list [--slices]          the container / slice inventory',
    '  brief                    the short form injected into an agent\'s context',
    '  suggest                  propose a starter map for an unmapped repo',
    '  emit [target]            generate a linter config for CI',
    '',
    `  emit targets: ${Object.keys(TARGETS).join(' | ')}`,
  ].join('\n');
  if (command && !commands[command] && !flags.has('help')) die(`unknown command \`${command}\`\n\n${usage}`);
  console.log(usage);
  process.exit(0);
}

commands[command]();

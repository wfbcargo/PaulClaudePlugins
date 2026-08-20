#!/usr/bin/env node
// claude-architect — container map CLI.
//
//   validate                 config coherence: direction, DAG, refs, overlaps
//   where <path>...          which container owns a file
//   scope <container-id>     the `## YOUR SCOPE` block for a spawn prompt
//   emit [target]            generate linter config from the map
//   check [--changed]        run the linter and report boundary violations
//   list [--slices]          the container / slice inventory
//
// Exit codes: 0 clean, 1 violations found, 2 bad config or usage.

import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { findConfig, loadModel, ConfigError, norm } from './containers/model.mjs';
import { emit, TARGETS, targetForLanguage } from './containers/emit.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.slice(1).filter((a) => !a.startsWith('--'));

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

function open() {
  const configPath = findConfig();
  if (!configPath) {
    die('No .wiki/containers.yaml found. This project does not use the container model;\n' +
        'every other part of the framework works without it. To adopt it, copy\n' +
        '<plugin>/wiki-template/containers.yaml to .wiki/ and edit it.');
  }
  try {
    return { model: loadModel(configPath), root: dirname(dirname(configPath)) };
  } catch (err) {
    if (err instanceof ConfigError) die(`Invalid ${configPath}:\n${err.message}`);
    throw err;
  }
}

function changedFiles(root) {
  const run = (a) => {
    try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }); } catch { return ''; }
  };
  const merge = run(['merge-base', 'HEAD', 'origin/HEAD']).trim();
  const out = [
    run(['diff', '--name-only', merge || 'HEAD']),
    run(['diff', '--name-only', '--cached']),
    run(['ls-files', '--others', '--exclude-standard']),
  ].join('\n');
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean).map(norm));
}

// ---------------------------------------------------------------------------

function cmdValidate() {
  const { model } = open();
  console.log(`OK  ${model.configPath}`);
  console.log(`    ${model.layers.length} layers, ${model.containers.length} containers, ` +
              `${model.containers.reduce((n, c) => n + c.consumes.length, 0)} declared edges, ` +
              `${model.slices.size} slices`);
  for (const w of model.warnings) console.log(`WARN ${w}`);
  process.exit(0);
}

function cmdList() {
  const { model } = open();
  if (flags.has('--slices')) {
    for (const [name, members] of model.slices) {
      console.log(`${name}\n  ${members.map((m) => m.id).join('\n  ')}`);
    }
    const shared = model.containers.filter((c) => c.shared);
    if (shared.length) console.log(`(shared)\n  ${shared.map((c) => c.id).join('\n  ')}`);
    return;
  }
  for (const c of model.containers) {
    const tags = [c.slice && `slice:${c.slice}`, c.shared && 'shared',
                  c.agent?.effort && `effort:${c.agent.effort}`,
                  c.agent?.model && `model:${c.agent.model}`].filter(Boolean);
    console.log(`${c.id.padEnd(32)} ${c.path}${tags.length ? `  [${tags.join(' ')}]` : ''}`);
    if (c.consumes.length) console.log(`${''.padEnd(32)}   -> ${c.consumes.join(', ')}`);
  }
}

function cmdWhere() {
  const { model, root } = open();
  if (!args.length) die('usage: containers.mjs where <path>...');
  let missing = 0;
  for (const arg of args) {
    const rel = norm(relative(resolve(root), resolve(arg)) || arg);
    const c = model.locate(rel);
    if (c) {
      const pure = model.policy.pure_paths.find((p) => rel.startsWith(`${c.path}/${p}/`));
      console.log(`${rel}\n  container: ${c.id}\n  layer:     ${c.layer}` +
                  `${c.slice ? `\n  slice:     ${c.slice}` : ''}` +
                  `\n  consumes:  ${c.consumes.join(', ') || '(nothing)'}` +
                  (pure
                    ? `\n  PURE:      under \`${pure}/\` — imports nothing outside it, not even the` +
                      `\n             rest of this container. Take data as an argument instead.`
                    : ''));
    } else {
      missing += 1;
      console.log(`${rel}\n  container: (unclassified — outside every declared container path)`);
    }
  }
  process.exit(missing ? 1 : 0);
}

function cmdScope() {
  const { model } = open();
  const id = args[0];
  if (!id) die(`usage: containers.mjs scope <container-id>\nknown: ${[...model.byId.keys()].join(', ')}`);
  const c = model.byId.get(id);
  if (!c) die(`unknown container \`${id}\`\nknown: ${[...model.byId.keys()].join(', ')}`);

  const allowed = model.allowed(id);
  const lines = [
    '## YOUR SCOPE',
    `layer: ${c.layer}`,
    `container: ${c.id}`,
    `you own: ${c.path}/**`,
    `you consume (read, never edit): ${allowed.map((a) => a.id).join(', ') || '(nothing — this container is a leaf of the graph)'}`,
    `public surface: ${c.surface.join(', ')} — additions here need my approval`,
    'seam contract: .wiki/specs/<id>.md#seams — implement it exactly; do not redesign it',
    'forbidden: any import not listed above; any import of another container\'s internals;',
    '  creating a new cross-container edge (record a `## Structural proposal` and escalate instead)',
    'self-check before reporting: node <plugin>/scripts/containers.mjs check --changed',
  ];
  if (c.owns) lines.splice(4, 0, `this container owns: ${c.owns}`);
  console.log(lines.join('\n'));

  if (c.agent && (c.agent.model || c.agent.effort || c.agent.notes)) {
    console.log('\n# dispatch hints (apply to the spawn, not the prompt body):');
    if (c.agent.model) console.log(`#   model:  ${c.agent.model}`);
    if (c.agent.effort) console.log(`#   effort: ${c.agent.effort}`);
    if (c.agent.notes) console.log(`#   notes:  ${c.agent.notes}`);
  }
}

function cmdEmit() {
  const { model, root } = open();
  const target = args[0] || targetForLanguage(model.policy.language);
  if (!target) {
    die(`Cannot pick an emit target: policy.language is ${JSON.stringify(model.policy.language)}.\n` +
        `Set it, or name a target explicitly: ${Object.keys(TARGETS).join(' | ')}`);
  }
  let result;
  try { result = emit(model, target); } catch (err) { die(err.message); }
  const out = join(root, result.file);
  writeFileSync(out, result.body, 'utf8');
  console.log(`wrote ${result.file}  (${result.ruleCount} rules from ${model.containers.length} containers)`);
  console.log('Generated artifact — commit it, but edit .wiki/containers.yaml and regenerate instead of editing it directly.');
}

function cmdCheck() {
  const { model, root } = open();
  const target = args[0] || targetForLanguage(model.policy.language);
  if (!target) die(`Set policy.language in ${model.configPath}, or name a target: ${Object.keys(TARGETS).join(' | ')}`);

  const configFile = TARGETS[target]?.file;
  if (!configFile || !existsSync(join(root, configFile))) {
    die(`${configFile ?? target} not found — run:\n  node <plugin>/scripts/containers.mjs emit ${target}`);
  }

  const only = flags.has('--changed') ? changedFiles(root) : null;
  if (only && only.size === 0) { console.log('No changed files to check.'); process.exit(0); }

  let violations = [];
  try {
    if (target === 'dependency-cruiser') {
      // Pass a GLOB, not the bare root: dependency-cruiser v18 reports zero
      // modules for a directory argument, which reads as "clean" — a false
      // negative in a gate is worse than no gate. Keep the extension list in
      // sync with enhancedResolveOptions in emit.mjs.
      const target = `${model.policy.root}/**/*.{ts,tsx,js,jsx,mjs,cjs}`;
      let raw;
      try {
        raw = execFileSync('npx', ['--no-install', 'depcruise', '--config', configFile,
                                   '--output-type', 'json', target],
                           { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
      } catch (err) {
        // depcruise exits non-zero when it finds violations; the JSON is still on stdout.
        raw = err.stdout;
        if (!raw) {
          die('dependency-cruiser is not installed in this project. Install it with:\n' +
              '  npm i -D dependency-cruiser');
        }
      }
      const report = JSON.parse(raw);
      // An empty analysis must never read as a pass. If the cruiser found no
      // modules at all, the target glob or the resolver is misconfigured and
      // every rule trivially passed.
      if ((report.modules?.length ?? 0) === 0) {
        die(`dependency-cruiser analysed 0 modules under \`${target}\`.\n` +
            'That is a misconfiguration, not a clean result — check policy.root and that\n' +
            'the source extensions match. Refusing to report a pass.');
      }
      const unresolved = report.modules.flatMap((m) =>
        (m.dependencies ?? []).filter((d) => d.couldNotResolve).map((d) => `${m.source} -> ${d.module}`));
      if (unresolved.length) {
        console.error(`WARN ${unresolved.length} import(s) could not be resolved and were NOT checked:`);
        for (const u of unresolved.slice(0, 10)) console.error(`     ${u}`);
        if (unresolved.length > 10) console.error(`     ... and ${unresolved.length - 10} more`);
        console.error('     Usually a missing path alias — add it to the generated config\'s resolver options.');
      }
      violations = (report.summary?.violations ?? []).map((v) => ({
        file: norm(v.from), to: norm(v.to), rule: v.rule?.name, comment: v.comment,
      }));
    } else {
      try {
        execFileSync('lint-imports', ['--config', configFile], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
      } catch (err) {
        if (err.code === 'ENOENT') {
          die('import-linter is not installed. Install it with:\n  pip install import-linter');
        }
        process.exit(1);
      }
      console.log('OK  no boundary violations.');
      process.exit(0);
    }
  } catch (err) {
    die(`check failed: ${err.message}`);
  }

  if (only) violations = violations.filter((v) => only.has(v.file));

  if (!violations.length) {
    console.log(`OK  no boundary violations${only ? ' in changed files' : ''}.`);
    process.exit(0);
  }

  console.log(`${violations.length} boundary violation(s)${only ? ' in changed files' : ''}:\n`);
  for (const v of violations) {
    const from = model.locate(v.file), to = model.locate(v.to);
    console.log(`  ${v.file}`);
    console.log(`    imports ${v.to}`);
    console.log(`    ${from?.id ?? '(unclassified)'} -> ${to?.id ?? '(unclassified)'}   [${v.rule}]`);
    if (v.comment) console.log(`    ${v.comment}`);
    console.log('');
  }
  console.log('A violation is either misplaced code or a missing edge. If the edge is genuinely\n' +
              'correct, that is a structural decision: escalate it — do not add the import.');
  process.exit(1);
}

// ---------------------------------------------------------------------------

const commands = { validate: cmdValidate, list: cmdList, where: cmdWhere, scope: cmdScope, emit: cmdEmit, check: cmdCheck };

if (!command || flags.has('--help') || !commands[command]) {
  const usage = [
    'usage: containers.mjs <command>',
    '',
    '  validate                 config coherence: direction, DAG, refs, overlaps',
    '  list [--slices]          container / slice inventory',
    '  where <path>...          which container owns a file',
    '  scope <container-id>     the `## YOUR SCOPE` block for a spawn prompt',
    '  emit [target]            generate linter config from the map',
    '  check [--changed]        run the linter and report boundary violations',
    '',
    `  targets: ${Object.keys(TARGETS).join(' | ')}`,
  ].join('\n');
  if (command && !commands[command] && !flags.has('--help')) die(`unknown command \`${command}\`\n\n${usage}`);
  console.log(usage);
  process.exit(0);
}

commands[command]();

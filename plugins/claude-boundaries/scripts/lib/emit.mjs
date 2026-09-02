// Generate a linter config from the container map, for the project's own CI.
//
// The hooks do not use this — they use the built-in checker, which needs
// nothing installed. This exists so a repo can enforce the same map in CI with
// a tool its team already runs, and so the map stays the single source of truth
// for both. Coverage is not identical between the targets; the README says
// which half you get.
//
// The generated file is an artifact: commit it, but edit the map and
// regenerate. A hand-edited config and a map that disagree is the failure this
// whole plugin exists to prevent, reproduced one level up.

export const TARGETS = {
  'dependency-cruiser': { file: '.dependency-cruiser.json', languages: ['typescript', 'javascript'] },
  'import-linter': { file: '.importlinter', languages: ['python'] },
};

export function targetForLanguage(language) {
  return Object.entries(TARGETS).find(([, t]) => t.languages.includes(language))?.[0] ?? null;
}

export function emit(model, target) {
  if (!TARGETS[target]) {
    throw new Error(`unknown emit target \`${target}\` — expected ${Object.keys(TARGETS).join(' | ')}`);
  }
  if (!TARGETS[target].languages.includes(model.policy.language)) {
    throw new Error(`target \`${target}\` does not support policy.language \`${model.policy.language}\``);
  }
  return target === 'dependency-cruiser' ? emitDepCruiser(model) : emitImportLinter(model);
}

function emitDepCruiser(model) {
  const forbidden = [];
  const pathOf = (c) => `^${c.path}/`;

  for (const c of model.containers) {
    const allowed = model.allowed(c.id);
    // Anything inside the map that this container does not consume.
    const others = model.containers.filter((t) => t.id !== c.id && !allowed.some((a) => a.id === t.id));
    if (others.length) {
      forbidden.push({
        name: `${c.id}-undeclared`,
        severity: 'error',
        comment: `${c.id} may consume: ${allowed.map((a) => a.id).join(', ') || 'nothing'}. ` +
                 'A new edge is a structural decision — update the container map, do not add the import.',
        from: { path: pathOf(c) },
        to: { path: others.map((t) => pathOf(t)).join('|') },
      });
    }
    // Declared edges still have to enter by the front door.
    for (const a of allowed) {
      forbidden.push({
        name: `${c.id}-surface-${a.id}`.replace(/[^a-zA-Z0-9-]/g, '-'),
        severity: 'error',
        comment: `Import ${a.id} through ${a.surface.join(' or ')}, never its internals.`,
        from: { path: pathOf(c) },
        to: { path: pathOf(a), pathNot: a.surface.map((s) => `^${s.replace(/\.[^.]+$/, '')}(\\.[^.]+)?$`).join('|') },
      });
    }
    for (const pure of model.policy.pure_paths) {
      forbidden.push({
        name: `${c.id}-pure-${pure}`.replace(/[^a-zA-Z0-9-]/g, '-'),
        severity: 'error',
        comment: `${c.path}/${pure}/ is pure: it imports nothing outside itself, not even the rest of ${c.id}.`,
        from: { path: `^${c.path}/${pure}/` },
        to: { path: '.', pathNot: `^${c.path}/${pure}/`, dependencyTypesNot: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'core'] },
      });
    }
    const external = model.externalPolicy(c);
    if (external !== 'any') {
      forbidden.push({
        name: `${c.id}-external`.replace(/[^a-zA-Z0-9-]/g, '-'),
        severity: 'error',
        comment: external === 'none'
          ? `${c.id} depends on nothing third-party.`
          : `${c.id} may only import: ${external.join(', ')}.`,
        from: { path: pathOf(c), pathNot: model.policy.test_exempt.map(globToRe).join('|') || undefined },
        to: {
          dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'],
          pathNot: Array.isArray(external) && external.length
            ? external.map((e) => `node_modules/${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`).join('|')
            : undefined,
        },
      });
    }
  }

  const body = {
    $schema: 'https://raw.githubusercontent.com/sverweij/dependency-cruiser/main/src/schema/configuration.schema.json',
    forbidden,
    options: {
      doNotFollow: { path: 'node_modules' },
      tsPreCompilationDeps: model.policy.type_imports === 'edge',
      enhancedResolveOptions: {
        extensions: model.policy.extensions,
        mainFields: ['module', 'main', 'types', 'typings'],
      },
    },
  };
  return {
    file: TARGETS['dependency-cruiser'].file,
    ruleCount: forbidden.length,
    body: `${JSON.stringify(body, null, 2)}\n`,
  };
}

function globToRe(glob) {
  return glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(.*/)?').replace(/\*/g, '[^/]*');
}

function emitImportLinter(model) {
  const mod = (p) => p.replace(/\//g, '.');
  const lines = [
    '# Generated from the container map by claude-boundaries. Do not hand-edit —',
    '# edit the map and regenerate. import-linter contracts are module-level, so',
    '# the public-surface rule (R4) and within-container purity are NOT covered',
    '# here; the built-in checker enforces those and the hooks use it.',
    '',
    '[importlinter]',
    `root_packages = ${[...new Set(model.containers.map((c) => c.path.split('/')[0]))].join(' ')}`,
    '',
    '[importlinter:contract:layers]',
    'name = Layer direction',
    'type = layers',
    'layers =',
  ];
  for (const layer of model.layers) {
    const members = model.containers.filter((c) => c.layer === layer.id).map((c) => mod(c.path));
    if (members.length) lines.push(`    ${members.join(' | ')}`);
  }
  lines.push('');

  let n = 0;
  for (const c of model.containers) {
    const allowed = new Set(model.allowed(c.id).map((a) => a.id));
    const forbidden = model.containers.filter((t) => t.id !== c.id && !allowed.has(t.id));
    if (!forbidden.length) continue;
    n += 1;
    lines.push(
      `[importlinter:contract:undeclared-${n}]`,
      `name = ${c.id} may only consume ${[...allowed].join(', ') || 'nothing'}`,
      'type = forbidden',
      `source_modules = ${mod(c.path)}`,
      'forbidden_modules =',
      ...forbidden.map((t) => `    ${mod(t.path)}`),
      '',
    );
  }
  for (const c of model.containers) {
    for (const pure of model.policy.pure_paths) {
      const others = model.containers.filter((t) => t.id !== c.id);
      if (!others.length) continue;
      n += 1;
      lines.push(
        `[importlinter:contract:pure-${n}]`,
        `name = ${c.id}/${pure} is pure`,
        'type = forbidden',
        `source_modules = ${mod(`${c.path}/${pure}`)}`,
        'forbidden_modules =',
        ...others.map((t) => `    ${mod(t.path)}`),
        '',
      );
    }
  }
  return { file: TARGETS['import-linter'].file, ruleCount: n + 1, body: `${lines.join('\n')}\n` };
}

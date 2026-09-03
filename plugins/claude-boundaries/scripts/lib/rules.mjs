// The rules. Every judgement this plugin makes about *code* is here; model.mjs
// judges the config, and nothing else decides anything.
//
//   R1 direction        never import an upper layer
//   R2 no-skip          surface may not reach engine directly
//   R3 declared edge    the target must be listed in `consumes`
//   R4 public surface   a cross-container import lands on the surface file
//   R5 purity           a `pure_paths` folder imports nothing outside itself
//   R6 escape           a relative import may not leave its own container
//   R7 external         third-party imports obey the layer's `external:` rule
//   R8 manifest         package.json deps agree with declared `consumes`
//   R9 owned types      `import type` is an edge like any other
//
// One import produces at most one finding, and the rules are evaluated from
// most specific to most general. Reporting a single relative cross-layer import
// as four separate violations tells the reader nothing the first one didn't,
// and an agent handed four findings will try to fix four things.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { norm, isUnder, globToRegExp } from './model.mjs';
import { createResolver, packageNameOf } from './resolve.mjs';
import { scanTs, scanWithTypeScript } from './scan-ts.mjs';
import { scanPy } from './scan-py.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '__pycache__', '.venv', 'venv']);

/** All source files under a directory, repo-relative, respecting the language's extensions. */
export function listSourceFiles(root, dir, extensions) {
  const files = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (extensions.some((x) => e.name.endsWith(x))) files.push(norm(child));
    }
  };
  walk(norm(dir));
  return files;
}

/** Every source file the map claims — the default subject of a full check. */
export function containerFiles(model) {
  const out = [];
  for (const c of model.containers) out.push(...listSourceFiles(model.root, c.path, model.policy.extensions));
  return out;
}

function loadTypeScript(root) {
  // Opportunistic: when the project has the real compiler, use it. The hand
  // scanner stays the tested default so a repo with nothing installed is still
  // checked — but where TypeScript is present it is the better oracle.
  try {
    const req = createRequire(join(root, 'package.json'));
    return req('typescript');
  } catch { return null; }
}

/**
 * Check a set of files against the map.
 * @returns {{ findings: object[], warnings: object[], scanned: number, unresolved: object[] }}
 */
export function check(model, files, options = {}) {
  const resolver = options.resolver ?? createResolver(model);
  const ts = model.policy.language === 'python' ? null : (options.ts ?? loadTypeScript(model.root));
  const findings = [];
  const warnings = [];
  const unresolved = [];
  let scanned = 0;

  for (const file of files) {
    const from = model.locate(file);
    if (!from) continue;               // unclassified files are handled separately
    const abs = join(model.root, file);
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    scanned += 1;

    const imports = model.policy.language === 'python'
      ? scanPy(text)
      : (ts ? scanWithTypeScript(text, abs, ts) : scanTs(text));

    for (const imp of imports) {
      const finding = judge(model, resolver, from, file, imp, unresolved);
      if (finding) findings.push(finding);
    }
  }

  findings.push(...manifestFindings(model));
  const unclassified = unclassifiedFindings(model, resolver);
  if (model.policy.unclassified === 'error') findings.push(...unclassified);
  else if (model.policy.unclassified === 'warn') warnings.push(...unclassified);

  if (unresolved.length && model.policy.unresolved === 'error') {
    findings.push(...unresolved);
  } else {
    warnings.push(...unresolved);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, warnings, scanned, unresolved };
}

const finding = (rule, file, line, message, extra = {}) =>
  ({ rule, file, line, message, ...extra });

/** Judge one import. Returns at most one finding — the most specific that applies. */
function judge(model, resolver, from, file, imp, unresolved) {
  const { specifier, line, typeOnly } = imp;
  const r = resolver.resolve(specifier, file);

  if (r.kind === 'builtin') return null;

  // R9 — a type-only import is a dependency unless the project says otherwise.
  // TypeScript erases it at runtime, which is exactly why it gets waved through
  // in review: the coupling is real, the emitted JS just doesn't show it.
  if (typeOnly && model.policy.type_imports === 'ignore') return null;

  if (r.kind === 'external') {
    return externalFinding(model, from, file, line, r, typeOnly);
  }

  if (r.kind === 'unresolved') {
    unresolved.push(finding('unresolved', file, line,
      `\`${specifier}\` could not be resolved, so no rule could be applied to it — this import is unchecked, not clean.`,
      { from: from.id, to: null, specifier }));
    return null;
  }

  const target = model.locate(r.file);

  // R5 — purity. Checked first because it is stricter than the container's own
  // edges: `orchestration/auth` may call `engine/token`, but
  // `orchestration/auth/domain` may not. If you cannot unit-test a rule without
  // stubbing an I/O call, the layers have collapsed, and this is the rule that
  // holds them apart.
  const pure = model.pureRoot(file);
  if (pure && !isUnder(r.file, pure)) {
    return finding('R5-purity', file, line,
      `\`${pure}/\` is a pure path: it may import nothing outside itself, not even the rest of \`${from.id}\`. ` +
      `\`${specifier}\` resolves to \`${r.file}\`. A rule that needs data takes it as an argument.`,
      { from: from.id, to: target?.id ?? null, specifier });
  }

  if (target && target.id === from.id) return null;   // inside its own container

  // R6 — a relative import that leaves the container. Under `packages` this is
  // the evasion that matters: it bypasses the package.json dependency graph
  // entirely, so every other manifest-level guarantee stops meaning anything.
  if (specifier.startsWith('.') && model.policy.relative_escape === 'forbid') {
    return finding('R6-escape', file, line,
      `relative import \`${specifier}\` escapes \`${from.id}\` (\`${from.path}/\`). ` +
      `Cross-container imports must go through the target's declared package name, not a path.`,
      { from: from.id, to: target?.id ?? null, specifier });
  }

  if (!target) {
    if (model.policy.unclassified === 'ignore') return null;
    return finding('R0-unclassified-target', file, line,
      `\`${specifier}\` resolves to \`${r.file}\`, which belongs to no container. ` +
      `An unclassified target is an unchecked one — give it a container or move the code into one.`,
      { from: from.id, to: null, specifier, severity: model.policy.unclassified });
  }

  const fromLayer = model.layerIndex.get(from.layer);
  const toLayer = model.layerIndex.get(target.layer);
  const delta = toLayer - fromLayer;

  // R1 — direction.
  if (delta < 0) {
    return finding('R1-direction', file, line,
      `\`${from.id}\` (${from.layer}) may not import \`${target.id}\` (${target.layer}) — that is an upward dependency. ` +
      `Dependency direction runs downward only; invert it with a callback, an event, or a port owned by the lower layer.`,
      { from: from.id, to: target.id, specifier });
  }

  // R2 — no skipping.
  if (delta > 1 && !model.policy.skip_layers) {
    const skipped = model.layers.slice(fromLayer + 1, toLayer).map((l) => l.id).join(', ');
    return finding('R2-skip', file, line,
      `\`${from.id}\` (${from.layer}) reaches past ${skipped} to \`${target.id}\` (${target.layer}). ` +
      `Route it through ${skipped}, or set policy.skip_layers if the architecture genuinely allows it.`,
      { from: from.id, to: target.id, specifier });
  }

  // R3 — declared edges only.
  if (!from.consumes.includes(target.id)) {
    const allowed = model.allowed(from.id).map((c) => c.id).join(', ') || '(nothing)';
    const intra = delta === 0 && model.layers[fromLayer].intra_layer !== 'declared'
      ? ` Layer \`${from.layer}\` sets intra_layer: none, so its containers may not call each other at all.`
      : '';
    return finding('R3-undeclared', file, line,
      `\`${from.id}\` imports \`${target.id}\`, which is not in its \`consumes\`. It may consume: ${allowed}.${intra} ` +
      `A new edge is a structural decision — propose it, do not add the import.`,
      { from: from.id, to: target.id, specifier });
  }

  // R4 — public surface. A declared edge still has to enter by the front door.
  if (!target.surface.includes(r.file) && !(r.viaPackage && !r.subpath)) {
    return finding('R4-surface', file, line,
      `\`${specifier}\` reaches into \`${target.id}\`'s internals (\`${r.file}\`). ` +
      `Its public surface is ${target.surface.join(', ')} — import from there, and if what you need is not exported, that is a seam change.`,
      { from: from.id, to: target.id, specifier });
  }

  return null;
}

/** R7 — third-party imports, judged against the effective `external:` rule. */
function externalFinding(model, from, file, line, r, typeOnly) {
  const policy = model.externalPolicy(from);
  if (policy === 'any') return null;

  // The one documented softness, inherited from AgentNexus: a test file may
  // bare-import its runner. R1-R6 still apply to tests, which is what keeps a
  // kernel's tests on local fakes rather than on real connectors.
  if (model.isTestFile(file)) return null;

  const pkg = r.pkg;
  if (Array.isArray(policy)) {
    if (policy.some((allowed) => pkg === allowed || pkg.startsWith(`${allowed}/`))) return null;
    return finding('R7-external', file, line,
      `\`${from.id}\` imports \`${r.specifier}\`. This container may only import: ${policy.join(', ')}. ` +
      `A third-party client here is usually the wrong layer holding it.`,
      { from: from.id, to: null, specifier: r.specifier, typeOnly });
  }
  // policy === 'none'
  return finding('R7-external', file, line,
    `\`${from.id}\` imports \`${r.specifier}\`, and this container is declared \`external: none\` — it depends on nothing. ` +
    `This holds regardless of which dependency map, if any, declares \`${pkg}\`. If it genuinely needs this, the contract is wrong: escalate rather than allowlisting.`,
    { from: from.id, to: null, specifier: r.specifier, typeOnly });
}

/**
 * R8 — the manifest must agree with the map (packages topology).
 *
 * The import check above is the one that matters, but it cannot see a
 * dependency that is declared and not yet imported, and a manifest is a
 * statement of intent that outlives any particular file. Both halves, because
 * either alone has a hole: AgentNexus found a concrete store hiding in
 * `devDependencies`, which resolves, compiles and ships exactly like a runtime
 * dependency — so the import site is checked regardless of any map, and the
 * map is checked regardless of any import.
 */
function manifestFindings(model) {
  if (model.policy.topology !== 'packages') return [];
  const out = [];
  for (const c of model.containers) {
    const manifest = join(model.root, c.path, 'package.json');
    if (!existsSync(manifest)) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); } catch { continue; }

    // devDependencies is deliberately excluded: it legitimately holds vitest,
    // eslint and typescript in every package in a workspace, and merging it in
    // would false-positive on all of them. The runtime-reachability question it
    // leaves open is answered at the import site by R7.
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    const allowedPackages = new Set(model.allowed(c.id).map((t) => t.package).filter(Boolean));
    const external = model.externalPolicy(c);

    for (const dep of deps) {
      const target = model.byPackage.get(dep);
      if (target) {
        if (!allowedPackages.has(dep)) {
          out.push(finding('R8-manifest', `${c.path}/package.json`, 0,
            `\`${c.id}\` declares a dependency on \`${dep}\` (\`${target.id}\`), which is not in its \`consumes\`. ` +
            `The manifest and the map disagree — fix whichever is wrong, but they may not differ.`,
            { from: c.id, to: target.id, specifier: dep }));
        }
        continue;
      }
      if (external === 'any') continue;
      if (Array.isArray(external) && external.some((a) => dep === a || dep.startsWith(`${a}/`))) continue;
      out.push(finding('R8-manifest', `${c.path}/package.json`, 0,
        external === 'none'
          ? `\`${c.id}\` is declared \`external: none\` but takes a runtime dependency on \`${dep}\`.`
          : `\`${c.id}\` takes a runtime dependency on \`${dep}\`, outside its allowlist [${external.join(', ')}].`,
        { from: c.id, to: null, specifier: dep }));
    }
  }
  return out;
}

/**
 * Fail closed on source that belongs to no container.
 *
 * This is the half a path-matching checker forgets. An unclassified package is
 * not merely unscanned — it is also an unclassified import *target*, so any
 * container can import it and the edge check has nothing to compare against. A
 * `packages/storage` that no layer claims, depended on by the kernel, passes
 * every other rule in this file.
 */
function unclassifiedFindings(model, resolver) {
  const out = [];
  if (model.policy.topology === 'packages') {
    for (const [name, dir] of resolver.packages) {
      if (model.byPackage.has(name)) continue;
      if (model.containers.some((c) => c.path === dir)) continue;
      out.push(finding('R0-unclassified', `${dir}/package.json`, 0,
        `package \`${name}\` (\`${dir}/\`) is in the workspace but not in the container map. ` +
        `Until it is classified it may be imported by anything, with no edge to check — give it a container, or exclude its directory from policy.package_roots.`,
        { from: null, to: null, specifier: name }));
    }
    return out;
  }
  const claimed = model.containers.map((c) => c.path);
  for (const file of listSourceFiles(model.root, model.policy.root, model.policy.extensions)) {
    if (claimed.some((p) => isUnder(file, p))) continue;
    out.push(finding('R0-unclassified', file, 0,
      `\`${file}\` is under policy.root \`${model.policy.root}\` but inside no container, so nothing constrains what it imports or who imports it.`,
      { from: null, to: null, specifier: null }));
  }
  return out;
}

export { globToRegExp };

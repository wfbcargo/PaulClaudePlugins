// Turn a module specifier into something the rules can reason about.
//
// Every specifier resolves to exactly one of four outcomes:
//
//   { kind: 'internal', file }      a file inside this repo
//   { kind: 'external', pkg }       a third-party package (R7 / R8 judge it)
//   { kind: 'builtin' }             node:* / a Python stdlib-shaped name — never a violation
//   { kind: 'unresolved' }          nothing matched
//
// The fourth is the dangerous one and is why it is a named outcome rather than
// a silent skip: an import that resolves to nothing matches no rule, so it is
// *unchecked*, not clean. Both AgentNexus's checker and dependency-cruiser
// learned to report these; a boundary check whose resolver quietly fails reads
// as a pass and is worse than no check at all.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { norm, globToRegExp } from './model.mjs';

const NODE_BUILTIN = /^node:/;
// Node's legacy unprefixed built-ins. Kept short and explicit: guessing wrong
// in either direction is a wrong verdict, not a warning.
const LEGACY_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const CANDIDATE_SUFFIXES = [
  '', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.mts', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs',
];

/** The npm package name a specifier addresses: `@scope/pkg/sub` -> `@scope/pkg`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Read a JSON file, returning null rather than throwing on anything unreadable. */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Build the resolution context for a repo once, then reuse it for every file.
 * Reading tsconfig and the workspace manifests per-import would dominate the
 * runtime of a hook that fires on every edit.
 */
export function createResolver(model) {
  const root = model.root;
  const aliases = model.policy.language === 'python' ? [] : loadAliases(root);
  const packages = loadWorkspacePackages(root, model);
  const containerPackages = new Map(
    model.containers.filter((c) => c.package).map((c) => [c.package, c.path]),
  );

  /** Probe a repo-relative path (extension-less) for a real file. */
  const probe = (relPath) => {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = `${relPath}${suffix}`;
      const abs = join(root, candidate);
      if (existsSync(abs)) {
        try { if (statSync(abs).isFile()) return norm(candidate); } catch { /* race — treat as miss */ }
      }
    }
    return null;
  };

  /**
   * @param {string} specifier
   * @param {string} fromFile  repo-relative path of the importing file
   */
  function resolve(specifier, fromFile) {
    if (model.policy.language === 'python') return resolvePython(specifier, fromFile);

    if (NODE_BUILTIN.test(specifier)) return { kind: 'builtin', pkg: specifier };

    if (specifier.startsWith('.')) {
      const target = norm(relative(root, resolvePath(join(root, dirname(fromFile)), specifier)));
      // A relative import may legitimately point at a file that does not exist
      // yet (generated output, or a sibling an agent is about to write). Report
      // the *intended* path so the direction rules can still judge it, and flag
      // that it did not land on disk.
      const hit = probe(target);
      return hit
        ? { kind: 'internal', file: hit, specifier }
        : { kind: 'internal', file: target, specifier, missing: true };
    }

    // A workspace package, by name — the edge that makes `packages` topology work.
    const pkg = packageNameOf(specifier);
    const subpath = specifier.slice(pkg.length).replace(/^\//, '');
    const dir = containerPackages.get(pkg) ?? packages.get(pkg);
    if (dir) {
      // Strip any subpath before deciding: `@app/kernel/dist/x.js` must land in
      // the same container as `@app/kernel`, or a deep import evades the check.
      const file = subpath ? (probe(`${dir}/${subpath}`) ?? `${dir}/${subpath}`) : (probe(dir) ?? dir);
      return { kind: 'internal', file: norm(file), specifier, viaPackage: pkg, subpath };
    }

    for (const { re, targets } of aliases) {
      const m = re.exec(specifier);
      if (!m) continue;
      for (const target of targets) {
        const candidate = norm(target.replace('*', m[1] ?? ''));
        const hit = probe(candidate);
        if (hit) return { kind: 'internal', file: hit, specifier, viaAlias: true };
      }
    }

    if (LEGACY_BUILTINS.has(pkg)) return { kind: 'builtin', pkg };
    if (existsSync(join(root, 'node_modules', pkg))) return { kind: 'external', pkg, specifier };
    // Not on disk anywhere. It is still almost certainly a package name — a
    // repo whose dependencies are not installed must not read as clean, but
    // neither should every import become a violation. Treat it as external and
    // let R7/R8 judge it against the declared allowlist, which is a statement
    // about intent and does not need node_modules to exist.
    return { kind: 'external', pkg, specifier, uninstalled: true };
  }

  function resolvePython(specifier, fromFile) {
    if (specifier.startsWith('.')) {
      const up = /^\.+/.exec(specifier)[0].length;
      const rest = specifier.slice(up).replace(/\./g, '/');
      let base = dirname(fromFile);
      for (let i = 1; i < up; i++) base = dirname(base);
      const target = norm(join(base, rest));
      for (const suffix of ['.py', '.pyi', '/__init__.py', '']) {
        if (existsSync(join(root, `${target}${suffix}`))) return { kind: 'internal', file: norm(`${target}${suffix}`), specifier };
      }
      return { kind: 'internal', file: target, specifier, missing: true };
    }
    const asPath = specifier.replace(/\./g, '/');
    for (const suffix of ['.py', '.pyi', '/__init__.py']) {
      if (existsSync(join(root, `${asPath}${suffix}`))) return { kind: 'internal', file: norm(`${asPath}${suffix}`), specifier };
      const underRoot = `${model.policy.root}/${asPath}${suffix}`;
      if (existsSync(join(root, underRoot))) return { kind: 'internal', file: norm(underRoot), specifier };
    }
    return { kind: 'external', pkg: specifier.split('.')[0], specifier };
  }

  return { resolve, packages, aliases };
}

/** tsconfig / jsconfig `baseUrl` + `paths`, following `extends`. */
function loadAliases(root) {
  const out = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const seen = new Set();
    let file = join(root, name);
    let baseUrl = null;
    let paths = null;
    // Follow `extends` until the innermost config that defines paths wins.
    while (existsSync(file) && !seen.has(file)) {
      seen.add(file);
      const json = readJson(file);
      if (!json) break;
      const co = json.compilerOptions ?? {};
      if (baseUrl == null && co.baseUrl != null) baseUrl = norm(join(relative(root, dirname(file)) || '.', co.baseUrl));
      if (paths == null && co.paths) paths = { dir: norm(relative(root, dirname(file)) || '.'), map: co.paths };
      if (!json.extends) break;
      const next = String(json.extends);
      file = next.startsWith('.') ? resolvePath(dirname(file), next) : join(root, 'node_modules', next);
      if (!file.endsWith('.json')) file += '.json';
    }
    if (!paths) continue;
    const prefix = baseUrl ?? paths.dir;
    for (const [pattern, targets] of Object.entries(paths.map)) {
      const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('(.*)')}$`);
      out.push({
        re,
        targets: [].concat(targets).map((t) => norm(join(prefix === '.' ? '' : prefix, t))),
      });
    }
  }
  return out;
}

/** Map every workspace package name to its repo-relative directory. */
function loadWorkspacePackages(root, model) {
  const map = new Map();
  const globs = new Set(model.policy.package_roots);

  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    for (const line of readFileSync(pnpm, 'utf8').split(/\r?\n/)) {
      const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
      if (m) globs.add(norm(m[1]));
    }
  }
  const rootPkg = readJson(join(root, 'package.json'));
  const ws = Array.isArray(rootPkg?.workspaces) ? rootPkg.workspaces : rootPkg?.workspaces?.packages;
  for (const g of ws ?? []) globs.add(norm(g));

  for (const glob of globs) {
    const re = globToRegExp(glob.replace(/\/\*\*$/, '/*'));
    for (const dir of expand(root, glob)) {
      if (!re.test(dir)) continue;
      const pkg = readJson(join(root, dir, 'package.json'));
      if (pkg?.name && !map.has(pkg.name)) map.set(pkg.name, dir);
    }
  }
  return map;
}

/** Expand a `a/*`-style glob to existing directories, without a glob library. */
function expand(root, glob) {
  const parts = norm(glob).split('/');
  let dirs = [''];
  for (const part of parts) {
    const next = [];
    for (const d of dirs) {
      const abs = join(root, d);
      if (part === '*' || part === '**') {
        let entries = [];
        try { entries = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
          next.push(d ? `${d}/${e.name}` : e.name);
        }
      } else {
        const candidate = d ? `${d}/${part}` : part;
        if (existsSync(join(root, candidate))) next.push(candidate);
      }
    }
    dirs = next;
  }
  return dirs;
}

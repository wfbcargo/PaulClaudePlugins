// The hooks are tested by running them the way Claude Code does: a real child
// process, hook JSON on stdin, and assertions on the exit code and stdout.
//
// The no-op cases matter most. A hook that misbehaves in a project that never
// adopted the model would get the plugin uninstalled, and a hook that throws
// on a malformed map would wedge every session in the repo that needs it most.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRepo, cleanup, FOLDER_MAP } from './helpers.mjs';

after(cleanup);

const HOOKS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks');

/** Run a hook exactly as the harness does. Returns { code, stdout, stderr }. */
function runHook(name, input) {
  try {
    const stdout = execFileSync(process.execPath, [join(HOOKS, name)], {
      input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const clean = () => makeRepo({
  '.wiki/containers.yaml': FOLDER_MAP,
  'src/user/api/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const routes = login;',
  'src/orchestration/auth/index.ts': 'export const login = 1;',
  'src/engine/db/index.ts': 'export const find = 1;',
});

const dirty = () => makeRepo({
  '.wiki/containers.yaml': FOLDER_MAP,
  'src/user/api/index.ts': 'export const routes = 1;',
  'src/orchestration/auth/index.ts': 'export const login = 1;',
  'src/engine/db/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const find = login;',
});

test('SessionStart states the rules as additionalContext', () => {
  const { code, stdout } = runHook('session-brief.mjs', { cwd: clean() });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /user > orchestration > engine/);
  assert.match(ctx, /downward only/);
  assert.match(ctx, /structural decision/);
});

test('every hook is a silent no-op in a project with no container map', () => {
  const bare = makeRepo({ 'src/index.ts': 'export const x = 1;' });
  for (const hook of ['session-brief.mjs', 'post-edit.mjs', 'stop-gate.mjs']) {
    const r = runHook(hook, { cwd: bare, tool_input: { file_path: join(bare, 'src/index.ts') } });
    assert.equal(r.code, 0, `${hook} should exit 0`);
    assert.equal(r.stdout.trim(), '', `${hook} should say nothing`);
  }
});

test('every hook fails open on a malformed map rather than wedging the session', () => {
  // A checker whose own config has a typo must not be able to stop work. It
  // goes quiet; `validate` is where a broken map gets reported.
  const broken = makeRepo({
    '.wiki/containers.yaml': 'version: 1\nlayers: [{ id: a }]\ncontainers:\n  - id: bad\n    path: src/x\n',
    'src/x/index.ts': 'export const x = 1;',
  });
  for (const hook of ['session-brief.mjs', 'post-edit.mjs', 'stop-gate.mjs']) {
    const r = runHook(hook, { cwd: broken, tool_input: { file_path: join(broken, 'src/x/index.ts') } });
    assert.equal(r.code, 0, `${hook} should exit 0 on a broken map`);
  }
});

test('PostToolUse exits 2 with the reason when the edited file violates', () => {
  const root = dirty();
  const r = runHook('post-edit.mjs', {
    cwd: root, tool_input: { file_path: join(root, 'src/engine/db/index.ts') },
  });
  assert.equal(r.code, 2, 'exit 2 is what puts the message in front of the agent');
  assert.match(r.stderr, /R1-direction/);
  assert.match(r.stderr, /engine\/db/);
  assert.match(r.stderr, /may import/);
});

test('PostToolUse is silent on a clean file, and on files outside the map', () => {
  const root = clean();
  assert.equal(runHook('post-edit.mjs', { cwd: root, tool_input: { file_path: join(root, 'src/user/api/index.ts') } }).code, 0);
  assert.equal(runHook('post-edit.mjs', { cwd: root, tool_input: { file_path: join(root, '.wiki/containers.yaml') } }).code, 0);
  assert.equal(runHook('post-edit.mjs', { cwd: root, tool_input: {} }).code, 0);
});

test('PostToolUse blames only the file that was edited', () => {
  // The map-wide checks are the Stop gate's business. Reporting them here would
  // blame this edit for something it did not do, and an agent that is blamed
  // for unrelated findings learns to ignore the hook.
  const root = makeRepo({
    '.wiki/containers.yaml': FOLDER_MAP,
    'src/user/api/index.ts': 'export const routes = 1;',
    'src/orchestration/auth/index.ts': 'export const login = 1;',
    'src/engine/db/index.ts': 'import { login } from "../../orchestration/auth/index";\nexport const find = login;',
  });
  const r = runHook('post-edit.mjs', { cwd: root, tool_input: { file_path: join(root, 'src/user/api/index.ts') } });
  assert.equal(r.code, 0);
});

test('Stop blocks while a violation stands, and yields on the second pass', () => {
  const root = dirty();
  // No git repo in the fixture, so `--changed` sees nothing; drive the gate
  // through the same path by initialising one with the files untracked.
  execFileSync('git', ['init', '-q'], { cwd: root });

  const blocked = runHook('stop-gate.mjs', { cwd: root });
  assert.equal(blocked.code, 0, 'the hook itself succeeds; the decision is in its payload');
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /R1-direction/);
  assert.match(decision.reason, /Do not silence the check/);

  // Second time through, the agent has already been told once. Blocking again
  // on findings it cannot fix would be an unbreakable loop.
  const second = runHook('stop-gate.mjs', { cwd: root, stop_hook_active: true });
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.decision, undefined, 'must not block twice on the same findings');
  assert.match(payload.systemMessage, /still stand/);
});

test('Stop says nothing when the changed files are clean', () => {
  const root = clean();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const r = runHook('stop-gate.mjs', { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

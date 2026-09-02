#!/usr/bin/env node
// Stop / SubagentStop — the hard gate. An agent does not get to finish a turn
// with a boundary violation standing in the working tree.
//
// This is the half that makes the model an invariant rather than a suggestion.
// The PostToolUse hook can be worked around by an agent that decides the
// message was advisory; this one cannot, because the turn does not end.
//
// Two escapes are deliberate:
//
//   - `stop_hook_active` means we already blocked once and the agent is
//     continuing because of it. Blocking again on the same findings risks an
//     unbreakable loop when the agent genuinely cannot fix them, so the second
//     time through we let it stop and say what is still wrong. The user, not
//     the hook, decides what happens next.
//   - Anything unexpected exits 0. See _shared.mjs.

import { readInput, openModel, formatFindings } from './_shared.mjs';
import { check, containerFiles } from '../scripts/lib/rules.mjs';
import { execFileSync } from 'node:child_process';
import { norm } from '../scripts/lib/model.mjs';

const input = await readInput();
const model = openModel(input.cwd);
if (!model) process.exit(0);

function changedFiles(root) {
  const run = (a) => {
    try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }); } catch { return ''; }
  };
  const mergeBase = run(['merge-base', 'HEAD', 'origin/HEAD']).trim();
  return new Set([
    run(['diff', '--name-only', mergeBase || 'HEAD']),
    run(['diff', '--name-only', '--cached']),
    run(['ls-files', '--others', '--exclude-standard']),
  ].join('\n').split('\n').map((s) => s.trim()).filter(Boolean).map(norm));
}

let result;
try {
  const changed = changedFiles(model.root);
  const files = containerFiles(model).filter((f) => changed.has(f));
  if (!files.length) process.exit(0);
  result = check(model, files);
} catch {
  process.exit(0);
}

// Findings in files this session actually touched. The map-wide checks
// (unclassified packages, manifest drift) are real but may predate the session,
// and blocking an agent for something it did not do teaches it to distrust the
// gate.
const changedFindings = result.findings.filter((f) => f.rule !== 'R0-unclassified');
if (!changedFindings.length) process.exit(0);

const summary = formatFindings(changedFindings, model);

if (input.stop_hook_active) {
  process.stdout.write(JSON.stringify({
    systemMessage:
      `${changedFindings.length} boundary violation(s) still stand after a retry — not blocking again.\n\n${summary}`,
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason:
    `You cannot finish while ${changedFindings.length} boundary violation(s) stand in files this session changed.\n\n` +
    `${summary}\n\n` +
    'Fix them, or — if the structure itself is wrong — stop and tell the user which edge you believe ' +
    'the architecture is missing and why. Do not silence the check.',
}));

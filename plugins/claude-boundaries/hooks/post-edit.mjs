#!/usr/bin/env node
// PostToolUse on Edit|Write|MultiEdit|NotebookEdit — check the file that just
// changed and, on a violation, hand the agent the reason immediately.
//
// Why *after* the write rather than denying it beforehand: an Edit gives the
// hook only the old and new strings, so a PreToolUse check would have to
// reconstruct the resulting file and would deny wrongly whenever it got that
// reconstruction wrong. A wrong deny wedges the agent with no way forward,
// which is a worse failure than a violation that lives for one turn. Reading
// the file from disk afterwards is exact, and exit 2 puts the message in front
// of the agent while it is still working on that file.

import { readInput, openModel, formatFindings } from './_shared.mjs';
import { check } from '../scripts/lib/rules.mjs';
import { norm } from '../scripts/lib/model.mjs';

const input = await readInput();
const model = openModel(input.cwd);
if (!model) process.exit(0);

const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!raw) process.exit(0);

const abs = norm(raw);
const file = abs.startsWith(`${model.root}/`) ? abs.slice(model.root.length + 1) : abs;

// Only files the map actually claims, and only languages it can read. Anything
// else is silence — the hook must be invisible outside its subject.
if (!model.locate(file)) process.exit(0);
if (!model.policy.extensions.some((ext) => file.endsWith(ext))) process.exit(0);

let result;
try {
  result = check(model, [file]);
} catch {
  process.exit(0);
}

// Only findings in the edited file itself. The manifest and unclassified checks
// run over the whole map and are the Stop gate's business — reporting them here
// would blame this edit for something it did not do.
const mine = result.findings.filter((f) => f.file === file);
if (!mine.length) process.exit(0);

const container = model.locate(file);
const allowed = model.allowed(container.id).map((c) => c.id).join(', ') || '(nothing)';

process.stderr.write(
  `Boundary violation in the file you just edited (${container.id}):\n\n` +
  `${formatFindings(mine, model)}\n\n` +
  `\`${container.id}\` may import: ${allowed}.\n`,
);
process.exit(2);

#!/usr/bin/env node
// SessionStart — tell the agent the rules before it writes a line.
//
// This is the hook that makes a *new* agent follow the model. Everything else
// in this plugin reacts to a violation after the fact; this is the only part
// that prevents one. It stays short on purpose: it is paid for on every
// session, and a wall of architecture prose gets skimmed exactly like the
// README it replaced.

import { readInput, openModel, respond } from './_shared.mjs';

const input = await readInput();
const model = openModel(input.cwd);
if (!model) process.exit(0);

const order = model.layers.map((l) => l.id).join(' > ');
const lines = [
  `## Architecture boundaries (enforced — claude-boundaries)`,
  '',
  `This repo declares its structure in \`${model.configPath}\`: ${model.containers.length} containers across ${model.layers.length} layers, ${order} (top to bottom).`,
  '',
  'Rules that apply to every import you write:',
  '- Dependency direction runs downward only — never import an upper layer.',
  model.policy.skip_layers
    ? '- Layers may be skipped in this project.'
    : '- No skipping a layer.',
  '- A container may only import the containers its `consumes` list names.',
  `- Cross-container imports land on the public surface (${model.policy.public_surface.join(', ')}), never on internals.`,
];
if (model.policy.pure_paths.length) {
  lines.push(`- \`${model.policy.pure_paths.join('/`, `')}/\` sub-paths import nothing outside themselves — a rule that needs data takes it as an argument.`);
}
const restricted = model.containers.filter((c) => model.externalPolicy(c) !== 'any');
if (restricted.length) {
  lines.push(`- Third-party imports are restricted in: ${restricted.map((c) => c.id).join(', ')}.`);
}

const cli = `node "${process.env.CLAUDE_PLUGIN_ROOT ?? '<plugin>'}/scripts/boundaries.mjs"`;
lines.push(
  '',
  'A violating edit is reported straight back to you, and you cannot finish a turn while one stands.',
  '**A new container or a new cross-container edge is a structural decision, not an implementation',
  'detail.** If that is genuinely the right answer, say so and stop — the map is changed with the',
  'user, never worked around in code.',
  '',
  `Which container owns a file, and what it may consume: \`${cli} where <path>\``,
  `The whole graph: \`${cli} map\``,
);

respond({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines.join('\n'),
  },
});

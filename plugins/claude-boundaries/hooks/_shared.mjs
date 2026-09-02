// Common plumbing for the three hooks.
//
// The hooks import the checker in-process rather than shelling out to the CLI.
// A PostToolUse hook fires on every single edit, and a second Node start-up per
// edit is a cost the user pays all day for no benefit.
//
// Every hook here fails OPEN: if the map is missing, unparseable, or the check
// throws, the hook exits 0 and says nothing. A boundary checker that wedges a
// session because its own config has a typo would be removed within the hour,
// and then it enforces nothing at all. Loud when it has something true to say,
// silent otherwise.

import { findConfig, loadModel } from '../scripts/lib/model.mjs';

export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Load the map for the session's working directory, or null when this project
 * has not adopted the model. Null means "exit 0 quietly" in every caller.
 */
export function openModel(cwd) {
  try {
    const configPath = findConfig(cwd || process.cwd());
    if (!configPath) return null;
    return loadModel(configPath);
  } catch {
    return null;
  }
}

/** Emit a JSON hook response on stdout and exit cleanly. */
export function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

/** Render findings as the text an agent will act on. */
export function formatFindings(findings, model) {
  const lines = [];
  for (const f of findings) {
    lines.push(`${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]`);
    lines.push(`  ${f.message}`);
  }
  lines.push('');
  lines.push('Fix the import, or move the code to the container that may legally hold it.');
  lines.push('If the edge is genuinely correct, this is a structural decision: say so and stop —');
  lines.push(`update ${model.configPath} with the user rather than working around the check.`);
  return lines.join('\n');
}

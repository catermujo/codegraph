#!/usr/bin/env node
// Compare replay-explore reports from several builds over one corpus.
// Usage: node replay-compare.mjs <corpus.jsonl> <name>=<report.json> <name>=<report.json> [...]
// The first arm is the reference. Corpus records may carry a `shapes` array; each shape gets its own table.
import { readFileSync } from 'node:fs';

const [corpusPath, ...armArgs] = process.argv.slice(2);
if (!corpusPath || armArgs.length < 2) {
  process.stderr.write('Usage: node replay-compare.mjs <corpus.jsonl> <name>=<report.json> <name>=<report.json> [...]\n');
  process.exit(1);
}

const shapesById = new Map();
for (const line of readFileSync(corpusPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const record = JSON.parse(line);
  if (record.id !== undefined) shapesById.set(String(record.id), record.shapes ?? []);
}

/** Flow links ("- A → B   [kind]") and per-symbol file views are what the two explore rules change. */
const metrics = (row) => ({
  chars: row.after.chars,
  sourceLines: row.after.sourceLines,
  links: (row.text.match(/^- \S[^\n]* → [^\n]*\[[^\n]*\]$/gm) ?? []).length,
  focused: (row.text.match(/· focused/g) ?? []).length,
  noRelevant: row.after.noRelevant,
  isError: row.after.isError,
  latencyMs: row.after.latencyMs,
});

const arms = armArgs.map((arg) => {
  const at = arg.indexOf('=');
  const report = JSON.parse(readFileSync(arg.slice(at + 1), 'utf8'));
  return { name: arg.slice(0, at), rows: new Map(report.results.map((row) => [String(row.id), row])) };
});
const [reference, ...others] = arms;
const ids = [...reference.rows.keys()].filter((id) => arms.every((arm) => arm.rows.has(id)));

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sum = (values) => values.reduce((total, value) => total + value, 0);
const round = (value) => Math.round(value);

const groups = new Map([['all', ids]]);
for (const id of ids) {
  for (const shape of shapesById.get(id) ?? []) {
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(id);
  }
}

const out = [];
out.push(`# Replay comparison`, '', `Reference arm: \`${reference.name}\`. Queries replayed by every arm: ${ids.length}.`, '');
for (const [group, groupIds] of groups) {
  out.push(`## ${group} (${groupIds.length} queries)`, '');
  out.push('| Arm | Same text as reference | Median chars | Total chars | Median source lines | Total links | Focused views | No relevant | Errors | Median latency ms |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of arms) {
    const rows = groupIds.map((id) => metrics(arm.rows.get(id)));
    const same = groupIds.filter((id) => arm.rows.get(id).text === reference.rows.get(id).text).length;
    out.push(`| ${arm.name} | ${arm === reference ? '—' : `${same}/${groupIds.length}`} | ${round(median(rows.map((r) => r.chars)))} | ${sum(rows.map((r) => r.chars))} | ${round(median(rows.map((r) => r.sourceLines)))} | ${sum(rows.map((r) => r.links))} | ${sum(rows.map((r) => r.focused))} | ${rows.filter((r) => r.noRelevant).length} | ${rows.filter((r) => r.isError).length} | ${round(median(rows.map((r) => r.latencyMs)))} |`);
  }
  out.push('');
}

for (const arm of others) {
  const changed = ids.filter((id) => arm.rows.get(id).text !== reference.rows.get(id).text);
  out.push(`## Changed responses: ${reference.name} → ${arm.name} (${changed.length})`, '');
  if (changed.length === 0) { out.push('None.', ''); continue; }
  out.push('| Id | Shapes | Query | Chars | Source lines | Links | Focused | No relevant |', '|---|---|---|---|---|---|---|---|');
  for (const id of changed) {
    const a = metrics(reference.rows.get(id));
    const b = metrics(arm.rows.get(id));
    const query = String(reference.rows.get(id).args.query ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 80);
    out.push(`| ${id} | ${(shapesById.get(id) ?? []).join(', ')} | ${query} | ${a.chars} → ${b.chars} | ${a.sourceLines} → ${b.sourceLines} | ${a.links} → ${b.links} | ${a.focused} → ${b.focused} | ${a.noRelevant} → ${b.noRelevant} |`);
  }
  out.push('');
}
process.stdout.write(out.join('\n') + '\n');

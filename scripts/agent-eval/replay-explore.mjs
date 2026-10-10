#!/usr/bin/env node
// DUMBAI: Replay literal queries, never execute commands from a transcript.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function literal(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map(literal);
    return values.includes(undefined) ? undefined : values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries = [];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)
        || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return undefined;
      const value = literal(property.initializer);
      if (value === undefined) return undefined;
      entries.push([property.name.text, value]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

function shellQueries(command) {
  const queries = [];
  for (const match of command.matchAll(/\bcodegraph\s+explore\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")([^\n;|&]*)/g)) {
    // DUMBAI: Double-quoted shell expansions need a shell and cannot be replayed as literals.
    if (match[2] !== undefined && /[$`]/.test(match[2])) continue;
    const args = { query: match[1] ?? match[2].replace(/\\(["\\])/g, '$1') };
    const tokens = match[3].match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
    let supported = true;
    for (let i = 0; i < tokens.length; i++) {
      const flag = tokens[i];
      if (flag === '--include-deps') { args.includeDeps = true; continue; }
      if (!['-p', '--path', '--target', '--max-files', '--scope', '--conversation', '--context-epoch'].includes(flag)) { supported = false; break; }
      const raw = tokens[++i];
      if (!raw || /[$`\\]/.test(raw)) { supported = false; break; }
      const value = raw.replace(/^['"]|['"]$/g, '');
      if (flag === '--max-files') args.maxFiles = Number(value);
      else if (flag === '--target') args.target = value;
      else if (flag === '--scope') args.scope = value;
      else if (flag === '--conversation') args.conversationId = value;
      else if (flag === '--context-epoch') args.contextEpoch = value;
      else args.projectPath = value;
    }
    if (supported) queries.push(args);
  }
  return queries;
}

export function queryCalls(name, input) {
  if (name.endsWith('codegraph_explore')) {
    return [{ args: typeof input === 'string' ? JSON.parse(input) : input, transport: 'mcp' }];
  }
  if (/exec_command|Bash/.test(name)) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return shellQueries(args?.cmd ?? args?.command ?? '').map(args => ({ args, transport: 'cli' }));
  }
  if (!/functions\.exec$/.test(name)) return [];
  return literalScriptCalls(input).flatMap(([callee, args]) => {
    if (callee.endsWith('codegraph_explore') && typeof args?.query === 'string') {
      return [{ args, transport: 'mcp' }];
    }
    if (callee.endsWith('exec_command') && typeof args?.cmd === 'string') {
      return shellQueries(args.cmd).map(args => ({ args, transport: 'cli' }));
    }
    return [];
  });
}

function literalScriptCalls(input) {
  const calls = [];
  const source = ts.createSourceFile('transcript.js', input, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = node => {
    if (ts.isCallExpression(node)) calls.push([node.expression.getText(source), literal(node.arguments[0])]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function isRawRead(name, input) {
  if (/(?:^|__)(?:Read|Grep)$/.test(name)) return true;
  const calls = /functions\.exec$/.test(name) ? literalScriptCalls(input)
    : /exec_command|Bash/.test(name) ? [[name, typeof input === 'string' ? JSON.parse(input) : input]] : [];
  return calls.some(([callee, args]) => callee.endsWith('readFileSync')
    || /exec_command|Bash/.test(callee) && /\b(?:rg|sed|cat)\b/.test(args?.cmd ?? args?.command ?? ''));
}

export function responseMetrics(text = '') {
  return {
    chars: text.length,
    noRelevant: /No relevant code found/.test(text),
    staleOmissions: (text.match(/^\*\*`[^`]+`\*\*[^\n]*(?:changed|stale)[^\n]*source omitted/gm) ?? []).length,
    sourceLines: (text.match(/^\d+\t/gm) ?? []).length,
    coverage: text.match(/Anchor coverage: (complete|incomplete)/)?.[1] ?? null,
  };
}

export function extractRecords(events) {
  const records = [];
  const pending = new Map();
  let cwd;
  let previous = [];
  const addCall = (name, input, id) => {
    const rawRead = isRawRead(name, input);
    const calls = queryCalls(name, input);
    for (const record of previous) record.nextAction = { tool: name, rawRead, explore: calls.length > 0 };
    previous = calls.map(call => ({ ...call, id, ...(cwd ? { cwd } : {}) }));
    records.push(...previous);
    if (previous.length === 1 && previous[0].transport === 'mcp' && name.endsWith('codegraph_explore')) {
      pending.set(id, previous[0]);
    }
  };
  for (const event of events) {
    // A normalized record can retain an exact historical response and a human verdict.
    if (typeof event.args?.query === 'string' || typeof event.query === 'string') {
      records.push({ ...event, args: event.args ?? { query: event.query } });
      continue;
    }
    const payload = event.payload;
    if (event.type === 'session_meta') cwd = payload?.cwd;
    if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
      addCall(payload.name, payload.arguments ?? payload.input, payload.call_id);
    } else if (payload?.type === 'function_call_output' && pending.has(payload.call_id)) {
      const record = pending.get(payload.call_id);
      let output = payload.output;
      try { output = JSON.parse(output); } catch { /* Plain-text outputs are also valid. */ }
      record.before = typeof output === 'string' ? output
        : output?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') addCall(block.name, block.input, block.id);
      if (block.type === 'tool_result' && pending.has(block.tool_use_id)) {
        pending.get(block.tool_use_id).before = typeof block.content === 'string' ? block.content
          : block.content?.map(item => item.text ?? '').join('\n');
      }
    }
  }
  return records;
}

export async function replay(repo, records, options = {}) {
  const CodeGraph = require('../../dist/index.js').default;
  const { ToolHandler } = require('../../dist/mcp/tools.js');
  const cg = CodeGraph.openSync(repo, { readOnly: options.readOnly === true });
  const handler = new ToolHandler(cg);
  const results = [];
  try {
    for (const record of records.slice(0, options.limit ?? records.length)) {
      const args = { ...record.args };
      if (typeof args.projectPath === 'string') args.projectPath = resolve(record.cwd ?? repo, args.projectPath);
      const started = performance.now();
      const result = await handler.execute('codegraph_explore', args);
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      results.push({
        id: record.id, transport: record.transport, args,
        historicalVerdict: record.verdict ?? null, nextAction: record.nextAction ?? null,
        before: typeof record.before === 'string' ? responseMetrics(record.before) : null,
        after: { ...responseMetrics(text), isError: result.isError === true, latencyMs: performance.now() - started },
        text,
      });
    }
  } finally {
    await handler.closeAll();
    cg.close();
  }
  return results;
}

async function main() {
  const [repo, input, ...flags] = process.argv.slice(2);
  if (!repo || !input || flags.includes('-help')) {
    process.stderr.write('Usage: node scripts/agent-eval/replay-explore.mjs <indexed-repo> <transcript.jsonl> [-read-only] [-limit N] [-output report.json]\n');
    process.exitCode = process.argv.includes('-help') ? 0 : 1;
    return;
  }
  const raw = readFileSync(input, 'utf8');
  const events = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const records = extractRecords(events);
  const limitAt = flags.indexOf('-limit');
  const limit = limitAt < 0 ? undefined : Number(flags[limitAt + 1]);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('Use a positive integer for -limit.');
  const results = await replay(repo, records, { readOnly: flags.includes('-read-only'), limit });
  const report = {
    summary: {
      extracted: records.length, replayed: results.length,
      noRelevant: results.filter(row => row.after.noRelevant).length,
      staleOmissions: results.reduce((sum, row) => sum + row.after.staleOmissions, 0),
      responseChars: results.reduce((sum, row) => sum + row.after.chars, 0),
      errors: results.filter(row => row.after.isError).length,
      nextActionsObserved: results.filter(row => row.nextAction !== null).length,
      observedNextRawReads: results.filter(row => row.nextAction?.rawRead).length,
      historicalJudged: results.filter(row => row.historicalVerdict !== null).length,
    },
    results,
  };
  const outputAt = flags.indexOf('-output');
  if (outputAt >= 0) writeFileSync(flags[outputAt + 1], JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeAllocation } from './parse-run.mjs';

// DUMBAI: Detect invocations, including node wrappers, without treating a search for codegraph as retrieval.
export const cliInvocation = (command) => {
  command = command.replace(/\b(?:\/\S*\/)?(?:bash|zsh|sh)\s+-[lc]+\s+["']/g, ';');
  return /(?:^|[;&|(`])\s*(?:[\w]+=[^\s]+\s+)*(?:["']?[\w./~-]*codegraph(?:\.js)?["']?)(?:\s|$)/i.test(command)
  || /(?:^|[;&|(`])\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:node|npx|npm\s+exec)\s+(?:[^;&|\n]*\s)?["']?[^\s;]*codegraph(?:\.js)?["']?(?:\s|$)/i.test(command);
};
const shellKind = (command) => /\b(?:rg|grep|find|ls)\b/.test(command) ? 'search'
  : /\b(?:cat|sed|head|tail|less|more)\b/.test(command) ? 'read' : 'other';
const textOf = (result) => (result?.content || []).filter((block) => block.type === 'text')
  .map((block) => block.text).join('\n');

export function parseCodexEvents(events, meta = {}) {
  const starts = new Map();
  const completed = new Map();
  const errors = [];
  const finished = new Set();
  const usage = {};
  let answer = '';
  let turns = 0;
  events.forEach((event, index) => {
    if (event.type === 'item.started') starts.set(event.item.id, index);
    if (event.type === 'item.completed') {
      const item = event.item;
      finished.add(item.id);
      if (item.type === 'agent_message') answer = item.text;
      if (item.type === 'error') errors.push(item.message);
      if (['mcp_tool_call', 'command_execution'].includes(item.type)) {
        completed.set(item.id, { ...item, order: starts.get(item.id) ?? index });
      }
    }
    if (event.type === 'turn.completed') {
      turns++;
      for (const [key, value] of Object.entries(event.usage || {})) usage[key] = (usage[key] || 0) + value;
    }
    if (event.type === 'error' || event.type === 'turn.failed') errors.push(event.message || event.error);
  });
  for (const id of starts.keys()) {
    if (!finished.has(id)) errors.push(`Incomplete item: ${id}`);
  }
  const calls = [...completed.values()].sort((a, b) => a.order - b.order);
  const mcp = calls.filter((call) => call.type === 'mcp_tool_call');
  const shell = calls.filter((call) => call.type === 'command_execution');
  const explores = mcp.filter((call) => call.server === 'codegraph' && call.tool === 'codegraph_explore');
  const cliAttempts = shell.filter((call) => cliInvocation(call.command));
  const allocation = computeAllocation(explores.map((call) => textOf(call.result)), answer);
  const sufficiency = explores.map((call) => {
    const next = calls[calls.indexOf(call) + 1];
    return { query: call.arguments?.query, next: !next ? 'answer'
      : next.type === 'mcp_tool_call' ? 'mcp' : `shell-${shellKind(next.command)}` };
  });
  const toolErrors = mcp.filter((call) => call.error || call.result?.isError || call.status === 'failed');
  return { ok: turns > 0 && errors.length === 0 && meta.exitCode === 0 && cliAttempts.length === 0
      && explores.length > 0 && toolErrors.length === 0 && answer.trim().length > 0,
    errors, toolErrors: toolErrors.map((call) => ({ tool: call.tool, error: call.error })),
    seconds: meta.seconds ?? null, model: meta.model, effort: meta.effort, turns, usage,
    tools: calls.length, mcp: mcp.length, explores: explores.length,
    shellReads: shell.filter((call) => shellKind(call.command) === 'read').length,
    shellSearches: shell.filter((call) => shellKind(call.command) === 'search').length,
    shellOther: shell.filter((call) => shellKind(call.command) === 'other').length,
    cliAttempts: cliAttempts.length,
    mcpChars: mcp.reduce((sum, call) => sum + textOf(call.result).length, 0),
    shellChars: shell.reduce((sum, call) => sum + (call.aggregated_output || '').length, 0),
    sufficiency, allocation, answer,
    calls: calls.map((call) => ({ type: call.type, tool: call.tool, arguments: call.arguments,
      command: call.command, status: call.status, exitCode: call.exit_code })) };
}

export function parseCodexRun(file) {
  const events = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  return parseCodexEvents(events, existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--brief');
  if (args[0] === '--compare') {
    const dir = args[1];
    const runs = readdirSync(dir).filter((file) => /^run-(new|baseline)-\d+\.jsonl$/.test(file))
      .sort().map((file) => ({ file, ...parseCodexRun(join(dir, file)) }));
    for (const run of runs) {
      const { answer, allocation, sufficiency, calls, ...summary } = run;
      console.log(JSON.stringify({ ...summary, citedShare: allocation.efficiency, sufficiency }));
    }
    if (!runs.length || runs.some((run) => !run.ok)) process.exitCode = 1;
  } else {
    const run = parseCodexRun(args[0]);
    console.log(JSON.stringify(run, null, 2));
    if (!run.ok) process.exitCode = 1;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { cliInvocation, parseCodexEvents } from './parse-codex-run.mjs';

const source = '**`fix/__init__.py`** _run_style_path(function)\n```python\n1: def _run_style_path(): pass\n```';
const mcp = { id: 'm1', type: 'mcp_tool_call', server: 'codegraph', tool: 'codegraph_explore',
  arguments: { query: 'fix style' }, status: 'completed', result: { content: [{ type: 'text', text: source }] } };
const done = (item) => ({ type: 'item.completed', item });
const start = (item) => ({ type: 'item.started', item });
const answer = done({ id: 'a1', type: 'agent_message', text: 'See [fix/__init__.py:1](fix/__init__.py:1).' });
const usage = { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } };
const meta = { exitCode: 0, seconds: 5, model: 'gpt-5.6-luna', effort: 'high' };

test('Codex started/completed events count each tool once and preserve reported usage', () => {
  const stats = parseCodexEvents([start(mcp), done(mcp), answer, usage], meta);
  assert.equal(stats.ok, true);
  assert.equal(stats.tools, 1);
  assert.equal(stats.explores, 1);
  assert.equal(stats.mcpChars, source.length);
  assert.deepEqual(stats.usage, usage.usage);
  assert.equal(stats.allocation.efficiencyPath, 1);
  assert.deepEqual(stats.sufficiency, [{ query: 'fix style', next: 'answer' }]);
});

test('fallback shell reads and repeated explores remain visible', () => {
  const shell = { id: 's1', type: 'command_execution', command: '/bin/zsh -lc "sed -n 1,20p fix/__init__.py"',
    aggregated_output: 'source', exit_code: 0, status: 'completed' };
  const stats = parseCodexEvents([done(mcp), start(shell), done(shell), answer, usage], meta);
  assert.equal(stats.shellReads, 1);
  assert.equal(stats.shellChars, 6);
  assert.equal(stats.sufficiency[0].next, 'shell-read');
});

test('CLI wrappers invalidate attribution while search mentions do not', () => {
  for (const command of ['codegraph explore q', '/bin/codegraph explore q', 'node /tmp/dist/bin/codegraph.js explore q',
    'npx @colbymchenry/codegraph explore q', '/bin/zsh -lc "codegraph explore q"']) {
    assert.equal(cliInvocation(command), true, command);
  }
  for (const command of ['rg codegraph src', 'ls .codegraph', 'which codegraph']) {
    assert.equal(cliInvocation(command), false, command);
  }
  const shell = { id: 's1', type: 'command_execution', command: 'node /tmp/codegraph.js explore q',
    aggregated_output: 'source', exit_code: 0 };
  const stats = parseCodexEvents([done(mcp), done(shell), answer, usage], meta);
  assert.equal(stats.ok, false);
  assert.equal(stats.cliAttempts, 1);
});

test('failed tools, unfinished streams and missing MCP adoption fail closed', () => {
  assert.equal(parseCodexEvents([start(mcp), answer, usage], meta).ok, false);
  assert.equal(parseCodexEvents([answer, usage], meta).ok, false);
  assert.equal(parseCodexEvents([done({ ...mcp, error: { message: 'failed' } }), answer, usage], meta).ok, false);
  assert.equal(parseCodexEvents([done(mcp), answer], meta).ok, false);
  assert.equal(parseCodexEvents([done(mcp), answer, usage], { ...meta, exitCode: 1 }).ok, false);
});

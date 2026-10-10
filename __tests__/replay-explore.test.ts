import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { extractRecords, queryCalls, responseMetrics } from '../scripts/agent-eval/replay-explore.mjs';

describe('recorded Explore replay', () => {
  let root: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('extracts literal MCP and CLI calls without evaluating transcript code', () => {
    const input = `
      globalThis.fail = (() => { throw new Error('never execute'); })();
      await tools.mcp__codegraph__codegraph_explore({query: 'ExactThing', maxFiles: 2});
      await tools.exec_command({cmd: 'codegraph explore "src/main.ts" --target app --include-deps --max-files 3'});
      await tools.mcp__codegraph__codegraph_explore({query: process.env.PRIVATE_VALUE});
      await tools.mcp__codegraph__codegraph_explore({query: 'ScopedThing', target: process.env.TARGET});
    `;
    expect(queryCalls('functions.exec', input)).toEqual([
      { transport: 'mcp', args: { query: 'ExactThing', maxFiles: 2 } },
      { transport: 'cli', args: { query: 'src/main.ts', target: 'app', includeDeps: true, maxFiles: 3 } },
    ]);
    expect(queryCalls('exec_command', { cmd: 'codegraph explore "$(cat private)"' })).toEqual([]);
    const records = extractRecords([
      { type: 'response_item', payload: { type: 'function_call', call_id: 'one', name: 'mcp__codegraph__codegraph_explore', arguments: '{"query":"ExactThing"}' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'two', name: 'functions.exec', input: "await tools.mcp__codegraph__codegraph_explore({query: 'cat'});" } },
    ]);
    expect(records[0].nextAction.rawRead).toBe(false);
  });

  it('retains the exact response and the next observed tool batch', () => {
    const records = extractRecords([
      { type: 'response_item', payload: { type: 'function_call', call_id: 'one', name: 'mcp__codegraph__codegraph_explore', arguments: '{"query":"ExactThing"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'one', output: JSON.stringify({ content: [{ type: 'text', text: 'No relevant code found' }] }) } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'two', name: 'functions.exec', input: 'await tools.exec_command({cmd: "sed -n 1,20p src/main.ts"});' } },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].before).toBe('No relevant code found');
    expect(records[0].nextAction).toEqual({ tool: 'functions.exec', rawRead: true, explore: false });
    expect(responseMetrics('**`src/main.ts`** — ⚠ changed on disk — source omitted\n')).toMatchObject({ staleOmissions: 1, sourceLines: 0 });
  });

  it('replays a real query shape through the built tool and repairs an edited anchor', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-replay-'));
    fs.mkdirSync(path.join(root, 'odd'));
    const file = path.join(root, 'odd/odinfmt.py');
    fs.writeFileSync(file, 'def format_source(source):\n    return source.strip()\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const oldHash = cg.getFile('odd/odinfmt.py')!.contentHash;
    fs.writeFileSync(file, '# changed after indexing\ndef format_source(source):\n    return source.rstrip()\n');
    const input = path.join(root, 'queries.jsonl');
    fs.writeFileSync(input, JSON.stringify({
      id: 'formatter-exact-file', args: { query: 'odd/odinfmt.py', maxFiles: 2, projectPath: '.' },
      before: '**`odd/odinfmt.py`** — ⚠ changed on disk — source omitted\n',
      verdict: 'partial', nextAction: { tool: 'Read', rawRead: true, explore: false },
    }) + '\n');
    const output = path.join(root, 'report.json');
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/agent-eval/replay-explore.mjs'), root, input, '-output', output], { timeout: 30000 });
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(report.summary).toMatchObject({ extracted: 1, replayed: 1, staleOmissions: 0, noRelevant: 0, errors: 0, nextActionsObserved: 1, observedNextRawReads: 1, historicalJudged: 1 });
    expect(report.results[0].before.staleOmissions).toBe(1);
    expect(report.results[0].after.sourceLines).toBeGreaterThan(0);
    expect(report.results[0].historicalVerdict).toBe('partial');
    expect(report.results[0].text).toContain('return source.rstrip()');
    expect(cg.getFile('odd/odinfmt.py')!.contentHash).not.toBe(oldHash);
  });
});

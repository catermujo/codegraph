import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { QueryPool } from '../src/mcp/query-pool';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import { loadExploreContext } from '../src/bin/explore-context';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const body = (name: string) => `export function ${name}(input: number) {\n`
  + Array.from({ length: 24 }, (_, i) => `  input += ${i};`).join('\n') + '\n  return input;\n}\n';

describe('Explore scope and explicit context lifecycle', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-context-scope-'));
    for (const [dir, name] of [['one', 'alphaRun'], ['two', 'betaRun']]) {
      fs.mkdirSync(path.join(root, dir!));
      fs.writeFileSync(path.join(root, dir!, 'shared.ts'), body(name!));
    }
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });
  afterAll(() => {
    handler.closeAll();
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const explore = async (args: Record<string, unknown>, state?: ExploreSessionState) =>
    (await handler.execute('codegraph_explore', args, state)).content[0]!.text!;
  const cli = (...args: string[]) => execFileSync(process.execPath,
    [...WASM_RUNTIME_FLAGS, path.resolve(__dirname, '../dist/bin/codegraph.js'), 'explore', ...args, '--path', root],
    { encoding: 'utf8', env: { ...process.env, CODEGRAPH_EXPLORE_DEDUP: '0' }, timeout: 30000 });

  it('resolves a basename inside explicit scope and never returns its sibling', async () => {
    const text = await explore({ query: 'shared.ts', scope: 'one' });
    expect(text).toContain('export function alphaRun');
    expect(text).not.toContain('export function betaRun');
    expect(text).not.toContain('two/shared.ts');
    expect(text).toContain('Search scope: `one`');
  });

  it('returns compact scope choices for unresolved ambiguity', async () => {
    const text = await explore({ query: 'shared.ts', maxFiles: 1 });
    expect(text).toContain('Scope choices');
    expect(text).toContain('one/shared.ts');
    expect(text).toContain('two/shared.ts');
    expect(text).not.toContain('export function');
    expect(text.length).toBeLessThan(2500);
  });

  it('refuses missing and outside scopes without broadening the search', async () => {
    for (const scope of ['missing', '../outside']) {
      const text = await explore({ query: 'alphaRun betaRun', scope });
      expect(text).not.toContain('export function');
      expect(text).toMatch(/scope/i);
    }
  });

  it('counts verified held source as coverage and resets when context changes or is omitted', async () => {
    const state = new ExploreSessionState();
    const identity = { conversationId: 'test-mcp', contextEpoch: '1' };
    await explore({ query: 'one/shared.ts', ...identity }, state);
    const second = await explore({ query: 'alphaRun betaRun', ...identity }, state);
    expect(second).toContain('Already sent earlier in this conversation');
    expect(second).toContain('held with verified ranges and fingerprints');
    expect(second).toContain('Anchor coverage: complete.');
    const compacted = await explore({ query: 'alphaRun betaRun', ...identity, contextEpoch: '2' }, state);
    expect(compacted).not.toContain('Already sent earlier in this conversation');
    expect(compacted).toContain('export function alphaRun');
    const untracked = await explore({ query: 'alphaRun betaRun' }, state);
    expect(untracked).not.toContain('Already sent earlier in this conversation');
  });

  it('reuses source across CLI processes only within the named conversation and epoch', () => {
    const identity = ['--conversation', 'test-cli', '--context-epoch', '1'];
    cli('one/shared.ts', ...identity);
    const second = cli('alphaRun betaRun', ...identity);
    expect(second).toContain('Already sent earlier in this conversation');
    expect(second).toContain('Anchor coverage: complete.');
    expect(cli('alphaRun betaRun', '--conversation', 'another', '--context-epoch', '1'))
      .not.toContain('Already sent earlier in this conversation');
    expect(cli('alphaRun betaRun', '--conversation', 'test-cli', '--context-epoch', '2'))
      .not.toContain('Already sent earlier in this conversation');
    expect(cli('alphaRun betaRun')).not.toContain('Already sent earlier in this conversation');
    expect(cli('shared.ts', '--scope', 'two')).toContain('export function betaRun');
  });

  it('carries scope and held-source proof through a real query worker', async () => {
    const pool = new QueryPool({ root, size: 1, createWorker: () => new Worker(
      path.resolve(__dirname, '../dist/mcp/query-worker.js'), { workerData: { root } },
    ) });
    handler.setQueryPool(pool);
    try {
      await vi.waitFor(() => expect(pool.ready).toBe(true), { timeout: 15000 });
      const state = new ExploreSessionState();
      const identity = { conversationId: 'pooled', contextEpoch: '1' };
      await explore({ query: 'shared.ts', scope: 'one', ...identity }, state);
      const text = await explore({ query: 'alphaRun betaRun', ...identity }, state);
      expect(text).toContain('Already sent earlier in this conversation');
      expect(text).toContain('Anchor coverage: complete.');
    } finally {
      handler.setQueryPool(undefined);
      await pool.destroy();
    }
  });

  it('re-serves edited source rather than pointing at a previous fingerprint', () => {
    const identity = ['--conversation', 'edited', '--context-epoch', '1'];
    cli('one/shared.ts', ...identity);
    fs.writeFileSync(path.join(root, 'one/shared.ts'), body('alphaRun').replace('return input;', 'return input * 999;'));
    const text = cli('alphaRun betaRun', ...identity);
    expect(text).toContain('return input * 999;');
    expect(text).not.toContain('Already sent earlier in this conversation');
  });

  it('ignores malformed persisted context instead of suppressing source', () => {
    const context = loadExploreContext(root, 'broken-cache', '1');
    context.save();
    const directory = path.join(root, '.codegraph', 'explore-context');
    for (const file of fs.readdirSync(directory)) fs.writeFileSync(path.join(directory, file), '{malformed');
    const restored = loadExploreContext(root, 'broken-cache', '1');
    expect(restored.state.snapshot()).toEqual([]);
  });
});

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('monorepo target query scope', () => {
  let root: string;
  let graph: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-target-scope-'));
    for (const target of ['pkg-a', 'pkg-b']) {
      fs.mkdirSync(path.join(root, target), { recursive: true });
      fs.writeFileSync(path.join(root, target, 'build.toml'), '[lib]\n');
    }
    fs.writeFileSync(
      path.join(root, 'pkg-a', 'a.ts'),
      'export class Entry {}\nexport function SharedThing() { return "a"; }\n',
    );
    fs.writeFileSync(
      path.join(root, 'pkg-b', 'b.ts'),
      'export function SharedThing() { return "b"; }\n' +
        'export function handleMissingField() { return "b-only"; }\n',
    );
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
  });

  afterEach(() => {
    graph.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('filters search and relevant context to directly associated target files', async () => {
    expect(graph.getTargets().map((target) => target.path)).toEqual(['pkg-a', 'pkg-b']);

    const all = graph.searchNodes('SharedThing', { limit: 20 });
    expect(new Set(all.map((result) => result.node.filePath))).toEqual(new Set(['pkg-a/a.ts', 'pkg-b/b.ts']));

    const scoped = graph.searchNodes('SharedThing', { limit: 20, targetPath: 'pkg-a' });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((result) => result.node.filePath === 'pkg-a/a.ts')).toBe(true);

    const context = await graph.findRelevantContext('SharedThing', {
      targetPath: 'pkg-a',
      searchLimit: 20,
      maxNodes: 50,
    });
    expect([...context.nodes.values()].every((node) => node.filePath === 'pkg-a/a.ts')).toBe(true);
  });

  it('exposes target scope in MCP schema and keeps explore output inside the target', async () => {
    const explore = new ToolHandler(graph).getTools().find((tool) => tool.name === 'codegraph_explore');
    expect(explore?.inputSchema.properties).toHaveProperty('target');

    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'SharedThing',
      target: 'pkg-a',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('pkg-a/a.ts');
    expect(result.content[0]?.text).not.toContain('pkg-b/b.ts');
  });

  it('filters camel-infix fallback seeds before they enter scoped explore output', async () => {
    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'Entry missingField',
      target: 'pkg-a',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).not.toContain('pkg-b/b.ts');
    expect(result.content[0]?.text).not.toContain('handleMissingField');
  });

  it('documents target scope in CLI help and filters CLI explore output', () => {
    const env = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' };
    const help = execFileSync(process.execPath, [BIN, 'explore', '--help'], { encoding: 'utf-8', env });
    expect(help).toContain('--target <path>');
    expect(help).toMatch(/direct files\s+only/);

    const output = execFileSync(
      process.execPath,
      [BIN, 'explore', 'SharedThing', '--target', 'pkg-a', '--path', root],
      { encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    expect(output).toContain('pkg-a/a.ts');
    expect(output).not.toContain('pkg-b/b.ts');
  });

  it('forwards an explicitly empty CLI target so it fails instead of becoming unscoped', () => {
    const env = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' };
    const result = spawnSync(
      process.execPath,
      [BIN, 'explore', 'SharedThing', '--target', '', '--path', root],
      { encoding: 'utf-8', env },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Unknown build.toml target');
  });
});

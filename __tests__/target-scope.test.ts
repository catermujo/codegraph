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
    }
    fs.writeFileSync(path.join(root, 'pkg-a', 'build.toml'), '[lib]\ndeps = ["pkg-b"]\n');
    fs.writeFileSync(path.join(root, 'pkg-b', 'build.toml'), '[lib]\n');
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

  it('expands only with includeDeps and ranks direct target files first', () => {
    const direct = graph.searchNodes('SharedThing', { limit: 20, targetPath: './pkg-a' });
    expect(direct.map((result) => result.node.filePath)).toEqual(['pkg-a/a.ts']);

    const expanded = graph.searchNodes('SharedThing', {
      limit: 20,
      targetPath: './pkg-a',
      includeDeps: true,
    });
    expect(expanded.map((result) => result.node.filePath)).toEqual(['pkg-a/a.ts', 'pkg-b/b.ts']);
    expect(graph.getTargetDependencyScope('./pkg-a')).toMatchObject({
      targetPath: 'pkg-a',
      direct: ['pkg-b'],
      transitive: [],
      paths: ['pkg-a', 'pkg-b'],
    });
  });

  it('keeps direct candidates ahead of dependency candidates before applying a LIKE limit', async () => {
    fs.appendFileSync(path.join(root, 'pkg-a', 'a.ts'), 'export function VeryLongDirectThing() { return 1; }\n');
    fs.appendFileSync(path.join(root, 'pkg-b', 'b.ts'), 'export function Thing() { return 2; }\n');
    await graph.sync({ paths: ['pkg-a/a.ts', 'pkg-b/b.ts'] });

    const scoped = graph.searchNodes('ing', {
      targetPath: './pkg-a',
      includeDeps: true,
      limit: 1,
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.node.filePath).toBe('pkg-a/a.ts');
  });

  it('applies a concrete allowed-file gate before a low result limit', () => {
    const options = { allowedFilePaths: ['pkg-b/b.ts'], limit: 1 };
    const scoped = graph.searchNodes('SharedThing', options);
    expect(scoped.map((result) => result.node.filePath)).toEqual(['pkg-b/b.ts']);
  });

  it('treats an explicit empty allowed-file set as matching nothing', () => {
    const options = { allowedFilePaths: [], limit: 20 };
    expect(graph.searchNodes('SharedThing', options)).toEqual([]);
  });

  it('gates a Unicode canonical file path exactly', async () => {
    fs.writeFileSync(path.join(root, 'pkg-a', 'Élite.ts'), 'export function SharedThing() { return "unicode"; }\n');
    await graph.sync({ paths: ['pkg-a/Élite.ts'] });

    const options = { allowedFilePaths: ['pkg-a/Élite.ts'], limit: 20 };
    expect(graph.searchNodes('SharedThing', options).map((result) => result.node.filePath)).toEqual(['pkg-a/Élite.ts']);
  });

  it('intersects allowed files with target and public path scopes', () => {
    const options = {
      allowedFilePaths: ['pkg-a/a.ts'],
      targetPath: 'pkg-a',
      includeDeps: true,
      limit: 20,
    };
    expect(graph.searchNodes('SharedThing path:pkg-b', options)).toEqual([]);
  });

  it('applies allowed files before context exact-name limits and traversal', async () => {
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(root, `decoy-${String(i).padStart(2, '0')}.ts`), 'export function SharedThing() { return "decoy"; }\n');
    }
    fs.writeFileSync(path.join(root, 'zz-target.ts'), 'export function SharedThing() { return "target"; }\n');
    await graph.indexAll();

    const context = await graph.findRelevantContext('SharedThing', {
      allowedFilePaths: ['zz-target.ts'],
      searchLimit: 1,
      maxNodes: 20,
    });
    expect([...context.nodes.values()].map((node) => node.filePath)).toEqual(['zz-target.ts']);
    expect(context.edges).toEqual([]);
  });

  it('returns an empty context for an explicit empty allowed-file set', async () => {
    const context = await graph.findRelevantContext('SharedThing', {
      allowedFilePaths: [],
      searchLimit: 20,
      maxNodes: 20,
    });
    expect(context.nodes.size).toBe(0);
    expect(context.edges).toEqual([]);
  });

  it('keeps prefix and text candidates inside the allowed file set', async () => {
    fs.writeFileSync(path.join(root, 'pkg-a', 'allowed.ts'), 'export class SharedThingHelper {}\n');
    fs.writeFileSync(path.join(root, 'pkg-a', 'outside.ts'), 'export class SharedThingHelperOutside {}\n');
    await graph.sync({ paths: ['pkg-a/allowed.ts', 'pkg-a/outside.ts'] });

    const context = await graph.findRelevantContext('shared helper', {
      allowedFilePaths: ['pkg-a/allowed.ts'],
      searchLimit: 20,
      maxNodes: 20,
    });
    expect([...context.nodes.values()].every((node) => node.filePath === 'pkg-a/allowed.ts')).toBe(true);
  });

  it('supports a Unicode canonical allowed file path in context', async () => {
    fs.writeFileSync(path.join(root, 'pkg-a', 'Élite.ts'), 'export function SharedThing() { return "unicode"; }\n');
    await graph.sync({ paths: ['pkg-a/Élite.ts'] });

    const context = await graph.findRelevantContext('SharedThing', {
      allowedFilePaths: ['pkg-a/Élite.ts'],
      searchLimit: 20,
      maxNodes: 20,
    });
    expect([...context.nodes.values()].map((node) => node.filePath)).toEqual(['pkg-a/Élite.ts']);
  });

  it('intersects allowed files with target scope in context', async () => {
    const context = await graph.findRelevantContext('SharedThing', {
      allowedFilePaths: ['pkg-b/b.ts'],
      targetPath: 'pkg-a',
      searchLimit: 20,
      maxNodes: 20,
    });
    expect(context.nodes.size).toBe(0);
    expect(context.edges).toEqual([]);
  });

  it('uses persisted manifests for transitive scope, cycles, and unresolved dependencies', async () => {
    const dependencyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-target-deps-'));
    const manifests: Record<string, string> = {
      app: '[project]\ndeps = ["./lib-a", "external-lib"]\n',
      'lib-a': '[lib]\ndeps = ["lib-b"]\n',
      'lib-b': '[lib]\ndeps = ["app"]\n',
    };
    for (const [target, manifest] of Object.entries(manifests)) {
      fs.mkdirSync(path.join(dependencyRoot, target), { recursive: true });
      fs.writeFileSync(path.join(dependencyRoot, target, 'build.toml'), manifest);
    }
    fs.writeFileSync(path.join(dependencyRoot, 'app', 'app.ts'), 'export class Entry {}\n');
    fs.writeFileSync(path.join(dependencyRoot, 'lib-a', 'a.ts'), 'export function DependencyOne() { return 1; }\n');
    fs.writeFileSync(path.join(dependencyRoot, 'lib-b', 'b.ts'), 'export function DependencyTwo() { return 2; }\n');

    const dependencyGraph = CodeGraph.initSync(dependencyRoot);
    try {
      await dependencyGraph.indexAll();
      expect(dependencyGraph.getTargetDependencyScope('./app')).toMatchObject({
        targetPath: 'app',
        direct: ['lib-a'],
        transitive: ['lib-b'],
        paths: ['app', 'lib-a', 'lib-b'],
      });

      expect(dependencyGraph.searchNodes('DependencyTwo', { targetPath: 'app', limit: 20 })).toEqual([]);
      expect(dependencyGraph.searchNodes('DependencyTwo', {
        targetPath: 'app',
        includeDeps: true,
        limit: 20,
      }).map((result) => result.node.filePath)).toEqual(['lib-b/b.ts']);

      const ranked = dependencyGraph.searchNodes('Entry DependencyOne', {
        targetPath: 'app',
        includeDeps: true,
        limit: 20,
      });
      expect(ranked.map((result) => result.node.filePath)).toEqual(['app/app.ts', 'lib-a/a.ts']);
    } finally {
      dependencyGraph.destroy();
      fs.rmSync(dependencyRoot, { recursive: true, force: true });
    }
  });

  it('exposes target scope in MCP schema and keeps explore output inside the target', async () => {
    const explore = new ToolHandler(graph).getTools().find((tool) => tool.name === 'codegraph_explore');
    expect(explore?.inputSchema.properties).toHaveProperty('target');
    expect(explore?.inputSchema.properties).toHaveProperty('includeDeps');

    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'SharedThing',
      target: 'pkg-a',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('pkg-a/a.ts');
    expect(result.content[0]?.text).not.toContain('pkg-b/b.ts');

    const expanded = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'SharedThing',
      target: 'pkg-a',
      includeDeps: true,
    });
    expect(expanded.isError).toBeUndefined();
    expect(expanded.content[0]?.text).toContain('pkg-a/a.ts');
    expect(expanded.content[0]?.text).toContain('pkg-b/b.ts');
    expect(expanded.content[0]!.text.indexOf('pkg-a/a.ts')).toBeLessThan(expanded.content[0]!.text.indexOf('pkg-b/b.ts'));
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

    expect(help).toContain('--include-deps');
    const expanded = execFileSync(
      process.execPath,
      [BIN, 'explore', 'SharedThing', '--target', 'pkg-a', '--include-deps', '--path', root],
      { encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    expect(expanded).toContain('pkg-a/a.ts');
    expect(expanded).toContain('pkg-b/b.ts');
    expect(expanded.indexOf('pkg-a/a.ts')).toBeLessThan(expanded.indexOf('pkg-b/b.ts'));

    const dependencies = execFileSync(
      process.execPath,
      [BIN, 'dependencies', 'pkg-a', root, '--json'],
      { encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    expect(JSON.parse(dependencies)).toMatchObject({
      targetPath: 'pkg-a',
      direct: ['pkg-b'],
      transitive: [],
    });
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

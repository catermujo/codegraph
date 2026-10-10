import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('Explore broad queries with vendored matches', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vendor-ranking-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, '_vendor', 'styles'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'formatter.ts'),
      'export function format() { return "application formatter"; }\n');
    for (let i = 0; i < 20; i++) {
      const next = (i + 1) % 20;
      fs.writeFileSync(path.join(root, '_vendor', 'styles', `style${i}.ts`),
        `import { Style${next} } from './style${next}';\n`
        + `export class Style${i} {\n`
        + `  format() { return new Style${next}().format(); }\n`
        + Array.from({ length: 16 }, (_, n) => `  style_${n}() { return this.format(); }`).join('\n')
        + '\n}\n');
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

  const explore = async (args: Record<string, unknown>) =>
    (await handler.execute('codegraph_explore', args)).content[0]!.text!;
  const sources = (text: string) => [...text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map(match => match[1]);

  it('serves application code before a dense dependency cluster on a broad query', async () => {
    const text = await explore({ query: 'style formatter', maxFiles: 1 });
    expect(sources(text)).toEqual(['src/formatter.ts']);
    expect(text).toContain('application formatter');
  });

  it('preserves a distinctive named dependency symbol', async () => {
    const text = await explore({ query: 'Style7', maxFiles: 1 });
    expect(sources(text)).toEqual(['_vendor/styles/style7.ts']);
    expect(text).toContain('export class Style7');
  });

  it('preserves an explicit dependency file', async () => {
    const text = await explore({ query: '_vendor/styles/style7.ts', maxFiles: 1 });
    expect(sources(text)).toEqual(['_vendor/styles/style7.ts']);
  });

  it('searches an explicitly scoped dependency tree at full weight', async () => {
    const text = await explore({ query: 'style formatter', scope: '_vendor/styles', maxFiles: 2 });
    expect(sources(text).length).toBeGreaterThan(0);
    expect(sources(text).every(file => file!.startsWith('_vendor/styles/'))).toBe(true);
    expect(text).not.toContain('application formatter');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { EXPLORE_EMISSION_KEY } from '../src/mcp/explore-session-state';

describe('anchor-gate baseline defects', () => {
  let root: string;
  let graph: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-anchor-gate-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src-utils'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'a-decoy.ts'),
      '/** needle needle needle needle needle needle needle needle */\n' +
        'export function needle() { return "decoy"; }\n',
    );
    fs.writeFileSync(path.join(root, 'z-target.ts'), 'export function needle() { return "target"; }\n');
    fs.writeFileSync(path.join(root, 'src', 'anchor.ts'), 'export function scopeNeedle() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src-utils', 'helper.ts'), 'export function scopeNeedle() { return 2; }\n');
    fs.writeFileSync(path.join(root, 'src', 'Élite.ts'), 'export function needle() { return "accent"; }\n');
    fs.writeFileSync(path.join(root, 'src', 'İnput.ts'), 'export function needle() { return "dotted-i"; }\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Auxiliary documentation\n');
    fs.writeFileSync(path.join(root, 'config.toml'), 'answer = 42\n');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
  });

  afterEach(() => {
    graph.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('requires an explicit path match to survive a low result limit', async () => {
    for (let i = 0; i < 150; i++) {
      fs.writeFileSync(path.join(root, `a${String(i).padStart(3, '0')}.ts`), 'export function needle() { return "decoy"; }\n');
    }
    fs.writeFileSync(path.join(root, 'zz-target-late.ts'), 'export function needle() { return "target"; }\n');
    await graph.indexAll();
    const results = graph.searchNodes('needle path:zz-target-late.ts', { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.node.filePath).toBe('zz-target-late.ts');
  });

  it('keeps a public substring path match before a low result limit', async () => {
    for (let i = 0; i < 150; i++) {
      fs.writeFileSync(path.join(root, `b${String(i).padStart(3, '0')}.ts`), 'export function needle() { return "decoy"; }\n');
    }
    fs.writeFileSync(path.join(root, 'src', 'api-client.ts'), 'export function needle() { return "target"; }\n');
    await graph.indexAll();
    const results = graph.searchNodes('needle path:api', { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.node.filePath).toBe('src/api-client.ts');
  });

  it('matches a Unicode path using JavaScript case folding', () => {
    const results = graph.searchNodes('needle path:élite', { limit: 20 });
    expect(results.map((result) => result.node.filePath)).toContain('src/Élite.ts');
  });

  it('matches an ASCII needle after a Unicode path lowercases to ASCII', () => {
    const results = graph.searchNodes('needle path:i', { limit: 20 });
    expect(results.map((result) => result.node.filePath)).toContain('src/İnput.ts');
  });

  it('records many exact definitions without selecting an arbitrary one', async () => {
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(root, `a${String(i).padStart(2, '0')}.ts`), 'export function crowdedSymbol() { return 0; }\n');
    }
    fs.writeFileSync(path.join(root, 'zz-target.ts'), 'export function crowdedSymbol() { return 1; }\n');
    await graph.indexAll();

    const context = await graph.findRelevantContext('crowdedSymbol', {
      searchLimit: 1,
      maxNodes: 20,
      minScore: 0,
    });
    const resolution = context.symbolResolutions?.find((entry) => entry.raw === 'crowdedSymbol');
    expect(resolution?.status).toBe('many');
    expect(resolution?.candidates.length).toBeGreaterThan(1);
    expect(resolution?.candidates.some((candidate) => candidate.filePath === 'zz-target.ts')).toBe(true);
    expect([...context.nodes.values()].filter((node) => node.name === 'crowdedSymbol')).toHaveLength(0);
  });

  it('does not render an arbitrary member of an oversized exact family in Explore', async () => {
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(root, `crowded-${String(i).padStart(2, '0')}.ts`), 'export function crowdedExplore() { return 0; }\n');
    }
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'crowdedExplore' });
    const output = result.content?.[0]?.text ?? '';
    expect(output).not.toMatch(/crowded-\d{2}\.ts/);
    expect(output.toLowerCase()).toContain('ambiguous');
    expect(output.toLowerCase()).toContain('at least 60 exact definitions');
    expect(output.toLowerCase()).toContain('no single definition was selected');
    expect(output.toLowerCase()).toContain('file or path scope');
  });

  it('reports a truncated exact family without rendering source or pointers', async () => {
    for (let i = 0; i < 70; i++) {
      fs.writeFileSync(path.join(root, `truncated-${String(i).padStart(2, '0')}.ts`), 'export function truncatedExplore() { return 0; }\n');
    }
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'truncatedExplore' });
    const output = result.content?.[0]?.text ?? '';
    expect(output).not.toMatch(/truncated-\d{2}\.ts/);
    expect(output.toLowerCase()).toContain('ambiguous');
    expect(output.toLowerCase()).toContain('at least 64+ exact definitions');
    expect(output.toLowerCase()).toContain('candidate list truncated');
    expect(output.toLowerCase()).toContain('no single definition was selected');
    expect(output.toLowerCase()).toContain('file or path scope');
  });

  it('renders every definition in a bounded exact family', async () => {
    fs.writeFileSync(path.join(root, 'bounded-one.ts'), 'export function boundedExplore() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'bounded-two.ts'), 'export function boundedExplore() { return 2; }\n');
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'boundedExplore' });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('bounded-one.ts');
    expect(output).toContain('bounded-two.ts');
    expect(output.toLowerCase()).toContain('ambiguous');
  });

  it.each([3, 4, 5])('keeps same-family relatives out at maxFiles=%s', async (maxFiles) => {
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(root, `small-many-${i}.ts`), 'export function SmallMany() { return 1; }\n');
    }
    fs.writeFileSync(path.join(root, 'small-many-extra.ts'), 'export function SmallManyExtra() { return 2; }\n');
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'SmallMany',
      maxFiles,
    });
    const output = result.content?.[0]?.text ?? '';
    if (maxFiles < 4) {
      expect(output).not.toMatch(/small-many-(?:0|1|2|3)\.ts/);
    } else {
      for (let i = 0; i < 4; i++) expect(output).toContain(`small-many-${i}.ts`);
    }
    expect(output).not.toContain('small-many-extra.ts');
  });

  it('keeps an independently exact term while suppressing a same-family relative', async () => {
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(root, `mixed-small-many-${i}.ts`), 'export function SmallMany() { return 1; }\n');
    }
    fs.writeFileSync(path.join(root, 'mixed-small-many-extra.ts'), 'export function SmallManyExtra() { return 2; }\n');
    fs.writeFileSync(path.join(root, 'independent.ts'), 'export function IndependentTerm() { return 3; }\n');
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'SmallMany IndependentTerm',
    });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('independent.ts');
    for (let i = 0; i < 4; i++) expect(output).toContain(`mixed-small-many-${i}.ts`);
    expect(output).not.toContain('mixed-small-many-extra.ts');
  });

  it('allows an explicit file pin to narrow an oversized exact family', async () => {
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(root, `pinned-small-many-${i}.ts`), 'export function SmallMany() { return 1; }\n');
    }
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'SmallMany pinned-small-many-2.ts',
      maxFiles: 1,
    });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('pinned-small-many-2.ts');
    expect(output).not.toContain('pinned-small-many-0.ts');
    expect(output).not.toContain('pinned-small-many-1.ts');
    expect(output).not.toContain('pinned-small-many-3.ts');
  });

  it('preserves every distinct shape-precise exact anchor under a low entry limit', async () => {
    const names = ['FirstAnchor', 'SecondAnchor', 'ThirdAnchor', 'FourthAnchor', 'FifthAnchor', 'LateAnchor'];
    for (const [index, name] of names.entries()) {
      fs.writeFileSync(path.join(root, `anchor-${index}.ts`), `export function ${name}() { return ${index}; }\n`);
    }
    await graph.indexAll();

    const context = await graph.findRelevantContext(names.join(' '), {
      searchLimit: 1,
      maxNodes: 20,
      minScore: 0,
    });
    const resolved = new Set(
      [...(context.symbolResolutions ?? [])]
        .filter((entry) => entry.status === 'one')
        .flatMap((entry) => entry.candidates.map((candidate) => candidate.name)),
    );
    expect(resolved).toEqual(new Set(names));
    expect([...context.nodes.values()].some((node) => node.name === 'LateAnchor')).toBe(true);
  });

  it('resolves a qualified exact anchor instead of its same-name decoy', async () => {
    fs.writeFileSync(path.join(root, 'container.ts'),
      'export class Container { lateSymbol() { return 1; } }\n');
    fs.writeFileSync(path.join(root, 'decoy.ts'), 'export function lateSymbol() { return 2; }\n');
    await graph.indexAll();

    const context = await graph.findRelevantContext('Container::lateSymbol', {
      searchLimit: 1,
      maxNodes: 20,
      minScore: 0,
    });
    const resolution = context.symbolResolutions?.find((entry) => entry.raw === 'Container::lateSymbol');
    expect(resolution?.status).toBe('one');
    expect(resolution?.candidates.map((candidate) => candidate.filePath)).toEqual(['container.ts']);
    expect([...context.nodes.values()].some((node) => node.filePath === 'container.ts' && node.name === 'lateSymbol')).toBe(true);
    expect([...context.nodes.values()].some((node) => node.filePath === 'decoy.ts' && node.name === 'lateSymbol')).toBe(false);
  });

  it('does not fuzzy-substitute for a zero-result exact anchor', async () => {
    fs.writeFileSync(path.join(root, 'near.ts'), 'export function ExactAnchorish() { return 1; }\n');
    await graph.indexAll();

    const context = await graph.findRelevantContext('ExactAnchor', {
      searchLimit: 1,
      maxNodes: 20,
      minScore: 0,
    });
    const resolution = context.symbolResolutions?.find((entry) => entry.raw === 'ExactAnchor');
    expect(resolution?.status).toBe('zero');
    expect([...context.nodes.values()].some((node) => node.name === 'ExactAnchorish')).toBe(false);
  });

  it('does not camel-prefix substitute for a zero-result PascalCase anchor', async () => {
    fs.writeFileSync(path.join(root, 'missing-widget-extra.ts'),
      'export function MissingWidgetExtra() { return 1; }\n');
    await graph.indexAll();

    const context = await graph.findRelevantContext('MissingWidget', {
      searchLimit: 1,
      maxNodes: 20,
      minScore: 0,
    });
    expect(context.symbolResolutions?.find((entry) => entry.raw === 'MissingWidget')?.status).toBe('zero');
    expect([...context.nodes.values()].some((node) => node.name === 'MissingWidgetExtra')).toBe(false);
  });

  it('keeps an independently recoverable lower-camel field beside a zero anchor', async () => {
    fs.writeFileSync(path.join(root, 'billing.ts'),
      'export function getBillingMethod() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'missing-widget-extra.ts'),
      'export function MissingWidgetExtra() { return 2; }\n');
    await graph.indexAll();

    const context = await graph.findRelevantContext('billingMethod MissingWidget', {
      searchLimit: 1,
      maxNodes: 20,
      minScore: 0,
    });
    expect([...context.nodes.values()].some((node) => node.name === 'getBillingMethod')).toBe(true);
    expect([...context.nodes.values()].some((node) => node.name === 'MissingWidgetExtra')).toBe(false);
  });

  it('reduces an exact-name ambiguity to one candidate inside allowed files', async () => {
    fs.writeFileSync(path.join(root, 'one.ts'), 'export function ScopedAnchor() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'two.ts'), 'export function ScopedAnchor() { return 2; }\n');
    await graph.indexAll();

    const context = await graph.findRelevantContext('ScopedAnchor', {
      searchLimit: 1,
      maxNodes: 20,
      minScore: 0,
      allowedFilePaths: ['two.ts'],
    });
    const resolution = context.symbolResolutions?.find((entry) => entry.raw === 'ScopedAnchor');
    expect(resolution?.status).toBe('one');
    expect(resolution?.candidates.map((candidate) => candidate.filePath)).toEqual(['two.ts']);
  });

  it('does not let a zero qualified anchor seed a fuzzy tail in Explore', async () => {
    fs.writeFileSync(path.join(root, 'name-decoy.ts'), 'export function Name() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'other.ts'), 'export function Other() { return 2; }\n');
    await graph.indexAll();

    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'Missing::Name Other',
    });
    const output = result.content?.[0]?.text ?? '';
    expect(output).not.toContain('name-decoy.ts');
  });

  it('keeps internal coverage on anchored early returns but strips it from public output', async () => {
    for (let i = 0; i < 70; i++) {
      fs.writeFileSync(path.join(root, `early-truncated-${String(i).padStart(2, '0')}.ts`),
        'export function earlyTruncated() { return 0; }\n');
    }
    await graph.indexAll();
    const anchored = [
      { query: 'Missing::Name', status: 'unresolved' },
      { query: 'read README.md', status: 'not-indexed' },
      { query: 'read missing.md', status: 'missing' },
      { query: 'scopeNeedle ../src', status: 'outside-root' },
      { query: 'earlyTruncated', status: 'ambiguous' },
    ] as const;
    const handler = new ToolHandler(graph);
    for (const { query, status } of anchored) {
      const raw = await handler.executeReadTool('codegraph_explore', { query });
      const emission = raw[EXPLORE_EMISSION_KEY];
      expect(emission?.coverage, query).toBeDefined();
      expect(emission?.coverage?.complete).toBe(false);
      expect(emission?.coverage?.anchors.some((anchor) => anchor.status === status)).toBe(true);

      const publicResult = await handler.execute('codegraph_explore', { query });
      expect(publicResult).not.toHaveProperty(EXPLORE_EMISSION_KEY);
      expect(publicResult.content?.[0]?.text ?? '').toContain('Anchor coverage:');
    }
    const unanchored = await handler.executeReadTool('codegraph_explore', { query: 'zzqqxxnosuch' });
    expect(unanchored[EXPLORE_EMISSION_KEY]?.coverage).toBeUndefined();
  }, 120_000);

  it('reports anchor coverage without claiming complete source for an anchored response', async () => {
    const handler = new ToolHandler(graph);
    const anchored = await handler.execute('codegraph_explore', { query: 'scopeNeedle src/' });
    const anchoredText = anchored.content?.[0]?.text ?? '';
    expect(anchoredText).toContain('Anchor coverage:');
    expect(anchoredText).not.toContain('Complete source for');

    const ordinary = await handler.execute('codegraph_explore', { query: 'scope needle' });
    const ordinaryText = ordinary.content?.[0]?.text ?? '';
    expect(ordinaryText).not.toContain('Anchor coverage:');
  });

  it('preserves substring compatibility for public path filters', () => {
    const results = graph.searchNodes('scopeNeedle path:src', { limit: 100 });
    expect(results.length).toBeGreaterThan(0);
    expect(new Set(results.map((result) => result.node.filePath))).toEqual(
      new Set(['src/anchor.ts', 'src-utils/helper.ts']),
    );
  });

  it('enforces an explicit directory anchor without admitting sibling prefixes', async () => {
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'scopeNeedle src/' });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('src/anchor.ts');
    expect(output).not.toContain('src-utils/helper.ts');
  });

  it('keeps mixed directory and exact-file anchors inside their union', async () => {
    fs.writeFileSync(path.join(root, 'src', 'extra.ts'), 'export function scopeNeedle() { return 3; }\n');
    await graph.sync({ paths: ['src/extra.ts'] });
    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'scopeNeedle src/ src/extra.ts',
    });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('src/anchor.ts');
    expect(output).toContain('src/extra.ts');
    expect(output).not.toContain('src-utils/helper.ts');
  });

  it('keeps renderer sections inside a directory anchor', async () => {
    fs.writeFileSync(path.join(root, 'src', 'entry.ts'),
      'export function Entry() { return Middle(); }\n');
    fs.writeFileSync(path.join(root, 'src-utils', 'middle.ts'),
      'export function Middle() { return Target(); }\n');
    fs.writeFileSync(path.join(root, 'src', 'target.ts'),
      'export function Target() { return 3; }\n');
    await graph.indexAll();
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'Entry Target src/' });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('src/entry.ts');
    expect(output).toContain('src/target.ts');
    expect(output).not.toContain('src-utils/middle.ts');
  });

  it('fails closed for an outside-root explicit anchor', async () => {
    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'scopeNeedle ../src',
    });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('No relevant code found');
  });

  it('keeps URL-like text unanchored', async () => {
    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: 'scopeNeedle https://example.com/src',
    });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('src/anchor.ts');
    expect(output).toContain('src-utils/helper.ts');
  });

  it('reports an ambiguous exact symbol instead of silently choosing a global result', async () => {
    for (const name of ['one', 'two', 'three', 'four']) {
      fs.writeFileSync(path.join(root, `${name}.ts`), 'export function commonThing() { return 1; }\n');
    }
    await graph.indexAll();
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'commonThing' });
    const output = result.content?.[0]?.text ?? '';
    expect(output.toLowerCase()).toContain('ambiguous');
  });

  it('reports an auxiliary filename as not indexed', async () => {
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'read README.md' });
    const output = result.content?.[0]?.text ?? '';
    expect(output.toLowerCase()).toContain('not-indexed');
  });

  it('distinguishes a missing explicit filename from an auxiliary file', async () => {
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'read missing.md' });
    const output = result.content?.[0]?.text ?? '';
    expect(output).toContain('No repository file matches');
    expect(output.toLowerCase()).not.toContain('not-indexed');
  });

  it('keeps an unanchored control query semantically stable across two runs', async () => {
    const run = async () => new ToolHandler(graph).execute('codegraph_explore', { query: 'scopeNeedle' });
    const semantic = (result: Awaited<ReturnType<ToolHandler['execute']>>) => {
      const text = result.content?.[0]?.text ?? '';
      const lines = text.split('\n');
      return {
        isError: result.isError ?? false,
        fileHeaders: lines.filter((line) => /^\*\*`[^`]+`/.test(line)),
        symbolLines: lines.filter((line) => /^\d+\t/.test(line)),
        edgeLines: lines.filter((line) => /→/.test(line)),
        sourceBytes: Buffer.byteLength(lines.filter((line) => /^\d+\t/.test(line)).join('\n')),
        responseBytes: Buffer.byteLength(text),
      };
    };
    expect(semantic(await run())).toEqual(semantic(await run()));
  });
});

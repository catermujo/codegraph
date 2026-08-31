import { describe, expect, it } from 'vitest';
import {
  buildExploreCoverage,
  formatExploreCoverage,
  type ExploreCoverageRenderFact,
} from '../src/mcp/explore-coverage';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import type { QueryPathAnchor } from '../src/search/query-paths';
import type { SymbolResolution } from '../src/types';

const source = (path: string, body = 'line 1\nline 2\nline 3'): string =>
  `**\`${path}\`**\n\n\`\`\`ts\n${body}\n\`\`\`\n`;

const fact = (
  path: string,
  ranges: Array<{ start: number; end: number }>,
  status: ExploreCoverageRenderFact['status'] = 'full-current',
  lineCount = 4,
): ExploreCoverageRenderFact => ({
  path,
  ranges,
  bytes: 20,
  status,
  fullRanges: [{ start: 1, end: lineCount - 1 }],
  lineCount,
});

const fileAnchor = (raw: string, filePath: string, ordinal = 0): QueryPathAnchor => ({
  raw,
  ordinal,
  start: ordinal * 4,
  end: ordinal * 4 + raw.length,
  kind: 'file',
  normalized: filePath,
  status: 'resolved',
  resolvedFiles: [filePath],
});

const symbol = (
  raw: string,
  status: SymbolResolution['status'],
  candidates: SymbolResolution['candidates'],
  truncated = false,
): SymbolResolution => ({
  raw,
  normalized: raw,
  kind: 'identifier',
  status,
  candidates,
  truncated,
});

const candidate = (nodeId: string, filePath: string, startLine: number, endLine: number) => ({
  nodeId,
  filePath,
  name: 'Wanted',
  qualifiedName: 'Wanted',
  kind: 'function' as const,
  startLine,
  endLine,
});

describe('buildExploreCoverage', () => {
  it('marks a unique symbol covered by a complete final source section complete', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'one', [candidate('n1', 'src/a.ts', 2, 2)])],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: source('src/a.ts'),
    });
    expect(coverage?.complete).toBe(true);
    expect(coverage?.allCandidatesCovered).toBe(true);
    expect(coverage).toMatchObject({ anchorCount: 1, expectedFileCount: 1, renderedFileCount: 1 });
  });

  it('separates candidate coverage from full-file coverage', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'one', [candidate('n1', 'src/a.ts', 2, 2)])],
      renderFacts: [fact('src/a.ts', [{ start: 2, end: 2 }], 'candidate-covered-partial')],
      finalText: source('src/a.ts', 'wanted line'),
    });
    expect(coverage?.allCandidatesCovered).toBe(true);
    expect(coverage?.complete).toBe(false);
  });

  it('downgrades a full-current fact whose emitted ranges are incomplete', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'one', [candidate('n1', 'src/a.ts', 2, 2)])],
      renderFacts: [fact('src/a.ts', [{ start: 2, end: 2 }])],
      finalText: source('src/a.ts', 'wanted line'),
    });
    expect(coverage?.allCandidatesCovered).toBe(true);
    expect(coverage?.files[0]?.status).toBe('candidate-covered-partial');
    expect(coverage?.complete).toBe(false);
  });

  it('checks two candidate spans independently in one file', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'many', [candidate('n1', 'src/a.ts', 1, 1), candidate('n2', 'src/a.ts', 3, 3)])],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 1 }], 'candidate-covered-partial')],
      finalText: source('src/a.ts', 'line 1'),
    });
    expect(coverage?.allCandidatesCovered).toBe(false);
    expect(coverage?.complete).toBe(false);
  });

  it('keeps bounded many ambiguous even when every candidate is covered', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'many', [candidate('n1', 'src/a.ts', 1, 1), candidate('n2', 'src/a.ts', 2, 2)])],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 2 }])],
      finalText: source('src/a.ts'),
    });
    expect(coverage?.allCandidatesCovered).toBe(true);
    expect(coverage?.anchors[0]?.status).toBe('ambiguous');
    expect(coverage?.complete).toBe(false);
  });

  it('recomputes symbol cardinality after the allowed-file intersection', () => {
    const coverage = buildExploreCoverage({
      allowedFilePaths: ['src/a.ts'],
      symbolResolutions: [symbol('Wanted', 'many', [candidate('n1', 'src/a.ts', 1, 1), candidate('n2', 'src/b.ts', 1, 1)])],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: source('src/a.ts'),
    });
    expect(coverage?.anchors[0]).toMatchObject({ status: 'resolved', candidateCount: 1 });
    expect(coverage?.complete).toBe(true);
  });

  it('marks truncated many metadata-only and incomplete', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'many', [candidate('n1', 'src/a.ts', 1, 1)], true)],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 1 }])],
      finalText: source('src/a.ts'),
    });
    expect(coverage?.anchors[0]).toMatchObject({ candidateLowerBound: 2, truncated: true });
    expect(coverage?.complete).toBe(false);
  });

  it.each([
    ['pointer', false], ['back-reference', false], ['focused', false], ['skeleton', false], ['clipped', false], ['stale', false],
  ] as const)('does not treat %s as full explicit-file coverage', (status, complete) => {
    const coverage = buildExploreCoverage({
      pathAnchors: [fileAnchor('src/a.ts', 'src/a.ts')],
      indexedFiles: ['src/a.ts'],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }], status)],
      finalText: source('src/a.ts'),
    });
    expect(coverage?.complete).toBe(complete);
  });

  it('expands a directory, dedupes overlapping files, and requires both full files', () => {
    const anchors = [
      { ...fileAnchor('src/a.ts', 'src/a.ts'), kind: 'directory' as const, directoryPrefix: 'src' },
      fileAnchor('src/a.ts', 'src/a.ts', 1),
    ];
    const coverage = buildExploreCoverage({
      pathAnchors: anchors,
      indexedFiles: ['src/a.ts', 'src/b.ts', 'src-utils/c.ts'],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }]), fact('src/b.ts', [{ start: 1, end: 2 }], 'clipped')],
      finalText: source('src/a.ts') + source('src/b.ts'),
    });
    expect(coverage?.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(coverage?.anchors[0]?.expectedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(coverage).toMatchObject({ anchorCount: 2, expectedFileCount: 2, renderedFileCount: 2 });
    expect(coverage?.complete).toBe(false);
  });

  it('distinguishes unresolved, missing, outside, and not-indexed statuses', () => {
    const unresolved = { ...fileAnchor('missing.ts', 'missing.ts'), status: 'unresolved' as const, resolvedFiles: [] };
    const outside = { ...fileAnchor('/other/a.ts', '/other/a.ts'), status: 'outside-root' as const, resolvedFiles: [] };
    const notIndexed = { ...fileAnchor('config.toml', 'config.toml'), status: 'not-indexed' as const, resolvedFiles: [] };
    const coverage = buildExploreCoverage({ pathAnchors: [unresolved, outside, notIndexed], renderFacts: [], finalText: '' });
    expect(coverage?.anchors.map((anchor) => anchor.status)).toEqual(['unresolved', 'outside-root', 'not-indexed']);
    expect(coverage?.complete).toBe(false);
  });

  it('forces incomplete for truncated path inventory and omits coverage for unanchored output', () => {
    const truncated = buildExploreCoverage({
      pathAnchors: [fileAnchor('src/a.ts', 'src/a.ts')],
      pathAnchorsTruncated: true,
      indexedFiles: ['src/a.ts'],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: source('src/a.ts'),
    });
    expect(truncated?.inventoryTruncated).toBe(true);
    expect(truncated?.complete).toBe(false);
    expect(buildExploreCoverage({ renderFacts: [], finalText: 'ordinary answer' })).toBeUndefined();
  });

  it('marks a final section cut without a closing fence as dropped', () => {
    const coverage = buildExploreCoverage({
      pathAnchors: [fileAnchor('src/a.ts', 'src/a.ts')],
      indexedFiles: ['src/a.ts'],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: '**`src/a.ts`**\n\n```ts\npartial',
    });
    expect(coverage?.files[0]).toMatchObject({ status: 'dropped', ranges: [] });
    expect(coverage?.complete).toBe(false);
  });

  it('does not treat markdown-looking labels inside source as file sections', () => {
    const coverage = buildExploreCoverage({
      pathAnchors: [fileAnchor('src/fake.ts', 'src/fake.ts')],
      indexedFiles: ['src/fake.ts'],
      renderFacts: [fact('src/fake.ts', [{ start: 1, end: 3 }])],
      finalText: source('src/real.ts', '**`src/fake.ts`**\nheading\n`not a fence`'),
    });
    expect(coverage?.files.find((file) => file.path === 'src/fake.ts')).toMatchObject({ status: 'dropped' });
    expect(coverage?.complete).toBe(false);
  });

  it('requires a real opened and closed fence after a header', () => {
    const headerOnly = buildExploreCoverage({
      pathAnchors: [fileAnchor('src/a.ts', 'src/a.ts')],
      indexedFiles: ['src/a.ts'],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: '**`src/a.ts`**\n',
    });
    const cutFence = buildExploreCoverage({
      pathAnchors: [fileAnchor('src/a.ts', 'src/a.ts')],
      indexedFiles: ['src/a.ts'],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: '**`src/a.ts`**\n\n```ts\npartial',
    });
    expect(headerOnly?.files[0]?.status).toBe('dropped');
    expect(cutFence?.files[0]?.status).toBe('dropped');
  });

  it('unions multiple legitimate sections for one file without trusting inner labels', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'one', [candidate('n1', 'src/a.ts', 2, 2)])],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: source('src/a.ts', 'first\n**`src/fake.ts`**\ninside') + source('src/a.ts', 'second'),
    });
    expect(coverage?.files).toHaveLength(1);
    expect(coverage?.files[0]?.status).toBe('full-current');
    expect(coverage?.complete).toBe(true);
  });

  it('keeps internal coverage out of session persistence', () => {
    const state = new ExploreSessionState();
    state.record({
      projectRoot: '/repo',
      query: 'Wanted',
      files: [],
      sourceBytes: 0,
      responseBytes: 12,
      coverage: {
        complete: false,
        inventoryTruncated: true,
        allCandidatesCovered: false,
        anchorCount: 0,
        expectedFileCount: 0,
        renderedFileCount: 0,
        anchors: [],
        files: [],
      },
    });
    expect(state.snapshot()[0]?.calls[0]).not.toHaveProperty('coverage');
  });

  it('formats complete, partial, and ambiguous obligations without equating anchors to files', () => {
    const complete = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'one', [candidate('n1', 'src/a.ts', 2, 2)])],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }])],
      finalText: source('src/a.ts'),
    })!;
    const partial = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'one', [candidate('n1', 'src/a.ts', 2, 2)])],
      renderFacts: [fact('src/a.ts', [{ start: 2, end: 2 }], 'candidate-covered-partial')],
      finalText: source('src/a.ts', 'wanted line'),
    })!;
    const many = buildExploreCoverage({
      symbolResolutions: [symbol('Wanted', 'many', [candidate('n1', 'src/a.ts', 1, 1), candidate('n2', 'src/b.ts', 1, 1)])],
      renderFacts: [fact('src/a.ts', [{ start: 1, end: 3 }]), fact('src/b.ts', [{ start: 1, end: 3 }])],
      finalText: source('src/a.ts') + source('src/b.ts'),
    })!;
    expect(formatExploreCoverage(complete)).toContain('Anchor coverage: complete.');
    expect(formatExploreCoverage(complete)).toContain('1/1 expected file full-current.');
    expect(formatExploreCoverage(partial)).toContain('partial');
    expect(formatExploreCoverage(many)).toContain('ambiguous');
    expect(formatExploreCoverage(many)).toContain('All known candidates are covered');
    expect(formatExploreCoverage(many)).toContain('no single definition was selected');
  });

  it('keeps the coverage note bounded when an inventory has many anchors', () => {
    const coverage = buildExploreCoverage({
      symbolResolutions: Array.from({ length: 100 }, (_, i) =>
        symbol(`Wanted${i}`, 'many', [candidate(`n${i}`, `src/${i}.ts`, 1, 1)], true)),
      renderFacts: [],
      finalText: '',
    })!;
    expect(formatExploreCoverage(coverage).length).toBeLessThanOrEqual(1_200);
    expect(formatExploreCoverage(coverage)).toContain('truncated');
  });
});

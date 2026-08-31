/**
 * File-path recognition in explore queries (src/search/query-paths.ts).
 *
 * The originating bug: an agent named two SvelteKit route files by exact path
 * (`src/routes/m/projects/[id]/runs/[runId]/+page.svelte`) and the explore
 * pipeline shredded them — the seeding tokenizer splits on brackets, so the
 * fragments `runId`/`scope` seeded as "named symbols" and headlined the blast
 * radius, while FTS admitted every sibling `+page.svelte` off the `page`/`runs`
 * fragments. These tests pin the module that stops that: path spans resolve
 * against the indexed file list, matching files pin, and the spans leave the
 * query. Resolution IS the detector — slash-bearing non-paths stay untouched.
 */
import { describe, it, expect } from 'vitest';
import { extractQueryPaths, queryMightContainPaths } from '../src/search/query-paths';

const INDEX = [
  'src/routes/m/projects/[id]/runs/[runId]/+page.svelte',
  'src/routes/m/projects/[id]/chat/[scope]/+page.svelte',
  'src/routes/m/projects/[id]/+page.svelte',
  'src/routes/(protected)/chat-window/+page.svelte',
  'src/lib/chat-manager.ts',
  'src/lib/task-runner-manager.ts',
  'src/lib/stores/sqlite-store.ts',
  'src/lib/stores/postgresql-store.ts',
  // Kebab-case frontend shapes (the amnisphere extension-less-basename bug):
  'src/components/training-set-page/training-set-page.tsx',
  'src/components/training-set-page/training-set-page-background-images.tsx',
  'src/components/training-set-page/training-set-page.module.scss',
  'src/components/training-set-page/background-image-table.tsx',
  'src/components/modal/add-to-training-set/add-to-training-set.tsx',
  'src/pages/library-page-layout.tsx',
  'src/api/job-manager/backgrounds.ts',
  'src/x/generic-modal.tsx',
  'src/y/generic-modal.tsx',
  'scripts/pre-commit',
  'src/a/user-profile.tsx',
  'src/b/user-profile.tsx',
  'src/c/user-profile.tsx',
  'src/d/user-profile.tsx',
];

const DIRECTORY_INDEX = [
  'src/anchor.ts',
  'src/nested/child.ts',
  'src-utils/helper.ts',
];

const AMBIGUOUS_DIRECTORY_INDEX = [
  ...DIRECTORY_INDEX,
  'packages/a/src/anchor.ts',
  'packages/b/src/anchor.ts',
];

describe('queryMightContainPaths — the cheap pre-gate', () => {
  it('fires on slashes and dotted basenames', () => {
    expect(queryMightContainPaths('look at src/lib/chat-manager.ts')).toBe(true);
    expect(queryMightContainPaths('look at chat-manager.ts please')).toBe(true);
  });

  it('stays quiet on plain prose and Class.method spans', () => {
    expect(queryMightContainPaths('how does the scroll pinning work')).toBe(false);
    // `.isPackaged` is 10 chars — past the 8-char extension cap.
    expect(queryMightContainPaths('what reads app.isPackaged here')).toBe(false);
  });

  it('fires on extension-less kebab basenames — with or without wrapping', () => {
    expect(queryMightContainPaths('background-image-table Source column')).toBe(true);
    expect(queryMightContainPaths('the `library-page-layout` wrapper')).toBe(true);
    expect(queryMightContainPaths('usage, add-to-training-set.')).toBe(true);
  });

  it('stays quiet on flags, snake_case, and snake-with-a-dash hybrids', () => {
    expect(queryMightContainPaths('run it with --no-cache maybe')).toBe(false);
    expect(queryMightContainPaths('where is background_image_table used')).toBe(false);
    expect(queryMightContainPaths('the foo_bar-baz helper')).toBe(false);
  });
});

describe('extractQueryPaths — resolution and stripping', () => {
  it('resolves a bracketed SvelteKit path and strips it from the query', () => {
    const q = 'auto-scroll logic in src/routes/m/projects/[id]/runs/[runId]/+page.svelte — atBottom tracking';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual(['src/routes/m/projects/[id]/runs/[runId]/+page.svelte']);
    expect(out.strippedQuery).not.toContain('+page.svelte');
    expect(out.strippedQuery).not.toContain('runId');
    expect(out.strippedQuery).toContain('atBottom tracking');
    expect(out.unresolvedPathSpans).toEqual([]);
  });

  it('pins multiple named files in appearance order', () => {
    const q = 'compare src/routes/m/projects/[id]/chat/[scope]/+page.svelte and src/routes/m/projects/[id]/runs/[runId]/+page.svelte';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual([
      'src/routes/m/projects/[id]/chat/[scope]/+page.svelte',
      'src/routes/m/projects/[id]/runs/[runId]/+page.svelte',
    ]);
  });

  it('resolves a (protected) route-group path — parens are path characters', () => {
    const out = extractQueryPaths('read src/routes/(protected)/chat-window/+page.svelte', INDEX);
    expect(out.pinnedFiles).toEqual(['src/routes/(protected)/chat-window/+page.svelte']);
  });

  it('resolves an absolute path by walking suffixes to the indexed relative path', () => {
    const q = 'fix /Users/colby/dev/beads-live-dashboard/src/lib/chat-manager.ts';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
  });

  it('resolves a unique basename and a partial path', () => {
    expect(extractQueryPaths('see chat-manager.ts', INDEX).pinnedFiles)
      .toEqual(['src/lib/chat-manager.ts']);
    expect(extractQueryPaths('see stores/sqlite-store.ts', INDEX).pinnedFiles)
      .toEqual(['src/lib/stores/sqlite-store.ts']);
  });

  it('strips wrapping punctuation and line references', () => {
    const out = extractQueryPaths('the bug (see `src/lib/chat-manager.ts:243`).', INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
    const hash = extractQueryPaths('regression at src/lib/task-runner-manager.ts#L88-L120', INDEX);
    expect(hash.pinnedFiles).toEqual(['src/lib/task-runner-manager.ts']);
  });

  it('treats an over-ambiguous basename as unresolved — stripped and reported', () => {
    const out = extractQueryPaths('why do all +page.svelte files flash', INDEX);
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual(['+page.svelte']);
    expect(out.strippedQuery).toBe('why do all files flash');
  });

  it('strips and reports a clearly-path-shaped span that matches nothing', () => {
    const out = extractQueryPaths('crash in src/routes/gone/missing-page.svelte on load', INDEX);
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual(['src/routes/gone/missing-page.svelte']);
    expect(out.strippedQuery).toBe('crash in on load');
  });

  it('leaves slash-bearing non-paths alone', () => {
    const q = 'does gen_server:call/2 block and/or timeout';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual([]);
    expect(out.strippedQuery).toBe(q);
  });

  it('dedupes a path named twice and honors maxPins', () => {
    const twice = extractQueryPaths(
      'src/lib/chat-manager.ts wraps src/lib/chat-manager.ts', INDEX,
    );
    expect(twice.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);

    const capped = extractQueryPaths(
      'src/lib/chat-manager.ts src/lib/task-runner-manager.ts', INDEX, { maxPins: 1 },
    );
    expect(capped.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
  });

  it('matches case-insensitively but returns the indexed spelling', () => {
    const out = extractQueryPaths('SRC/LIB/CHAT-MANAGER.TS', INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
  });

  it('passes through untouched when nothing resolves', () => {
    const q = 'plain prose question about scrolling';
    const out = extractQueryPaths(q, INDEX);
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [] });
  });
});

describe('extractQueryPaths — extension-less kebab basenames', () => {
  it('pins the file a bare kebab basename names and consumes the token', () => {
    const out = extractQueryPaths('background-image-table Source column', INDEX);
    expect(out.pinnedFiles)
      .toEqual(['src/components/training-set-page/background-image-table.tsx']);
    expect(out.hardScope).toEqual({
      exactFiles: ['src/components/training-set-page/background-image-table.tsx'],
      directoryPrefixes: [],
    });
    expect(out.strippedQuery).toBe('Source column');
    expect(out.unresolvedPathSpans).toEqual([]);
  });

  it('resolves with no slash or extension anywhere in the query (session-4 shape)', () => {
    const out = extractQueryPaths(
      'TrainingSetPage train modal library-page-layout AddToTrainingSetModal usage', INDEX,
    );
    expect(out.pinnedFiles).toEqual(['src/pages/library-page-layout.tsx']);
    // Identifier-shaped tokens stay for the named-symbol seeder.
    expect(out.strippedQuery).toBe('TrainingSetPage train modal AddToTrainingSetModal usage');
  });

  it('pins every named file in a mixed dotted + kebab query (session-1 shape)', () => {
    const out = extractQueryPaths(
      'add-to-training-set training-set-page-background-images backgrounds.ts background-image-table Source column',
      INDEX,
    );
    expect(out.pinnedFiles).toEqual([
      // The dotted pass runs first, so the explicit basename pins ahead of the kebabs.
      'src/api/job-manager/backgrounds.ts',
      'src/components/modal/add-to-training-set/add-to-training-set.tsx',
      'src/components/training-set-page/training-set-page-background-images.tsx',
      'src/components/training-set-page/background-image-table.tsx',
    ]);
    expect(out.strippedQuery).toBe('Source column');
  });

  it('leaves kebab prose that names no indexed file untouched — and unreported', () => {
    const q = 'how does cross-call dedup make explore non-blocking';
    const out = extractQueryPaths(q, INDEX);
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [] });
  });

  it('leaves a stem shared by too many files alone — one hot name must not pin half the repo', () => {
    const q = 'refactor the user-profile rendering';
    const out = extractQueryPaths(q, INDEX);
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [] });
  });

  it('pins all files sharing a stem when within the ambiguity budget', () => {
    const out = extractQueryPaths('generic-modal close behavior', INDEX);
    expect(out.pinnedFiles).toEqual(['src/x/generic-modal.tsx', 'src/y/generic-modal.tsx']);
  });

  it('matches case-insensitively and through wrapping punctuation', () => {
    expect(extractQueryPaths('see `Background-Image-Table`.', INDEX).pinnedFiles)
      .toEqual(['src/components/training-set-page/background-image-table.tsx']);
  });

  it('stems drop only the last extension — a kebab token cannot pin a .module.scss sibling', () => {
    const out = extractQueryPaths('training-set-page props flow', INDEX);
    expect(out.pinnedFiles)
      .toEqual(['src/components/training-set-page/training-set-page.tsx']);
  });

  it('pins an extension-less indexed file by its exact name', () => {
    expect(extractQueryPaths('what does the pre-commit hook run', INDEX).pinnedFiles)
      .toEqual(['scripts/pre-commit']);
  });

  it('skips tokens the dotted pass consumed and dedupes a file named both ways', () => {
    const out = extractQueryPaths('src/lib/chat-manager.ts vs chat-manager internals', INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
    expect(out.strippedQuery).toBe('vs internals');
  });

  it('explicit paths win the shared maxPins budget over kebab tokens', () => {
    const out = extractQueryPaths(
      'background-image-table then src/lib/chat-manager.ts', INDEX, { maxPins: 1 },
    );
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
    // The kebab token was not consumed once the budget was spent — it stays for FTS.
    expect(out.strippedQuery).toBe('background-image-table then');
  });
});

describe('extractQueryPaths — internal directory scope', () => {
  it('derives a hard directory scope from a trailing-slash path', () => {
    const out = extractQueryPaths('inspect src/', DIRECTORY_INDEX);
    expect(out.hardScope).toEqual({ exactFiles: [], directoryPrefixes: ['src'] });
    expect(out.strippedQuery).toBe('inspect src/');
  });

  it('resolves a unique slash-bearing directory without a trailing slash', () => {
    const out = extractQueryPaths('inspect src/nested', DIRECTORY_INDEX);
    expect(out.hardScope).toEqual({ exactFiles: [], directoryPrefixes: ['src/nested'] });
  });

  it('resolves an in-root absolute directory to its canonical relative prefix', () => {
    const out = extractQueryPaths('inspect /work/repo/src/nested', DIRECTORY_INDEX, {
      rootPath: '/work/repo',
    });
    expect(out.hardScope).toEqual({ exactFiles: [], directoryPrefixes: ['src/nested'] });
  });

  it('does not treat URI or import-scheme tokens as path anchors', () => {
    for (const q of ['inspect https://example.com/src', 'inspect pkg://example.com/src']) {
      const out = extractQueryPaths(q, DIRECTORY_INDEX);
      expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [] });
    }
  });

  it('records an in-root absolute file as an exact hard-scope member', () => {
    const out = extractQueryPaths('inspect /work/repo/src/anchor.ts', DIRECTORY_INDEX, {
      rootPath: '/work/repo',
    });
    expect(out.pinnedFiles).toEqual(['src/anchor.ts']);
    expect(out.hardScope).toEqual({ exactFiles: ['src/anchor.ts'], directoryPrefixes: [] });
  });

  it('rejects outside-root and parent escapes without pinning', () => {
    const outside = extractQueryPaths('inspect /work/other/src', DIRECTORY_INDEX, {
      rootPath: '/work/repo',
    });
    expect(outside.pinnedFiles).toEqual([]);
    expect(outside.hardScope).toBeUndefined();
    expect(outside.unresolvedPathSpans).toContain('/work/other/src');

    const escape = extractQueryPaths('inspect ../src', DIRECTORY_INDEX, {
      rootPath: '/work/repo',
    });
    expect(escape.pinnedFiles).toEqual([]);
    expect(escape.hardScope).toBeUndefined();
    expect(escape.unresolvedPathSpans).toContain('../src');
  });

  it('keeps directory scope segment-aligned and excludes sibling prefixes', () => {
    const out = extractQueryPaths('inspect src/', DIRECTORY_INDEX);
    expect(out.hardScope?.directoryPrefixes).toEqual(['src']);
    expect(out.hardScope?.directoryPrefixes).not.toContain('src-utils');
  });

  it('preserves directory text by default and consumes it only when opted in', () => {
    const mixed = extractQueryPaths('inspect src/ and src/anchor.ts', DIRECTORY_INDEX);
    expect(mixed.hardScope).toEqual({ exactFiles: ['src/anchor.ts'], directoryPrefixes: ['src'] });
    expect(mixed.strippedQuery).toBe('inspect src/ and');

    const consumed = extractQueryPaths('inspect src/ and src/anchor.ts', DIRECTORY_INDEX, {
      consumeDirectories: true,
    });
    expect(consumed.hardScope).toEqual({ exactFiles: ['src/anchor.ts'], directoryPrefixes: ['src'] });
    expect(consumed.strippedQuery).toBe('inspect and');
  });

  it('preserves Windows drive identity and rejects mismatches and drive-relative paths', () => {
    const root = 'C:\\work\\repo';
    const inRoot = extractQueryPaths('inspect C:\\WORK\\REPO\\src\\anchor.ts', DIRECTORY_INDEX, { rootPath: root });
    expect(inRoot.pinnedFiles).toEqual(['src/anchor.ts']);

    for (const q of ['inspect D:\\work\\repo\\src\\anchor.ts', 'inspect C:src\\anchor.ts']) {
      const out = extractQueryPaths(q, DIRECTORY_INDEX, { rootPath: root });
      expect(out.pinnedFiles).toEqual([]);
      expect(out.hardScope).toBeUndefined();
    }
  });

  it('keeps UNC and POSIX roots distinct while accepting separator variants', () => {
    const unc = extractQueryPaths('inspect \\\\server\\share\\repo\\src\\anchor.ts', DIRECTORY_INDEX, {
      rootPath: '\\\\server\\share\\repo',
    });
    expect(unc.pinnedFiles).toEqual(['src/anchor.ts']);

    const wrongRoot = extractQueryPaths('inspect \\\\server\\share\\repo\\src\\anchor.ts', DIRECTORY_INDEX, {
      rootPath: '/server/share/repo',
    });
    expect(wrongRoot.pinnedFiles).toEqual([]);
    expect(wrongRoot.hardScope).toBeUndefined();
  });

  it('reports an ambiguous directory suffix without choosing one', () => {
    const out = extractQueryPaths('inspect ./src/', AMBIGUOUS_DIRECTORY_INDEX);
    expect(out.hardScope).toBeUndefined();
    expect(out.unresolvedPathSpans).toContain('src');
  });

  it('resolves an exact indexed path containing a colon before scheme rejection', () => {
    const out = extractQueryPaths('inspect foo:bar/baz.ts', ['foo:bar/baz.ts']);
    expect(out.pinnedFiles).toEqual(['foo:bar/baz.ts']);
  });

  it('does not suffix-match an unresolved colon scheme token', () => {
    const query = 'inspect foo:bar/missing.ts';
    const out = extractQueryPaths(query, ['other/bar/missing.ts']);
    expect(out).toEqual({ strippedQuery: query, pinnedFiles: [], unresolvedPathSpans: [] });
  });

  it('keeps one identity record per repeated alias while deduping pinned files', () => {
    const query = 'inspect src/anchor.ts and ./src/anchor.ts';
    const out = extractQueryPaths(query, DIRECTORY_INDEX);
    expect(out.pinnedFiles).toEqual(['src/anchor.ts']);
    expect(out.pathAnchors).toEqual([
      {
        raw: 'src/anchor.ts',
        ordinal: 1,
        start: 8,
        end: 21,
        kind: 'file',
        normalized: 'src/anchor.ts',
        status: 'resolved',
        resolvedFiles: ['src/anchor.ts'],
      },
      {
        raw: './src/anchor.ts',
        ordinal: 3,
        start: 26,
        end: 41,
        kind: 'file',
        normalized: 'src/anchor.ts',
        status: 'resolved',
        resolvedFiles: ['src/anchor.ts'],
      },
    ]);
  });

  it('retains distinct file and directory identities for overlapping anchors', () => {
    const out = extractQueryPaths('inspect src/ and src/anchor.ts', DIRECTORY_INDEX);
    expect(out.pathAnchors).toEqual([
      {
        raw: 'src/',
        ordinal: 1,
        start: 8,
        end: 12,
        kind: 'directory',
        normalized: 'src',
        status: 'resolved',
        resolvedFiles: [],
        directoryPrefix: 'src',
      },
      {
        raw: 'src/anchor.ts',
        ordinal: 3,
        start: 17,
        end: 30,
        kind: 'file',
        normalized: 'src/anchor.ts',
        status: 'resolved',
        resolvedFiles: ['src/anchor.ts'],
      },
    ]);
  });

  it('records unresolved and outside-root attempts without inventing resolutions', () => {
    const missing = extractQueryPaths('inspect src/missing.ts', DIRECTORY_INDEX);
    expect(missing.pathAnchors).toEqual([
      expect.objectContaining({
        raw: 'src/missing.ts',
        ordinal: 1,
        kind: 'unresolved-path',
        normalized: 'src/missing.ts',
        status: 'unresolved',
        resolvedFiles: [],
      }),
    ]);

    const outside = extractQueryPaths('inspect /work/other/src/anchor.ts', DIRECTORY_INDEX, {
      rootPath: '/work/repo',
    });
    expect(outside.pathAnchors).toEqual([
      expect.objectContaining({
        raw: '/work/other/src/anchor.ts',
        kind: 'unresolved-path',
        normalized: '/work/other/src/anchor.ts',
        status: 'outside-root',
        resolvedFiles: [],
      }),
    ]);
  });

  it('does not create anchor identities for URLs or dotted prose', () => {
    for (const query of ['inspect https://example.com/src', 'inspect pkg://example.com/src', 'inspect foo.Bar']) {
      expect(extractQueryPaths(query, DIRECTORY_INDEX).pathAnchors).toBeUndefined();
    }
  });

  it('records canonical identities for colon and Windows-shaped exact files', () => {
    const colon = extractQueryPaths('inspect foo:bar/baz.ts', ['foo:bar/baz.ts']);
    expect(colon.pathAnchors).toEqual([
      expect.objectContaining({
        raw: 'foo:bar/baz.ts',
        kind: 'file',
        normalized: 'foo:bar/baz.ts',
        status: 'resolved',
        resolvedFiles: ['foo:bar/baz.ts'],
      }),
    ]);

    const windows = extractQueryPaths('inspect C:\\WORK\\REPO\\src\\anchor.ts', DIRECTORY_INDEX, {
      rootPath: 'C:\\work\\repo',
    });
    expect(windows.pathAnchors).toEqual([
      expect.objectContaining({
        raw: 'C:\\WORK\\REPO\\src\\anchor.ts',
        kind: 'file',
        normalized: 'src/anchor.ts',
        status: 'resolved',
        resolvedFiles: ['src/anchor.ts'],
      }),
    ]);
  });

  it('reports an exact token remainder when maxPins stops examination', () => {
    const index = ['src/first.ts', 'src/second.ts', 'src/third.ts', 'src/fourth.ts'];
    const query = 'inspect src/first.ts src/second.ts src/third.ts src/fourth.ts';
    const out = extractQueryPaths(query, index, { maxPins: 1 });
    expect(out.pinnedFiles).toEqual(['src/first.ts']);
    expect(out.strippedQuery).toBe('inspect src/second.ts src/third.ts src/fourth.ts');
    expect(out.pathAnchorsTruncated).toBe(true);
    expect(out.unexaminedTokenCount).toBe(3);
    expect(out.pathAnchorsTruncationReasons).toEqual(['max-pins']);
    expect(out.pathAnchors).toHaveLength(1);
  });

  it('does not fabricate an anchor for an extensionless kebab token after maxPins', () => {
    const index = ['src/first.ts', 'src/background-image-table.ts'];
    const out = extractQueryPaths('inspect src/first.ts background-image-table', index, { maxPins: 1 });
    expect(out.pinnedFiles).toEqual(['src/first.ts']);
    expect(out.pathAnchorsTruncated).toBe(true);
    expect(out.unexaminedTokenCount).toBe(1);
    expect(out.pathAnchorsTruncationReasons).toEqual(['max-pins']);
    expect(out.pathAnchors).toHaveLength(1);
    expect(out.pathAnchors?.some((anchor) => anchor.raw === 'background-image-table')).toBe(false);
  });

  it('does not report truncation when maxPins is reached at the end of the query', () => {
    const out = extractQueryPaths('inspect src/first.ts', ['src/first.ts'], { maxPins: 1 });
    expect(out.pinnedFiles).toEqual(['src/first.ts']);
    expect(out.pathAnchorsTruncated).toBeUndefined();
    expect(out.unexaminedTokenCount).toBeUndefined();
    expect(out.pathAnchorsTruncationReasons).toBeUndefined();
  });

  it('reports candidates beyond the bounded path scan without consuming their text', () => {
    const index = Array.from({ length: 12 }, (_, i) => `src/p${i}.ts`);
    const query = `inspect ${index.join(' ')}`;
    const out = extractQueryPaths(query, index, { maxPins: 20 });
    expect(out.pinnedFiles).toEqual(index.slice(0, 8));
    expect(out.strippedQuery).toBe(`inspect ${index.slice(8).join(' ')}`);
    expect(out.pathAnchorsTruncated).toBe(true);
    expect(out.unexaminedTokenCount).toBe(4);
    expect(out.pathAnchorsTruncationReasons).toEqual(['candidate-cap']);
    expect(out.pathAnchors).toHaveLength(8);
  });

  it('treats trailing separators as directory intent over extensionless files', () => {
    const withDescendant = extractQueryPaths('inspect src/', ['src', 'src/child.ts']);
    expect(withDescendant.pinnedFiles).toEqual([]);
    expect(withDescendant.hardScope).toEqual({ exactFiles: [], directoryPrefixes: ['src'] });
    expect(withDescendant.pathAnchors).toEqual([
      expect.objectContaining({ kind: 'directory', normalized: 'src', status: 'resolved' }),
    ]);

    const withoutDescendant = extractQueryPaths('inspect empty/', ['empty']);
    expect(withoutDescendant.pinnedFiles).toEqual([]);
    expect(withoutDescendant.pathAnchors).toEqual([
      expect.objectContaining({ kind: 'directory', normalized: 'empty', status: 'unresolved' }),
    ]);
  });

  it('preserves trailing directory intent for Windows drive and UNC roots', () => {
    const drive = extractQueryPaths('inspect C:\\repo\\src\\', ['src/child.ts'], {
      rootPath: 'C:\\repo',
    });
    expect(drive.hardScope).toEqual({ exactFiles: [], directoryPrefixes: ['src'] });
    expect(drive.pathAnchors).toEqual([
      expect.objectContaining({ kind: 'directory', normalized: 'src', status: 'resolved' }),
    ]);

    const unc = extractQueryPaths('inspect \\\\server\\share\\repo\\src\\', ['src/child.ts'], {
      rootPath: '\\\\server\\share\\repo',
    });
    expect(unc.hardScope).toEqual({ exactFiles: [], directoryPrefixes: ['src'] });
    expect(unc.pathAnchors).toEqual([
      expect.objectContaining({ kind: 'directory', normalized: 'src', status: 'resolved' }),
    ]);
  });

  it('reports the full bounded token remainder without classifying maxPins tail text', () => {
    const index = ['src/first.ts', 'src/late.ts', 'src/child.ts'];
    const query = 'inspect src/first.ts gen_server:call/2 and/or foo/bar call/2 src/late.ts src/missing.ts /work/repo/src/child.ts src/';
    const out = extractQueryPaths(query, index, { maxPins: 1, rootPath: '/work/repo' });
    expect(out.pinnedFiles).toEqual(['src/first.ts']);
    expect(out.pathAnchorsTruncated).toBe(true);
    expect(out.unexaminedTokenCount).toBe(8);
    expect(out.pathAnchorsTruncationReasons).toEqual(['max-pins']);
    expect(out.pathAnchors).toHaveLength(1);
    expect(out.pathAnchors?.some((anchor) => anchor.raw === 'src/late.ts')).toBe(false);
    expect(out.pathAnchors?.some((anchor) => anchor.raw === 'gen_server:call/2')).toBe(false);
    expect(out.pathAnchors?.some((anchor) => anchor.raw === 'and/or')).toBe(false);
  });

  it('keeps candidate-cap truth at N-1, N, and N+1 without counting slash prose', () => {
    const index = Array.from({ length: 9 }, (_, i) => `src/p${i}.ts`);
    const falseTail = 'gen_server:call/2 and/or foo/bar call/2';
    const extract = (count: number, includeFalseTail = true) => extractQueryPaths(
      `inspect ${index.slice(0, count).join(' ')}${includeFalseTail ? ` ${falseTail}` : ''}`,
      index,
      { maxPins: 20 },
    );

    for (const count of [7, 8]) {
      const out = extract(count, false);
      expect(out.pathAnchorsTruncated).toBeUndefined();
      expect(out.unexaminedTokenCount).toBeUndefined();
      expect(out.pinnedFiles).toEqual(index.slice(0, count));
    }
    const over = extract(9);
    expect(over.pathAnchorsTruncated).toBe(true);
    expect(over.unexaminedTokenCount).toBe(5);
    expect(over.pathAnchorsTruncationReasons).toEqual(['candidate-cap']);
    expect(over.pathAnchors).toHaveLength(8);
    expect(over.pathAnchors?.some((anchor) => anchor.raw === 'gen_server:call/2')).toBe(false);
    expect(over.pathAnchors?.some((anchor) => anchor.raw === 'and/or')).toBe(false);
    expect(over.pathAnchors?.some((anchor) => anchor.raw === 'foo/bar')).toBe(false);
    expect(over.pathAnchors?.some((anchor) => anchor.raw === 'call/2')).toBe(false);
  });

  it('uses aggregate truncation for true path and ordinary tail tokens alike', () => {
    const indexed = [
      ...Array.from({ length: 8 }, (_, i) => `src/p${i}.ts`),
      'src/late/child.ts',
      'src/background-image-table.ts',
    ];
    const out = extractQueryPaths(
      'inspect src/p0.ts src/p1.ts src/p2.ts src/p3.ts src/p4.ts src/p5.ts src/p6.ts src/p7.ts '
        + 'src/late/child.ts background-image-table gen_server:call/2',
      indexed,
      { maxPins: 20 },
    );
    expect(out.pathAnchorsTruncated).toBe(true);
    expect(out.unexaminedTokenCount).toBe(3);
    expect(out.pathAnchorsTruncationReasons).toEqual(['candidate-cap']);
    expect(out.pathAnchors).toHaveLength(8);
    expect(out.pathAnchors?.some((anchor) => anchor.raw === 'src/late/child.ts')).toBe(false);
    expect(out.pathAnchors?.some((anchor) => anchor.raw === 'background-image-table')).toBe(false);
    expect(out.pathAnchors?.some((anchor) => anchor.raw === 'gen_server:call/2')).toBe(false);
  });
});

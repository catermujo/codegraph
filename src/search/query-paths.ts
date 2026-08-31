/**
 * File-path recognition for explore queries.
 *
 * Agents routinely name files by path in a `codegraph_explore` query —
 * "the scroll logic in src/routes/m/projects/[id]/runs/[runId]/+page.svelte" —
 * and until this module existed those spans were SHREDDED by the downstream
 * tokenizers instead of being read as file references:
 *
 *   - the named-symbol seeder splits on `[\s,()[\]]+`, so SvelteKit/Next
 *     bracketed segments (`[id]`, `[runId]`) and route groups (`(protected)`)
 *     exploded the path into fragments; the identifier-shaped survivors
 *     (`runId`, `scope`) then seeded as "symbols the agent named" and
 *     headlined the blast radius;
 *   - FTS saw the fragments (`page`, `chat`, `runs`) and admitted every
 *     sibling `+page.svelte` in the repo, which ate the output envelope and
 *     truncated the files the agent actually asked for.
 *
 * `extractQueryPaths` finds path-like spans — slashed paths, dotted basenames,
 * and extension-less kebab basenames (`background-image-table`, the spelling
 * import paths and prose actually use) — resolves them against the INDEXED
 * file list (resolution IS the detector — `and/or`, `gen_server:call/2`,
 * `non-blocking` and other path-shaped non-paths match nothing and are left
 * alone), and returns the matches as pinned files plus the query with those
 * spans removed.
 * Callers treat pinned files as first-class: guaranteed admission, top rank,
 * funded first. Pure string work — no DB, no fs — so it is trivially testable
 * and safe inside the query-pool workers.
 */

import * as path from 'path';

export interface QueryPathExtraction {
  /** The query with resolved/clearly-path spans removed, whitespace-joined. */
  strippedQuery: string;
  /** Indexed file paths the query named, appearance-ordered, deduped. */
  pinnedFiles: string[];
  /**
   * Spans that are unambiguously path-shaped but resolved to nothing (stale
   * path, unindexed file) or to too many files (bare `+page.svelte`). Stripped
   * from the query — their fragments could only mint junk matches — and
   * surfaced to the agent so the miss is visible instead of silent.
   */
  unresolvedPathSpans: string[];
  /** Explicit indexed files and directory prefixes for later hard scoping. */
  hardScope?: QueryPathScope;
  /** Each path-shaped query occurrence that was actually resolved or rejected. */
  pathAnchors?: QueryPathAnchor[];
  /** True when bounded processing left one or more query tokens unexamined. */
  pathAnchorsTruncated?: boolean;
  /** Exact number of query tokens after the first bounded stop. */
  unexaminedTokenCount?: number;
  /** Safety caps that caused bounded path processing to stop. */
  pathAnchorsTruncationReasons?: QueryPathAnchorTruncationReason[];
}

interface QueryPathScope {
  exactFiles: string[];
  directoryPrefixes: string[];
}

export type QueryPathAnchorKind = 'file' | 'directory' | 'unresolved-path';
export type QueryPathAnchorStatus =
  | 'resolved' | 'ambiguous' | 'unresolved' | 'not-indexed' | 'missing' | 'outside-root';
export type QueryPathAnchorTruncationReason = 'max-pins' | 'candidate-cap';

/** Serializable identity for one explicit path attempt in the original query. */
export interface QueryPathAnchor {
  /** The exact whitespace-delimited spelling, including wrapping punctuation. */
  raw: string;
  /** Zero-based token occurrence in the original query. */
  ordinal: number;
  /** UTF-16 offsets into the original query. */
  start: number;
  end: number;
  kind: QueryPathAnchorKind;
  /** Normalized query spelling, or the best lexical normalization after rejection. */
  normalized: string;
  status: QueryPathAnchorStatus;
  /** Canonical indexed files selected by this occurrence. */
  resolvedFiles: string[];
  /** Canonical indexed directory prefix selected by this occurrence. */
  directoryPrefix?: string;
}

/**
 * Cheap pre-gate so callers only fetch the indexed file list when the query
 * could possibly contain a path: a slash, a dot-extension-shaped tail
 * (`chat-manager.ts`), or a hyphen-joined word (`background-image-table` —
 * kebab files are named WITHOUT their extension more often than with, so the
 * shape must open the gate on its own). Extensions cap at 8 chars, which
 * keeps `Class.method` spans (`app.isPackaged`) from qualifying; the kebab
 * alternative requires clean non-word boundaries, which keeps `--flags` and
 * snake_case-with-a-dash hybrids from firing it.
 */
export function queryMightContainPaths(query: string): boolean {
  return /[/\\]/.test(query)
    || /\.[A-Za-z][A-Za-z0-9]{0,7}(?=[\s,;:)\]'"`]|$)/.test(query)
    || /(?:^|[^-\w])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?=[^-\w]|$)/.test(query);
}

/**
 * Longest span→suffix walk tried per span. 8 covers an absolute macOS path
 * (`/Users/<user>/dev/<repo>/…`) over a deeply nested repo-relative file;
 * deeper prefixes buy nothing.
 */
const MAX_SUFFIX_TRIES = 8;
/** Spans examined per query — a prose sentence is not 50 paths. */
const MAX_CANDIDATE_SPANS = 8;

/** `name.ext` shape with a plausible source extension (no slash required). */
const DOTTED_BASENAME = /^[^\s/\\]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Extension-less kebab basename (`background-image-table`). Hyphens are
 * illegal in identifiers, so consuming these tokens can never steal one from
 * the named-symbol seeder; ≥2 segments keeps single words out.
 */
const KEBAB_BASENAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;

/** A basename's last dot-extension, same shape DOTTED_BASENAME accepts. */
const LAST_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Lowercased basename stems of the hyphen-named indexed files, stem → paths.
 * A stem drops only the LAST extension (`a-b.module.scss` → `a-b.module`), so
 * a bare kebab token can't accidentally pin a same-named stylesheet or
 * `.d.ts` sibling of the source file it names; an extension-less basename
 * (`pre-commit`) is its own stem. Hyphen-free basenames are skipped — a
 * KEBAB_BASENAME token can never equal one, and the filter keeps the map
 * near-empty in repos that don't name files this way.
 */
function buildBasenameStems(indexedPaths: readonly string[]): Map<string, string[]> {
  const stems = new Map<string, string[]>();
  for (const p of indexedPaths) {
    const basename = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
    if (!basename.includes('-')) continue;
    const stem = basename.replace(LAST_EXTENSION, '').toLowerCase();
    if (!stem) continue;
    const existing = stems.get(stem);
    if (existing) existing.push(p);
    else stems.set(stem, [p]);
  }
  return stems;
}

/**
 * Strip prose punctuation wrapped around a token without eating punctuation
 * that is PART of the path: quotes/backticks always strip; a trailing `)`/`]`
 * strips only when the token has no matching opener (so `(protected)` and
 * `[id]` segments survive, while "…(see src/foo.ts)" loses its parenthesis);
 * a leading `(`/`[` mirrors that. Trailing sentence punctuation strips last,
 * so "src/foo.ts." resolves.
 */
function stripWrapping(token: string): string {
  let s = token;
  for (;;) {
    const first = s[0];
    if (!first) break;
    if ('\'"`<'.includes(first)) { s = s.slice(1); continue; }
    if (first === '(' && !s.includes(')')) { s = s.slice(1); continue; }
    if (first === '[' && !s.includes(']')) { s = s.slice(1); continue; }
    if (first === '{' && !s.includes('}')) { s = s.slice(1); continue; }
    break;
  }
  for (;;) {
    const last = s[s.length - 1];
    if (!last) break;
    if ('\'"`>.,;!?'.includes(last)) { s = s.slice(0, -1); continue; }
    if (last === ')' && !s.includes('(')) { s = s.slice(0, -1); continue; }
    if (last === ']' && !s.includes('[')) { s = s.slice(0, -1); continue; }
    if (last === '}' && !s.includes('{')) { s = s.slice(0, -1); continue; }
    break;
  }
  // Line references ride along in agent-written paths: `foo.ts:123`,
  // `foo.ts:12-40`, `foo.ts#L88`. The file is what gets pinned.
  s = s.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  return s;
}

/** Normalize a span into the repo-relative shape the files table stores. */
function normalizeSpan(span: string): string {
  return span
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

function isWindowsAbsolute(span: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(span) || /^[/\\]{2}[^/\\]/.test(span);
}

function isDriveRelative(span: string): boolean {
  return /^[A-Za-z]:[^\\/]/.test(span);
}

function isSchemeLike(span: string): boolean {
  return !isWindowsAbsolute(span) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(span);
}

function normalizeRootedSpan(span: string, rootPath: string): string | null {
  if (isDriveRelative(span)) return null;
  const windowsRoot = isWindowsAbsolute(rootPath);
  if (windowsRoot) {
    if (span.startsWith('/') && !isWindowsAbsolute(span)) return null;
    const root = path.win32.normalize(rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
    const candidate = isWindowsAbsolute(span)
      ? path.win32.normalize(span).replace(/\\/g, '/').replace(/\/+$/, '')
      : normalizeSpan(span);
    if (isWindowsAbsolute(span)) {
      if (candidate.toLowerCase() === root.toLowerCase()) return '';
      if (!candidate.toLowerCase().startsWith(root.toLowerCase() + '/')) return null;
      return normalizeSpan(candidate.slice(root.length + 1));
    }
    return normalizeSpan(candidate);
  }
  if (isWindowsAbsolute(span)) return null;
  const root = path.posix.normalize(rootPath).replace(/\/+$/, '');
  const candidate = path.posix.normalize(span).replace(/\/+$/, '');
  if (candidate.startsWith('/')) {
    if (candidate.toLowerCase() === root.toLowerCase()) return '';
    if (!candidate.toLowerCase().startsWith(root.toLowerCase() + '/')) return null;
    return normalizeSpan(candidate.slice(root.length + 1));
  }
  const segments: string[] = [];
  for (const segment of candidate.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

/** Path-shaped beyond doubt: ≥2 segments and a dot-extension on the last. */
function isClearlyPathShaped(normalized: string): boolean {
  const slash = normalized.lastIndexOf('/');
  if (slash <= 0) return false;
  return DOTTED_BASENAME.test(normalized.slice(slash + 1));
}

function isPathTokenShape(stripped: string): boolean {
  return /[/\\]/.test(stripped) || DOTTED_BASENAME.test(stripped);
}

/**
 * Resolve one normalized span against the indexed paths: exact match first,
 * then segment-aligned suffix matches, dropping leading segments one at a
 * time (so an absolute path, or one prefixed with the repo directory name,
 * still lands on the indexed repo-relative file). Suffixes only get shorter —
 * and therefore only match MORE — so the walk stops at the first suffix that
 * matches anything: within budget it resolves, over budget it is ambiguous.
 */
function resolveSpan(
  normalizedLower: string,
  lowerToOriginal: ReadonlyMap<string, string>,
  getDirectoryPrefixes: () => ReadonlyMap<string, readonly string[]>,
  maxMatches: number,
  preferDirectory: boolean,
): { matches: string[]; directoryPrefixes: string[]; ambiguous: boolean } {
  if (!preferDirectory) {
    const exact = lowerToOriginal.get(normalizedLower);
    if (exact) return { matches: [exact], directoryPrefixes: [], ambiguous: false };
  }

  const segments = normalizedLower.split('/').filter(Boolean);
  const tries = Math.min(segments.length, MAX_SUFFIX_TRIES);
  if (!preferDirectory) {
    for (let drop = 0; drop < tries; drop++) {
      const suffix = segments.slice(drop).join('/');
      if (!suffix) break;
      const withSlash = '/' + suffix;
      const matches: string[] = [];
      for (const [lower, original] of lowerToOriginal) {
        if (lower === suffix || lower.endsWith(withSlash)) {
          matches.push(original);
          if (matches.length > maxMatches) return { matches: [], directoryPrefixes: [], ambiguous: true };
        }
      }
      if (matches.length > 0) return { matches, directoryPrefixes: [], ambiguous: false };
    }
  }
  const lowerToDirectoryPrefixes = getDirectoryPrefixes();
  for (let drop = 0; drop < tries; drop++) {
    const suffix = segments.slice(drop).join('/');
    if (!suffix) break;
    const withSlash = '/' + suffix;
    const directoryPrefixes: string[] = [];
    for (const [lower, prefixes] of lowerToDirectoryPrefixes) {
      if (lower !== suffix && !lower.endsWith(withSlash)) continue;
      directoryPrefixes.push(...prefixes);
      if (directoryPrefixes.length > maxMatches) break;
    }
    if (directoryPrefixes.length === 0) continue;
    if (directoryPrefixes.length !== 1 || directoryPrefixes.length > maxMatches) {
      return { matches: [], directoryPrefixes: [], ambiguous: true };
    }
    return { matches: [], directoryPrefixes, ambiguous: false };
  }
  return { matches: [], directoryPrefixes: [], ambiguous: false };
}

export function extractQueryPaths(
  query: string,
  indexedPaths: readonly string[],
  opts: {
    maxPins?: number;
    maxMatchesPerSpan?: number;
    rootPath?: string;
    consumeDirectories?: boolean;
  } = {},
): QueryPathExtraction {
  const maxPins = Math.max(1, opts.maxPins ?? 8);
  const maxMatchesPerSpan = Math.max(1, opts.maxMatchesPerSpan ?? 3);

  const passthrough: QueryPathExtraction = {
    strippedQuery: query,
    pinnedFiles: [],
    unresolvedPathSpans: [],
  };
  if (!query.trim() || indexedPaths.length === 0) return passthrough;

  // Lowercase view of the index, built once per call. Last writer wins on a
  // case-colliding pair, which is the existing file-view behavior too.
  const lowerToOriginal = new Map<string, string>();
  for (const p of indexedPaths) lowerToOriginal.set(p.toLowerCase(), p);
  const tokenSpans = [...query.matchAll(/\S+/g)].map((match) => ({
    raw: match[0]!,
    start: match.index!,
    end: match.index! + match[0]!.length,
  }));
  const tokens = tokenSpans.map((token) => token.raw);
  const directoryNeedles = new Set<string>();
  const indexedPathNeedsNormalization = indexedPaths.some((p) =>
    p.includes('\\') || p.includes('//') || p.endsWith('/'));
  let lowerToDirectoryPrefixes: Map<string, string[]> | undefined;
  const ensureDirectoryNeedles = (normalized: string): void => {
    const segments = normalized.toLowerCase().split('/').filter(Boolean);
    let changed = false;
    for (let drop = 0; drop < Math.min(segments.length, MAX_SUFFIX_TRIES); drop++) {
      const needle = segments.slice(drop).join('/');
      if (directoryNeedles.has(needle)) continue;
      directoryNeedles.add(needle);
      changed = true;
    }
    if (changed) lowerToDirectoryPrefixes = undefined;
  };
  const getDirectoryPrefixes = (): ReadonlyMap<string, readonly string[]> => {
    if (lowerToDirectoryPrefixes) return lowerToDirectoryPrefixes;
    lowerToDirectoryPrefixes = new Map<string, string[]>();
    const needles = [...directoryNeedles];
    const canonicalEntries = !indexedPathNeedsNormalization
      ? [...lowerToOriginal.entries()]
      : indexedPaths.map((p) => {
        const normalized = normalizeSpan(p);
        return [normalized.toLowerCase(), normalized] as const;
      });
    if (needles.length === 1) {
      const needle = needles[0]!;
      const marker = `/${needle}/`;
      for (const [lower, canonicalPath] of canonicalEntries) {
        if (lower.startsWith(`${needle}/`)) {
          lowerToDirectoryPrefixes.set(needle, [canonicalPath.slice(0, needle.length)]);
        }
        let offset = lower.indexOf(marker);
        while (offset >= 0) {
          const prefix = canonicalPath.slice(0, offset + marker.length - 1);
          const existing = lowerToDirectoryPrefixes.get(needle);
          if (existing && !existing.includes(prefix)) existing.push(prefix);
          else if (!existing) lowerToDirectoryPrefixes.set(needle, [prefix]);
          offset = lower.indexOf(marker, offset + 1);
        }
      }
      return lowerToDirectoryPrefixes;
    }
    for (const [lower, canonicalPath] of canonicalEntries) {
      for (const needle of needles) {
        const marker = `/${needle}/`;
        if (lower.startsWith(`${needle}/`)) {
          const existing = lowerToDirectoryPrefixes.get(needle);
          const canonicalPrefix = canonicalPath.slice(0, needle.length);
          if (existing && !existing.includes(canonicalPrefix)) existing.push(canonicalPrefix);
          else if (!existing) lowerToDirectoryPrefixes.set(needle, [canonicalPrefix]);
        }
        let offset = lower.indexOf(marker);
        while (offset >= 0) {
          const prefix = canonicalPath.slice(0, offset + marker.length - 1);
          const existing = lowerToDirectoryPrefixes.get(needle);
          if (existing && !existing.includes(prefix)) existing.push(prefix);
          else if (!existing) lowerToDirectoryPrefixes.set(needle, [prefix]);
          offset = lower.indexOf(marker, offset + 1);
        }
      }
    }
    return lowerToDirectoryPrefixes;
  };
  const consumed = new Set<number>();
  const pinned: string[] = [];
  const pinnedSeen = new Set<string>();
  const unresolved: string[] = [];
  const pathAnchors: QueryPathAnchor[] = [];
  const hardScope: QueryPathScope = { exactFiles: [], directoryPrefixes: [] };
  let pathAnchorsTruncated = false;
  const pathAnchorsTruncationReasons = new Set<QueryPathAnchorTruncationReason>();
  let unexaminedTokenCount: number | undefined;
  let candidatesExamined = 0;

  const recordAnchor = (
    ordinal: number,
    kind: QueryPathAnchorKind,
    normalized: string,
    status: QueryPathAnchorStatus,
    resolvedFiles: readonly string[] = [],
    directoryPrefix?: string,
  ): void => {
    const token = tokenSpans[ordinal]!;
    pathAnchors.push({
      raw: token.raw,
      ordinal,
      start: token.start,
      end: token.end,
      kind,
      normalized,
      status,
      resolvedFiles: [...resolvedFiles],
      ...(directoryPrefix === undefined ? {} : { directoryPrefix }),
    });
  };

  const recordTruncation = (start: number, reason: QueryPathAnchorTruncationReason): void => {
    pathAnchorsTruncated = true;
    pathAnchorsTruncationReasons.add(reason);
    unexaminedTokenCount = Math.max(unexaminedTokenCount ?? 0, tokens.length - start);
  };

  let basenameStems: Map<string, string[]> | null = null;
  const getBasenameStems = (): ReadonlyMap<string, readonly string[]> => {
    basenameStems ??= buildBasenameStems(indexedPaths);
    return basenameStems;
  };
  let firstPassStop: { start: number; reason: QueryPathAnchorTruncationReason } | undefined;

  for (let i = 0; i < tokens.length; i++) {
    if (pinned.length >= maxPins) {
      firstPassStop = { start: i, reason: 'max-pins' };
      break;
    }
    if (candidatesExamined >= MAX_CANDIDATE_SPANS) {
      firstPassStop = { start: i, reason: 'candidate-cap' };
      break;
    }
    const stripped = stripWrapping(tokens[i]!);
    if (stripped.length < 4) continue;
    if (!isPathTokenShape(stripped)) continue;

    const normalized = opts.rootPath === undefined
      ? normalizeSpan(stripped)
      : normalizeRootedSpan(stripped, opts.rootPath);
    const directoryIntent = /[/\\]$/.test(stripped);
    const exactIndexedPath = normalized === null
      ? undefined
      : lowerToOriginal.get(normalized.toLowerCase());
    if (isSchemeLike(stripped) && exactIndexedPath === undefined) continue;
    if (normalized === null) {
      consumed.add(i);
      if (unresolved.length < 4) unresolved.push(normalizeSpan(stripped));
      recordAnchor(i, 'unresolved-path', normalizeSpan(stripped), 'outside-root');
      candidatesExamined++;
      continue;
    }
    if (!normalized) continue;
    candidatesExamined++;
    ensureDirectoryNeedles(normalized);

    const { matches, directoryPrefixes, ambiguous } = resolveSpan(
      normalized.toLowerCase(), lowerToOriginal, getDirectoryPrefixes, maxMatchesPerSpan, directoryIntent,
    );
    if (matches.length > 0) {
      consumed.add(i);
      recordAnchor(i, 'file', normalized, 'resolved', matches);
      for (const m of matches) {
        if (pinnedSeen.has(m) || pinned.length >= maxPins) continue;
        pinnedSeen.add(m);
        pinned.push(m);
        hardScope.exactFiles.push(m);
      }
    } else if (directoryPrefixes.length > 0) {
      if (opts.consumeDirectories) consumed.add(i);
      recordAnchor(i, 'directory', normalized, 'resolved', [], directoryPrefixes[0]);
      for (const prefix of directoryPrefixes) {
        if (!hardScope.directoryPrefixes.includes(prefix)) hardScope.directoryPrefixes.push(prefix);
      }
    } else if (directoryIntent || ambiguous || isClearlyPathShaped(normalized)) {
      // A real path that didn't resolve to a usable set. Keeping it in the
      // query is strictly worse — its fragments are what minted the junk
      // matches this module exists to stop — so strip it and say so.
      consumed.add(i);
      if (unresolved.length < 4) unresolved.push(normalized);
      recordAnchor(i, directoryIntent ? 'directory' : 'unresolved-path', normalized,
        ambiguous ? 'ambiguous' : 'unresolved');
    }
    // Anything else (`and/or`, `call/2`, `foo.Bar`) is not a path reference:
    // leave the token for the normal matching pipeline.
  }

  if (firstPassStop) recordTruncation(firstPassStop.start, firstPassStop.reason);

  // Second pass — extension-less kebab basenames. `background-image-table`
  // opens no door above (no slash, no dotted tail), the hyphens disqualify it
  // from the named-symbol seeder downstream, and FTS shreds it into the most
  // common words in a kebab-cased repo (`background`, `image`, `table`) —
  // which admit look-alike SIBLINGS that crowd out the named file. Resolution
  // stays the detector: a token pins only when its whole lowercased form is
  // the stem of an indexed basename. Two deliberate asymmetries vs the first
  // pass: prose that resolves to nothing (`non-blocking`, `cross-call`) is
  // LEFT IN the query — unlike a slashed span it may be legitimate wording,
  // so it keeps feeding FTS and is not reported as an unresolved path — and a
  // stem hotter than maxMatchesPerSpan is likewise left alone (pinning half a
  // monorepo off one hot name trades precision the wrong way; a directory
  // segment, which the first pass handles, disambiguates). Runs after the
  // slashed/dotted pass so explicit paths win the shared maxPins budget, and
  // examines every remaining token: lookups are O(1) map hits, so the
  // scan-cost rationale behind MAX_CANDIDATE_SPANS doesn't apply.
  let secondPassStop: number | undefined;
  let secondPassLastExamined = -1;
  for (let i = 0; i < tokens.length && !firstPassStop && pinned.length < maxPins; i++) {
    secondPassLastExamined = i;
    if (consumed.has(i)) continue;
    const stripped = stripWrapping(tokens[i]!);
    if (stripped.length < 4 || !KEBAB_BASENAME.test(stripped)) continue;
    const matches = getBasenameStems().get(stripped.toLowerCase());
    if (!matches || matches.length > maxMatchesPerSpan) continue;
    consumed.add(i);
    recordAnchor(i, 'file', normalizeSpan(stripped), 'resolved', matches);
    for (const m of matches) {
      if (pinnedSeen.has(m) || pinned.length >= maxPins) continue;
      pinnedSeen.add(m);
      pinned.push(m);
      hardScope.exactFiles.push(m);
    }
  }
  if (!firstPassStop && pinned.length >= maxPins) {
    if (secondPassLastExamined >= 0 && secondPassLastExamined + 1 < tokens.length) {
      secondPassStop = secondPassLastExamined + 1;
    }
  }
  if (secondPassStop !== undefined) recordTruncation(secondPassStop, 'max-pins');

  if (consumed.size === 0 && hardScope.exactFiles.length === 0 && hardScope.directoryPrefixes.length === 0) {
    return passthrough;
  }
  return {
    strippedQuery: tokens.filter((_, i) => !consumed.has(i)).join(' '),
    pinnedFiles: pinned,
    unresolvedPathSpans: unresolved,
    ...(hardScope.exactFiles.length > 0 || hardScope.directoryPrefixes.length > 0 ? { hardScope } : {}),
    ...(pathAnchors.length > 0 ? { pathAnchors } : {}),
    ...(pathAnchorsTruncated ? {
      pathAnchorsTruncated,
      unexaminedTokenCount,
      pathAnchorsTruncationReasons: [...pathAnchorsTruncationReasons],
    } : {}),
  };
}

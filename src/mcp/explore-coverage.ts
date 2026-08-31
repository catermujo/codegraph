import type { QueryPathAnchor } from '../search/query-paths';
import type { SymbolResolution } from '../types';

export type ExploreCoverageResolutionStatus =
  | 'resolved' | 'ambiguous' | 'unresolved' | 'not-indexed' | 'missing' | 'outside-root';

export type ExploreCoverageRenderStatus =
  | 'full-current' | 'candidate-covered-partial' | 'focused' | 'skeleton' | 'clipped' | 'pointer'
  | 'back-reference' | 'stale' | 'omitted' | 'dropped';

export interface ExploreCoverageCandidate {
  nodeId: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface ExploreCoverageAnchor {
  id: string;
  raw: string;
  kind: 'file' | 'directory' | 'symbol';
  status: ExploreCoverageResolutionStatus;
  expectedFiles: string[];
  candidates: ExploreCoverageCandidate[];
  candidateCount?: number;
  candidateLowerBound?: number;
  truncated?: boolean;
}

export interface ExploreCoverageFile {
  path: string;
  status: ExploreCoverageRenderStatus;
  ranges: ExploreLineRange[];
  fingerprint?: string;
}

export interface ExploreLineRange {
  start: number;
  end: number;
}

export interface ExploreCoverage {
  complete: boolean;
  inventoryTruncated: boolean;
  allCandidatesCovered: boolean;
  /** Number of distinct explicit path/symbol obligations in this ledger. */
  anchorCount: number;
  /** Number of distinct canonical files required by those obligations. */
  expectedFileCount: number;
  /** Number of distinct files represented by final render facts. */
  renderedFileCount: number;
  anchors: ExploreCoverageAnchor[];
  files: ExploreCoverageFile[];
}

export interface ExploreCoverageRenderFact {
  path: string;
  ranges: ExploreLineRange[];
  bytes: number;
  fingerprint?: string;
  status: ExploreCoverageRenderStatus;
  fullRanges: ExploreLineRange[];
  lineCount: number;
}

export interface ExploreCoverageInput {
  pathAnchors?: readonly QueryPathAnchor[];
  pathAnchorStatusOverrides?: ReadonlyMap<string, ExploreCoverageResolutionStatus>;
  pathAnchorsTruncated?: boolean;
  symbolResolutions?: readonly SymbolResolution[];
  indexedFiles?: readonly string[];
  allowedFilePaths?: readonly string[];
  renderFacts: readonly ExploreCoverageRenderFact[];
  finalText: string;
}

export const EXPLORE_COVERAGE_NOTE_MAX = 1_200;

interface FinalSection {
  hasClosedFence: boolean;
}

const mergeRanges = (ranges: readonly ExploreLineRange[]): ExploreLineRange[] => {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)
    .map((r) => ({ start: Math.floor(r.start), end: Math.floor(r.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ExploreLineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
};

const coversRange = (ranges: readonly ExploreLineRange[], wanted: ExploreLineRange): boolean =>
  mergeRanges(ranges).some((range) => range.start <= wanted.start && range.end >= wanted.end);

const coversFile = (fact: ExploreCoverageRenderFact): boolean => {
  const end = Math.max(1, fact.lineCount - 1);
  return coversRange(fact.fullRanges, { start: 1, end })
    && coversRange(fact.ranges, { start: 1, end });
};

function finalSections(text: string): Map<string, FinalSection> {
  const result = new Map<string, FinalSection>();
  let pendingPath: string | undefined;
  let activeFence: { char: '`' | '~'; length: number; path?: string } | undefined;
  const remember = (path: string, hasClosedFence: boolean): void => {
    const previous = result.get(path);
    result.set(path, {
      hasClosedFence: (previous?.hasClosedFence ?? false) || hasClosedFence,
    });
  };
  for (const line of text.split('\n')) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (activeFence !== undefined) {
      if (fence !== null && fence[1]![0] === activeFence.char
        && fence[1]!.length >= activeFence.length && /^\s*$/.test(fence[2]!)) {
        if (activeFence.path !== undefined) remember(activeFence.path, true);
        activeFence = undefined;
      }
      continue;
    }
    if (fence !== null) {
      if (pendingPath !== undefined) {
        activeFence = { char: fence[1]![0] as '`' | '~', length: fence[1]!.length, path: pendingPath };
        pendingPath = undefined;
      }
      continue;
    }
    const header = line.match(/^\*\*`([^`]+)`\*\*(?:\s+.*)?$/);
    if (header !== null) {
      pendingPath = header[1];
      remember(header[1]!, false);
    } else if (pendingPath !== undefined && line.trim() !== '') {
      pendingPath = undefined;
    }
  }
  return result;
}

function pathAnchorExpectedFiles(
  anchor: QueryPathAnchor,
  indexedFiles: readonly string[],
  allowed: ReadonlySet<string> | undefined,
): string[] {
  const inAllowed = (file: string): boolean => allowed === undefined || allowed.has(file);
  if (anchor.kind === 'file') return anchor.resolvedFiles.filter(inAllowed);
  if (anchor.kind !== 'directory' || !anchor.directoryPrefix) return [];
  return indexedFiles.filter((file) => inAllowed(file)
    && (file === anchor.directoryPrefix || file.startsWith(`${anchor.directoryPrefix}/`)));
}

function pathStatus(
  anchor: QueryPathAnchor,
  expectedFiles: readonly string[],
  overrides: ReadonlyMap<string, ExploreCoverageResolutionStatus> | undefined,
): ExploreCoverageResolutionStatus {
  const override = overrides?.get(anchor.raw) ?? overrides?.get(anchor.normalized);
  if (override !== undefined) return override;
  if (anchor.status === 'outside-root') return 'outside-root';
  if (anchor.status === 'not-indexed') return 'not-indexed';
  if (anchor.status === 'missing') return 'missing';
  if (anchor.status === 'ambiguous') return 'ambiguous';
  if (anchor.status === 'unresolved') return expectedFiles.length > 0 ? 'resolved' : 'unresolved';
  return expectedFiles.length > 0 ? 'resolved' : 'unresolved';
}

export function buildExploreCoverage(input: ExploreCoverageInput): ExploreCoverage | undefined {
  const pathAnchors = input.pathAnchors ?? [];
  const symbolResolutions = input.symbolResolutions ?? [];
  if (pathAnchors.length === 0 && symbolResolutions.length === 0 && !input.pathAnchorsTruncated) return undefined;

  const allowed = input.allowedFilePaths === undefined ? undefined : new Set(input.allowedFilePaths);
  const indexedFiles = input.indexedFiles ?? [];
  const anchors: ExploreCoverageAnchor[] = [];
  const expectedFiles = new Set<string>();

  for (const anchor of pathAnchors) {
    const files = pathAnchorExpectedFiles(anchor, indexedFiles, allowed);
    for (const file of files) expectedFiles.add(file);
    anchors.push({
      id: `path:${anchor.ordinal}:${anchor.start}:${anchor.end}`,
      raw: anchor.raw,
      kind: anchor.kind === 'unresolved-path' ? 'file' : anchor.kind,
      status: pathStatus(anchor, files, input.pathAnchorStatusOverrides),
      expectedFiles: files,
      candidates: [],
      candidateCount: files.length,
    });
  }

  for (const resolution of symbolResolutions) {
    const candidates = resolution.candidates
      .filter((candidate) => allowed === undefined || allowed.has(candidate.filePath))
      .map((candidate) => ({
        nodeId: candidate.nodeId,
        filePath: candidate.filePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
      }));
    const status: ExploreCoverageResolutionStatus = resolution.status === 'zero' || candidates.length === 0
      ? 'unresolved'
      : resolution.truncated
        ? 'ambiguous'
        : resolution.status === 'many' && candidates.length !== 1
          ? 'ambiguous'
          : 'resolved';
    for (const candidate of candidates) expectedFiles.add(candidate.filePath);
    anchors.push({
      id: `symbol:${resolution.raw}`,
      raw: resolution.raw,
      kind: 'symbol',
      status,
      expectedFiles: [...new Set(candidates.map((candidate) => candidate.filePath))],
      candidates,
      ...(resolution.truncated
        ? { candidateLowerBound: candidates.length + 1, truncated: true }
        : { candidateCount: candidates.length }),
    });
  }

  const sections = finalSections(input.finalText);
  const factsByFile = new Map(input.renderFacts.map((fact) => [fact.path, fact]));
  const files = [...new Set([...expectedFiles, ...input.renderFacts.map((fact) => fact.path)])].map((filePath) => {
    const fact = factsByFile.get(filePath);
    const section = sections.get(filePath);
    if (!fact) return { path: filePath, status: 'omitted' as const, ranges: [] };
    if (!section) return { path: filePath, status: 'dropped' as const, ranges: [], fingerprint: fact.fingerprint };
    if (fact.status === 'pointer' || fact.status === 'back-reference') {
      return { path: filePath, status: fact.status, ranges: [], fingerprint: fact.fingerprint };
    }
    if (!section.hasClosedFence) {
      return { path: filePath, status: 'dropped' as const, ranges: [], fingerprint: fact.fingerprint };
    }
    const status = fact.status === 'full-current' && !coversFile(fact)
      ? 'candidate-covered-partial' as const
      : fact.status;
    return {
      path: filePath,
      status,
      ranges: mergeRanges(fact.ranges),
      ...(fact.fingerprint === undefined ? {} : { fingerprint: fact.fingerprint }),
    };
  });
  const fileByPath = new Map(files.map((file) => [file.path, file]));

  let allCandidatesCovered = true;
  let everyAnchorComplete = true;
  for (const anchor of anchors) {
    if (anchor.status !== 'resolved') everyAnchorComplete = false;
    if (anchor.kind === 'symbol') {
      if (anchor.status === 'ambiguous' || anchor.truncated) everyAnchorComplete = false;
      if (anchor.candidates.length === 0) {
        allCandidatesCovered = false;
        everyAnchorComplete = false;
      }
      for (const candidate of anchor.candidates) {
        const file = fileByPath.get(candidate.filePath);
        const covered = file !== undefined && coversRange(file.ranges, {
          start: candidate.startLine,
          end: candidate.endLine,
        });
        allCandidatesCovered = allCandidatesCovered && covered;
        if (!covered) everyAnchorComplete = false;
      }
    } else {
      for (const filePath of anchor.expectedFiles) {
        const fact = factsByFile.get(filePath);
        const final = fileByPath.get(filePath);
        const complete = fact !== undefined && final?.status === 'full-current' && coversFile(fact)
          && final.ranges.length > 0;
        allCandidatesCovered = allCandidatesCovered && complete;
        if (!complete) everyAnchorComplete = false;
      }
      if (anchor.expectedFiles.length === 0) {
        allCandidatesCovered = false;
        everyAnchorComplete = false;
      }
    }
  }

  const relevantFiles = files.filter((file) => expectedFiles.has(file.path));
  const hasBadRelevantRender = relevantFiles.some((file) => file.status !== 'full-current');
  return {
    complete: !input.pathAnchorsTruncated && everyAnchorComplete && allCandidatesCovered && !hasBadRelevantRender,
    inventoryTruncated: input.pathAnchorsTruncated === true,
    allCandidatesCovered,
    anchorCount: anchors.length,
    expectedFileCount: expectedFiles.size,
    renderedFileCount: files.length,
    anchors,
    files,
  };
}

/** Format bounded, user-facing anchor accounting without exposing raw ledgers. */
export function formatExploreCoverage(
  coverage: ExploreCoverage,
  maxChars = EXPLORE_COVERAGE_NOTE_MAX,
): string {
  const expected = new Set(coverage.anchors.flatMap((anchor) => anchor.expectedFiles));
  const expectedFiles = coverage.files.filter((file) => expected.has(file.path));
  const fullFiles = expectedFiles.filter((file) => file.status === 'full-current').length;
  const partialFiles = expectedFiles.length - fullFiles;
  const candidateAnchors = coverage.anchors.filter((anchor) => anchor.kind === 'symbol');
  const candidates = candidateAnchors.flatMap((anchor) => anchor.candidates);
  const coveredCandidates = candidates.filter((candidate) => {
    const file = coverage.files.find((entry) => entry.path === candidate.filePath);
    return file !== undefined && coversRange(file.ranges, {
      start: candidate.startLine,
      end: candidate.endLine,
    });
  }).length;
  const statusCounts = new Map<ExploreCoverageResolutionStatus, number>();
  for (const anchor of coverage.anchors) {
    statusCounts.set(anchor.status, (statusCounts.get(anchor.status) ?? 0) + 1);
  }
  const renderCounts = new Map<ExploreCoverageRenderStatus, number>();
  for (const file of expectedFiles) {
    renderCounts.set(file.status, (renderCounts.get(file.status) ?? 0) + 1);
  }
  const parts = [`Anchor coverage: ${coverage.complete ? 'complete' : 'incomplete'}.`];
  if (coverage.anchorCount > 0) {
    parts.push(`${coverage.anchorCount} explicit anchor${coverage.anchorCount === 1 ? '' : 's'}.`);
  }
  if (expectedFiles.length > 0) {
    parts.push(`${fullFiles}/${expectedFiles.length} expected file${expectedFiles.length === 1 ? '' : 's'} full-current.`);
    if (partialFiles > 0) {
      const details = [...renderCounts.entries()]
        .filter(([status]) => status !== 'full-current')
        .map(([status, count]) => `${count} ${status}`)
        .join(', ');
      parts.push(`Expected-file status: ${details}.`);
    }
  }
  if (candidates.length > 0) {
    parts.push(`${coveredCandidates}/${candidates.length} known symbol candidate${candidates.length === 1 ? '' : 's'} covered.`);
  }
  const ambiguous = candidateAnchors.filter((anchor) => anchor.status === 'ambiguous');
  if (ambiguous.length > 0) {
    const details = ambiguous.slice(0, 2).map((anchor) => {
      const count = anchor.truncated
        ? `at least ${anchor.candidateLowerBound ?? anchor.candidates.length}`
        : `${anchor.candidateCount ?? anchor.candidates.length}`;
      return `\`${anchor.raw}\` (${count} exact candidates${anchor.truncated ? ', truncated' : ''})`;
    }).join(', ');
    parts.push(`${ambiguous.length} ambiguous symbol anchor${ambiguous.length === 1 ? '' : 's'}: ${details}.`);
    if (coverage.allCandidatesCovered) parts.push('All known candidates are covered, but no single definition was selected.');
  }
  const unresolvedDetails = [...statusCounts.entries()]
    .filter(([status]) => status === 'unresolved' || status === 'not-indexed' || status === 'missing' || status === 'outside-root')
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  if (unresolvedDetails) parts.push(`Explicit-anchor status: ${unresolvedDetails}.`);
  if (coverage.inventoryTruncated) parts.push('Path-anchor inventory was truncated; unexamined anchors force incomplete coverage.');
  if (!coverage.complete) {
    parts.push('Use an exact file or directory scope to disambiguate or retrieve omitted anchor content.');
  }
  const text = parts.join(' ');
  const limit = Math.max(32, Math.min(maxChars, EXPLORE_COVERAGE_NOTE_MAX));
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

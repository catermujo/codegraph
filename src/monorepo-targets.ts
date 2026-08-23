import * as fs from 'fs';
import * as path from 'path';
import { MonorepoTarget, MonorepoTargetKind } from './types';

export interface ParsedBuildTarget {
  kind: MonorepoTargetKind;
  core: string;
  deps: string[];
  tags: string[];
}

const BUILD_MANIFEST = 'build.toml';
const MAX_SCAN_DEPTH = 16;
const MAX_SCAN_DIRECTORIES = 20000;
const MAX_TARGETS = 5000;

const MONOREPO_SCAN_SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store', '.git', '.svn', '.hg', '.codegraph',
  'dist', 'build', 'out', '.output', 'target', 'vendor', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.venv', 'venv',
  '__pycache__', '.gradle', 'Pods', 'Carthage', 'DerivedData',
  '.dart_tool', '.pub-cache', '.cxx', '.externalNativeBuild', 'tmp', 'temp',
]);

export function parseBuildToml(text: string): ParsedBuildTarget | null {
  let section: MonorepoTargetKind | null = null;
  let parsed: ParsedBuildTarget | null = null;
  let knownSectionSeen = false;
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = stripTomlComment(lines[lineIndex] ?? '').trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[(project|lib)\]$/);
    if (sectionMatch) {
      if (knownSectionSeen) return null;
      section = sectionMatch[1] as MonorepoTargetKind;
      parsed = { kind: section, core: '.', deps: [], tags: [] };
      knownSectionSeen = true;
      continue;
    }
    if (line.startsWith('[')) {
      section = null;
      continue;
    }
    if (!section || !parsed) continue;

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;

    const key = assignment[1]!;
    const value = collectTomlValue(lines, lineIndex, assignment[2]!);
    lineIndex = value.lastLine;
    if (!value.complete) return null;

    if (key === 'core') {
      const core = parseTomlString(value.text);
      if (core === null || !normalizeRelativeValue(core)) return null;
      parsed.core = normalizeRelativeValue(core)!;
    } else if (key === 'deps' || key === 'tags') {
      const values = parseTomlStringArray(value.text);
      if (values === null) return null;
      parsed[key] = values;
    }
  }

  return parsed;
}

export function discoverBuildTargets(projectRoot: string): MonorepoTarget[] {
  const targets: MonorepoTarget[] = [];
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: path.resolve(projectRoot), relativePath: '', depth: 0 },
  ];
  let visitedDirectories = 0;

  while (queue.length > 0 && visitedDirectories < MAX_SCAN_DIRECTORIES && targets.length < MAX_TARGETS) {
    const current = queue.shift()!;
    visitedDirectories++;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === BUILD_MANIFEST) {
        const manifestPath = current.relativePath ? `${current.relativePath}/${BUILD_MANIFEST}` : BUILD_MANIFEST;
        let parsed: ParsedBuildTarget | null;
        try {
          parsed = parseBuildToml(fs.readFileSync(path.join(current.absolutePath, entry.name), 'utf8'));
        } catch {
          parsed = null;
        }
        if (parsed) {
          const targetPath = current.relativePath || '.';
          targets.push({
            ...parsed,
            path: targetPath,
            name: targetPath,
            manifestPath,
          });
        }
        continue;
      }

      if (!entry.isDirectory() || entry.isSymbolicLink() || current.depth >= MAX_SCAN_DEPTH) continue;
      if (entry.name.startsWith('.') || MONOREPO_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      queue.push({
        absolutePath: path.join(current.absolutePath, entry.name),
        relativePath,
        depth: current.depth + 1,
      });
    }
  }

  return targets.sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeTargetPath(value: string): string | null {
  return normalizeRelativeValue(value);
}

export function associateBuildTargets(
  targets: readonly MonorepoTarget[],
  indexedFilePaths: readonly string[],
): Map<string, string[]> {
  const filesByTarget = new Map<string, string[]>(targets.map((target) => [target.path, []]));
  const sortedTargets = [...targets].sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));

  for (const filePath of indexedFilePaths) {
    const normalizedFilePath = normalizeProjectRelativePath(filePath);
    const target = sortedTargets.find((candidate) => isTargetPath(candidate.path, normalizedFilePath));
    if (target) filesByTarget.get(target.path)!.push(normalizedFilePath);
  }

  return filesByTarget;
}

function isTargetPath(targetPath: string, filePath: string): boolean {
  return targetPath === '.' || filePath === targetPath || filePath.startsWith(`${targetPath}/`);
}

function normalizeProjectRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/').replace(/^\.\//, ''));
  return normalized === '.' ? '' : normalized;
}

function normalizeRelativeValue(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized)) return null;
  const result = path.posix.normalize(normalized);
  if (result === '..' || result.startsWith('../')) return null;
  return result === '' ? '.' : result;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (quote === '"' && character === '\\') {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function collectTomlValue(
  lines: readonly string[],
  firstLine: number,
  firstValue: string,
): { text: string; lastLine: number; complete: boolean } {
  let text = stripTomlComment(firstValue).trim();
  if (!text.startsWith('[')) return { text, lastLine: firstLine, complete: true };

  let depth = arrayDepth(text);
  if (depth === 0) return { text, lastLine: firstLine, complete: true };
  for (let lineIndex = firstLine + 1; depth > 0 && lineIndex < lines.length; lineIndex++) {
    const next = stripTomlComment(lines[lineIndex] ?? '').trim();
    text += ` ${next}`;
    depth = arrayDepth(text);
    if (depth < 0) return { text, lastLine: lineIndex, complete: false };
    if (depth === 0) return { text, lastLine: lineIndex, complete: true };
  }
  return { text, lastLine: Math.max(firstLine, lines.length - 1), complete: depth === 0 };
}

function arrayDepth(text: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote === '"' && character === '\\') {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[') depth++;
    else if (character === ']') depth--;
  }
  return depth;
}

function parseTomlString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return null;
  const parsed = readTomlString(trimmed, 0);
  return parsed && !trimmed.slice(parsed.end).trim() ? parsed.value : null;
}

function parseTomlStringArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']') || arrayDepth(trimmed) !== 0) return null;
  const values: string[] = [];
  let index = 1;
  while (/\s/.test(trimmed[index] ?? '')) index++;
  if (index === trimmed.length - 1) return values;

  while (index < trimmed.length - 1) {
    const parsed = readTomlString(trimmed, index);
    if (!parsed) return null;
    if (!parsed.value.trim()) return null;
    values.push(parsed.value);
    index = parsed.end;
    while (/\s/.test(trimmed[index] ?? '')) index++;
    if (index === trimmed.length - 1) return values;
    if (trimmed[index] !== ',') return null;
    index++;
    while (/\s/.test(trimmed[index] ?? '')) index++;
    if (index === trimmed.length - 1) return values;
  }
  return values;
}

function readTomlString(value: string, start: number): { value: string; end: number } | null {
  const quote = value[start];
  if (quote !== '"' && quote !== "'") return null;
  let result = '';
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index]!;
    if (character === quote) return { value: result, end: index + 1 };
    if (quote === "'") {
      result += character;
      continue;
    }
    if (character !== '\\') {
      result += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) return null;
    const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
    if (escapes[escaped] !== undefined) {
      result += escapes[escaped];
    } else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 1, index + 5))) {
      result += String.fromCharCode(parseInt(value.slice(index + 1, index + 5), 16));
      index += 4;
    } else {
      return null;
    }
  }
  return null;
}

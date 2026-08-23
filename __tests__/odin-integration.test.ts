import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractImportMappings, resolveImportPath, resolveViaImport } from '../src/resolution/import-resolver';
import type { ResolutionContext } from '../src/resolution/types';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['odin']);
});

describe('Odin integration', () => {
  it('detects and extracts the positional Odin AST through WASM', () => {
    const source = `package probe
import "core:fmt"
import helper "./helper"

Thing :: struct {
    value: int,
    other: string,
}
Kinds :: enum { none, ready }
Choice :: union { int, string }
Flags :: bit_field u8 { ready: u8 | 1, done: bool | 1 }
mutable: int
VALUE :: 3
work :: proc(x: int) -> int {
    helper.run(x)
    ptr->run(x)
    return x
}
`;
    expect(detectLanguage('probe.odin')).toBe('odin');

    const result = extractFromSource('probe.odin', source, 'odin');
    expect(result.errors).toEqual([]);
    expect(result.nodes.some((node) => node.kind === 'struct' && node.name === 'Thing')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'field' && node.name === 'other')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'Kinds')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'ready')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'union' && node.name === 'Choice')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'struct' && node.name === 'Flags')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'field' && node.name === 'done')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'variable' && node.name === 'mutable')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'constant' && node.name === 'VALUE')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'work')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'import' && node.name === 'core:fmt')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'helper.run')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'ptr.run')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'run')).toBe(false);
  });

  it('maps Odin imports and keeps compiler collections external', () => {
    const mappings = extractImportMappings(
      'src/main.odin',
      'import helper "./pkg"\n@(require) import rtcli "rt:cli"\nimport "core:fmt"\nimport "rt:atom"\n',
      'odin',
    );
    expect(mappings).toEqual([
      { localName: 'helper', exportedName: '*', source: './pkg', isDefault: false, isNamespace: true },
      { localName: 'rtcli', exportedName: '*', source: 'rt:cli', isDefault: false, isNamespace: true },
      { localName: 'fmt', exportedName: '*', source: 'core:fmt', isDefault: false, isNamespace: true },
      { localName: 'atom', exportedName: '*', source: 'rt:atom', isDefault: false, isNamespace: true },
    ]);

    const context: ResolutionContext = {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '/project',
      getAllFiles: () => [
        'src/main.odin',
        'src/pkg/helper.odin',
        'rt/atom/atomic.odin',
      ],
    };
    expect(resolveImportPath('./pkg', 'src/main.odin', 'odin', context)).toBe('src/pkg/helper.odin');
    expect(resolveImportPath('rt:atom', 'src/main.odin', 'odin', context)).toBe('rt/atom/atomic.odin');
    expect(resolveImportPath('core:fmt', 'src/main.odin', 'odin', context)).toBeNull();
  });

  it('keeps selector-call receivers and does not resolve them as bare imports', () => {
    const mainSource = `package main
import run "./run"
work :: proc(ptr: ^Thing) { ptr->run(1) }
`;
    const runSource = 'package run\nrun :: proc(x: int) {}\n';
    const main = extractFromSource('main.odin', mainSource, 'odin');
    const run = extractFromSource('run.odin', runSource, 'odin');
    const nodesByFile = new Map([
      ['main.odin', main.nodes],
      ['run.odin', run.nodes],
    ]);
    const mappings = extractImportMappings('main.odin', mainSource, 'odin');
    const context = {
      getNodesInFile: (file: string) => nodesByFile.get(file) ?? [],
      getNodesByName: (name: string) => [...nodesByFile.values()].flat().filter((node) => node.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '/project',
      getAllFiles: () => [...nodesByFile.keys()],
      getImportMappings: () => mappings,
      getNodeById: (id: string) => [...nodesByFile.values()].flat().find((node) => node.id === id) ?? null,
    } as ResolutionContext;

    const calls = main.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls');
    expect(calls.map((ref) => ref.referenceName)).toEqual(['ptr.run']);
    expect(resolveViaImport(calls[0]!, context)).toBeNull();
  });

  it('resolves member calls to the matching imported package only', () => {
    const mainSource = `package main
import a "./a"
import b "./b"
work :: proc() { a.run(); b.run() }
`;
    const aSource = 'package a\nrun :: proc() {}\n';
    const bSource = 'package b\nrun :: proc() {}\n';
    const main = extractFromSource('main.odin', mainSource, 'odin');
    const a = extractFromSource('a.odin', aSource, 'odin');
    const b = extractFromSource('b.odin', bSource, 'odin');
    const nodesByFile = new Map([
      ['main.odin', main.nodes],
      ['a.odin', a.nodes],
      ['b.odin', b.nodes],
    ]);
    const mappings = extractImportMappings('main.odin', mainSource, 'odin');
    const context = {
      getNodesInFile: (file: string) => nodesByFile.get(file) ?? [],
      getNodesByName: (name: string) => [...nodesByFile.values()].flat().filter((node) => node.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '/project',
      getAllFiles: () => [...nodesByFile.keys()],
      getImportMappings: () => mappings,
      getNodeById: (id: string) => [...nodesByFile.values()].flat().find((node) => node.id === id) ?? null,
    } as ResolutionContext;

    const calls = main.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls');
    expect(calls.map((ref) => ref.referenceName)).toEqual(['a.run', 'b.run']);
    const resolved = calls.map((ref) => resolveViaImport(ref, context));
    expect(resolved[0]?.targetNodeId).toBe(a.nodes.find((node) => node.kind === 'function' && node.name === 'run')?.id);
    expect(resolved[1]?.targetNodeId).toBe(b.nodes.find((node) => node.kind === 'function' && node.name === 'run')?.id);
  });
});

# Odin grammar provenance

CodeGraph's Odin adapter uses the local `vendor/tree-sitter-odin` checkout. The
relevant upstream/local grammar lineage includes source commit
`d2ca8efb4487e156a60d5bd6db2598b872629403` (`fix: allow multiple identifiers
before ':' in `named_type`). The checkout also contains later local Odin
patches, including `badeda3` and `db8dc24`; it is not an unmodified copy of
that source commit.

The CodeGraph integration adds stable field annotations to existing Odin named
nodes. Aggregate wrapper-node experiments were reverted because they changed
real `Name :: struct {}` parses to `const_declaration`. The current extractor
therefore handles aggregate bodies from the original positional AST.

Generated artifacts were produced with the local command:

```text
gtimeout 120s tree-sitter generate
```

The generator was `tree-sitter 0.26.12`. The repository-pinned `tree-sitter-cli`
`0.24.5` was attempted with offline npm resolution but was unavailable from the
local cache (`ENOTCACHED`), so these artifacts do not claim 0.24.5 parity.

The matching WASM module was built from that same checkout with:

```text
gtimeout 120s tree-sitter build --wasm
```

Vendored WASM SHA-256:

```text
91d6de56d48c0c1197e99ab0e8b2126b8339bc19f6d7114c3f5c284c829c6cac
```

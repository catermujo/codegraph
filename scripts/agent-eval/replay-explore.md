# Replay recorded Explore queries

Run the runner from the CodeGraph repository after `npm run build`:

```sh
node scripts/agent-eval/replay-explore.mjs /path/to/indexed/repo transcript.jsonl -output report.json
```

Use `-read-only` for a baseline that does not refresh stale anchors. Use `-limit 20` to bound the query count.
The default run uses the same anchor refresh as an MCP call. It can update the existing derived index.
The runner does not initialize an index.

The input can contain Codex rollout events, Claude Code transcript events, or normalized query records:

```json
{"id":"formatter","args":{"query":"odd/odinfmt.py","maxFiles":2},"before":"historical response","verdict":"partial","nextAction":{"tool":"Read","rawRead":true}}
```

The parser accepts direct MCP calls and literal calls inside `functions.exec`.
It also accepts quoted CLI queries with `--path`, `--target`, `--include-deps`, and `--max-files` after the query.
It skips dynamic expressions and shell expansions. It never executes transcript code.
For unsupported command forms, supply normalized records. The report shows the extracted and replayed counts.

Queries without `projectPath` use the repository argument.
Relative project paths use the captured working directory, or the repository argument when no directory is recorded. Separate transcripts from different default repositories before replay.
CLI records use MCP dispatch with the captured query options. This measures retrieval, not CLI startup or shell behavior.
Each replay is independent and does not simulate session reuse.

The report includes the response text, character count, source-line count, stale omissions, empty results, anchor coverage, and latency.
When available, it retains the historical response metrics and the next observed tool batch.
A raw read in that batch is an observation. It does not prove that Explore failed or that the read concerned returned files.

The `historicalVerdict` field retains supplied human labels: sufficient, partial, misleading, or abandoned.
It describes the original response. Review the replay response before assigning a new verdict.
The runner does not infer sufficiency from source-line counts.
Historical comparisons also include source and index changes since the original call. Use a fixed snapshot for causal comparisons.

Three queries from the recent formatter investigation are in `fixtures/recent-codegraph-queries.jsonl`.
Run them with the monorepo index to check broad discovery, multiple explicit files, and one exact file.

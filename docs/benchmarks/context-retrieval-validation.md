# Context retrieval validation — October 10, 2026

Run `AGENT=codex MODEL=gpt-5.6-luna EFFORT=high scripts/agent-eval/ab-new-vs-baseline.sh <indexed-target> "<task>" lymrmxmr` to compare committed builds.
Use at least two trials per arm. The harness requires Codex authentication and a clean engine checkout.

## Implemented retrieval changes

Requested changed files refresh before symbol selection, with limits of eight files and 8 MiB per call.
Index location and search scope are separate inputs. Ambiguous scopes return choices.
Coverage distinguishes current source, verified held ranges, clipped ranges, stale files, and unresolved anchors.
Held source requires a conversation identity and context epoch. Fingerprints invalidate old proofs after edits.
CLI reuse uses the same explicit identity and epoch. Reset the epoch after context loss or compaction.

Revision `xrvqpury` also reduces the rank of incidental matches under vendor directories.
The multiplier applies before text selection and to file scores, graph mass, and source allocation.
Explicit file requests, dependency scopes, and uniquely resolved symbol anchors keep their priority.
The integrated fixture fails on baseline `lymrmxmr`: a dense dependency cluster displaces the application formatter.
The patch returns the application formatter first. All three dependency controls pass on both builds.
The final size check includes the summary for queries without explicit anchors.
Coverage uses only source that survives that check.

## Live Codex comparison

The comparison uses Codex CLI 0.148.0 with `gpt-5.6-luna` and high effort in both arms.
The installed CLI rejects the app-configured `gpt-6-luna`. Its local model catalog lists the selected model.
The maintainer requested Codex, which overrides the default Claude benchmark policy.

Each arm uses a separate committed source export and build.
Every trial gets a fresh index and warm daemon. Trials run sequentially.
The corpus is a source-only copy of `odd`, with caches and virtual environments excluded.
It contains 647 files. CodeGraph indexes 486 files, including 281 under `_vendor`.
All eight trial copies match the original corpus hash after the runs. All trial daemons stopped.
The live trials do not use the original monorepo index.

The new build uses revision `ktmsnkwr`. Baseline `lymrmxmr` already includes the scope, stale-source, and proof changes.
Thus this comparison measures the vendor ranking and final size changes, not all earlier retrieval work.
[Trial evidence](codex-retrieval-trials-2026-10-10.json) contains hashes, questions, calls, answers, usage, and citation checks.

Each row gives the range across two trials.
Repository fallback excludes commands that read only instruction files. Mixed instruction and source searches count as fallback.

| Question | Build | Duration | All tools | Explores | Repository fallback calls | MCP characters | Cited source share |
|---|---|---|---|---|---|---|---|
| Broad formatter flow | Baseline | 47.0–63.2s | 8–13 | 7–10 | 0–3 | 111,823–160,059 | 8.3–49.7% |
| Broad formatter flow | Patch | 62.3–124.8s | 20–23 | 18–20 | 0–2 | 230,583–297,164 | 34.7–38.5% |
| Exact file and symbols | Baseline | 31.1–38.8s | 3 | 1 | 0 | 13,653–13,669 | 100% |
| Exact file and symbols | Patch | 24.9–29.5s | 2 | 1 | 0 | 13,664–13,721 | 100% |

The broad prompt fails the efficiency target on both builds. The patch uses more explores and returns more text.
Its median duration is approximately 70% higher on this prompt. Two trials cannot establish a general performance effect.
Cited-source allocation also varies too much to establish a gain.
The exact control needs one explore on both builds. Different instruction-read counts prevent attribution of its timing difference to retrieval.
No CLI invocation or MCP error appears in these eight runs.

All answers correctly describe the pipeline order, dry-run behavior, and shader fallback.
One broad answer per arm omits the missing-path fallback. All exact controls cover it.
One baseline flow answer has an invalid absolute citation path.
One baseline control uses placeholder citation links. Its source facts and line references are correct.
Citation share is an allocation proxy, not proof that an answer is correct or complete.

Codex reports cumulative usage for the completed user turn.
The evidence stores input, cached input, output, and reasoning counts separately, without adding cache counts to input counts.
The parser measures returned characters directly. It does not infer residual context occupancy or a context-window size.

## Remaining context killers

Broad words such as `style`, `command`, and `imports` still select loosely related application files.
The vendor penalty removes one source of noise. It does not resolve broad intent.
The agent can repeat keyword queries before it chooses the correct file or scope.

These Codex runs never supply `conversationId` or `contextEpoch`.
Therefore, repeated source cannot use the held-range proof. A host must track context retention to enable safe reuse.
Automatic reuse after compaction remains a host integration limit.

Ambient instruction reads return 5,158–9,433 characters per exact control. The runner sets `project_doc_max_bytes=0`, but these reads still occur.
They account for all shell reads in those controls. This overhead is separate from CodeGraph retrieval.

## Host monorepo probes

Both builds read the same existing index. These probes do not change that index.

| Query and scope | Baseline | Patch |
|---|---|---|
| `fix style formatter declarations imports memory`, scope `odd` | 25,041 characters, openpyxl style files lead | 23,524 characters, import tooling leads |
| Same query, scope `odd/fix` | 21,997 characters, both formatter files | 21,997 characters, both formatter files |
| `CellStyle`, scope `odd`, one file | Requested definition omitted | Requested definition returned |

## Platform checks

| Environment | Result |
|---|---|
| macOS, Node 22, arm64 | 595 tests pass in 42 engine suites, full build passes |
| Linux Docker, Node 22, arm64, `node:22-bookworm`, `--init` | 595 tests pass in the same 42 suites, clean install and full build pass |
| Wine 11 on macOS, Windows Node 22.23.0, x64 | 27 tests pass in four suites, engine and viewer builds pass |

The Wine checks include separate CLI processes, context resets, fingerprints, scopes, and a real query worker.
The Windows executable is a PE32+ x86-64 binary. The runtime reports `win32 x64` and passes a SQLite assertion.
The Wine environment uses a separate prefix and Windows dependency packages in a temporary directory.
Native Windows remains unverified because no configured Windows host was available.

The Codex parser passes four focused regression tests and a schema check against a real MCP transcript.
The existing Claude parser passes all 68 checks. Shell and Node syntax checks pass.
The engine source did not change during the Codex harness work, so the earlier platform results still apply.

# Context retrieval validation — October 10, 2026

Use `scripts/agent-eval/ab-new-vs-baseline.sh` with an indexed target, a task, and baseline `lymrmxmr` to compare this patch.
Run `claude auth login` first. The live preflight failed because the OAuth session expired.

## Patch and controls

Revision `xrvqpury` reduces the rank of incidental matches under vendor directories.
The multiplier applies before text selection and to file scores, graph mass, and source allocation.
Explicit file requests, dependency scopes, and uniquely resolved symbol anchors keep their priority.
The integrated fixture fails on baseline `lymrmxmr`: a dense dependency cluster displaces the application formatter.
The patch returns the application formatter first. All three dependency controls pass on both builds.

The final size check now includes the summary for queries without explicit anchors.
Coverage still uses only source that survives the final size check.

## Host monorepo probes

Both builds read the same existing index. These probes do not change that index.

| Query and scope | Baseline | Patch |
|---|---|---|
| `fix style formatter declarations imports memory`, scope `odd` | 25,041 characters; openpyxl style files lead | 23,524 characters; import tooling leads |
| Same query, scope `odd/fix` | 21,997 characters; both formatter files | 21,997 characters; both formatter files |
| `CellStyle`, scope `odd`, one file | Requested definition omitted | Requested definition returned |

Broad queries without a scope still return loosely related files in this monorepo.
The patch limits dependency noise. It does not infer intent from generic keywords.

## Platform checks

| Environment | Result |
|---|---|
| macOS, Node 22, arm64 | 595 tests pass in 42 engine suites; full build passes |
| Linux Docker, Node 22, arm64, `node:22-bookworm`, `--init` | 595 tests pass in the same 42 suites; clean install and full build pass |
| Wine 11 on macOS, Windows Node 22.23.0, x64 | 27 tests pass in four suites; engine and viewer builds pass |

The Wine checks include separate CLI processes, context resets, fingerprints, scopes, and a real query worker.
The Windows executable is a PE32+ x86-64 binary. The runtime reports `win32 x64` and passes a SQLite assertion.
The Wine environment uses a separate prefix and Windows dependency packages in a temporary directory.
Wine proves compatibility through that environment. Native Windows remains unverified because no configured Windows host was available.

## Agent comparison limits

The repaired harness exports complete committed revisions into separate directories.
Every trial gets a fresh indexed target. Build or daemon failures stop the run.
The harness keeps the shared CLI block, disables the ambient prompt hook, and uses Sonnet with high effort.
It defaults to two trials per arm and accepts a Jujutsu change ID for the baseline.

A smoke test used a fake agent to exercise four trials against the real exported builds.
All four trials started clean after the fake agent changed its target.
The original target stayed unchanged, and every trial daemon stopped.
This checks harness isolation. It does not measure agent behavior.

Live agent comparisons remain pending authentication. No agent speed, recall, or context-use gain is claimed from these checks.

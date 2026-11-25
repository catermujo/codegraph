#!/usr/bin/env bash
# Replay one Explore query corpus against several committed builds on one fixed index snapshot.
#
# Usage: replay-arms.sh <indexed-repo> <corpus.jsonl> <ref> <ref> [<ref>...]
# Each ref gets its own source export and build. The snapshot holds the index and only the
# indexed source files, so edits in the live repository cannot reach one arm and not another.
# Every arm replays read-only. REPLAY_ARMS_OUT selects the output directory; the default uses /tmp.
# The comparison lands in <out>/compare.md; per-arm reports in <out>/<ref>.json.
set -euo pipefail

TARGET="$(cd "${1:?usage: replay-arms.sh <indexed-repo> <corpus.jsonl> <ref> <ref> [<ref>...]}" && pwd)"
CORPUS="$(cd "$(dirname "${2:?corpus required}")" && pwd)/$(basename "$2")"
shift 2
[ "$#" -ge 2 ] || { echo "give at least two refs"; exit 1; }
HARNESS="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HARNESS/../.." && pwd)"
OUT="${REPLAY_ARMS_OUT:-$(mktemp -d /tmp/replay-arms.XXXXXX)}"
mkdir -p "$OUT"
[ -f "$TARGET/.codegraph/codegraph.db" ] || { echo "target not indexed: $TARGET"; exit 1; }

# Snapshot: a consistent copy of the database plus the indexed files it renders source from.
SNAP="$OUT/snapshot"
if [ ! -f "$SNAP/.codegraph/codegraph.db" ]; then
  mkdir -p "$SNAP/.codegraph"
  sqlite3 "$TARGET/.codegraph/codegraph.db" ".backup '$SNAP/.codegraph/codegraph.db'"
  sqlite3 -readonly "$SNAP/.codegraph/codegraph.db" "SELECT path FROM files" > "$OUT/indexed-files.txt"
  (cd "$TARGET" && rsync -a --files-from="$OUT/indexed-files.txt" ./ "$SNAP/")
  for config in config.json codegraph.json; do
    [ -f "$TARGET/.codegraph/$config" ] && cp "$TARGET/.codegraph/$config" "$SNAP/.codegraph/"
  done
fi

ARMS=()
for ref in "$@"; do
  commit="$(git -C "$ENGINE" rev-parse --verify "$ref^{commit}" 2>/dev/null \
    || jj --ignore-working-copy --repository "$ENGINE" log -r "$ref" --no-graph -T commit_id)"
  name="$(printf '%s' "$ref" | tr -c 'A-Za-z0-9._-' '_')"
  # Keyed by commit: a rewritten change keeps its ref name but must not reuse an old build.
  build="$OUT/build-${commit:0:12}"
  if [ ! -f "$build/dist/index.js" ]; then
    rm -rf "$build" && mkdir -p "$build"
    git -C "$ENGINE" archive "$commit" | tar -x -C "$build"
    (cd "$build" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  fi
  echo "replaying $ref ($commit)"
  CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_PROMPT_HOOK=1 \
    node "$build/scripts/agent-eval/replay-explore.mjs" "$SNAP" "$CORPUS" -read-only -output "$OUT/$name.json"
  ARMS+=("$name=$OUT/$name.json")
done

node "$HARNESS/replay-compare.mjs" "$CORPUS" "${ARMS[@]}" > "$OUT/compare.md"
echo "comparison: $OUT/compare.md"

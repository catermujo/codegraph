#!/usr/bin/env bash
# Compare committed CodeGraph builds on fresh copies of an indexed target.
# Each build uses a separate source export. Each trial gets a new index and a warm daemon.
# The original engine and target remain unchanged.
#
# Usage: AGENT=codex ab-new-vs-baseline.sh <indexed-repo> "<task>" [baseline-ref]
# AGENT defaults to claude. Codex trials are read-only.
# RUNS defaults to 2. Report the range across runs.
# MODEL and EFFORT default to sonnet/high for Claude and gpt-5.6-luna/high for Codex.
# AGENT_EVAL_OUT selects a fresh output directory. The default uses /tmp.
#
# Both agents receive a sanitized PATH. Claude also uses a hook that blocks CLI calls.
# Codex uses a task constraint and rejects any detected CLI invocation in the event log.
# The Codex parser reports tool calls, returned characters, reported usage, and wall time.
# It does not estimate residual context occupancy or a context-window size.
# Both arms disable the ambient prompt hook.
set -euo pipefail

TARGET="${1:?usage: ab-new-vs-baseline.sh <indexed-repo> \"<task>\" [baseline-ref]}"
TARGET="$(cd "$TARGET" && pwd)"
TASK="${2:?task required}"
BASE_REF="${3:-HEAD~1}"
HARNESS="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HARNESS/../.." && pwd)"
BIN=""
OUT="${AGENT_EVAL_OUT:-$(mktemp -d /tmp/ab-new-vs-baseline.XXXXXX)}"
PARSE="$HARNESS/parse-run.mjs"
AGENT="${AGENT:-claude}"

case "$AGENT" in
  claude)
    command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
    claude auth status >/dev/null 2>&1 || { echo "Claude login required: run 'claude auth login' first"; exit 1; }
    ;;
  codex)
    command -v codex >/dev/null || { echo "codex CLI not on PATH"; exit 1; }
    codex login status >/dev/null 2>&1 || { echo "Codex login required: run 'codex login' first"; exit 1; }
    PARSE="$HARNESS/parse-codex-run.mjs"
    ;;
  *) echo "unsupported AGENT: $AGENT"; exit 1 ;;
esac
[ -d "$TARGET/.codegraph" ] || { echo "target not indexed: run 'codegraph init $TARGET' first"; exit 1; }
if [ -n "$(git -C "$ENGINE" status --porcelain --untracked-files=normal)" ]; then
  echo "engine repo has uncommitted changes — commit first (each build uses a committed source export)"; exit 1
fi
if ! git -C "$ENGINE" rev-parse --verify "$BASE_REF^{commit}" >/dev/null 2>&1; then
  BASE_REF="$(jj --ignore-working-copy --repository "$ENGINE" log -r "$BASE_REF" --no-graph -T commit_id)"
fi
CHANGED=$(git -C "$ENGINE" diff --name-only "$BASE_REF" HEAD -- src 2>/dev/null)
[ -n "$CHANGED" ] || { echo "no src/ changes between $BASE_REF and HEAD — nothing to A/B"; exit 1; }

# Separate the builds and runs so the baseline cannot change the engine source.
[ ! -e "$OUT/engine-new" ] && [ ! -e "$OUT/engine-baseline" ] || {
  echo "output already contains build snapshots: choose a fresh AGENT_EVAL_OUT"; exit 1
}
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
DAEMON_TARGETS=()
stop_daemon() {
  local pidfile="$1/.codegraph/daemon.pid" pid
  [ -f "$pidfile" ] || return 0
  pid="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)' "$pidfile")"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then kill "$pid" 2>/dev/null || true; fi
}
cleanup() {
  for tgt in "${DAEMON_TARGETS[@]}"; do stop_daemon "$tgt"; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_snapshot() {
  local label="$1" ref="$2" dir="$OUT/engine-$1"
  mkdir "$dir"
  git -C "$ENGINE" archive "$ref" | tar -x -C "$dir"
  ( cd "$dir" && npm ci && npm run build ) >"$OUT/build-$label.log" 2>&1
}
build_snapshot new HEAD
build_snapshot baseline "$BASE_REF"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({agent:process.argv[2],new:process.argv[3],baseline:process.argv[4],target:process.argv[5],task:process.argv[6]},null,2))' \
  "$OUT/manifest.json" "$AGENT" "$(git -C "$ENGINE" rev-parse HEAD)" "$(git -C "$ENGINE" rev-parse "$BASE_REF")" "$TARGET" "$TASK"

# Preserve required tools while removing the shared CLI from the agent PATH.
. "$HARNESS/no-cli-shim.sh"
CG_EVAL_AGENT="$AGENT" cg_no_cli_setup "$OUT" || exit 1

echo "###### engine=$ENGINE  baseline=$BASE_REF"
echo "###### changed: $(echo "$CHANGED" | tr '\n' ' ')"
echo "###### target=$TARGET"
echo "###### task=$TASK"
echo

prewarm() {
  DAEMON_TARGETS+=("$1")
  CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  # Ask the arm's build where its daemon binds: a long target path moves the socket to the temp dir.
  node -e 'const fs=require("fs");const paths=require(process.argv[2]).getDaemonSocketCandidates(process.argv[1]);let n=0;const t=setInterval(()=>{if(paths.some((p)=>fs.existsSync(p))){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" "$(dirname "$BIN")/../mcp/daemon-paths.js"
  echo "  daemon warm: $1"
}

run_arm() { # label, target-copy — runs the task $RUNS times against one build
  local label="$1" tgt c
  echo "############## ARM [$label] ##############"
  for i in $(seq 1 "${RUNS:-2}"); do
    tgt="$OUT/t-$label-$i"
    c="$OUT/mcp-$label-$i.json"
    mkdir "$tgt"
    rsync -a --exclude node_modules --exclude .git --exclude .jj --exclude dist --exclude .codegraph "$TARGET/" "$tgt/"
    node "$BIN" init "$tgt" >"$OUT/index-$label-$i.log" 2>&1
    node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({mcpServers:{codegraph:{command:process.execPath,args:[process.argv[2],"serve","--mcp","--path",process.argv[3]],env:{CODEGRAPH_WASM_RELAUNCHED:"1",CODEGRAPH_EXPLORE_DEBUG:process.argv[4]}}}}))' \
      "$c" "$BIN" "$tgt" "$OUT/explore-$label-$i.jsonl"
    prewarm "$tgt"
    if [ "$AGENT" = codex ]; then
      PATH="$ARM_PATH" CODEGRAPH_NO_PROMPT_HOOK=1 node "$HARNESS/run-codex.mjs" "$c" "$tgt" "$TASK" "$OUT/run-$label-$i"
    else
      ( cd "$tgt" && PATH="$ARM_PATH" CODEGRAPH_NO_PROMPT_HOOK=1 claude -p "$TASK" \
        --output-format stream-json --verbose --permission-mode bypassPermissions \
        --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd "${MAX_BUDGET_USD:-4}" --strict-mcp-config --mcp-config "$c" \
        --settings "$ARM_SETTINGS" \
        </dev/null > "$OUT/run-$label-$i.jsonl" 2>"$OUT/run-$label-$i.err" )
    fi
    echo "-- run $i --"
    node "$PARSE" --brief "$OUT/run-$label-$i.jsonl" >"$OUT/metrics-$label-$i.txt"
    echo "  metrics: $OUT/metrics-$label-$i.txt"
    stop_daemon "$tgt"
  done
  echo
}

for label in new baseline; do
  BIN="$OUT/engine-$label/dist/bin/codegraph.js"
  run_arm "$label"
done

if [ "$AGENT" = codex ]; then
  node "$PARSE" --compare "$OUT"
else
  node "$HARNESS/compare-arms.mjs" "$OUT" new baseline
fi

echo "###### DONE. Comparison above. Per-run metrics and answers in the output directory."
echo "###### Full logs in: $OUT"

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PRT_DIR="${PRT_DIR:-$HOME/Dev/karolk91/polkadot-referenda-tester-prod}"
AH_WS="${AH_WS:-wss://polkadot-asset-hub-rpc.polkadot.io}"
HYDRATION_WS="${HYDRATION_WS:-wss://hydration-rpc.n.dwellir.com}"
RELAY_WS="${RELAY_WS:-wss://rpc.polkadot.io}"

ENACT_BLOCK="${ENACT_BLOCK:-}"
ENACT_OFFSET="${ENACT_OFFSET:-100000}"

EXECUTIONS="${EXECUTIONS:-once}"
REDUCE_CHUNKED_TO="${REDUCE_CHUNKED_TO:-}"

BLOCK_DETAILS="${BLOCK_DETAILS:-1}"

USE_SUBWAY="${USE_SUBWAY:-1}"
if [ "$USE_SUBWAY" = "1" ]; then
  if command -v subway >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/subway" ]; then
    echo "== 0. starting subway RPC proxies =="
    scripts/subway.sh start
    trap 'scripts/subway.sh stop >/dev/null 2>&1 || true' EXIT
    AH_WS="ws://127.0.0.1:${AH_SUBWAY_PORT:-9011}"
    HYDRATION_WS="ws://127.0.0.1:${HYDRATION_SUBWAY_PORT:-9012}"
    [ -n "$RELAY_WS" ] && RELAY_WS="ws://127.0.0.1:${RELAY_SUBWAY_PORT:-9013}"
  else
    echo "WARN: USE_SUBWAY=1 but subway binary not found; using direct endpoints." >&2
    echo "      install: cargo install --git https://github.com/AcalaNetwork/subway --locked" >&2
  fi
fi

export AH_ENDPOINT="$AH_WS"
export HYD_ENDPOINT="$HYDRATION_WS"
[ -n "$RELAY_WS" ] && export RELAY_ENDPOINT="$RELAY_WS"

BUILD_ARGS=()
if [ -n "$ENACT_BLOCK" ]; then
  BUILD_ARGS+=(--cancel-at-block "$ENACT_BLOCK")
else
  BUILD_ARGS+=(--enact-offset "$ENACT_OFFSET")
fi
[ -n "$REDUCE_CHUNKED_TO" ] && BUILD_ARGS+=(--reduce-chunked "$REDUCE_CHUNKED_TO")

mkdir -p out
echo "== 1. building the consolidation referendum (${BUILD_ARGS[*]}) =="
npx tsx scratch.buildAll.ts "${BUILD_ARGS[@]}"
test -f out/all-ah-sim.yml || { echo "builder did not emit out/all-ah-sim.yml" >&2; exit 1; }

PREIMAGE="$(tr -d '[:space:]' < out/all-preimage.call)"
SUBMIT="$(tr -d '[:space:]' < out/all-submit.call)"

HYD_ENTRY="$HYDRATION_WS"
if [ -n "$REDUCE_CHUNKED_TO" ]; then
  test -f out/hyd-reduce.yml || { echo "REDUCE_CHUNKED_TO set but out/hyd-reduce.yml missing" >&2; exit 1; }
  HYD_ENTRY="$(pwd)/out/hyd-reduce.yml"
fi
ADDITIONAL="$HYD_ENTRY"
[ -n "$RELAY_WS" ] && ADDITIONAL="$HYD_ENTRY,$RELAY_WS"

echo "== 2+3. executing via referenda-tester + post-test (executions: $EXECUTIONS; additional-chains: $ADDITIONAL) =="
node "$PRT_DIR/dist/cli.js" test \
  --governance-chain-url "$(pwd)/out/all-ah-sim.yml" \
  --additional-chains "$ADDITIONAL" \
  --call-to-note-preimage-for-governance-referendum "$PREIMAGE" \
  --call-to-create-governance-referendum "$SUBMIT" \
  --post-test "$(pwd)/post-tests/all.ts" \
  --post-test-args "{\"executions\":\"$EXECUTIONS\",\"outDir\":\"$(pwd)/out\",\"blockDetails\":$BLOCK_DETAILS}" \
  --verbose

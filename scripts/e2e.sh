#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PRT_DIR="${PRT_DIR:-$HOME/Dev/karolk91/polkadot-referenda-tester-prod}"
AH_WS="${AH_WS:-wss://polkadot-asset-hub-rpc.polkadot.io}"
HYDRATION_WS="${HYDRATION_WS:-wss://hydration-rpc.n.dwellir.com}"
RELAY_WS="${RELAY_WS:-wss://rpc.polkadot.io}"
COLLECTIVES_WS="${COLLECTIVES_WS:-wss://polkadot-collectives-rpc.polkadot.io}"
EXECUTIONS="${EXECUTIONS:-0}"
[ "$EXECUTIONS" = "all" ] && EXECUTIONS=100000
TRACK="${TRACK:-root}"
PREFUND_SOVEREIGN_DOT="${PREFUND_SOVEREIGN_DOT:-}"
FEE_BUDGET_DOT="${FEE_BUDGET_DOT:-0.02}"
BLOCK_DETAILS="${BLOCK_DETAILS:-1}"

USE_SUBWAY="${USE_SUBWAY:-1}"
if [ "$USE_SUBWAY" = "1" ]; then
  if command -v subway >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/subway" ]; then
    echo "== 0. starting subway RPC proxies (caching + failover) =="
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

HOLDER_ACCT="7N4oFqXKgeTXo6CMSY9BVZdHP5J3RhQXY77Fe7qmQwjcxa1w"
SOVEREIGN_ACCT="7LCt6dFqtxzdKVB2648jWW9d85doiFfLSbZJDNAMVJNxh5rJ"
HYD_ENTRY="$HYDRATION_WS"
GEN_ARGS=(--track "$TRACK")
[ -n "${EXTRA_EXECUTIONS:-}" ] && GEN_ARGS+=(--extra-executions "$EXTRA_EXECUTIONS")
DOT_ASSET_ID=5
USDT_ASSET_ID=10
USDC_ASSET_ID=22
planck() { awk -v d="$1" -v e="$2" 'BEGIN{printf "%.0f", d*(10^e)}'; }
tok_entry() { printf "      - - ['%s', %s]\n        - free: '%s'\n          reserved: '0'\n          frozen: '0'\n" "$1" "$2" "$3"; }
if [ -n "$PREFUND_SOVEREIGN_DOT" ]; then
  CFG="$(pwd)/hydration-prefund.gen.yml"
  {
    echo "endpoint: '$HYDRATION_WS'"
    echo "import-storage:"
    echo "  Tokens:"
    echo "    Accounts:"
    tok_entry "$SOVEREIGN_ACCT" "$DOT_ASSET_ID" "$(planck "$PREFUND_SOVEREIGN_DOT" 10)"
    [ -n "${SWEEP_USDT:-}" ] && tok_entry "$HOLDER_ACCT" "$USDT_ASSET_ID" "$(planck "$SWEEP_USDT" 6)"
    [ -n "${SWEEP_USDC:-}" ] && tok_entry "$HOLDER_ACCT" "$USDC_ASSET_ID" "$(planck "$SWEEP_USDC" 6)"
  } > "$CFG"
  HYD_ENTRY="$CFG"
  GEN_ARGS+=(--top-up-dot 0 --fee-budget-dot "$FEE_BUDGET_DOT" --assume-sovereign-dot "$PREFUND_SOVEREIGN_DOT")
  [ -n "${SWEEP_USDT:-}" ] && GEN_ARGS+=(--usdt "$SWEEP_USDT")
  [ -n "${SWEEP_USDC:-}" ] && GEN_ARGS+=(--usdc "$SWEEP_USDC")
  echo "== 0b. pre-funding via $CFG: sovereign $PREFUND_SOVEREIGN_DOT DOT${SWEEP_USDT:+, holder $SWEEP_USDT USDT}${SWEEP_USDC:+ / $SWEEP_USDC USDC}; no on-chain top-up; fee budget $FEE_BUDGET_DOT DOT/msg =="
fi

if [ -n "${GEN_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206 — word splitting is the point here.
  GEN_ARGS+=($GEN_EXTRA_ARGS)
fi

ADDITIONAL="$HYD_ENTRY"
[ -n "$RELAY_WS" ] && ADDITIONAL="$HYD_ENTRY,$RELAY_WS"

echo "== 1. generating referendum calls (${GEN_ARGS[*]}) =="
npm start --silent -- "${GEN_ARGS[@]}"

PREIMAGE="$(tr -d '[:space:]' < out/ahp-submit-the-preimage-for-the-public-referendum.call)"
if [ "$TRACK" = "whitelisted-caller" ]; then
  SUBMIT="$(tr -d '[:space:]' < out/ahp-open-a-public-referendum-on-the-whitelisted-caller-track.call)"
  FELLOWSHIP_SUBMIT="$(tr -d '[:space:]' < out/collectives-open-a-fellowship-referendum-to-whitelist-the-call.call)"
else
  SUBMIT="$(tr -d '[:space:]' < out/ahp-open-a-public-referendum-on-the-root-track.call)"
fi

CMD=(node "$PRT_DIR/dist/cli.js" test
  --governance-chain-url "$AH_WS"
  --additional-chains "$ADDITIONAL"
  --call-to-note-preimage-for-governance-referendum "$PREIMAGE"
  --call-to-create-governance-referendum "$SUBMIT"
  --post-test "$(pwd)/post-tests/sweep.ts"
  --post-test-args "{\"executions\":$EXECUTIONS,\"outDir\":\"$(pwd)/out\",\"blockDetails\":$BLOCK_DETAILS}"
  --verbose)

if [ "$TRACK" = "whitelisted-caller" ]; then
  CMD+=(--fellowship-chain-url "$COLLECTIVES_WS" --call-to-create-fellowship-referendum "$FELLOWSHIP_SUBMIT")
  FELLOWSHIP_PREIMAGE_FILE="out/collectives-submit-the-preimage-for-the-fellowship-referendum.call"
  if [ -f "$FELLOWSHIP_PREIMAGE_FILE" ]; then
    CMD+=(--call-to-note-preimage-for-fellowship-referendum "$(tr -d '[:space:]' < "$FELLOWSHIP_PREIMAGE_FILE")")
  fi
fi

echo "== 2+3. executing via referenda-tester + post-test (track: $TRACK; additional-chains: $ADDITIONAL) =="
"${CMD[@]}"

#!/usr/bin/env bash
# End-to-end test of the Hydration treasury sweep:
#   1. generate the referendum calls (writes out/summary.json + out/*.call),
#   2. hand the proposal to polkadot-referenda-tester, which forks Asset Hub + Hydration on
#      Chopsticks, creates and executes the referendum, then
#   3. runs post-tests/sweep.ts against the live post-referendum network to assert the sweep works.
#
# Requires the referenda-tester checkout (feat/post-test-hook, built) next to this repo, and a Node
# that can import .ts post-tests (>= 22.18 / 23.6, or the tester's pinned Node 24).
set -euo pipefail
cd "$(dirname "$0")/.."

PRT_DIR="${PRT_DIR:-$HOME/Dev/karolk91/polkadot-referenda-tester-prod}"
AH_WS="${AH_WS:-wss://polkadot-asset-hub-rpc.polkadot.io}"
HYDRATION_WS="${HYDRATION_WS:-wss://hydration-rpc.n.dwellir.com}"
# The Polkadot relay is forked alongside so Chopsticks routes AH<->Hydration sibling HRMP during the
# driving phase (without it, the swept XCM is never delivered to Hydration). Set RELAY_WS="" to omit.
RELAY_WS="${RELAY_WS:-wss://rpc.polkadot.io}"
# Polkadot Collectives — only forked for the whitelisted-caller track, to run the companion
# Fellowship referendum that whitelists the call on Asset Hub.
COLLECTIVES_WS="${COLLECTIVES_WS:-wss://polkadot-collectives-rpc.polkadot.io}"
EXECUTIONS="${EXECUTIONS:-0}"
# How many scheduled sweeps the post-test drives. Use "all" (or a big number) to run the whole
# schedule to completion — it drives every scheduled execution, empties the holder, and the post-test
# asserts the full sweep (start holder ≈ treasury gain, holder emptied). 0 = enactment checks only.
[ "$EXECUTIONS" = "all" ] && EXECUTIONS=100000
TRACK="${TRACK:-root}"
# Out-of-band pre-funding: instead of an on-chain top-up leg, seed Asset Hub's sovereign account on
# Hydration with DOT via a generated chopsticks import-storage override (hydration-prefund.gen.yml), so the
# scheduled sweeps can pay their XCM fees and the per-message fee budget can be over-provisioned
# freely (unspent DOT is refunded). Set PREFUND_SOVEREIGN_DOT to a DOT amount (e.g. 10) to enable;
# empty relies on the sovereign account's existing DOT (or a top-up leg via GEN_EXTRA_ARGS).
PREFUND_SOVEREIGN_DOT="${PREFUND_SOVEREIGN_DOT:-}"
# Per-message DOT fee budget (WithdrawAsset/BuyExecution); over-budgeting is free (surplus refunded).
FEE_BUDGET_DOT="${FEE_BUDGET_DOT:-0.02}"

# Put local subway RPC proxies (caching + failover) in front of the public nodes so the
# tester's repeated Chopsticks forks hit a warm local cache and survive a flaky upstream.
# On by default; set USE_SUBWAY=0 to talk to the public endpoints directly. If the subway
# binary is missing, a warning is printed and the direct endpoints are used.
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

# When pre-funding, hand Hydration to the tester as a chopsticks config path (endpoint + an
# import-storage override) instead of a bare URL, and tell the generator to drop the on-chain top-up.
# The config's endpoint tracks $HYDRATION_WS so it still goes through subway when that is enabled.
#
# SWEEP_USDT / SWEEP_USDC (6-dp human amounts, optional) additionally override the holder's balances
# in the fork and cap the swept totals — use them for a fast reduced run that empties the holder in
# a few executions, so the margin / schedule-completion phase is reached without a full ~205-run sweep.
# EXTRA_EXECUTIONS overrides the margin count (default 16).
HOLDER_ACCT="7N4oFqXKgeTXo6CMSY9BVZdHP5J3RhQXY77Fe7qmQwjcxa1w"
SOVEREIGN_ACCT="7LCt6dFqtxzdKVB2648jWW9d85doiFfLSbZJDNAMVJNxh5rJ"
HYD_ENTRY="$HYDRATION_WS"
GEN_ARGS=(--track "$TRACK")
[ -n "${EXTRA_EXECUTIONS:-}" ] && GEN_ARGS+=(--extra-executions "$EXTRA_EXECUTIONS")
planck() { awk -v d="$1" -v e="$2" 'BEGIN{printf "%.0f", d*(10^e)}'; }
tok_entry() { printf "      - - ['%s', %s]\n        - free: '%s'\n          reserved: '0'\n          frozen: '0'\n" "$1" "$2" "$3"; }
if [ -n "$PREFUND_SOVEREIGN_DOT" ]; then
  CFG="$(pwd)/hydration-prefund.gen.yml"
  {
    echo "endpoint: '$HYDRATION_WS'"
    echo "import-storage:"
    echo "  Tokens:"
    echo "    Accounts:"
    tok_entry "$SOVEREIGN_ACCT" 5 "$(planck "$PREFUND_SOVEREIGN_DOT" 10)"   # DOT = orml asset 5
    [ -n "${SWEEP_USDT:-}" ] && tok_entry "$HOLDER_ACCT" 10 "$(planck "$SWEEP_USDT" 6)"  # USDT = asset 10
    [ -n "${SWEEP_USDC:-}" ] && tok_entry "$HOLDER_ACCT" 22 "$(planck "$SWEEP_USDC" 6)"  # USDC = asset 22
  } > "$CFG"
  HYD_ENTRY="$CFG"
  GEN_ARGS+=(--top-up-dot 0 --fee-budget-dot "$FEE_BUDGET_DOT" --assume-sovereign-dot "$PREFUND_SOVEREIGN_DOT")
  [ -n "${SWEEP_USDT:-}" ] && GEN_ARGS+=(--usdt "$SWEEP_USDT")
  [ -n "${SWEEP_USDC:-}" ] && GEN_ARGS+=(--usdc "$SWEEP_USDC")
  echo "== 0b. pre-funding via $CFG: sovereign $PREFUND_SOVEREIGN_DOT DOT${SWEEP_USDT:+, holder $SWEEP_USDT USDT}${SWEEP_USDC:+ / $SWEEP_USDC USDC}; no on-chain top-up; fee budget $FEE_BUDGET_DOT DOT/msg =="
fi

# Extra generator flags appended verbatim (space-separated), e.g.
# GEN_EXTRA_ARGS="--max-footprint 0.1 --interval-hours 2".
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
  --post-test-args "{\"executions\":$EXECUTIONS,\"outDir\":\"$(pwd)/out\"}"
  --verbose)

if [ "$TRACK" = "whitelisted-caller" ]; then
  # The public referendum runs on the Whitelisted Caller track, which requires the Fellowship to have
  # whitelisted the call first: fork Collectives and create+execute that Fellowship referendum. prt
  # auto-injects Alice as a Fellow and dispatches the whitelist XCM to Asset Hub before the public ref.
  CMD+=(--fellowship-chain-url "$COLLECTIVES_WS" --call-to-create-fellowship-referendum "$FELLOWSHIP_SUBMIT")
  # The Fellowship proposal is inline when small enough; pass a preimage only if the generator made one.
  FELLOWSHIP_PREIMAGE_FILE="out/collectives-submit-the-preimage-for-the-fellowship-referendum.call"
  if [ -f "$FELLOWSHIP_PREIMAGE_FILE" ]; then
    CMD+=(--call-to-note-preimage-for-fellowship-referendum "$(tr -d '[:space:]' < "$FELLOWSHIP_PREIMAGE_FILE")")
  fi
fi

echo "== 2+3. executing via referenda-tester + post-test (track: $TRACK; additional-chains: $ADDITIONAL) =="
"${CMD[@]}"

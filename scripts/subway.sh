#!/usr/bin/env bash
# Start / stop local subway RPC proxies (caching + failover, from AcalaNetwork/subway)
# in front of the public Polkadot / Asset Hub / Hydration endpoints, so the e2e's
# repeated Chopsticks forks hit a warm local cache and transparently fail over when a
# public node stalls.
#
# Usage:
#   scripts/subway.sh start     # generate configs, start proxies, wait until each responds
#   scripts/subway.sh stop      # stop the proxies started by `start`
#   scripts/subway.sh status    # show whether each proxy responds on /liveness
#
# Ports (override via env): AH_SUBWAY_PORT=9011  HYDRATION_SUBWAY_PORT=9012  RELAY_SUBWAY_PORT=9013
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

SUBWAY_BIN="${SUBWAY_BIN:-subway}"
TEMPLATE="scripts/subway-template.yml"
ENDPOINTS_JSON="scripts/endpoints.json"
RUN_DIR="${SUBWAY_RUN_DIR:-.subway}"

AH_SUBWAY_PORT="${AH_SUBWAY_PORT:-9011}"
HYDRATION_SUBWAY_PORT="${HYDRATION_SUBWAY_PORT:-9012}"
RELAY_SUBWAY_PORT="${RELAY_SUBWAY_PORT:-9013}"

# key-in-endpoints.json : port
PAIRS=(
  "assetHubPolkadot:${AH_SUBWAY_PORT}"
  "hydration:${HYDRATION_SUBWAY_PORT}"
  "polkadot:${RELAY_SUBWAY_PORT}"
)

live() { curl -fsS -m 4 "http://127.0.0.1:$1/liveness" >/dev/null 2>&1; }

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Error: '$1' not found in PATH" >&2; exit 1; }
}

start() {
  need jq
  if ! command -v "$SUBWAY_BIN" >/dev/null 2>&1; then
    echo "Error: subway not found. Install: cargo install --git https://github.com/AcalaNetwork/subway --locked" >&2
    exit 1
  fi
  mkdir -p "$RUN_DIR"
  for pair in "${PAIRS[@]}"; do
    local key="${pair%%:*}" port="${pair##*:}"
    if live "$port"; then
      echo "  = $key already live on 127.0.0.1:$port"
      continue
    fi
    local endpoints
    endpoints="$(jq -c ".$key" "$ENDPOINTS_JSON")"
    if [ "$endpoints" = "null" ] || [ -z "$endpoints" ]; then
      echo "Error: no endpoints for '$key' in $ENDPOINTS_JSON" >&2; exit 1
    fi
    local cfg="$RUN_DIR/$key-$port.yml" logf="$RUN_DIR/$key-$port.log" pidf="$RUN_DIR/$key-$port.pid"
    sed -e "s/{{PORT}}/$port/g" -e "s|{{ENDPOINTS}}|$endpoints|g" "$TEMPLATE" > "$cfg"
    "$SUBWAY_BIN" --config "$cfg" > "$logf" 2>&1 &
    echo $! > "$pidf"
    echo "  + $key -> 127.0.0.1:$port (pid $(cat "$pidf"), upstream $(jq -r ".$key[0]" "$ENDPOINTS_JSON"))"
  done

  echo "Waiting for proxies to answer /liveness ..."
  for pair in "${PAIRS[@]}"; do
    local key="${pair%%:*}" port="${pair##*:}"
    local ok=""
    for _ in $(seq 1 60); do
      if live "$port"; then ok=1; break; fi
      sleep 1
    done
    if [ -n "$ok" ]; then
      echo "  ✓ $key live on 127.0.0.1:$port"
    else
      echo "  ✗ $key did NOT come up on 127.0.0.1:$port — see $RUN_DIR/$key-$port.log" >&2
      tail -n 20 "$RUN_DIR/$key-$port.log" >&2 || true
      exit 1
    fi
  done
  echo "All subway proxies are running."
}

stop() {
  for pair in "${PAIRS[@]}"; do
    local key="${pair%%:*}" port="${pair##*:}"
    local pidf="$RUN_DIR/$key-$port.pid"
    if [ -f "$pidf" ]; then
      local pid; pid="$(cat "$pidf")"
      if kill "$pid" 2>/dev/null; then echo "  - stopped $key (pid $pid)"; fi
      rm -f "$pidf"
    fi
  done
  # Belt and suspenders: reap any stragglers pointing at our configs.
  pkill -f "subway --config $RUN_DIR/" 2>/dev/null || true
}

status() {
  for pair in "${PAIRS[@]}"; do
    local key="${pair%%:*}" port="${pair##*:}"
    if live "$port"; then echo "  ✓ $key  127.0.0.1:$port  live"; else echo "  ✗ $key  127.0.0.1:$port  down"; fi
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "Usage: $0 {start|stop|status}" >&2; exit 1 ;;
esac

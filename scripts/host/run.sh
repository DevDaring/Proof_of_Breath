#!/usr/bin/env bash
# Proof of Breath - (re)start the API on 127.0.0.1:8270 and the browser camera relay slots on 8271+.
# Caddy serves web/ and proxies /api, /ws and /ws/camera/N.
# One API worker on purpose: live gate sessions and the sensor links live in process memory.
set -e
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8270}"
NODE="${NODE:-$(command -v node || echo /usr/local/bin/node)}"
RELAY_SLOTS="${POB_RELAY_SLOTS:-3}"
cd "$APP_DIR"
"$APP_DIR/stop.sh" >/dev/null 2>&1 || true
mkdir -p logs
setsid bash -c "cd '$APP_DIR/backend' && export POB_ENV_FILE='$APP_DIR/.env' && exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $PORT --workers 1 --proxy-headers --forwarded-allow-ips=127.0.0.1 --timeout-keep-alive 120 --no-access-log" \
  >> logs/api.log 2>&1 < /dev/null &
echo $! > logs/api.pid
ready=0
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/ping" >/dev/null && { ready=1; break; }; sleep 1; done
[ "$ready" = 1 ] || { echo "pob did not become ready; see logs/api.log" >&2; exit 1; }
echo "pob up on 127.0.0.1:$PORT"
# One SDK capture per process, so each slot is its own process.
if [ -f "$APP_DIR/relay/src/relay.mjs" ] && grep -q '^POB_RELAY_TOKEN=' "$APP_DIR/.env"; then
  for i in $(seq 0 $((RELAY_SLOTS - 1))); do
    setsid bash -c "cd '$APP_DIR/relay' && POB_RELAY_ENV='$APP_DIR/.env' POB_BACKEND_WS='ws://127.0.0.1:$PORT' POB_RELAY_SLOT=$i POB_RELAY_PORT=$((PORT + 1 + i)) exec '$NODE' src/relay.mjs" \
      >> "logs/relay-$i.log" 2>&1 < /dev/null &
    echo $! > "logs/relay-$i.pid"
  done
  echo "relay slots: $RELAY_SLOTS on 127.0.0.1:$((PORT + 1))-$((PORT + RELAY_SLOTS))"
fi

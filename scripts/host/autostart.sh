#!/usr/bin/env bash
# Proof of Breath watchdog - idempotent (cron: @reboot and */5). Starts the DB container and the API only if needed.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8270}"
[ -x "$APP_DIR/run.sh" ] || exit 0
docker start pob-db >/dev/null 2>&1 || true
relays_ok=1
for p in "$APP_DIR"/logs/relay-*.pid; do [ -f "$p" ] && ! kill -0 "$(cat "$p")" 2>/dev/null && relays_ok=0; done
curl -sf "http://127.0.0.1:$PORT/api/ping" >/dev/null && [ "$relays_ok" = 1 ] && exit 0
mkdir -p "$APP_DIR/logs"
for i in $(seq 1 30); do docker exec pob-db pg_isready -U pob -d proof_of_breath >/dev/null 2>&1 && break; sleep 1; done
echo "$(date -Is) autostart: starting pob" >> "$APP_DIR/logs/autostart.log"
"$APP_DIR/run.sh" >> "$APP_DIR/logs/autostart.log" 2>&1

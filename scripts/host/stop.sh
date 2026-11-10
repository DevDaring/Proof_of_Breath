#!/usr/bin/env bash
# Stop only Proof of Breath's API and relay slots (matched by pid files).
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for p in "$APP_DIR"/logs/relay-*.pid "$APP_DIR/logs/api.pid"; do
  [ -f "$p" ] || continue
  kill "$(cat "$p")" 2>/dev/null; pkill -P "$(cat "$p")" 2>/dev/null
  rm -f "$p"
done
sleep 1

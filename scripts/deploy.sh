#!/usr/bin/env bash
# Build and deploy to /home/Debz/Host/pob, following this server's conventions.
# Backend on 127.0.0.1:8270, Postgres container pob-db on 127.0.0.1:5445, Caddy serves web/.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${POB_DEPLOY_DIR:-/home/Debz/Host/pob}"
mkdir -p "$DST"/{logs,backups,web,backend}

echo "== frontend"
(cd "$SRC/frontend" && npm ci --no-audit --no-fund --silent && npm run build --silent)
rsync -a --delete "$SRC/frontend/dist/" "$DST/web/"

echo "== backend"
rsync -a --delete --exclude .venv --exclude __pycache__ --exclude '.pytest_cache' --exclude tests "$SRC/backend/" "$DST/backend/"
[ -x "$DST/backend/.venv/bin/python" ] || python3.12 -m venv "$DST/backend/.venv"
"$DST/backend/.venv/bin/pip" install -q --upgrade pip
"$DST/backend/.venv/bin/pip" install -q -r "$DST/backend/requirements.txt"

echo "== camera relay"
mkdir -p "$DST/relay"
rsync -a --delete --exclude node_modules --exclude test --exclude .env --exclude '.env.*' "$SRC/bridge/" "$DST/relay/"
(cd "$DST/relay" && npm ci --no-audit --no-fund --silent --omit=dev)

for f in run.sh stop.sh autostart.sh backup.sh; do install -m 755 "$SRC/scripts/host/$f" "$DST/$f"; done

echo "== migrate and restart"
docker start pob-db >/dev/null 2>&1 || true
for _ in $(seq 1 30); do docker exec pob-db pg_isready -U pob -d proof_of_breath >/dev/null 2>&1 && break; sleep 1; done
(cd "$DST/backend" && POB_ENV_FILE="$DST/.env" .venv/bin/alembic upgrade head)
"$DST/run.sh"

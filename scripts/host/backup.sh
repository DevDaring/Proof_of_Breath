#!/usr/bin/env bash
# Proof of Breath daily database backup (keeps 14 days).
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$APP_DIR/backups"
f="$APP_DIR/backups/pob-$(date +%Y%m%d-%H%M).sql.gz"
docker exec pob-db pg_dump -U pob -d proof_of_breath | gzip > "$f" && echo "$(date -Is) backup $f"
find "$APP_DIR/backups" -name 'pob-*.sql.gz' -mtime +14 -delete

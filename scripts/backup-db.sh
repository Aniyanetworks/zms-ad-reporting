#!/usr/bin/env bash
# Nightly logical backup of the Supabase Postgres database.
#
#   scripts/backup-db.sh
#
# * reads SUPABASE_DB_URL from backend/.env (or $DB_ENV_FILE) without echoing it
# * pg_dump --format=custom inside a postgres:17-alpine container (no host Python/pg needed)
#   of the app-owned schemas (public, raw_meta, raw_google; override with DUMP_SCHEMAS)
# * encrypts with age to AGE_RECIPIENT when set (~/.config/zms/backup.env); otherwise
#   WARNS and keeps the plaintext dump locally with 600 permissions
# * stores in ${BACKUP_DIR:-~/Backups/zms-ads}/db/, prunes files older than RETENTION_DAYS (30)
# * optional off-site copy: `rclone copy` to $BACKUP_REMOTE/db when BACKUP_REMOTE is set
#
# Scheduled by infra/launchd/com.zms.backup-db.plist (03:15 daily).
set -euo pipefail
# shellcheck source=backup-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/backup-lib.sh"
require_cmd docker

DB_ENV_FILE="${DB_ENV_FILE:-$REPO_ROOT/backend/.env}"
[[ -f "$DB_ENV_FILE" ]] || die "env file not found: $DB_ENV_FILE"
SUPABASE_DB_URL=$(env_value "$DB_ENV_FILE" SUPABASE_DB_URL)
[[ -n "$SUPABASE_DB_URL" ]] || die "SUPABASE_DB_URL is empty in $DB_ENV_FILE"
export SUPABASE_DB_URL   # passed to docker with -e NAME (value never appears in argv)

OUT_DIR="$BACKUP_DIR/db"
mkdir -p "$OUT_DIR"; chmod 700 "$BACKUP_DIR" "$OUT_DIR"
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
BASENAME="zms-ads-${STAMP}.dump"
DUMP_SCHEMAS="${DUMP_SCHEMAS:-public raw_meta raw_google}"
schema_args=()
for s in $DUMP_SCHEMAS; do schema_args+=(--schema="$s"); done

log "pg_dump ($PG_IMAGE) schemas: $DUMP_SCHEMAS -> $OUT_DIR/$BASENAME"
# --no-owner/--no-privileges: Supabase-specific roles do not exist on a restore target.
docker run --rm -e SUPABASE_DB_URL -e PGCONNECT_TIMEOUT=20 -v "$OUT_DIR:/out" "$PG_IMAGE" \
  sh -c 'exec pg_dump --format=custom --compress=6 --no-owner --no-privileges --file "/out/$0" "$@" "$SUPABASE_DB_URL"' \
  "$BASENAME" "${schema_args[@]}"
chmod 600 "$OUT_DIR/$BASENAME"
SIZE=$(du -h "$OUT_DIR/$BASENAME" | cut -f1)

if [[ -n "$AGE_RECIPIENT" ]]; then
  age_encrypt "$OUT_DIR/$BASENAME" "$OUT_DIR/$BASENAME.age"
  FINAL="$OUT_DIR/$BASENAME.age"
else
  warn "AGE_RECIPIENT not set — dump kept UNENCRYPTED at $OUT_DIR/$BASENAME (mode 600). Set AGE_RECIPIENT in $BACKUP_CONF."
  FINAL="$OUT_DIR/$BASENAME"
fi
log "backup written: $FINAL ($SIZE raw)"

prune_old "$OUT_DIR" 'zms-ads-*.dump*'
upload_dir "$OUT_DIR" db
log "done"

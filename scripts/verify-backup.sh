#!/usr/bin/env bash
# Restore the newest database dump into a throwaway Postgres container and row-count
# the key tables. Exits non-zero on any pg_restore error or if a key table is missing.
#
#   scripts/verify-backup.sh [dump-file]
#
# Encrypted dumps (*.age) need AGE_IDENTITY (private key file) in ~/.config/zms/backup.env.
# Nothing here touches Supabase. Scheduled weekly by infra/launchd/com.zms.verify-backup.plist.
set -euo pipefail
# shellcheck source=backup-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/backup-lib.sh"
require_cmd docker

DB_DIR="$BACKUP_DIR/db"
if [[ $# -ge 1 ]]; then
  DUMP="$1"
else
  DUMP=$(find "$DB_DIR" -maxdepth 1 -type f \( -name "zms-ads-*.dump" -o -name "zms-ads-*.dump.age" \) -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 1 || true)
fi
[[ -n "$DUMP" && -f "$DUMP" ]] || die "no dump found in $DB_DIR (run scripts/backup-db.sh first)"
log "verifying $DUMP"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/zms-verify.XXXXXX"); chmod 700 "$WORK"
CONTAINER="zms-ads-verify-$$"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PLAIN="$WORK/restore.dump"
if [[ "$DUMP" == *.age ]]; then
  age_decrypt "$DUMP" "$PLAIN"
else
  cp "$DUMP" "$PLAIN"; chmod 600 "$PLAIN"
fi

log "starting throwaway $PG_IMAGE"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify \
  -v "$WORK:/work:ro" --tmpfs /var/lib/postgresql/data "$PG_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres -q && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres -q || die "postgres did not start"

# Stubs for Supabase-managed objects the dump references (roles used in RLS policies,
# auth.uid()/auth.role()/auth.jwt(), auth.users behind profiles.id). Restore itself is
# checked for errors below, so keep this list minimal and explicit.
docker exec -i "$CONTAINER" psql -U postgres -d verify -v ON_ERROR_STOP=1 -q <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create role supabase_admin nologin;
-- the dump recreates public itself (Supabase owns it on the source)
drop schema if exists public cascade;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select null::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create extension if not exists "uuid-ossp" schema extensions;
SQL

log "pg_restore"
RESTORE_LOG="$WORK/restore.log"
set +e
docker exec "$CONTAINER" pg_restore -U postgres -d verify --no-owner --no-privileges --exit-on-error /work/restore.dump >"$RESTORE_LOG" 2>&1
RESTORE_RC=$?
set -e
if [[ $RESTORE_RC -ne 0 ]] || grep -qi 'error' "$RESTORE_LOG"; then
  cat "$RESTORE_LOG" >&2
  die "pg_restore reported errors (exit $RESTORE_RC)"
fi

echo "== row counts"
FAIL=0
for t in clients ad_metrics_daily recommendations audit_log sync_runs; do
  n=$(docker exec "$CONTAINER" psql -U postgres -d verify -Atc "select count(*) from public.$t" 2>/dev/null || true)
  if [[ -z "$n" ]]; then
    printf '%-22s MISSING\n' "$t"
    # audit_log only exists from migration 20260917000011 on; sync_runs may be empty on a fresh project.
    [[ "$t" == sync_runs || "$t" == audit_log ]] || FAIL=1
  else printf '%-22s %s\n' "$t" "$n"; fi
done
[[ $FAIL == 0 ]] || die "a key table is missing from the restored dump"
log "verify OK: $DUMP"

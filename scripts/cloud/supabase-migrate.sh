#!/usr/bin/env bash
# Apply supabase/migrations to an environment's database with the Supabase CLI.
#   scripts/cloud/supabase-migrate.sh staging      # uses SUPABASE_DB_URL from backend/.env.staging
#   scripts/cloud/supabase-migrate.sh production   # uses SUPABASE_DB_URL from backend/.env — PROMPTS for confirmation
# Never runs destructive statements unnoticed: scripts/check-migrations.sh runs first.
set -euo pipefail
ENV="${1:-}"; [ -n "$ENV" ] || { echo "usage: $0 <staging|production> [--dry-run]"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "$ENV" in
  staging)    ENVF="$ROOT/backend/.env.staging" ;;
  production) ENVF="$ROOT/backend/.env" ;;
  *) echo "unknown env $ENV"; exit 1 ;;
esac
[ -f "$ENVF" ] || { echo "missing $ENVF"; exit 1; }
DB_URL="$(grep -E '^SUPABASE_DB_URL=' "$ENVF" | cut -d= -f2- | tr -d '"')"
[ -n "$DB_URL" ] || { echo "SUPABASE_DB_URL not set in $ENVF"; exit 1; }
"$ROOT/scripts/check-migrations.sh" "${BASE_REF:-origin/main}" || { echo "destructive migration detected — set ALLOW_DESTRUCTIVE=1 only with owner approval"; exit 1; }
if [ "$ENV" = production ] && [ "${2:-}" != "--dry-run" ]; then
  [ -t 0 ] || { echo "refusing to migrate production without an interactive terminal"; exit 1; }
  read -r -p "Apply pending migrations to PRODUCTION? type 'migrate production': " ans || ans=""
  [ "$ans" = "migrate production" ] || { echo "aborted"; exit 1; }
fi
cd "$ROOT"
if [[ "${2:-}" == "--dry-run" ]]; then
  supabase db push --db-url "$DB_URL" --include-all --dry-run
else
  supabase db push --db-url "$DB_URL" --include-all
fi

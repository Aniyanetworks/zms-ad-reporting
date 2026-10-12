#!/usr/bin/env bash
# One-time baseline of the Supabase CLI migration history for a database whose
# migrations were applied by other means (SQL editor / MCP), so `supabase db push`
# only runs what is genuinely pending.
#
#   scripts/cloud/supabase-baseline.sh <staging|production> <pending-version> [<pending-version> ...]
#
# Every file in supabase/migrations/ EXCEPT the versions you name as pending is
# recorded as applied (nothing is executed). Verify first with:
#   supabase migration list --db-url "$SUPABASE_DB_URL"
# Then run scripts/cloud/supabase-migrate.sh <env> --dry-run and check only the
# pending versions are listed.
set -euo pipefail
ENV="${1:-}"; shift || true
[ -n "$ENV" ] && [ $# -ge 1 ] || { sed -n '2,12p' "$0"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "$ENV" in
  staging)    ENVF="$ROOT/backend/.env.staging" ;;
  production) ENVF="$ROOT/backend/.env" ;;
  *) echo "unknown env $ENV"; exit 1 ;;
esac
DB_URL="$(grep -E '^SUPABASE_DB_URL=' "$ENVF" | cut -d= -f2- | tr -d '"')"
[ -n "$DB_URL" ] || { echo "SUPABASE_DB_URL not set in $ENVF"; exit 1; }
# SUPABASE_DB_URL is stored percent-encoded (asyncpg and the CLI both require that); pass it through unchanged.
pending=(" $* ")
applied=()
for f in "$ROOT"/supabase/migrations/*.sql; do
  v="$(basename "$f" | cut -d_ -f1)"
  case "${pending[*]}" in *" $v "*) continue ;; esac
  applied+=("$v")
done
echo "Will mark ${#applied[@]} migration versions as APPLIED on $ENV (not executed):"
printf '  %s\n' "${applied[@]}"
echo "Pending (left for db push): $*"
if [ "$ENV" = production ]; then
  [ -t 0 ] || { echo "refusing to touch production history without an interactive terminal"; exit 1; }
  read -r -p "Type 'baseline production' to continue: " ans || ans=""
  [ "$ans" = "baseline production" ] || { echo "aborted"; exit 1; }
fi
cd "$ROOT"
supabase migration repair --db-url "$DB_URL" --status applied "${applied[@]}"
echo
supabase migration list --db-url "$DB_URL"

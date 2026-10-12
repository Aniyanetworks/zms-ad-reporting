#!/usr/bin/env bash
# Show the health of one environment (default production): container status, Docker
# health-check state, the two HTTP health endpoints, and the deploy state files.
#
#   scripts/health.sh [production|staging]
#
# Exit status is 0 only when every container is healthy/running and both endpoints
# return 200 — usable from monitoring. Needs no credentials.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

set_env "${1:-production}"
require_cmd docker curl
cd "$REPO_ROOT"
rc=0

echo "== $ENV_NAME — compose services"
if [[ -f "$ROOT_ENV_FILE" ]]; then
  compose ps || rc=1
else
  # No env file (e.g. on a fresh machine): fall back to a label filter.
  docker ps --filter "label=com.docker.compose.project=$( [[ $ENV_NAME == staging ]] && echo zms-ads-staging || echo zms-ad-reporting )" \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
fi

echo
echo "== container health"
prefix=$( [[ $ENV_NAME == staging ]] && echo zms-ads-stg- || echo zms-ads- )
for c in redis api celery-worker celery-beat web; do
  name="$prefix$c"
  if ! docker inspect "$name" >/dev/null 2>&1; then printf '%-28s %s\n' "$name" "MISSING"; rc=1; continue; fi
  status=$(docker inspect --format '{{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$name")
  image=$(docker inspect --format '{{.Config.Image}}' "$name")
  printf '%-28s %-22s %s\n' "$name" "$status" "$image"
  [[ "$status" == running || "$status" == "running / healthy" ]] || rc=1
done

echo
echo "== HTTP"
for url in "http://127.0.0.1:${API_PORT}/api/health/live" "http://127.0.0.1:${API_PORT}/api/health" "http://127.0.0.1:${WEB_PORT}/healthz"; do
  code=$(http_code "$url")
  body=$(curl -s --max-time 5 "$url" 2>/dev/null | head -c 400 || true)
  printf '%-3s %s\n    %s\n' "$code" "$url" "${body:-<no body>}"
  [[ "$code" == 200 ]] || rc=1
done

echo
echo "== deploy state ($DEPLOY_STATE_DIR)"
printf 'current:  %s\nprevious: %s\n' "$(state_read "$ENV_NAME.current")" "$(state_read "$ENV_NAME.previous")"
[[ -f "$DEPLOY_STATE_DIR/$ENV_NAME.history" ]] && { echo "last deploys:"; tail -n 5 "$DEPLOY_STATE_DIR/$ENV_NAME.history"; }

echo
[[ $rc == 0 ]] && echo "OVERALL: healthy" || echo "OVERALL: PROBLEMS (exit 1)"
exit $rc

#!/usr/bin/env bash
# Deploy the ZMS Ads stack.
#
#   scripts/deploy.sh <production|staging> [git-sha]
#
# 1. verifies the checkout is clean and at <git-sha> (default: HEAD)
# 2. builds zms-ads-api / zms-ads-web tagged IMAGE_TAG=<sha> (web bakes NEXT_PUBLIC_GIT_SHA)
# 3. records the tag currently running to <state>/<env>.previous
# 4. docker compose up -d --wait --remove-orphans  (production: project zms-ad-reporting,
#    the stack running today; staging: project zms-ads-staging, ports 3011/8011/6381)
# 5. polls http://127.0.0.1:<api-port>/api/health and http://127.0.0.1:<web-port>/healthz
#    for up to HEALTH_TIMEOUT (120 s); on failure runs scripts/rollback.sh and exits 1
# 6. writes <state>/<env>.current
#
# Env knobs: ALLOW_DIRTY=1 (skip the clean-tree check), HEALTH_TIMEOUT, HEALTH_ALLOW_DEGRADED=1
# (accept 503 from the deep health check, i.e. db/redis unreachable — debugging only; a
# fresh staging DB with no sync history already returns 200 'degraded' and passes), ZMS_DEPLOY_STATE_DIR,
# ZMS_SECRETS_DIR (see scripts/lib.sh), NO_BUILD=1 (reuse already-built images for <sha>).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 2; }
[[ $# -ge 1 && $# -le 2 ]] || usage
set_env "$1"
require_cmd docker git curl

cd "$REPO_ROOT"

SHA=$(git rev-parse --verify "${2:-HEAD}^{commit}") || die "unknown git ref: ${2:-HEAD}"
HEAD_SHA=$(git rev-parse HEAD)
[[ "$SHA" == "$HEAD_SHA" ]] || die "checkout is at $HEAD_SHA but $SHA was requested — run 'git checkout $SHA' first (the images are built from the working tree)"
if [[ "${ALLOW_DIRTY:-0}" != 1 && -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "working tree has uncommitted changes; commit them or set ALLOW_DIRTY=1"
fi

[[ -f "$BACKEND_ENV_FILE" ]] || die "backend env file missing: $BACKEND_ENV_FILE"
[[ -f "$ROOT_ENV_FILE" ]]    || die "web env file missing: $ROOT_ENV_FILE (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY)"
grep -q '^NEXT_PUBLIC_SUPABASE_URL=.\+' "$ROOT_ENV_FILE" || warn "NEXT_PUBLIC_SUPABASE_URL is empty in $ROOT_ENV_FILE"

export IMAGE_TAG="$SHA" GIT_SHA="$SHA" BACKEND_ENV_FILE
log "deploying $ENV_NAME @ $SHA (state: $DEPLOY_STATE_DIR)"

# --- remember what is running now, so rollback.sh has a target -------------------
CURRENT_TAG=$(running_tag)
RECORDED_CURRENT=$(state_read "$ENV_NAME.current")
if [[ "$CURRENT_TAG" == legacy:* ]]; then
  # Pre-hardening images (zms-ad-reporting-api:latest etc.). Re-tag them into the new
  # naming so rollback.sh can address them. NOTE: they run as root and expect a writable
  # rootfs, so a rollback to them under the hardened compose files may not work — if you
  # must, check out the pre-hardening commit and `docker compose up -d` from there.
  legacy_api="${CURRENT_TAG#legacy:}"
  legacy_web=$(docker inspect --format '{{.Config.Image}}' "$WEB_CONTAINER" 2>/dev/null || true)
  docker tag "$legacy_api" zms-ads-api:pre-hardening
  [[ -n "$legacy_web" ]] && docker tag "$legacy_web" zms-ads-web:pre-hardening
  CURRENT_TAG=pre-hardening
  warn "running images were pre-hardening ($legacy_api); tagged as :pre-hardening for rollback"
fi
[[ -n "$CURRENT_TAG" ]] || CURRENT_TAG="$RECORDED_CURRENT"
if [[ -n "$CURRENT_TAG" && "$CURRENT_TAG" != "$SHA" ]]; then
  state_write "$ENV_NAME.previous" "$CURRENT_TAG"
  log "previous tag recorded: $CURRENT_TAG"
elif [[ "$CURRENT_TAG" == "$SHA" ]]; then
  log "redeploying the tag that is already running ($SHA); previous stays '$(state_read "$ENV_NAME.previous")'"
else
  warn "nothing is running for $ENV_NAME yet; no rollback target"
fi

# --- build --------------------------------------------------------------------------
if [[ "${NO_BUILD:-0}" != 1 ]]; then
  log "building zms-ads-api:$SHA and zms-ads-web:$SHA"
  compose build --pull=false api web
fi
docker image inspect "zms-ads-api:$SHA" "zms-ads-web:$SHA" >/dev/null || die "images for $SHA not found"

# --- up -----------------------------------------------------------------------------
log "compose up (waiting for container health checks)"
UP_OK=1
API_ID_BEFORE="$(compose ps -q api 2>/dev/null || true)"
compose up -d --wait --wait-timeout 180 --remove-orphans --no-build || UP_OK=0
# The Next.js proxy keeps dialling the API container's OLD ip after the api
# container is recreated (seen 2026-09-25: every /api call from the web container
# failed with ECONNREFUSED while both containers were "healthy"). If api was
# recreated and web was not, bounce web so it re-resolves `api`.
API_ID_AFTER="$(compose ps -q api 2>/dev/null || true)"
if [[ "$UP_OK" == 1 && -n "$API_ID_BEFORE" && "$API_ID_BEFORE" != "$API_ID_AFTER" ]]; then
  log "api container was recreated — restarting web so its proxy re-resolves the api address"
  compose restart web || UP_OK=0
  compose up -d --wait --wait-timeout 120 --no-build web || UP_OK=0
fi

if [[ "$UP_OK" == 1 ]] && wait_healthy "${HEALTH_TIMEOUT:-120}"; then
  state_write "$ENV_NAME.current" "$SHA"
  mkdir -p "$DEPLOY_STATE_DIR"
  printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$SHA" "ok" >> "$DEPLOY_STATE_DIR/$ENV_NAME.history"
  compose ps
  log "deploy of $ENV_NAME @ $SHA succeeded"
  exit 0
fi

warn "deploy of $ENV_NAME @ $SHA FAILED — last container logs:"
compose ps >&2 || true
compose logs --no-color --tail 40 >&2 || true
mkdir -p "$DEPLOY_STATE_DIR"
printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$SHA" "failed" >> "$DEPLOY_STATE_DIR/$ENV_NAME.history"

PREV=$(state_read "$ENV_NAME.previous")
if [[ -n "$PREV" && "$PREV" != "$SHA" ]]; then
  warn "rolling back to $PREV"
  "$REPO_ROOT/scripts/rollback.sh" "$ENV_NAME" || warn "rollback also failed — stack needs manual attention"
else
  warn "no previous tag to roll back to"
fi
exit 1

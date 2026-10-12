#!/usr/bin/env bash
# Roll an environment back to the previously deployed image tag.
#
#   scripts/rollback.sh <production|staging> [tag]
#
# Uses <state>/<env>.previous (or the explicit tag) — the images zms-ads-api:<tag> and
# zms-ads-web:<tag> must still exist locally (deploy.sh never deletes them). Runs
# `compose up -d --wait --no-build` with IMAGE_TAG=<tag>, polls the health endpoints, and
# on success swaps <env>.current / <env>.previous. Compose files come from the current
# checkout; only the images change.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -ge 1 && $# -le 2 ]] || { sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 2; }
set_env "$1"
require_cmd docker curl
cd "$REPO_ROOT"

TARGET="${2:-$(state_read "$ENV_NAME.previous")}"
[[ -n "$TARGET" ]] || die "no rollback target: $DEPLOY_STATE_DIR/$ENV_NAME.previous is empty and no tag given"
CURRENT=$(state_read "$ENV_NAME.current")
[[ -f "$BACKEND_ENV_FILE" ]] || die "backend env file missing: $BACKEND_ENV_FILE"
[[ -f "$ROOT_ENV_FILE" ]]    || die "web env file missing: $ROOT_ENV_FILE"

docker image inspect "zms-ads-api:$TARGET" "zms-ads-web:$TARGET" >/dev/null 2>&1 \
  || die "images zms-ads-api:$TARGET / zms-ads-web:$TARGET not found locally"
[[ "$TARGET" == pre-hardening ]] && warn "rolling back to pre-hardening images (root, writable rootfs) under the hardened compose files — worker/beat may fail; see deploy.sh notes"

export IMAGE_TAG="$TARGET" GIT_SHA="$TARGET" BACKEND_ENV_FILE
log "rolling $ENV_NAME back to $TARGET (was: ${CURRENT:-unknown})"
compose up -d --wait --wait-timeout 180 --remove-orphans --no-build || warn "compose up --wait reported unhealthy containers"

if wait_healthy "${HEALTH_TIMEOUT:-120}"; then
  state_write "$ENV_NAME.current" "$TARGET"
  [[ -n "$CURRENT" && "$CURRENT" != "$TARGET" ]] && state_write "$ENV_NAME.previous" "$CURRENT"
  printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$TARGET" "rollback-ok" >> "$DEPLOY_STATE_DIR/$ENV_NAME.history"
  compose ps
  log "rollback of $ENV_NAME to $TARGET succeeded"
  exit 0
fi
printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$TARGET" "rollback-failed" >> "$DEPLOY_STATE_DIR/$ENV_NAME.history"
compose logs --no-color --tail 40 >&2 || true
die "rollback of $ENV_NAME to $TARGET did not become healthy"

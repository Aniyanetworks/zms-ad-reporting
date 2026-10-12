#!/usr/bin/env bash
# Shared helpers for scripts/*.sh — source, do not execute.
# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

# Where deploy state lives (<env>.current / <env>.previous / <env>.history).
# On the CI runner actions/checkout wipes untracked files, so point this outside the
# workspace (the workflows set ZMS_DEPLOY_STATE_DIR=$HOME/.zms-ads/deploy).
DEPLOY_STATE_DIR="${ZMS_DEPLOY_STATE_DIR:-$REPO_ROOT/.deploy}"
export DEPLOY_STATE_DIR

# Where env files live. Default: the checkout itself (backend/.env, .env, ...).
# On the runner: $HOME/.zms-ads/secrets/<env>/{backend.env,web.env}.
SECRETS_DIR="${ZMS_SECRETS_DIR:-}"

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
warn() { printf '[%s] WARN: %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die()  { printf '[%s] ERROR: %s\n' "$(date '+%H:%M:%S')" "$*" >&2; exit 1; }

require_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"; done
}

# Sets: ENV_NAME, WEB_PORT, API_PORT, REDIS_PORT, BACKEND_ENV_FILE, ROOT_ENV_FILE,
#       API_CONTAINER, WEB_CONTAINER, COMPOSE (array).
set_env() {
  ENV_NAME="$1"
  case "$ENV_NAME" in
    production)
      WEB_PORT=3010; API_PORT=8010; REDIS_PORT=6380
      API_CONTAINER=zms-ads-api; WEB_CONTAINER=zms-ads-web
      PROJECT_ARGS=()
      OVERLAY=compose.production.yml
      if [[ -n "$SECRETS_DIR" ]]; then
        BACKEND_ENV_FILE="$SECRETS_DIR/production/backend.env"
        ROOT_ENV_FILE="$SECRETS_DIR/production/web.env"
      else
        BACKEND_ENV_FILE="$REPO_ROOT/backend/.env"
        ROOT_ENV_FILE="$REPO_ROOT/.env"
      fi
      ;;
    staging)
      WEB_PORT=3011; API_PORT=8011; REDIS_PORT=6381
      API_CONTAINER=zms-ads-stg-api; WEB_CONTAINER=zms-ads-stg-web
      PROJECT_ARGS=(-p zms-ads-staging)
      OVERLAY=compose.staging.yml
      if [[ -n "$SECRETS_DIR" ]]; then
        BACKEND_ENV_FILE="$SECRETS_DIR/staging/backend.env"
        ROOT_ENV_FILE="$SECRETS_DIR/staging/web.env"
      else
        BACKEND_ENV_FILE="$REPO_ROOT/backend/.env.staging"
        ROOT_ENV_FILE="$REPO_ROOT/.env.staging"
        [[ -f "$ROOT_ENV_FILE" ]] || ROOT_ENV_FILE="$REPO_ROOT/.env"
      fi
      ;;
    *) die "unknown environment '$ENV_NAME' (expected production|staging)" ;;
  esac
  export ENV_NAME WEB_PORT API_PORT REDIS_PORT API_CONTAINER WEB_CONTAINER BACKEND_ENV_FILE ROOT_ENV_FILE
  COMPOSE=(docker compose ${PROJECT_ARGS[@]+"${PROJECT_ARGS[@]}"} --env-file "$ROOT_ENV_FILE"
           -f "$REPO_ROOT/docker-compose.yml" -f "$REPO_ROOT/$OVERLAY")
}

compose() { "${COMPOSE[@]}" "$@"; }

http_code() {  # http_code URL -> prints status code (000 on connection failure)
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || printf '000'
}

# wait_healthy TIMEOUT_SECONDS -> 0 when api (deep) and web are both 200 within timeout.
# HEALTH_ALLOW_DEGRADED=1 accepts a 503 from /api/health (e.g. a fresh staging DB with
# no sync history yet) as long as /api/health/live is 200.
wait_healthy() {
  local timeout="${1:-120}" deadline api_live api_deep web
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    api_live=$(http_code "http://127.0.0.1:${API_PORT}/api/health/live")
    api_deep=$(http_code "http://127.0.0.1:${API_PORT}/api/health")
    web=$(http_code "http://127.0.0.1:${WEB_PORT}/healthz")
    if [[ "$api_live" == 200 && "$web" == 200 ]]; then
      if [[ "$api_deep" == 200 ]]; then
        log "healthy: api/live=$api_live api/health=$api_deep web/healthz=$web"; return 0
      fi
      if [[ "${HEALTH_ALLOW_DEGRADED:-0}" == 1 && "$api_deep" == 503 ]]; then
        warn "api/health=503 (db/redis unreachable) accepted because HEALTH_ALLOW_DEGRADED=1 — debugging only"
        curl -s --max-time 5 "http://127.0.0.1:${API_PORT}/api/health" >&2 || true; echo >&2
        return 0
      fi
    fi
    if (( $(date +%s) >= deadline )); then
      warn "health gate failed after ${timeout}s: api/live=$api_live api/health=$api_deep web/healthz=$web"
      curl -s --max-time 5 "http://127.0.0.1:${API_PORT}/api/health" >&2 || true; echo >&2
      return 1
    fi
    sleep 3
  done
}

# Image tag currently running for the env's api container ("" if not running).
running_tag() {
  local img
  img=$(docker inspect --format '{{.Config.Image}}' "$API_CONTAINER" 2>/dev/null || true)
  case "$img" in
    zms-ads-api:*) printf '%s' "${img#zms-ads-api:}" ;;
    "") printf '' ;;
    *) printf 'legacy:%s' "$img" ;;   # pre-hardening image name (zms-ad-reporting-api:latest)
  esac
}

state_read()  { cat "$DEPLOY_STATE_DIR/$1" 2>/dev/null || true; }
state_write() { mkdir -p "$DEPLOY_STATE_DIR"; printf '%s\n' "$2" > "$DEPLOY_STATE_DIR/$1"; }

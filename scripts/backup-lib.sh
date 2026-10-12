#!/usr/bin/env bash
# Shared pieces for backup-db.sh / verify-backup.sh / backup-config.sh — source only.
# shellcheck shell=bash
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Optional settings file (0600): AGE_RECIPIENT, AGE_IDENTITY, BACKUP_DIR, BACKUP_REMOTE, PG_IMAGE
BACKUP_CONF="${BACKUP_CONF:-$HOME/.config/zms/backup.env}"
if [[ -f "$BACKUP_CONF" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$BACKUP_CONF"; set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/zms-ads}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"        # rclone remote, e.g. b2:zms-ads-backups
AGE_RECIPIENT="${AGE_RECIPIENT:-}"        # age1... public key
AGE_IDENTITY="${AGE_IDENTITY:-}"          # path to the private key file (verify-backup.sh only)
RETENTION_DAYS="${RETENTION_DAYS:-30}"
# Supabase runs PostgreSQL 17 on projects created since 2025; pg_dump must be >= the
# server's major version, and the 17 client dumps 15/16/17 servers fine.
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
TOOLS_IMAGE="${TOOLS_IMAGE:-zms-ads-tools:latest}"
export BACKUP_DIR BACKUP_REMOTE AGE_RECIPIENT AGE_IDENTITY RETENTION_DAYS PG_IMAGE TOOLS_IMAGE

build_tools_image() {
  docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1 && return 0
  log "building helper image $TOOLS_IMAGE (age, rclone, pg client)"
  docker build -q -t "$TOOLS_IMAGE" "$REPO_ROOT/infra/tools" >/dev/null
}

# Read one KEY=value from an env file without exporting the whole file. Strips quotes.
env_value() {  # env_value FILE KEY
  local line
  line=$(grep -E "^${2}=" "$1" | tail -n 1 || true)
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

# age_encrypt SRC DST — encrypts SRC to DST with AGE_RECIPIENT (host age if present, else the
# tools container). Removes SRC on success.
age_encrypt() {
  local src="$1" dst="$2"
  if command -v age >/dev/null 2>&1; then
    age -r "$AGE_RECIPIENT" -o "$dst" "$src"
  else
    build_tools_image
    docker run --rm -i "$TOOLS_IMAGE" age -r "$AGE_RECIPIENT" < "$src" > "$dst"
  fi
  chmod 600 "$dst"
  rm -f "$src"
}

# age_decrypt SRC DST — needs AGE_IDENTITY (a file). Never prints the key.
age_decrypt() {
  local src="$1" dst="$2"
  [[ -n "$AGE_IDENTITY" && -f "$AGE_IDENTITY" ]] || die "AGE_IDENTITY (private key file) is required to decrypt $src"
  if command -v age >/dev/null 2>&1; then
    age -d -i "$AGE_IDENTITY" -o "$dst" "$src"
  else
    build_tools_image
    docker run --rm -i -v "$AGE_IDENTITY:/key.txt:ro" "$TOOLS_IMAGE" age -d -i /key.txt < "$src" > "$dst"
  fi
  chmod 600 "$dst"
}

# upload_dir LOCAL_DIR REMOTE_SUBDIR — rclone copy when BACKUP_REMOTE is set.
upload_dir() {
  local src="$1" sub="$2"
  [[ -n "$BACKUP_REMOTE" ]] || { log "BACKUP_REMOTE unset — skipping off-site upload"; return 0; }
  if command -v rclone >/dev/null 2>&1; then
    rclone copy --min-age 0 "$src" "$BACKUP_REMOTE/$sub"
  else
    build_tools_image
    local conf="${RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}"
    [[ -f "$conf" ]] || die "rclone config not found at $conf (set RCLONE_CONFIG)"
    docker run --rm -v "$conf:/rclone.conf:ro" -v "$src:/src:ro" "$TOOLS_IMAGE" \
      rclone --config /rclone.conf copy /src "$BACKUP_REMOTE/$sub"
  fi
  log "uploaded $src -> $BACKUP_REMOTE/$sub"
}

prune_old() {  # prune_old DIR GLOB
  find "$1" -type f -name "$2" -mtime "+$RETENTION_DAYS" -print -delete 2>/dev/null | sed 's/^/pruned: /' >&2 || true
}

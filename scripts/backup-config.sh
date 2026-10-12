#!/usr/bin/env bash
# Weekly encrypted bundle of everything needed to rebuild the Mac mini host config:
# env files, compose files, Cloudflare tunnel credentials, launchd plists.
#
#   scripts/backup-config.sh
#
# Output: ${BACKUP_DIR:-~/Backups/zms-ads}/config/zms-ads-config-<stamp>.tar.gz.age
# The bundle is pure secrets, so AGE_RECIPIENT is REQUIRED (set ALLOW_PLAINTEXT=1 to
# override for a one-off local copy). Same retention/upload logic as backup-db.sh.
# Scheduled by infra/launchd/com.zms.backup-config.plist (Sundays 04:00).
set -euo pipefail
# shellcheck source=backup-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/backup-lib.sh"

if [[ -z "$AGE_RECIPIENT" && "${ALLOW_PLAINTEXT:-0}" != 1 ]]; then
  die "AGE_RECIPIENT is not set ($BACKUP_CONF) — refusing to write an unencrypted secrets bundle (ALLOW_PLAINTEXT=1 to override)"
fi

OUT_DIR="$BACKUP_DIR/config"
mkdir -p "$OUT_DIR"; chmod 700 "$BACKUP_DIR" "$OUT_DIR"
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
TAR="$OUT_DIR/zms-ads-config-${STAMP}.tar.gz"

CANDIDATES=(
  "$REPO_ROOT/.env"
  "$REPO_ROOT/.env.staging"
  "$REPO_ROOT/backend/.env"
  "$REPO_ROOT/backend/.env.staging"
  "$REPO_ROOT/backend/.dlt/secrets.toml"
  "$REPO_ROOT/docker-compose.yml"
  "$REPO_ROOT/compose.production.yml"
  "$REPO_ROOT/compose.staging.yml"
  "$HOME/.cloudflared"
  "$HOME/.config/zms"
  "$HOME/.zms-ads/secrets"
  "/Library/LaunchDaemons/com.cloudflare.cloudflared.plist"
)
# frontend/.env* and LaunchAgents by glob
for f in "$REPO_ROOT"/frontend/.env*; do [[ -e "$f" ]] && CANDIDATES+=("$f"); done
for f in "$HOME"/Library/LaunchAgents/com.zms.*.plist; do [[ -e "$f" ]] && CANDIDATES+=("$f"); done

FILES=()
for f in "${CANDIDATES[@]}"; do
  if [[ -r "$f" ]]; then FILES+=("$f"); else log "skip (missing/unreadable): $f"; fi
done
[[ ${#FILES[@]} -gt 0 ]] || die "nothing to back up"

log "bundling ${#FILES[@]} paths"
# -P keeps absolute paths (restore with: tar -xzP -f bundle.tar.gz — check contents first!)
umask 077
tar -czPf "$TAR" "${FILES[@]}"
chmod 600 "$TAR"

if [[ -n "$AGE_RECIPIENT" ]]; then
  age_encrypt "$TAR" "$TAR.age"; FINAL="$TAR.age"
else
  warn "ALLOW_PLAINTEXT=1: bundle left unencrypted at $TAR"; FINAL="$TAR"
fi
log "config backup written: $FINAL"

prune_old "$OUT_DIR" 'zms-ads-config-*'
upload_dir "$OUT_DIR" config
log "done"

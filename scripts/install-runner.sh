#!/usr/bin/env bash
# Install the GitHub Actions self-hosted runner for zmsseoagency/zms-ad-reporting on the
# Mac mini, as the dedicated standard (non-admin) macOS user `deploy`.
#
# One-time prerequisites (done by an admin, NOT by this script):
#   1. Create the standard macOS user `deploy` (System Settings > Users & Groups).
#   2. Docker Desktop (runs under the admin user `zms`) must accept connections from
#      `deploy`: Settings > Advanced > "Allow the default Docker socket to be used
#      (requires password)". Today /var/run/docker.sock -> /Users/zms/.docker/run/docker.sock
#      is mode 0755 owned by zms, so `deploy` cannot use it until that is done. Verify
#      with `docker info` as deploy before running this.
#   3. Secrets for the runner's deploys live OUTSIDE the workspace (actions/checkout wipes
#      untracked files): as deploy, create
#        ~/.zms-ads/secrets/production/backend.env   (copy of backend/.env)
#        ~/.zms-ads/secrets/production/web.env       (copy of root .env: NEXT_PUBLIC_*)
#        ~/.zms-ads/secrets/staging/backend.env      (staging Supabase project, no prod tokens)
#        ~/.zms-ads/secrets/staging/web.env
#      chmod 700 ~/.zms-ads -R. Deploy state goes to ~/.zms-ads/deploy/.
#   4. A registration token, minted by a repo admin (valid 1 hour):
#        gh api -X POST repos/zmsseoagency/zms-ad-reporting/actions/runners/registration-token --jq .token
#
# Then, logged in as `deploy` (Fast User Switching or `su - deploy`):
#   RUNNER_TOKEN=<token> bash /Users/zms/zms-ad-reporting/scripts/install-runner.sh
#
# The runner is registered to THIS ONE REPO with labels `self-hosted,macmini`, name
# `macmini-deploy`, and installed as a per-user launchd agent (./svc.sh install). A user
# LaunchAgent only runs while `deploy` has a login session; keep `deploy` logged in
# (fast-user-switched to the background) or convert the generated plist to a LaunchDaemon.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zmsseoagency/zms-ad-reporting}"
RUNNER_NAME="${RUNNER_NAME:-macmini-deploy}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,macmini}"
RUNNER_USER="${RUNNER_USER:-deploy}"
RUNNER_HOME="${RUNNER_HOME:-$HOME/actions-runner}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*" >&2; }

# --- guards ---------------------------------------------------------------------------
[[ "$(id -u)" -ne 0 ]] || die "do not run as root — run as the '$RUNNER_USER' user"
[[ "$(id -un)" == "$RUNNER_USER" ]] || die "run this as the '$RUNNER_USER' user (current: $(id -un)); override with RUNNER_USER=... only if you know why"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || die "expected macOS on Apple silicon"
[[ -n "${RUNNER_TOKEN:-}" ]] || die "RUNNER_TOKEN is required (gh api -X POST repos/zmsseoagency/zms-ad-reporting/actions/runners/registration-token --jq .token)"
command -v docker >/dev/null 2>&1 || die "docker CLI not on PATH for $RUNNER_USER (Docker Desktop installs /usr/local/bin/docker)"
docker info >/dev/null 2>&1 || die "docker info failed as $RUNNER_USER — enable Docker Desktop > Settings > Advanced > 'Allow the default Docker socket to be used'"
for d in production staging; do
  [[ -f "$HOME/.zms-ads/secrets/$d/backend.env" && -f "$HOME/.zms-ads/secrets/$d/web.env" ]] \
    || printf 'WARN: %s\n' "\$HOME/.zms-ads/secrets/$d/{backend.env,web.env} missing — deploys to $d will fail until created" >&2
done
mkdir -p "$HOME/.zms-ads/deploy"; chmod 700 "$HOME/.zms-ads"

# --- download the latest arm64 runner and verify its checksum -------------------------
log "resolving latest runner release"
RELEASE_JSON=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)
VERSION=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1)
[[ -n "$VERSION" ]] || die "could not determine runner version"
ASSET="actions-runner-osx-arm64-${VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${VERSION}/${ASSET}"
# The release notes embed the checksum as <!-- BEGIN SHA osx-arm64 -->...<!-- END SHA osx-arm64 -->
EXPECTED_SHA=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*BEGIN SHA osx-arm64 -->\([0-9a-f]\{64\}\)<!-- END SHA osx-arm64.*/\1/p' | head -n 1)

mkdir -p "$RUNNER_HOME"; cd "$RUNNER_HOME"
if [[ -x ./config.sh && -f .runner ]]; then
  die "$RUNNER_HOME already holds a configured runner; run ./config.sh remove --token <token> first"
fi
log "downloading $ASSET"
curl -fsSL -o "$ASSET" "$URL"
if [[ -n "$EXPECTED_SHA" ]]; then
  ACTUAL_SHA=$(shasum -a 256 "$ASSET" | cut -d' ' -f1)
  [[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || die "checksum mismatch for $ASSET (expected $EXPECTED_SHA, got $ACTUAL_SHA)"
  log "checksum OK"
else
  printf 'WARN: could not find a published checksum for %s; continuing unverified\n' "$ASSET" >&2
fi
tar xzf "$ASSET" && rm -f "$ASSET"

# --- register + install as a launchd service ------------------------------------------
log "registering runner '$RUNNER_NAME' (labels: $RUNNER_LABELS) with $REPO_URL"
./config.sh --url "$REPO_URL" --token "$RUNNER_TOKEN" --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" --work _work --unattended --replace --disableupdate
unset RUNNER_TOKEN

# Docker Desktop CLI location + the runner's env (deploy.sh reads these).
cat > .env <<ENV
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin
ZMS_DEPLOY_STATE_DIR=$HOME/.zms-ads/deploy
ZMS_SECRETS_DIR=$HOME/.zms-ads/secrets
ENV
chmod 600 .env

log "installing launchd agent"
./svc.sh install
./svc.sh start
./svc.sh status || true
log "done — the runner should appear online at $REPO_URL/settings/actions/runners"

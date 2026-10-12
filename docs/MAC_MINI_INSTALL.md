# Mac mini install (fresh machine to running production)

Target: Apple-silicon Mac mini (today: M4, macOS 26.2), Docker Desktop 29 / Compose v5,
admin user `zms` (owns the checkout and runs the stack), standard user `deploy` (runs the
GitHub Actions runner). Companion docs: `STARTUP_RECOVERY.md` (why these settings),
`CLOUDFLARE_TUNNEL.md`, `DOCKER.md`, `BACKUP_RESTORE.md`, `SECURITY_CHECKLIST.md`.

Order matters: secrets and the tunnel before the first deploy; the `deploy` user after
production works by hand.

## 1. macOS settings (as `zms`, admin)

| Setting | Value | Why |
|---|---|---|
| Users & Groups -> Login Options | Automatic login: `zms` | Docker Desktop is a user app; nothing starts before login. Requires FileVault OFF (trade-off in `STARTUP_RECOVERY.md`) |
| Energy | never sleep, start up after power failure, wake for network | `sudo pmset -a sleep 0 autorestart 1 womp 1 displaysleep 10` |
| General -> Software Update -> (i) | "Install macOS updates" **off**; keep "Install Security Responses and system files" | unattended reboots would take the stack down; the owner schedules updates (plan 3.8, TODO (Carl)) |
| General -> Sharing | Remote Login **off** after Tailscale SSH works (section 10) | no sshd on the LAN |
| Lock Screen | require password after screen saver | the box auto-logs in; lock the screen, not the boot |
| Homebrew | `xcode-select --install`, then install Homebrew | needed for `cloudflared`, `age`, `rclone`, `tailscale` |

```bash
sudo pmset -a sleep 0 autorestart 1 womp 1 displaysleep 10
```

Keep the `com.zms.caffeinate` LaunchAgent (`caffeinate -dimsu`) if the machine has it; it is
belt and braces. Do not enable FileVault.

## 2. Docker Desktop

1. Install Docker Desktop for Apple silicon, sign in is not required.
2. Settings -> General: **Start Docker Desktop when you sign in** on.
3. Settings -> Advanced: **Allow the default Docker socket to be used (requires password)**
   on. This creates `/var/run/docker.sock` so the `deploy` user can run `docker` later.
4. Settings -> Resources: at least 4 CPUs / 6 GB; the worker's `/tmp` tmpfs is 2 GB.

```bash
docker info --format '{{.ServerVersion}} {{.OperatingSystem}}' && docker compose version
```

## 3. Clone the repo

```bash
git clone git@github.com:zmsseoagency/zms-ad-reporting.git ~/zms-ad-reporting
```

```bash
cd ~/zms-ad-reporting && git checkout main
```

The production compose project name is the directory name `zms-ad-reporting`, so the path
`~/zms-ad-reporting` matters (see `DOCKER.md`).

## 4. Secrets placement

Values come from the encrypted config bundle (`BACKUP_RESTORE.md`) or from the owner's
password manager. Names and owners: `CREDENTIALS_CHECKLIST.md`. Never from chat.

| File (mode 600) | Contents | Used by |
|---|---|---|
| `~/zms-ad-reporting/backend/.env` | production backend secrets (`backend/.env.example` is the template); `ENVIRONMENT=production`, `DASHBOARD_URL=https://adbuildout.contractorscalingblueprint.com` | api, worker, beat via `env_file`; `scripts/backup-db.sh`; `supabase-migrate.sh production` |
| `~/zms-ad-reporting/.env` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `LEADERBOARD_HOST` | compose interpolation + web build args |
| `~/zms-ad-reporting/backend/.env.staging`, `~/zms-ad-reporting/.env.staging` | same for staging (staging Supabase project, no production tokens) | staging deploys by hand |
| `~/.config/zms/cloudflare.env` | `CF_API_TOKEN`, `CF_ACCOUNT_ID` | `scripts/cloud/cloudflare-*.py` |
| `~/.config/zms/backup.env` | `AGE_RECIPIENT`, `BACKUP_DIR`, `BACKUP_REMOTE`, optionally `AGE_IDENTITY` | backup scripts |
| `~/.config/zms/supabase-staging.env` | staging ref, keys, DB password | source for `.env.staging` files |
| `/Users/deploy/.zms-ads/secrets/<env>/backend.env` and `web.env` | copies of the four env files above, for the runner | `scripts/lib.sh` when `ZMS_SECRETS_DIR` is set (section 8) |

```bash
cd ~/zms-ad-reporting && cp backend/.env.example backend/.env && cp .env.example .env && chmod 600 backend/.env .env
```

```bash
mkdir -p ~/.config/zms && chmod 700 ~/.config/zms
```

`frontend/.env*` files are for `npm run dev` only; production reads the root `.env`.

## 5. cloudflared + LaunchDaemon

Full detail in `CLOUDFLARE_TUNNEL.md`. Short form: the tunnel `zms-seo-dashboard`
(`b9929fe5-4b97-4708-acdb-734c224430e5`) is remote-managed and shared with the SEO dashboard.

```bash
brew install cloudflared
```

Restore `~/.cloudflared/<TUNNEL_ID>.json` and `~/.cloudflared/config.yml` from the config
bundle (only `tunnel:` and `credentials-file:` in it matter), then install the daemon:

```bash
sudo cloudflared --config /Users/zms/.cloudflared/config.yml service install
```

```bash
sudo launchctl print system/com.cloudflare.cloudflared | grep -E 'state|pid'
```

Ingress rules live in Cloudflare: `adbuildout.`, `ads.`, `setter.` -> `localhost:3010`,
`staging-adbuildout.` -> `localhost:3011`. Add missing ones with
`python3 scripts/cloud/cloudflare-hostnames.py --apply` (`DNS_CHECKLIST.md`).

## 6. First deploy (as `zms`)

Migrations first, always (`SUPABASE.md`), then the deploy script, which builds the images,
starts the production project and gates on health.

```bash
cd ~/zms-ad-reporting && scripts/cloud/supabase-migrate.sh production --dry-run
```

```bash
cd ~/zms-ad-reporting && scripts/deploy.sh production $(git rev-parse HEAD)
```

`deploy.sh` refuses a dirty tree (`ALLOW_DIRTY=1` to override) and a checkout that is not at
the requested sha. State goes to `~/zms-ad-reporting/.deploy/production.{current,previous,history}`.
Details and the first hardened-deploy caveats: `DEPLOY_PRODUCTION.md`.

## 7. Verify

```bash
cd ~/zms-ad-reporting && scripts/health.sh production
```

Then from a phone hotspot (outside the LAN), the checklist in `DNS_CHECKLIST.md`
"Verification from outside the LAN". Nothing is "live" until that list passes.

## 8. `deploy` user and the GitHub Actions runner

The runner lets `deploy-staging.yml` / `deploy-production.yml` run on this machine. It is a
**standard** (non-admin) user with no sudo.

1. System Settings -> Users & Groups -> Add User: Standard, name `deploy`, strong password
   in the password manager.
2. Log in as `deploy` once (Fast User Switching). Confirm Docker works for that user:

```bash
docker info >/dev/null && echo docker OK
```

   If it fails, revisit Docker Desktop -> Advanced -> "Allow the default Docker socket to be
   used" as `zms`.
3. As `deploy`, create the secrets layout `scripts/lib.sh` expects
   (`ZMS_SECRETS_DIR=$HOME/.zms-ads/secrets`):

```bash
mkdir -p ~/.zms-ads/secrets/production ~/.zms-ads/secrets/staging ~/.zms-ads/deploy && chmod -R 700 ~/.zms-ads
```

| Runner path | Copy of |
|---|---|
| `~/.zms-ads/secrets/production/backend.env` | `/Users/zms/zms-ad-reporting/backend/.env` |
| `~/.zms-ads/secrets/production/web.env` | `/Users/zms/zms-ad-reporting/.env` |
| `~/.zms-ads/secrets/staging/backend.env` | `/Users/zms/zms-ad-reporting/backend/.env.staging` |
| `~/.zms-ads/secrets/staging/web.env` | `/Users/zms/zms-ad-reporting/.env.staging` |

   Copy them as `zms` with `sudo install -m 600 -o deploy` (the `deploy` user cannot read
   `/Users/zms`). Deploy state for runner deploys lives in `~deploy/.zms-ads/deploy/`, separate
   from `zms`'s `.deploy/` (see `DEPLOY_STAGING.md`).
4. Mint a registration token as a repo admin (valid one hour):

```bash
gh api -X POST repos/zmsseoagency/zms-ad-reporting/actions/runners/registration-token --jq .token
```

5. As `deploy`, install the runner (downloads the latest arm64 release, verifies its
   checksum, registers name `macmini-deploy`, labels `self-hosted,macmini`, installs a
   per-user launchd service, writes `~/actions-runner/.env` with `PATH`,
   `ZMS_DEPLOY_STATE_DIR`, `ZMS_SECRETS_DIR`):

```bash
RUNNER_TOKEN=<token> bash /Users/zms/zms-ad-reporting/scripts/install-runner.sh
```

6. Check https://github.com/zmsseoagency/zms-ad-reporting/settings/actions/runners shows
   `macmini-deploy` Idle. The runner is a **user** LaunchAgent: it runs only while `deploy`
   has a login session. Leave `deploy` logged in in the background (fast-user-switch back to
   `zms`), or convert `~/actions-runner/.service` plist to a LaunchDaemon (TODO (deploy)).
7. Set the production allow-list variable (GitHub logins, comma-separated):

```bash
gh variable set PRODUCTION_DEPLOYERS -R zmsseoagency/zms-ad-reporting --body "<carl-github-login>"
```

## 9. launchd backup jobs (as `zms`)

Templates in `infra/launchd/` run the scripts from `/Users/zms/zms-ad-reporting`; edit the
paths if the home differs. Settings come from `~/.config/zms/backup.env` (`BACKUP_RESTORE.md`).

| Plist | Script | When (local time) |
|---|---|---|
| `com.zms.backup-db.plist` | `scripts/backup-db.sh` | daily 03:15 |
| `com.zms.backup-config.plist` | `scripts/backup-config.sh` | Sundays 04:00 |
| `com.zms.verify-backup.plist` | `scripts/verify-backup.sh` | Sundays 04:30 |

```bash
mkdir -p ~/Library/Logs/zms-ads && cp ~/zms-ad-reporting/infra/launchd/com.zms.*.plist ~/Library/LaunchAgents/
```

```bash
for j in backup-db backup-config verify-backup; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zms.$j.plist; done
```

Run one immediately and read its log:

```bash
launchctl kickstart -k gui/$(id -u)/com.zms.backup-db && tail -n 20 ~/Library/Logs/zms-ads/backup-db.log
```

To remove: `launchctl bootout gui/$(id -u)/com.zms.backup-db`.

## 10. Tailscale SSH for admin access (plan item 3.9, TODO (Carl))

```bash
brew install --cask tailscale
```

Open Tailscale, log in with Carl's identity, then:

```bash
tailscale set --ssh
```

From another device on the tailnet: `ssh zms@<mac-mini-tailscale-name>`. Once that works,
System Settings -> General -> Sharing -> **Remote Login off**. Tailscale is outbound-only;
no router port is opened. Consider a tailnet ACL that limits SSH to Carl's devices.

## 11. UPS (plan item 3.11, TODO (Carl))

APC Back-UPS Pro 1000VA (BR1000MS) or CyberPower CP1000PFCLCD, pure sine wave, USB data
cable to the Mac. Put the **modem and router on the same UPS**. System Settings -> Energy ->
UPS: shut down after ~10 minutes on battery. Rationale and runtime estimate in
`STARTUP_RECOVERY.md`.

## 12. Done checklist

- [ ] `scripts/health.sh production` prints `OVERALL: healthy`
- [ ] Outside-LAN checklist in `DNS_CHECKLIST.md` passed
- [ ] Runner `macmini-deploy` Idle; `PRODUCTION_DEPLOYERS` set
- [ ] Three `com.zms.*` jobs loaded (`launchctl list | grep com.zms`)
- [ ] First `backup-db.log` shows `backup written`; `verify-backup.log` shows `verify OK`
- [ ] Tailscale SSH works, Remote Login off
- [ ] Software Update auto-install off
- [ ] SEO dashboard hostnames still answer (shared tunnel)

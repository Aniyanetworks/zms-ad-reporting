# Startup and recovery (Mac mini)

How the Mac mini is set up so the dashboard comes back on its own, what happens in each failure
mode, and how the owner checks health. Facts verified on the host 2026-09-16.

## Machine configuration

| Setting | Value | Why |
|---|---|---|
| Hardware / OS | Mac mini M4, 16 GB, macOS 26.2 | |
| Power (`pmset -g`) | `sleep 0`, `autorestart 1`, `womp 1` | never sleeps; restarts after power loss; wake on LAN |
| LaunchAgent `com.zms.caffeinate` | `caffeinate -dimsu`, KeepAlive | belt and braces against display/idle/system sleep |
| Auto-login | user `zms` | Docker Desktop is a user app; it starts only after login |
| Docker Desktop 29 | AutoStart on | containers start when the desktop app starts |
| FileVault | **OFF** | see trade-off below |
| LaunchDaemon `com.cloudflare.cloudflared` | RunAtLoad + KeepAlive, runs as root, `--config /Users/zms/.cloudflared/config.yml` | tunnel is up before anyone logs in |
| Software Update | "Automatically install macOS updates" **ON** | TODO (Carl): turn OFF (plan item 3.8); keep security responses on |
| Tailscale | installed, logged out | TODO (Carl): plan item 3.9 for private admin access |
| Remote Login (sshd) | on locally; router unknown | TODO (Carl): turn off after Tailscale SSH works |
| UPS | none | see below |

### FileVault trade-off (read this)

FileVault is off on purpose. With FileVault on, a reboot stops at the pre-boot password screen
and nothing (Docker, the dashboard, the SEO dashboard) starts until someone types the password at
the keyboard. With it off, the Mac boots, auto-logs in `zms`, Docker starts, containers start,
the tunnel reconnects, all unattended.

The cost: the disk is unencrypted. Anyone who takes the Mac mini can read `backend/.env` (Meta
system-user token, Google refresh token, Supabase service key) and `~/.cloudflared`. Mitigations:
keep the machine in a locked space; if it is lost, rotate every credential in
`CREDENTIALS_CHECKLIST.md` the same day and revoke the tunnel in Cloudflare. Revisit if a person
is always available to type the password, or if the box moves to a shared space.

## What restarts what

| Layer | Mechanism | After reboot | After crash |
|---|---|---|---|
| Tunnel | LaunchDaemon KeepAlive | yes, before login | relaunched by launchd |
| Docker engine | Docker Desktop AutoStart + auto-login | yes, ~30 to 60 s after login | Docker Desktop restarts itself; if not, `open -a Docker` |
| Containers | `restart: unless-stopped` on every service (`docker-compose.yml`) | yes, when the engine is up | yes; a failing `healthcheck:` marks the container unhealthy (compose does not auto-restart on unhealthy alone) |
| Start order | `depends_on` with `condition: service_healthy`: redis -> api -> web; worker/beat wait for redis | | |
| Celery beat schedule | stored on tmpfs, rebuilt from `celery_app.beat_schedule` at start | yes | yes |

Containers stopped on purpose (`docker compose stop`) stay stopped across reboots. After
maintenance always finish with `up -d`.

## Failure modes

### Internet outage at the house

- Cloudflare returns 530 / 1033 to visitors while the tunnel is disconnected.
- `cloudflared` reconnects on its own when the connection returns; nothing to do.
- Containers keep running. Celery/beat are unaffected; a nightly sync that fires during the
  outage fails against Meta/Google/GHL, is logged in `sync_runs` with `status='error'`, and
  `/api/health` reports `degraded` until the next success.
- Recovery: wait for the next scheduled run (Meta gets a second pass at 06:00 PT), or sign in as
  the owner -> Settings -> Sync status -> **Sync meta / google / ghl**. Per-client backfills of up
  to 365 days are possible through `POST /api/sync/trigger` with `client_slug` and `days`.

### Power outage

- Everything stops. When power returns: `autorestart 1` powers the Mac on, auto-login starts
  Docker, containers restart, the tunnel reconnects. Typical time to healthy: 2 to 4 minutes after
  power returns, provided the modem and router are also back.
- Redis data (broker queue only) may be lost; nothing of value lives there. All data is in
  Supabase.
- Recommendation: a UPS with a USB data cable so macOS shuts down cleanly and the Mac is not
  hard-powered-off. **APC Back-UPS Pro 1000VA (BR1000MS)** or **CyberPower CP1000PFCLCD**, both
  pure sine wave. Put the **modem and router on the same UPS**, otherwise the Mac stays up with no
  internet and the tunnel is down anyway. Expected load ~30 W, roughly 60 to 90 minutes of
  runtime. Configure: System Settings -> Energy -> UPS -> shut down after N minutes on battery.
  TODO (Carl).

### macOS update or dialog needing a person

- An automatic macOS update reboots the machine; the stack comes back on its own only if no
  dialog blocks login. Firmware or security updates sometimes need a click.
- TODO (Carl): System Settings -> General -> Software Update -> (i) -> turn off "Install macOS
  updates"; keep "Install Security Responses and system files". Do updates on a schedule
  (for example first Sunday of the month, morning PT, before the 01:00 syncs are due next), then
  run the health checks below. `brew upgrade cloudflared` on the same schedule (see
  `CLOUDFLARE_TUNNEL.md`).

### Mac mini hardware failure

- The dashboard, worker and tunnel are down until the machine is replaced. Data is safe in
  Supabase. Restore path: new Mac -> Docker Desktop -> clone the private repo -> restore
  `backend/.env`, root `.env`, `~/.cloudflared` from the encrypted off-site bundle
  (`BACKUP_RESTORE.md`, TODO (deploy)) -> `docker compose up -d --wait`. The tunnel credentials
  file makes the new machine take over the same hostnames.

## Availability warning

**The application is unavailable during:** a home power outage (until power returns, even with
auto-restart), an internet outage at the house, a Mac mini hardware failure, or a macOS update
or dialog that needs someone at the keyboard. There is no second machine and no failover. Data
in Supabase is unaffected; only the UI, the API and the nightly syncs stop. Anyone relying on the
dashboard should know this.

## Owner health check (2 minutes)

Open three URLs:

| URL | Healthy looks like |
|---|---|
| https://adbuildout.contractorscalingblueprint.com/healthz | `{"status":"ok","service":"web","version":"<sha>"}` |
| https://adbuildout.contractorscalingblueprint.com/api/health | HTTP 200, `"status":"ok"`, every `checks.syncs.<source>.ok` true. `degraded` = db+redis fine but a sync is older than 26 h. HTTP 503 = db or redis down |
| https://adbuildout.contractorscalingblueprint.com/ | login page or dashboard, no Cloudflare error page |

On the Mac mini:

```bash
cd ~/zms-ad-reporting
docker compose -f docker-compose.yml -f compose.production.yml ps    # every service "running (healthy)"
scripts/health.sh production                                          # TODO (deploy): prints the same in one line
sudo launchctl print system/com.cloudflare.cloudflared | grep -E 'state|pid'
docker compose -f docker-compose.yml -f compose.production.yml logs --since 30m api celery-worker | tail -50
```

Also check the separate SEO dashboard still answers; it shares the machine and tunnel.

## Rollback

If a deploy made things worse, follow `ROLLBACK.md` (`scripts/rollback.sh production`, restores
the previous image tag recorded by `scripts/deploy.sh`). TODO (deploy) for both files.

## Alerts

Nothing on the Mac mini can alert you that the Mac mini is down. Use an external monitor:

- **UptimeRobot** (free): HTTP(s) monitor on `https://adbuildout.contractorscalingblueprint.com/api/health`
  every 5 minutes, keyword `"status":"ok"` optional; alert to email and to a Slack webhook.
- **Healthchecks.io** (free): a ping URL that the nightly sync calls on success; alerts if the
  01:00 PT run is missed. TODO (deploy): add the ping call to `slack_health_alerts` or the sync tasks.
- Slack: set `SLACK_WEBHOOK_URL` in `backend/.env` to enable the existing 07:05 PT daily health
  alert and `/notify`. Blank today by choice.

TODO (Carl): choose the alert channel (email only, or email + Slack) and create the monitors.

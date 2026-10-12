# Health monitoring

The three URLs, the one command, what healthy looks like, and what to do when it is not.
Endpoint code: `backend/app/routers/health.py`, `frontend/src/app/healthz/route.ts`.
Machine-level failure modes: `STARTUP_RECOVERY.md`.

## The three URLs

| URL | Healthy |
|---|---|
| https://adbuildout.contractorscalingblueprint.com/healthz | 200, `{"status":"ok","service":"web","version":"<sha>"}` |
| https://adbuildout.contractorscalingblueprint.com/api/health | 200, `"status":"ok"` (see shapes below) |
| https://adbuildout.contractorscalingblueprint.com/ | login page or dashboard, no Cloudflare error page |

Staging: same paths on `staging-adbuildout.contractorscalingblueprint.com` after the
Cloudflare Access PIN.

## `/api/health` response shapes

`/api/health/live` is the process probe (no I/O): always `{"status":"ok"}` while uvicorn runs.
Containers and `deploy.sh` use it for liveness.

`/api/health` runs three checks in parallel with 3 s timeouts and returns:

```json
{
  "status": "ok",
  "service": "api",
  "environment": "production",
  "version": "<git sha>",
  "checked_at": "2026-09-16T14:02:11+00:00",
  "checks": {
    "db":    {"ok": true},
    "redis": {"ok": true},
    "syncs": {
      "meta":   {"ok": true, "last_success": "2026-09-16T08:03:10+00:00"},
      "google": {"ok": true, "last_success": "..."},
      "ghl":    {"ok": true, "last_success": "..."}
    }
  }
}
```

| `status` | HTTP | Meaning | Rule |
|---|---|---|---|
| `ok` | 200 | Postgres and Redis answer; every source has a `sync_runs` success within `HEALTH_SYNC_STALE_HOURS` (26) | all green |
| `degraded` | 200 | Postgres and Redis fine; at least one of `meta`, `google`, `ghl` has no success in 26 h (`ok:false`, `last_success` may be `null`) | investigate the sync; the app works |
| `unhealthy` | 503 | `db.ok` or `redis.ok` is false; the failing check carries `"error": "<ExceptionName>"` | page someone |

`Cache-Control: no-store` on both. Only db/redis decide the HTTP code, so an external monitor
on the status code catches outages without paging for a late sync; add a keyword check on
`"status":"ok"` if you want to be told about stale syncs too.

## The one command (on the Mac mini)

```bash
cd ~/zms-ad-reporting && scripts/health.sh production
```

Prints four sections and exits 0 only when everything passes (usable from cron/monitoring):

1. `compose ps` for the project (falls back to a `docker ps` label filter if `.env` is absent).
2. Container health: `zms-ads-{redis,api,celery-worker,celery-beat,web}` each
   `running / healthy` plus the image tag. `MISSING` or `unhealthy` sets exit 1.
3. HTTP: `/api/health/live`, `/api/health`, `/healthz` on 127.0.0.1 with the first 400 bytes
   of each body.
4. Deploy state: `current`, `previous`, last five lines of `production.history`.

`scripts/health.sh staging` does the same for ports 8011/3011 and `zms-ads-stg-*`.

Other useful views:

```bash
docker compose --env-file .env -f docker-compose.yml -f compose.production.yml ps
```

```bash
docker inspect --format '{{.Name}} {{.State.Health.Status}} {{range .State.Health.Log}}{{.ExitCode}} {{end}}' zms-ads-api zms-ads-celery-worker zms-ads-celery-beat zms-ads-web zms-ads-redis
```

Container healthchecks (commands and intervals in `DOCKER.md`): redis ping, api live probe,
worker `celery inspect ping`, beat schedule-file mtime under 20 min, web `/healthz`. An
`unhealthy` container is not auto-restarted by compose; `up -d` recreates it.

## Sync freshness in the UI

Settings -> **Sync status** lists the latest `sync_runs` per source and client with status
(`success`, `partial`, `error`), rows and error text, and lets the owner trigger Meta, Google
or GHL manually. Schedule (PT): Meta 01:00, Google 01:15, GHL 01:30, booking sheets 01:45,
Sheets export 02:00, Meta second pass 06:00, Slack alert 07:05, setters every 60 s. By 08:00 PT
every source should be green. SQL equivalent (Supabase SQL editor):

```sql
select source, status, count(*), max(finished_at) from sync_runs where started_at > now() - interval '2 days' group by 1,2 order by 1,2;
```

## External monitors (nothing on the Mac can tell you the Mac is down)

| Monitor | Setup | Alerts |
|---|---|---|
| UptimeRobot (free) | HTTP(s) monitor on `https://adbuildout.contractorscalingblueprint.com/api/health`, 5 min interval, optional keyword `"status":"ok"`; second monitor on `/healthz` | email + Slack webhook |
| Healthchecks.io (free) | one check per nightly job with a grace of 2 h; the job pings the URL on success | email + Slack when the 01:00 PT sync does not report. TODO (deploy): add the ping to `sync_*_all` / `slack_health_alerts` |
| Slack | set `SLACK_WEBHOOK_URL` in `backend/.env` (blank by choice today) and restart worker/beat; enables the 07:05 PT daily health post | in-channel |
| Cloudflare | Notifications -> Tunnel health (tunnel down / reconnect) | email |
| Sentry (free tier) | TODO (deploy): `sentry-sdk[fastapi]` in the api/worker, `@sentry/nextjs` in web, DSNs in `.env`; not installed yet | error traces |

TODO (Carl): choose the alert channel (email only, or email + Slack) and create the UptimeRobot
monitors; add Carl and one backup contact.

## Weekly owner routine (10 minutes)

1. Open the three URLs; `/api/health` is `ok`.
2. `scripts/health.sh production` on the Mac (or over Tailscale SSH): `OVERALL: healthy`.
3. Settings -> Sync status: no `error` rows from the last 7 nights that were not retried.
4. `tail -n 5 ~/Library/Logs/zms-ads/backup-db.log` shows `backup written`; Sunday's
   `verify-backup.log` shows `verify OK` (`BACKUP_RESTORE.md`).
5. GitHub: Actions tab green; Security tab / Dependabot PRs reviewed.
6. Supabase Dashboard -> Advisors: no new ERRORs; Auth -> Users: only expected people.
7. `docker system df` under control; `docker image prune -f` if needed.
8. macOS updates pending? Schedule them (`STARTUP_RECOVERY.md`).

## What to do per failure class

| Symptom | Likely cause | Do |
|---|---|---|
| `/api/health` 503, `checks.db.ok:false` (`TimeoutError`, `ConnectionRefusedError`, auth error) | Supabase down, project paused (Free plan pauses after inactivity), pooler unreachable, `SUPABASE_DB_URL` password rotated | Supabase status page and dashboard for `ayxvikfnktlxtpgzcrok`; restore/resume project; if credentials changed, update `backend/.env`, `docker compose ... up -d api celery-worker celery-beat` |
| `/api/health` 503, `checks.redis.ok:false` | redis container down or volume permission problem after a recreate | `docker compose ... ps redis`; `docker logs zms-ads-redis`; `up -d redis`; check the volume is owned by uid 999 |
| `degraded`, one source `ok:false` | last night's sync failed (token expired, API outage, rate limit) | Settings -> Sync status -> read the error; fix the token (`CREDENTIALS_CHECKLIST.md`) or wait for the 06:00 pass; trigger a manual sync |
| `degraded`, all sources `ok:false`, `last_success` fresh yesterday | beat not scheduling (unhealthy `celery-beat`) or worker not consuming | `docker inspect zms-ads-celery-beat --format '{{.State.Health.Status}}'`; `docker logs --tail 50 zms-ads-celery-worker`; `up -d celery-beat celery-worker` |
| Cloudflare **502** on the hostname, localhost 3010 fine | tunnel ingress points at the wrong port, or web container restarting | `curl -sI http://127.0.0.1:3010/healthz` on the Mac; check ingress in Zero Trust; `docker compose ... ps web` |
| Cloudflare **502**, localhost 3010 also fails | web container down | `scripts/health.sh production`; `up -d`; check `docker logs zms-ads-web` |
| Cloudflare **530 / 1033** | tunnel disconnected: Mac off, no internet, `cloudflared` stopped | `sudo launchctl print system/com.cloudflare.cloudflared`; `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`; check the home connection (`CLOUDFLARE_TUNNEL.md`) |
| Cloudflare 404 tunnel page | hostname not in ingress | `python3 scripts/cloud/cloudflare-hostnames.py --apply` |
| `/healthz` 200 but the sha is old after a deploy | deploy failed and rolled back | `cat .deploy/production.history` or the runner's `~/.zms-ads/deploy/production.history`; read the workflow log; `ROLLBACK.md` |
| Sign-in fails for everyone | Supabase Auth issue or `NEXT_PUBLIC_SUPABASE_*` wrong in the web build | Supabase status; `docker exec zms-ads-web sh -c 'env | grep NEXT_PUBLIC_SUPABASE_URL'`; redeploy with the correct `.env` |
| 429 for legitimate users | Cloudflare rate rule (60 req/10 s/IP on `/api/*`) or slowapi limits (600/min default, 30/min mutations) | check Cloudflare Security events; raise `RATE_LIMIT_*` in `backend/.env` only with a reason |
| Both dashboards (ads and SEO) down | Mac or tunnel | `STARTUP_RECOVERY.md`; power, internet, Docker Desktop running (`open -a Docker`) |

Escalation: if the Mac mini itself is unreachable (no Tailscale, no tunnel), someone must be
physically present. Data is safe in Supabase; only the UI and syncs stop.

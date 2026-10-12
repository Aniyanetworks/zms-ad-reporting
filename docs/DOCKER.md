# Docker

How the images are built and how the compose files are layered. Source of truth:
`backend/Dockerfile`, `frontend/Dockerfile`, `infra/tools/Dockerfile`, `docker-compose.yml`,
`compose.production.yml`, `compose.staging.yml`. Deploy procedures are in `DEPLOY_STAGING.md`
and `DEPLOY_PRODUCTION.md`; this file explains what they drive.

## Images

| Image | Built from | Base (digest-pinned) | Runs as | Used by |
|---|---|---|---|---|
| `zms-ads-api:<tag>` | `backend/Dockerfile` target `runtime` | `python:3.12-slim` | `app` (uid 10001) | `api`, `celery-worker`, `celery-beat` |
| `zms-ads-web:<tag>` | `frontend/Dockerfile` target `runner` | `node:22-alpine` | `node` (uid 1000) | `web` |
| `redis:7-alpine@sha256:…` | pulled | official | `999:1000` (compose `user:`) | `redis` |
| `zms-ads-tools:latest` | `infra/tools/Dockerfile` | `alpine:3.22` | `tools` (uid 10001) | `age`, `rclone`, `pg_dump/pg_restore` 17 for the backup scripts (built on demand by `scripts/backup-lib.sh`) |

Refresh a digest with `docker buildx imagetools inspect <image:tag>`; Dependabot's docker
ecosystem proposes bumps weekly for `/backend`, `/frontend`, `/infra/tools`.

### Backend stages (`backend/Dockerfile`)

| Stage | Purpose |
|---|---|
| `base` | pinned Python, env (`PYTHONDONTWRITEBYTECODE`, venv on `PATH`), user `app` |
| `builder` | gcc + libpq-dev, venv; installs third-party deps from `pyproject.toml` first (cached layer), then the project with `--no-deps` |
| `test` | builder + `.[dev]` extras + `tests/`; `USER app`, `HOME=/tmp`; `CMD pytest -q -p no:cacheprovider` |
| `runtime` (default) | libpq5 only, copies the venv and source as root-owned read-only files; `HOME=/tmp`, `DLT_DATA_DIR=/tmp/dlt`, `TMPDIR=/tmp`; `USER app`; `HEALTHCHECK` on `/api/health/live`; `CMD uvicorn` |

```bash
docker build --target test -t zms-ads-api-test ./backend && docker run --rm zms-ads-api-test
```

### Frontend stages (`frontend/Dockerfile`)

`deps` (`npm ci`) -> `builder` (`npm run build` with build args `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_ENVIRONMENT`, `NEXT_PUBLIC_GIT_SHA`,
`API_URL=http://api:8000`) -> `runner` (`.next`, `node_modules`, `public`, `next.config.ts`
root-owned; only `.next/cache` owned by `node`; `npm_config_cache=/tmp/.npm`; `CMD npm run start`).

The `/api/*` rewrite target is baked at **build** time (`routes-manifest.json`), which is why
`API_URL` is a build arg and why a web image is per environment only in its `NEXT_PUBLIC_*`
values.

## Worker and beat reuse the api image

`celery-worker` and `celery-beat` declare `image: zms-ads-api:${IMAGE_TAG}` with
`pull_policy: never` and no `build:`. `compose build api web` (what `scripts/deploy.sh` runs)
produces both images once; worker and beat start from the api image with a different
`command:`. They are never pulled from a registry.

## Hardening applied to every service (`docker-compose.yml`)

| Control | Setting |
|---|---|
| Non-root | from the image (`app`, `node`); redis via `user: "999:1000"` because the stock entrypoint would need SETUID/SETGID to drop privileges |
| Read-only root filesystem | `read_only: true` on all five services |
| Writable paths | `tmpfs`: api `/tmp` (1 GB), worker `/tmp` (2 GB, dlt extract/normalize), beat `/tmp` (schedule DB `/tmp/celerybeat-schedule`), web `/tmp` + `/app/.next/cache`, redis `/tmp`; redis data on the named volume |
| Privileges | `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]` |
| Restart | `restart: unless-stopped` (a stopped container stays stopped across reboots) |
| Graceful stop | `stop_grace_period: 30s`; worker `--soft-time-limit=3300 --time-limit=3600` |
| Logs | `json-file`, `max-size: 20m`, `max-file: 5` per container (100 MB cap) |
| Network exposure | base file has `expose:` only; overlays publish ports on `127.0.0.1` |
| Start order | `depends_on: redis: service_healthy` for api/worker/beat; `web` waits for `api: service_healthy` |

## Healthchecks per service

| Service | Command | Interval / timeout / retries / start |
|---|---|---|
| redis | `redis-cli ping` | 10s / 5s / 5 / 5s |
| api | `python -c "urllib.request.urlopen('http://127.0.0.1:8000/api/health/live', timeout=3)"` (exit 0 on 200) | 30s / 5s / 3 / 20s |
| celery-worker | `celery -A app.celery_app inspect ping -d celery@$HOSTNAME --timeout 10` | 60s / 20s / 3 / 60s |
| celery-beat | python: newest `/tmp/celerybeat-schedule*` mtime younger than 1200 s (beat rewrites it every 3 min) | 60s / 10s / 3 / 90s |
| web | `wget -qO- http://127.0.0.1:3000/healthz` | 30s / 5s / 3 / 20s |

`docker compose up --wait` and `scripts/deploy.sh` rely on these. The deep check
`/api/health` (Postgres, Redis, sync freshness) is polled by the deploy health gate, not by the
container healthcheck, so a stale sync never restarts the api. See `HEALTH_MONITORING.md`.

## Variables and the IMAGE_TAG scheme

| Variable | Set by | Meaning |
|---|---|---|
| `IMAGE_TAG` | `scripts/deploy.sh` = full git sha; default `latest` | tag of `zms-ads-api` / `zms-ads-web` to build/run |
| `GIT_SHA` | `deploy.sh` = same sha; default `dev` | reported by `/api/health` (`version`) and baked as `NEXT_PUBLIC_GIT_SHA` for `/healthz` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | root `.env` / `.env.staging` (`--env-file`) | web build args |
| `NEXT_PUBLIC_ENVIRONMENT` | overlay (`production` / `staging`) | staging renders the amber banner |
| `BACKEND_ENV_FILE` | overlay default `./backend/.env` or `./backend/.env.staging`; `deploy.sh` overrides to `~/.zms-ads/secrets/<env>/backend.env` on the runner | `env_file` for api/worker/beat |
| `LEADERBOARD_HOST` | overlay default `setter.contractorscalingblueprint.com` (staging: `setter-staging.invalid`) | hostname that serves only `/leaderboard` |

Special tags: `pre-hardening` (created by `deploy.sh` from the legacy `zms-ad-reporting-*`
images on the first hardened deploy) and the manual `zms-ad-reporting-*:prod-2026-09-16`
snapshots. `deploy.sh` never deletes images, so every deployed sha stays available for
`scripts/rollback.sh` until you prune.

## Compose file layering

`docker-compose.yml` is the environment-agnostic base: no ports, no container names, no env
files. **Never run it alone.** Always pair it with exactly one overlay.

| Environment | Project name | Overlay | Containers | Ports (127.0.0.1) | Volume |
|---|---|---|---|---|---|
| production | `zms-ad-reporting` (directory name, what runs today) | `compose.production.yml` | `zms-ads-{redis,api,celery-worker,celery-beat,web}` | 3010 web, 8010 api, 6380 redis | `zms-ad-reporting_redis-data` |
| staging | `zms-ads-staging` (explicit `-p`) | `compose.staging.yml` | `zms-ads-stg-{redis,api,celery-worker,celery-beat,web}` | 3011, 8011, 6381 | `zms-ads-staging_redis-data` |

Production, exact invocation (from `~/zms-ad-reporting`):

```bash
docker compose --env-file .env -f docker-compose.yml -f compose.production.yml up -d --wait --remove-orphans
```

Staging, exact invocation (`-p` is mandatory; without it compose reuses the production
project name and replaces the production containers):

```bash
docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml up -d --wait --remove-orphans
```

`scripts/deploy.sh <env> <sha>` wraps these with the build, the `.previous` bookkeeping, the
health gate and automatic rollback; prefer it. `scripts/lib.sh` `set_env` builds the same
`COMPOSE` array the scripts use.

## Common commands

Define an alias per shell session to avoid typos:

```bash
alias dcp='docker compose --env-file .env -f docker-compose.yml -f compose.production.yml'
```

```bash
dcp ps
```

```bash
dcp logs -f --tail 100 api celery-worker
```

```bash
dcp exec api python -m app.cli backfill --all --source meta --days 28
```

```bash
dcp exec api sh -c 'echo $ENVIRONMENT $GIT_SHA'
```

```bash
docker inspect zms-ads-api --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.State.Health.Status}}'
```

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -v 127.0.0.1 ; echo "(only headers expected)"
```

Restart one service without rebuilding:

```bash
dcp up -d --no-build api
```

Prune images older than the last few deploys (keeps anything a container uses):

```bash
docker image prune -f
```

## What NOT to do

- **No `docker compose down -v` on production.** It deletes `zms-ad-reporting_redis-data`.
  Redis only holds queue state, but the volume is owned by uid 999 and recreating it under the
  hardened `user:` needs care. `down` without `-v` is also unnecessary; use `up -d` to
  recreate.
- **No `0.0.0.0` ports.** Every `ports:` entry is `127.0.0.1:<host>:<container>`. The tunnel
  is the only way in (`CLOUDFLARE_TUNNEL.md`).
- **No `docker compose up` with the base file alone**, and no staging `up` without
  `-p zms-ads-staging`.
- **No `docker compose down` while the SEO dashboard's stack is on the same daemon** unless
  you are sure of the project name: it lives on 3000/8000/6379 and shares the tunnel.
- **No bind mounts of source code** into production containers; images are immutable, the
  rootfs is read-only, and `env_file` is the only host input.
- **No `latest` in production.** Deploy by sha so `rollback.sh` has a target.
- **No edits to a running container** (`docker exec ... pip install`). Change the Dockerfile,
  rebuild, deploy.
- **No `--privileged`, `cap_add`, or removing `read_only`** to "fix" a write error. Add a
  `tmpfs` path or fix the code to write under `/tmp`.

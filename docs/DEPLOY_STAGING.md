# Deploy to staging

Staging is a second compose project on the same Mac mini (`zms-ads-staging`, ports
3011 / 8011 / 6381) with its own Supabase project, reachable at
https://staging-adbuildout.contractorscalingblueprint.com behind Cloudflare Access. Every
commit that lands on `main` is deployed here automatically; production only ever receives a
sha that staging has run (`DEPLOY_PRODUCTION.md`).

## Prerequisites (one-time)

| Item | How | Status |
|---|---|---|
| Staging Supabase project `zms-ads-staging` | `python3 scripts/cloud/supabase-staging-create.py --apply` (writes ref, keys, DB password to `~/.config/zms/supabase-staging.env`) | TODO (Carl) |
| `backend/.env.staging` | from `backend/.env.staging.example`; staging Supabase values; Meta/Google/GHL tokens blank or sandbox; `ENVIRONMENT=staging`, `DASHBOARD_URL=https://staging-adbuildout.contractorscalingblueprint.com` | TODO (Carl) |
| `.env.staging` (root) | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` of the staging project | TODO (Carl) |
| Schema | `scripts/cloud/supabase-migrate.sh staging` (runs `check-migrations.sh` first, then `supabase db push --db-url`) | TODO (deploy) |
| Staging Auth settings | `SUPABASE_PROJECT_REF=<staging ref> python3 scripts/cloud/supabase-auth-hardening.py --site-url https://staging-adbuildout.contractorscalingblueprint.com --apply`, then create staging users (`MEDIA_BUYER_ONBOARDING.md`) | TODO (Carl) |
| DNS + tunnel ingress `staging-adbuildout.` -> `localhost:3011` | `python3 scripts/cloud/cloudflare-hostnames.py --apply` | TODO (Carl), `DNS_CHECKLIST.md` |
| Cloudflare Access on staging (email PIN, `@zealmediasolutions.com`) | `python3 scripts/cloud/cloudflare-access-staging.py --apply` | TODO (Carl) |
| Runner secrets | `~deploy/.zms-ads/secrets/staging/{backend.env,web.env}` (`MAC_MINI_INSTALL.md` section 8) | TODO (deploy) |

Apply migrations:

```bash
scripts/cloud/supabase-migrate.sh staging --dry-run
```

```bash
scripts/cloud/supabase-migrate.sh staging
```

## Automatic path: push to `main`

`.github/workflows/deploy-staging.yml` runs on every push to `main` (and on
`workflow_dispatch` with an optional `sha`), on the self-hosted runner `macmini-deploy`
(labels `self-hosted, macmini`, user `deploy`), GitHub environment `staging`, concurrency
group `deploy-staging` (runs queue, never cancel each other).

Steps:

1. Checkout at the target sha (`persist-credentials: false`).
2. Export `ZMS_DEPLOY_STATE_DIR=$HOME/.zms-ads/deploy` and
   `ZMS_SECRETS_DIR=$HOME/.zms-ads/secrets`; fail if `staging/backend.env` or
   `staging/web.env` is missing.
3. `scripts/deploy.sh staging "$TARGET_SHA"` (build, up, health gate, auto-rollback).
4. Informational public probe of `https://staging-adbuildout…/healthz`. A 302/403 from
   Cloudflare Access is a warning, not a failure; the localhost gate is authoritative.
5. Step summary with `staging.current` and `staging.previous`.

Watch it:

```bash
gh run watch -R zmsseoagency/zms-ad-reporting
```

Redeploy a specific commit:

```bash
gh workflow run deploy-staging.yml -R zmsseoagency/zms-ad-reporting -f sha=<full-sha>
```

## Manual path (on the Mac mini)

Same script, run as `zms` from the checkout. The checkout must be **clean and at the sha**
(images are built from the working tree):

```bash
cd ~/zms-ad-reporting && git fetch origin && git checkout <sha>
```

```bash
scripts/deploy.sh staging <sha>
```

What `deploy.sh staging <sha>` does:

1. Verifies `HEAD == <sha>` and a clean tree (`ALLOW_DIRTY=1` overrides).
2. Checks `backend/.env.staging` and `.env.staging` exist (or the `ZMS_SECRETS_DIR` copies).
3. Records the tag currently running on `zms-ads-stg-api` to `staging.previous`.
4. `compose build --pull=false api web` with `IMAGE_TAG=<sha>` (`NO_BUILD=1` skips).
5. `docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml up -d --wait --wait-timeout 180 --remove-orphans --no-build`.
6. Health gate (below). On success writes `staging.current` and appends to
   `staging.history`; on failure prints the last 40 log lines and runs
   `scripts/rollback.sh staging`.

Knobs: `HEALTH_TIMEOUT` (default 120 s), `HEALTH_ALLOW_DEGRADED=1` (accept a 503 from
`/api/health` when `/api/health/live` is 200; useful for a brand-new staging DB with no
`sync_runs` yet, although an empty DB yields `degraded`/200, not 503).

## What the health gate checks

`wait_healthy` in `scripts/lib.sh` polls every 3 s, up to `HEALTH_TIMEOUT`:

| Probe | Must be |
|---|---|
| `http://127.0.0.1:8011/api/health/live` | 200 |
| `http://127.0.0.1:8011/api/health` | 200 (`ok` or `degraded`); 503 only accepted with `HEALTH_ALLOW_DEGRADED=1` |
| `http://127.0.0.1:3011/healthz` | 200 |

Before that, `compose up --wait` already required every container healthcheck (redis ping,
api live, worker `inspect ping`, beat schedule mtime, web `/healthz`) to pass; see `DOCKER.md`.

## Smoke test checklist (a person, after every staging deploy that matters)

1. Open https://staging-adbuildout.contractorscalingblueprint.com in a private window. Expect
   the **Cloudflare Access** email PIN prompt, then the dashboard login with the amber
   STAGING banner.
2. `https://staging-adbuildout…/healthz` returns `{"status":"ok","service":"web","version":"<sha>"}`
   and the sha matches what you deployed.
3. `https://staging-adbuildout…/api/health` returns 200 with `"environment":"staging"` and
   `"version":"<sha>"`. `degraded` is fine on staging when sync tokens are blank.
4. Sign in as a staging `admin`, open a client, **approve a test recommendation** (create one
   through the plugin against staging, or insert a `proposed` row in the staging DB). Expect
   the status to change and `approved_by_id` to be your user id.
5. Confirm the **audit_log row** in the staging Supabase SQL editor:

```sql
select at, actor_email, action, entity_id from audit_log order by at desc limit 5;
```

   Expect `recommendation.approve` with your email.
6. As a `viewer`, the Approve button is absent and `POST .../approve` returns 403.
7. `docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml ps` shows five services `running (healthy)`.
8. Production still answers: `curl -s https://adbuildout.contractorscalingblueprint.com/healthz`.

Record the sha and "staging smoke passed" in the PR or release note. `deploy-production.yml`
will only accept this exact sha.

## Where state lives

| Who deploys | State dir | Files |
|---|---|---|
| Runner (`deploy` user) | `/Users/deploy/.zms-ads/deploy/` | `staging.current`, `staging.previous`, `staging.history` (tab-separated `time  sha  ok|failed|rollback-ok|rollback-failed`) |
| Manual as `zms` | `~/zms-ad-reporting/.deploy/` (gitignored) unless `ZMS_DEPLOY_STATE_DIR` is set | same |

These are **two separate stores**. The production workflow's staging-parity check reads the
runner's `staging.current`, so a staging deploy done by hand as `zms` does not count for
promotion. Either deploy staging through the workflow, or run the manual deploy with
`ZMS_DEPLOY_STATE_DIR=/Users/deploy/.zms-ads/deploy` as a user who can write there.

```bash
scripts/health.sh staging
```

prints container health, the three endpoints and the state files for whichever store the
current user sees.

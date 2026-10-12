# ZMS Ads Intelligence Dashboard

Multi-client paid-ads reporting and a human-approved action queue for Zeal Media Solutions
(~19 home-services clients). Pulls **Meta Ads**, **Google Ads** and **GoHighLevel** nightly
into Supabase, shows CPL / cost per booked appointment per client, campaign and service, and
holds the recommendations the Claude Code plugin (`zeal-paid-ads`) proposes until a signed-in
person approves them. Next.js web + FastAPI api + Celery worker/beat + Redis in Docker Compose
on an Apple-silicon Mac mini, managed Supabase, Cloudflare Tunnel. No inbound ports.

## Hostnames

| Hostname | Purpose |
|---|---|
| https://adbuildout.contractorscalingblueprint.com | production (primary) |
| https://report.contractorscalingblueprint.com | production alias (legacy, kept until retired) |
| https://setter.contractorscalingblueprint.com | public setter leaderboard (`/leaderboard` only, same container) |
| https://staging-adbuildout.contractorscalingblueprint.com | staging, behind Cloudflare Access (email PIN) |

Architecture, ports, trust boundaries, data flow: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start: developers

```bash
git clone git@github.com:zmsseoagency/zms-ad-reporting.git && cd zms-ad-reporting
cp backend/.env.staging.example backend/.env.staging && cp .env.example .env.staging   # staging Supabase values, never production
docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml up -d --build --wait
docker build --target test -t zms-ads-api-test ./backend && docker run --rm zms-ads-api-test  # 49 tests
cd frontend && npm ci && npm run lint && npm run typecheck && npm run test && npm run dev      # http://localhost:3000, API_URL in frontend/.env.local
```

Full guide: [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md). Never commit `.env*`.

## Quick start: operators (on the Mac mini, `~/zms-ad-reporting`)

| Task | Command |
|---|---|
| Health | `scripts/health.sh production` |
| Deploy staging | push to `main` (auto), or `scripts/deploy.sh staging <sha>` |
| Deploy production | `gh workflow run deploy-production.yml -f sha=<sha> -f confirm="deploy <sha>"` (sha must be live on staging) |
| Roll back | `scripts/rollback.sh production` |
| Migrate | `scripts/cloud/supabase-migrate.sh production` (prompts) |
| Backup now | `scripts/backup-db.sh` |
| Verify backup | `scripts/verify-backup.sh` |
| Compose (prod) | `docker compose --env-file .env -f docker-compose.yml -f compose.production.yml ps` |

Production project `zms-ad-reporting` binds 127.0.0.1 only: web 3010, api 8010, redis 6380.
Staging project `zms-ads-staging`: 3011 / 8011 / 6381. The SEO dashboard shares the machine
and tunnel on 3000 / 8000 / 6379; never touch those. The browser only talks to Next.js;
`/api/*` is rewritten to FastAPI inside the compose network.

## Human-control rules

Enforced in `backend/app/core/policy.py`, mirrored in the UI, audited in `audit_log`:

- The AI (plugin) prepares drafts and proposes recommendations; it never approves them.
- Approval is a signed-in person (`admin` or `media_buyer`); `approved_by_id` is their user id.
- The plugin token cannot reach status `approved` (409, logged as `recommendation.approve_denied`).
- Every created campaign, ad set or ad starts PAUSED; launch (`activate`) is a separate human step in the ad platform and is never executed by the system.
- Budget increases above 20 % need the Agency Owner (`admin`); viewers are read-only.
- Execute refuses anything not approved by a person.
- Production only receives a commit already verified on staging, with typed confirmation by an allow-listed deployer; migrations are applied first by a person and are never destructive automatically.
- Every consequential action lands in the append-only `audit_log`.

## Sync schedule (PT, `backend/app/celery_app.py`)

| Time | Job | Notes |
|---|---|---|
| 01:00 | Meta, trailing 28 days | Meta restates conversions up to 28 days out |
| 01:15 | Google Ads, trailing 30 days | conversion lag |
| 01:30 | GoHighLevel, trailing 7 days | does not restate |
| 01:45 | Booking sheets (`booking_system=sheet` clients) | |
| 02:00 | Google Sheets export | |
| 06:00 | Meta second pass | late-attributed leads |
| 07:05 | Slack health alert | only if `SLACK_WEBHOOK_URL` is set |
| every 60 s | Setter leaderboard mirror | read-only, two Google Sheets |

Settled snapshots `leads_t1/t3/t7` are stamped once and never overwritten. Rows keep each
account's local date and currency. One client's failure writes an `error` row to `sync_runs`
and the loop continues. `/api/health` reports `degraded` when a source has no success in 26 h.

## Repository layout

```
backend/            FastAPI + Celery + dlt pipelines (app/core: config, security, policy, audit, middleware, ratelimit)
frontend/           Next.js App Router: /login, / (overview), /portfolio, /clients/[slug], /services, /settings, /leaderboard, /healthz
supabase/migrations schema, RLS, roles, audit_log (applied in filename order)
scripts/            deploy.sh rollback.sh health.sh backup-db.sh backup-config.sh verify-backup.sh install-runner.sh check-migrations.sh
scripts/cloud/      idempotent Cloudflare / Supabase provisioning (dry run by default, --apply)
infra/launchd/      backup job templates; infra/tools/ helper image (age, rclone, pg 17 client)
.github/workflows/  ci.yml, deploy-staging.yml, deploy-production.yml, security.yml
docker-compose.yml  base; compose.production.yml / compose.staging.yml overlays
docs/               everything below
```

## Docs index

| Document | What it covers |
|---|---|
| [DEPLOYMENT_PLAN.md](docs/DEPLOYMENT_PLAN.md) | the approved hardening plan: current state, target, phases, open questions |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, diagram, data flow, trust boundaries, ports, environments, human-control rules |
| [LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) | clone, env files, run the stack, tests in Docker, frontend dev, PR workflow, migrations |
| [MAC_MINI_INSTALL.md](docs/MAC_MINI_INSTALL.md) | fresh Mac mini to production: macOS, Docker Desktop, secrets, tunnel, runner, backups, Tailscale, UPS |
| [DOCKER.md](docs/DOCKER.md) | image stages, hardening, healthchecks, IMAGE_TAG, compose layering, commands, what not to do |
| [DEPLOY_STAGING.md](docs/DEPLOY_STAGING.md) | prerequisites, push-to-main workflow, manual deploy, health gate, smoke test, state files |
| [DEPLOY_PRODUCTION.md](docs/DEPLOY_PRODUCTION.md) | the rule, pre-flight, workflow_dispatch gate, manual path, first hardened deploy, external verification |
| [ROLLBACK.md](docs/ROLLBACK.md) | image rollback, forward-fix migrations, reverting cloud config, first-deploy rollback |
| [HEALTH_MONITORING.md](docs/HEALTH_MONITORING.md) | health endpoints and shapes, `health.sh`, external monitors, weekly routine, failure playbook |
| [BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | what is backed up, `age` encryption, off-site, verify, full restore procedure, drill |
| [STARTUP_RECOVERY.md](docs/STARTUP_RECOVERY.md) | Mac mini boot chain, FileVault trade-off, outage modes, availability warning, UPS |
| [CLOUDFLARE_TUNNEL.md](docs/CLOUDFLARE_TUNNEL.md) | the shared remote-managed tunnel, ingress rules, LaunchDaemon, troubleshooting |
| [DNS_CHECKLIST.md](docs/DNS_CHECKLIST.md) | records, ingress, cloud scripts, callback URLs, outside-LAN verification list |
| [SUPABASE.md](docs/SUPABASE.md) | projects, tables, RLS, keys, migrations workflow, Auth hardening, advisors |
| [Campaign Builder](docs/CAMPAIGN_BUILDER.md) | Chat-driven Meta campaign drafting at /build: creatives in, plan validated by code, human approval, PAUSED creation |
| [SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md) | every control with status (done / TODO Carl / TODO deploy) and how to verify |
| [CREDENTIALS_CHECKLIST.md](docs/CREDENTIALS_CHECKLIST.md) | every secret: purpose, location, owner, rotation |
| [MEDIA_BUYER_ONBOARDING.md](docs/MEDIA_BUYER_ONBOARDING.md) | create a user, set the role, permissions matrix, first login, revoke |
| [REMOTE_MCP.md](docs/REMOTE_MCP.md) | deferred remote MCP server design and prerequisites |
| [google-ads-api-design-doc.pdf](docs/google-ads-api-design-doc.pdf) | Google Ads API integration design (reference) |

Availability: there is one machine and no failover. The dashboard is down during a home power
or internet outage, a hardware failure, or a macOS dialog that needs a person. Data in Supabase
is unaffected. See `docs/STARTUP_RECOVERY.md`.

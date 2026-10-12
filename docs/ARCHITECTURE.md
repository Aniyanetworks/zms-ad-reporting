# Architecture

ZMS Ads Intelligence dashboard: Next.js web + FastAPI api + Celery worker/beat + Redis,
run with Docker Compose on an Apple-silicon Mac mini, backed by managed Supabase
(Postgres + Auth), published through a Cloudflare Tunnel. Last updated 2026-09-16
(branch `hardening/phase-1`).

## Components

| Component | Runs where | Role |
|---|---|---|
| `web` (Next.js 16, App Router) | container `zms-ads-web`, host 127.0.0.1:3010 | UI, Supabase SSR session, `/api/*` rewrite to the api container, `/healthz` liveness, security headers (`frontend/next.config.ts`), public `/leaderboard` on the `setter.` hostname only (`frontend/src/proxy.ts`) |
| `api` (FastAPI) | container `zms-ads-api`, host 127.0.0.1:8010 | verifies Supabase JWTs (`backend/app/core/security.py`), enforces roles (`policy.py`), writes `audit_log` (`audit.py`), rate limits (`ratelimit.py`), Origin check + headers (`middleware.py`), `/api/plugin/*` for the Claude Code plugin |
| `celery-worker` | container `zms-ads-celery-worker` | Meta / Google Ads / GHL / booking-sheet / setter-sheet syncs, Sheets export, Slack health alerts |
| `celery-beat` | container `zms-ads-celery-beat` | schedule (PT): Meta 01:00, Google 01:15, GHL 01:30, booking sheets 01:45, Sheets export 02:00, Meta 2nd pass 06:00, Slack alerts 07:05, setters every 60 s |
| `redis` | container `zms-ads-redis`, host 127.0.0.1:6380 | Celery broker/result backend |
| Supabase | managed, us-east-2 | Postgres (all data), Auth (users, TOTP MFA), RLS |
| Cloudflare | edge | DNS, TLS, WAF, rate-limit rule, Access on staging, Tunnel |
| `cloudflared` | Mac mini LaunchDaemon `com.cloudflare.cloudflared` (root) | outbound-only tunnel `zms-seo-dashboard` (b9929fe5-4b97-4708-acdb-734c224430e5); also serves the separate SEO dashboard on 3000/8000 |

## Diagram

```
 Browser (Owner / media buyer)          Claude Code + zeal-paid-ads plugin
        |  HTTPS                                  |  HTTPS  Authorization: Bearer PLUGIN_API_TOKEN
        v                                         v
 +--------------------------------------------------------------------------+
 | Cloudflare edge: DNS, TLS, WAF, /api/* rate rule, Access (staging only)  |
 +------------------------------------+-------------------------------------+
                                      | tunnel b9929fe5 (outbound from the Mac, no inbound ports)
 +------------------------------------v-------------------------------------+
 | Mac mini (M4, macOS 26.2, Docker Desktop)   cloudflared LaunchDaemon      |
 |                                                                          |
 |  ingress: adbuildout./ads./setter. -> 127.0.0.1:3010   (production)      |
 |           staging-adbuildout.      -> 127.0.0.1:3011   (staging)         |
 |           SEO dashboard hostnames  -> :3000 / :8000    (do not touch)    |
 |                                                                          |
 |  compose project zms-ad-reporting (prod)   compose project zms-ads-staging |
 |   web :3010 --/api rewrite--> api :8000     web :3011 --> api :8000       |
 |   api --> redis <-- celery-worker/beat      api --> redis <-- worker/beat |
 +-------------+-----------------------------------------+------------------+
               | Postgres (pooler) + Auth JWKS           | nightly syncs (outbound)
               v                                         v
   Supabase prod ayxvikfnktlxtpgzcrok          Meta Marketing API, Google Ads API,
   Supabase staging zms-ads-staging            GoHighLevel API, Google Sheets/Drive
```

## Data flow

1. Nightly (beat): worker pulls yesterday from Meta, Google Ads, GHL and the booking / setter
   sheets, upserts `ad_metrics_daily`, `adset_metrics_daily`, `ad_level_metrics_daily`,
   `ghl_metrics_daily`, `ghl_adset_daily`, `setter_*`; logs every run in `sync_runs`.
2. Browser: signs in with Supabase Auth (cookie session via `@supabase/ssr`), calls `/api/*`
   with the Supabase access token; Next rewrites to the api container; api verifies the JWT
   against Supabase JWKS and reads `profiles.role`.
3. Plugin path: Claude Code plugin calls `/api/plugin/*` with the shared bearer token to list
   clients, upsert benchmarks, record triage runs and propose recommendations. It can move a
   recommendation to `dismissed`, `executed` or `failed`, never to `approved`.
4. Approval: a signed-in person calls `POST /api/clients/{slug}/recommendations/{id}/approve`
   (`backend/app/routers/actions.py`). `approved_by_id` is the `auth.users.id`. Only then may
   the plugin `/execute` it and mark it `executed`.
5. Every consequential action lands in `audit_log` (append-only, service-role write).

## Trust boundaries

| Boundary | Control |
|---|---|
| Internet -> Cloudflare | TLS terminates at Cloudflare; WAF + rate rule; staging additionally behind Access (email PIN, @zealmediasolutions.com) |
| Cloudflare -> Mac mini | tunnel only; no router port forwarding; every compose port bound to 127.0.0.1 |
| web -> api | inside the compose network (`http://api:8000`); the browser never talks to the api origin directly |
| Person -> api | Supabase JWT (ES256/RS256 via JWKS, HS256 fallback for tests); role from `profiles`; `require_role()` on mutating routes |
| Plugin -> api | `PLUGIN_API_TOKEN` compared with `secrets.compare_digest`; limited status transitions (`policy.PLUGIN_ALLOWED_TRANSITIONS`); own rate limit |
| api -> Supabase | service-role key + pooler DB URL, both only in `backend/.env`; RLS applies to browser reads via the anon key |
| Secrets | Meta system-user token, Google OAuth refresh token, GHL PITs (`client_secrets`, RLS with no policies) live only on the Mac mini; never in the frontend bundle or git |

## Ports

| Port (127.0.0.1) | Service | Environment |
|---|---|---|
| 3010 | web | production (tunnel target for adbuildout., ads., setter.) |
| 8010 | api | production (local debugging only) |
| 6380 | redis | production |
| 3011 | web | staging (tunnel target for staging-adbuildout.) |
| 8011 | api | staging |
| 6381 | redis | staging |
| 3000 / 8000 / 6379 | SEO dashboard stack | separate repo, same Mac mini and tunnel. Never reuse these ports. |

## Environments

| | Local | Staging | Production |
|---|---|---|---|
| Hostname | http://localhost:3000 (web), :8000 or :8010 (api) | https://staging-adbuildout.contractorscalingblueprint.com (Cloudflare Access) | https://adbuildout.contractorscalingblueprint.com (alias https://ads.contractorscalingblueprint.com; public https://setter.contractorscalingblueprint.com serves /leaderboard only) |
| Compose | `docker compose -f docker-compose.yml -f compose.production.yml` (dev may run api/web outside Docker) | `docker compose -p zms-ads-staging -f docker-compose.yml -f compose.staging.yml` | `docker compose -f docker-compose.yml -f compose.production.yml` (project name = directory `zms-ad-reporting`) |
| Ports | 3000 / 8000 | 3011 / 8011 / 6381 | 3010 / 8010 / 6380 |
| Backend env file | `backend/.env` (ENVIRONMENT=development) | `backend/.env.staging` | `backend/.env` |
| Web env file | `.env` | `.env.staging` | `.env` |
| Supabase project | staging or a personal project | `zms-ads-staging` (TODO (Carl): create with `scripts/cloud/supabase-staging-create.py`) | `ayxvikfnktlxtpgzcrok` |
| API docs | `/docs` enabled | `/docs` enabled | disabled (`ENVIRONMENT=production`) |
| Banner | none | amber STAGING banner (`NEXT_PUBLIC_ENVIRONMENT=staging`) | none |

## Human-control rules

Encoded in `backend/app/core/policy.py` (tests in `backend/tests/test_policy.py`), mirrored in
`frontend/src/lib/permissions.ts`, surfaced by `GET /api/me`:

1. AI (the plugin) can prepare and modify drafts and provide recommendations.
2. AI cannot approve itself: the plugin token has no path to `approved`; the attempt is
   refused with 409 and written to `audit_log` as `recommendation.approve_denied`.
3. Campaign creation requires human approval; created objects start PAUSED.
4. Launch (`activate`) is a separate human step in the ad platform; `can_approve()` refuses it.
5. Budget increases above 20 % need the Agency Owner (`admin`); media buyers can approve
   everything else; viewers are read-only.
6. Execute refuses a recommendation that was never approved by a person (`approved_by` unset).
7. Every consequential action is recorded in `audit_log` (append-only).

Roles: `admin` (Agency Owner), `media_buyer`, `viewer`. See `SECURITY_CHECKLIST.md`,
`MEDIA_BUYER_ONBOARDING.md`, and the plugin's operator handoff at
`~/zeal-paid-ads/docs/TEAM_HANDOFF.md`.

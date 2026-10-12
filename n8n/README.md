# Backend on n8n — migration plan

Goal: replace the FastAPI + Celery backend (`backend/`) with n8n workflows, keeping
the Next.js frontend unchanged. Data stays in the existing Supabase project.

## How the frontend reaches n8n

The frontend calls `/api/*`, which `next.config.ts` rewrites to `${API_URL}/api/*`.
n8n serves webhooks with path params at `/webhook/<webhookId>/<path>`, so every workflow
shares webhookId `zms` and static paths are prefixed `zms/`: every endpoint lives under
`${N8N_URL}/webhook/zms/api/...` and the frontend uses `API_URL=${N8N_URL}/webhook/zms`. Each endpoint is
a Webhook node whose path is `api/<route>` (path params use n8n's `:param` syntax,
e.g. `api/clients/:slug/campaigns`).

Cut-over is per endpoint, not big-bang: `next.config.ts` sends the paths listed in
`N8N_ROUTES` to n8n and everything else to the existing FastAPI backend. An endpoint
moves only after its n8n response matches FastAPI's (see Parity below).

## Shared building blocks

| Workflow | Purpose |
|---|---|
| `lib/auth` | Verifies the Supabase JWT (`GET {SUPABASE_URL}/auth/v1/user`), loads the profile/role, returns 401/403 like `backend/app/core/security.py` |
| `lib/audit` | Writes `audit_log` rows like `backend/app/core/audit.py` |
| `lib/error` | Uniform JSON errors (`{"detail": ...}`) matching FastAPI |

## n8n credentials (created by you in the n8n UI — never in this repo)

| Name | Type | Used for |
|---|---|---|
| `ZMS Supabase Postgres` | Postgres | all reads/writes (session-mode pooler URI from Carl) |
| `ZMS Supabase Anon` | Header Auth (`apikey`) | JWT verification against Supabase Auth |
| `ZMS Meta` | Header Auth / Meta | Phase 3–4 |
| `ZMS Google Ads` | Google Ads OAuth2 | Phase 3 |
| `ZMS GHL` | Header Auth | Phase 3 |
| `ZMS Slack`, `ZMS Anthropic` | — | Phase 4 |

## Phases

1. **Read-only endpoints** (safe to run beside the Mac mini): health, me, clients (GET),
   overview, today, plays, creative-health, campaigns/periods/creatives/top-ads/adsets/ads,
   services, service-targets (GET), funnel, google-ads, portfolio, scorecard,
   recommendations (GET), tracking, brief + dates, integrations (GET), sync/status,
   setters/leaderboard, audit-log, export ai-bundle, builds (GET).
2. **Dashboard writes**: clients POST/PATCH, service-targets PUT/DELETE/reseed,
   recommendations approve/dismiss/bulk-approve, builds CRUD/plan/validate, plugin API.
3. **Scheduled syncs** (Meta, Google, GHL, booking sheets, setters, integration health,
   Sheets export) — only after Carl stops Celery beat on the Mac mini, otherwise both
   systems write the same tables.
4. **Live actions & AI**: recommendation execute / bulk-execute (Meta writes, PAUSED +
   policy guards from `core/policy.py`), sync/trigger, brief/run + daily brief, Slack
   report, campaign builder chat (Anthropic), build approve.

## Parity

`n8n/scripts/parity` calls each migrated GET endpoint on both backends with the same
user token and diffs the JSON. An endpoint goes into `N8N_ROUTES` only when it matches.

## Endpoint tracker

Status: ☐ todo · ◐ built · ✓ parity-verified & routed

| # | Method | Path | Source | Phase | Status |
|---|---|---|---|---|---|
| 1 | GET | /api/health/live | health.py | 1 | ◐ |
| 2 | GET | /api/health | health.py | 1 | ◐ |
| 3 | GET | /api/me | me.py | 1 | ◐ |
| 4 | GET | /api/clients | clients.py | 1 | ◐ |
| 5 | POST | /api/clients | clients.py | 2 | ◐ |
| 6 | PATCH | /api/clients/{client_id} | clients.py | 2 | ◐ |
| 7 | GET | /api/overview | overview.py | 1 | ◐ |
| 8 | GET | /api/today | today.py | 1 | ☐ |
| 9 | GET | /api/clients/{slug}/plays | today.py | 1 | ☐ |
| 10 | GET | /api/clients/{slug}/creative-health | today.py | 1 | ☐ |
| 11 | GET | /api/clients/{slug}/campaigns | campaigns.py | 1 | ☐ |
| 12 | GET | /api/clients/{slug}/periods | campaigns.py | 1 | ☐ |
| 13 | GET | /api/clients/{slug}/creatives | campaigns.py | 1 | ☐ |
| 14 | GET | /api/clients/{slug}/top-ads | campaigns.py | 1 | ☐ |
| 15 | GET | /api/clients/{slug}/campaigns/{campaign_id}/adsets | campaigns.py | 1 | ☐ |
| 16 | GET | /api/clients/{slug}/adsets/{adset_id}/ads | campaigns.py | 1 | ☐ |
| 17 | GET | /api/services | services.py | 1 | ☐ |
| 18 | GET | /api/service-targets | service_targets.py | 1 | ◐ |
| 19 | PUT | /api/service-targets | service_targets.py | 2 | ◐ |
| 20 | DELETE | /api/service-targets/{service}/{platform} | service_targets.py | 2 | ◐ |
| 21 | POST | /api/service-targets/reseed | service_targets.py | 2 | ◐ |
| 22 | GET | /api/clients/{slug}/funnel | funnel.py | 1 | ☐ |
| 23 | GET | /api/clients/{slug}/google-ads | google_ads.py | 1 | ☐ |
| 24 | GET | /api/portfolio | actions.py | 1 | ☐ |
| 25 | GET | /api/clients/{slug}/scorecard | actions.py | 1 | ☐ |
| 26 | GET | /api/clients/{slug}/recommendations | actions.py | 1 | ☐ |
| 27 | GET | /api/recommendations/tracking | actions.py | 1 | ☐ |
| 28 | POST | /api/clients/{slug}/recommendations/{rec_id}/approve | actions.py | 2 | ☐ |
| 29 | POST | /api/clients/{slug}/recommendations/{rec_id}/dismiss | actions.py | 2 | ☐ |
| 30 | POST | /api/recommendations/bulk-approve | actions.py | 2 | ☐ |
| 31 | POST | /api/clients/{slug}/recommendations/{rec_id}/execute | actions.py | 4 | ☐ |
| 32 | POST | /api/recommendations/bulk-execute | actions.py | 4 | ☐ |
| 33 | GET | /api/brief/dates | brief.py | 1 | ☐ |
| 34 | GET | /api/brief | brief.py | 1 | ☐ |
| 35 | POST | /api/brief/run | brief.py | 4 | ☐ |
| 36 | GET | /api/integrations | integrations.py | 1 | ☐ |
| 37 | POST | /api/integrations/run | integrations.py | 3 | ☐ |
| 38 | POST | /api/integrations/propose-tracking | integrations.py | 4 | ☐ |
| 39 | GET | /api/sync/status | sync.py | 1 | ◐ |
| 40 | POST | /api/sync/trigger | sync.py | 4 | ☐ |
| 41 | GET | /api/setters/leaderboard | setters.py | 1 | ☐ |
| 42 | GET | /api/audit-log | audit.py | 1 | ☐ |
| 43 | GET | /api/clients/{slug}/ai-bundle | export.py | 1 | ☐ |
| 44 | GET | /api/export/ai-bundle | export.py | 1 | ☐ |
| 45 | GET | /api/builds | builds.py | 1 | ☐ |
| 46 | POST | /api/builds | builds.py | 2 | ☐ |
| 47 | GET | /api/builds/{build_id} | builds.py | 1 | ☐ |
| 48 | DELETE | /api/builds/{build_id} | builds.py | 2 | ☐ |
| 49 | PATCH | /api/builds/{build_id}/brief | builds.py | 2 | ☐ |
| 50 | GET | /api/builds/{build_id}/geo | builds.py | 1 | ☐ |
| 51 | POST | /api/builds/{build_id}/assets | builds.py | 2 | ☐ |
| 52 | DELETE | /api/builds/{build_id}/assets/{asset_id} | builds.py | 2 | ☐ |
| 53 | GET | /api/builds/{build_id}/messages | builds.py | 1 | ☐ |
| 54 | POST | /api/builds/{build_id}/messages | builds.py | 4 | ☐ |
| 55 | PUT | /api/builds/{build_id}/plan | builds.py | 2 | ☐ |
| 56 | POST | /api/builds/{build_id}/validate | builds.py | 2 | ☐ |
| 57 | POST | /api/builds/{build_id}/approve | builds.py | 4 | ☐ |
| 58 | GET | /api/plugin/clients | plugin.py | 2 | ☐ |
| 59 | POST | /api/plugin/benchmarks | plugin.py | 2 | ☐ |
| 60 | POST | /api/plugin/triage-runs | plugin.py | 2 | ☐ |
| 61 | POST | /api/plugin/recommendations | plugin.py | 2 | ☐ |
| 62 | PATCH | /api/plugin/recommendations/{rec_id} | plugin.py | 2 | ☐ |
| 63 | POST | /api/plugin/notify | plugin.py | 2 | ☐ |

Scheduled jobs (Phase 3/4): `sync_meta_all`, `sync_google_all`, `sync_ghl_all`,
`sync_booking_sheets`, `sync_setters`, `integration_health`, `export_sheets`,
`daily_brief`, `slack_daily_report` — schedules in `backend/app/celery_app.py`.

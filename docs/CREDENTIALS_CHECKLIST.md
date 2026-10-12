# Credentials checklist

Every secret the system needs: what it is for, where it lives, who owns it, how to rotate it.
Names only. **Never paste a value into git, a prompt, Slack, email or a document.** Hand values
over in a password manager or in person.

Allowed storage locations (nothing else):

| Location | Holds | Notes |
|---|---|---|
| `~/zms-ad-reporting/backend/.env` (Mac mini) | production backend secrets | gitignored; mode 600; mounted read-only into api/worker/beat via `env_file` |
| `~/zms-ad-reporting/backend/.env.staging` (Mac mini) | staging backend secrets | own Supabase project; never production tokens |
| `~/zms-ad-reporting/.env` and `.env.staging` (Mac mini) | web build args (`NEXT_PUBLIC_*`) | public keys only |
| `~/.config/zms/*.env` (Mac mini, mode 600) | operator API tokens for the cloud scripts | `cloudflare.env`, `supabase-staging.env` |
| `~/.cloudflared/` (Mac mini, root-owned) | tunnel credentials JSON + `config.yml` | shared with the SEO dashboard |
| GitHub repo secrets / variables | CI + deploy only | never the Meta/Google/GHL tokens |
| Encrypted off-site copy (`age`) | backup of the above | see `BACKUP_RESTORE.md` (TODO (deploy)) |

## Backend (`backend/.env`, `backend/.env.staging`)

| Variable | Purpose | Owner | Rotation |
|---|---|---|---|
| `SUPABASE_URL` | project API base URL | Carl | not secret; changes only with a new project |
| `SUPABASE_ANON_KEY` | publishable key; RLS-limited browser + api reads | Carl | Supabase -> Settings -> API Keys -> create new publishable key, update `.env` + root `.env`, rebuild web, delete old |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key; bypasses RLS; api writes, audit log, `client_secrets` | Carl | Supabase -> API Keys -> create new secret key, update `.env`, restart api/worker/beat, delete old. Rotate immediately if the Mac is lost |
| `SUPABASE_JWT_SECRET` | legacy HS256 verification (blank on new projects; tests only) | Carl | leave blank |
| `SUPABASE_DB_URL` | session-mode pooler URL incl. DB password (dlt + api reads) | Carl | Supabase -> Settings -> Database -> Reset database password; update `.env`, restart stack |
| `META_SYSTEM_USER_TOKEN` | Meta Marketing API system-user token (ads_read, business_management) for every client ad account shared to the ZMS Business Manager | Carl (Meta BM admin) | Meta Business Settings -> System Users -> Generate new token; update `.env`; restart worker; revoke old |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API developer token (MCC) | Carl | Google Ads -> API Center |
| `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` | OAuth client for the Google Ads refresh token | Carl (Google Cloud project) | Cloud Console -> Credentials -> reset secret; re-run the OAuth loopback flow to mint a new refresh token |
| `GOOGLE_ADS_REFRESH_TOKEN` | OAuth refresh token under Zeal's MCC | Carl | re-run OAuth flow; old token revoked at myaccount.google.com -> Security -> Third-party access |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC id, digits only | Carl | not secret |
| `GOOGLE_SHEETS_REFRESH_TOKEN` | OAuth token for the daily Sheets export | Carl | same as above |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | optional service account (Sheets + Drive read-only) for the setter leaderboard | Carl | Cloud Console -> Service accounts -> Keys -> add key, update `.env`, delete old key |
| `GHL_AGENCY_TOKEN` | GoHighLevel agency token or PIT (limited use; location data needs per-client PITs) | Carl | GHL -> Settings -> Private Integrations -> rotate |
| Per-client GHL PIT (`client_secrets.ghl_token`, not an env var) | location-level Private Integration token per client | Carl | rotate in that GHL sub-account, then Settings page -> edit client -> paste new token (write-only field) |
| `PLUGIN_API_TOKEN` | bearer token for `/api/plugin/*` used by the zeal-paid-ads Claude Code plugin | Carl | `openssl rand -hex 32`; update `backend/.env`, restart api; give the new value to every plugin operator (`plugins/meta-ads/.env` on their machine) |
| `SLACK_WEBHOOK_URL` | incoming webhook for health alerts + `/notify` (blank by choice today) | Carl | Slack -> Apps -> Incoming Webhooks -> regenerate |
| `REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND` | internal Redis (no auth, compose network only) | n/a | not secret |
| `ENVIRONMENT`, `DASHBOARD_URL`, `ALLOWED_ORIGINS`, `GIT_SHA`, `RATE_LIMIT_*`, `HEALTH_SYNC_STALE_HOURS`, `LOG_LEVEL`, `TZ`, `SETTER_*` | configuration, not secrets | n/a | n/a |

## Frontend (root `.env`, `.env.staging`, `frontend/.env.example`)

| Variable | Purpose | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL baked into the browser bundle | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable key baked into the bundle (RLS applies) | no (public by design) |
| `API_URL` | api base for the Next rewrite (`http://api:8000` in compose) | no |
| `NEXT_PUBLIC_ENVIRONMENT`, `NEXT_PUBLIC_GIT_SHA` | banner + `/healthz` version | no |

Nothing with `SERVICE_ROLE`, `TOKEN` or `SECRET` may ever appear in `frontend/`.

## Operator tokens (`~/.config/zms/*.env`, Mac mini only)

| File / variable | Purpose | Owner | Rotation |
|---|---|---|---|
| `cloudflare.env`: `CF_API_TOKEN`, `CF_ACCOUNT_ID` | `scripts/cloud/cloudflare-*.py` (DNS, tunnel config, Access, rate rule) | Carl | Cloudflare -> My Profile -> API Tokens -> roll; scope: Zone DNS edit, Cloudflare Tunnel edit, Access edit, Zone WAF edit for this zone only |
| `SUPABASE_ACCESS_TOKEN` (env, or read from `~/zeal-paid-ads/plugins/meta-ads/.env`) | `scripts/cloud/supabase-*.py` (Management API) | Carl | supabase.com/dashboard/account/tokens -> revoke + create |
| `supabase-staging.env`: `SUPABASE_STAGING_REF`, `_DB_PASSWORD`, `_ANON_KEY`, `_SERVICE_ROLE_KEY`, `_DB_URL` | written by `supabase-staging-create.py`; source for `backend/.env.staging` | Carl | reset in the staging project |

## Cloudflare Tunnel (`~/.cloudflared/`)

| Item | Purpose | Rotation |
|---|---|---|
| `b9929fe5-4b97-4708-acdb-734c224430e5.json` | tunnel credentials (shared with the SEO dashboard) | Cloudflare Zero Trust -> Networks -> Tunnels -> refresh token; replace file; `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`. Coordinate: the SEO dashboard goes down during the swap |
| `config.yml` | local config (ingress in it is stale; ingress is remote-managed) | not secret |

## GitHub (repo `zmsseoagency/zms-ad-reporting`)

| Secret / variable | Purpose | Notes |
|---|---|---|
| GHCR push: built-in `GITHUB_TOKEN` | image publish | no extra secret |
| Self-hosted runner registration token | one-time runner install on the Mac mini (user `deploy`) | short-lived; TODO (deploy) |
| Production deploy allow-list (actor logins) | typed-confirmation gate in `deploy-production.yml` | repository variable, not a secret |
| Nothing else | Meta/Google/GHL/Supabase service keys are **not** GitHub secrets; the runner reads them from `$HOME/.zms-ads/secrets/<env>/` on the Mac mini | see `scripts/lib.sh` `ZMS_SECRETS_DIR` |

## Rules

1. `.env`, `.env.*` are gitignored; `git ls-files | grep '\.env'` must stay empty. Push protection
   and secret scanning on the repo: TODO (Carl).
2. One person owns each credential (Carl today). Media buyers get a dashboard login and, for the
   plugin, `PLUGIN_API_TOKEN` + a read-only Supabase token + a per-client GHL PIT (see
   `~/zeal-paid-ads/docs/TEAM_HANDOFF.md` section 5).
3. Rotate everything in this file if the Mac mini is lost or stolen (FileVault is off).
4. Rotate `PLUGIN_API_TOKEN` and the per-client GHL PITs when an operator leaves.
5. Staging never holds production tokens. Staging Meta/Google/GHL values may be blank; syncs
   then log errors and `/api/health` reports `degraded`, which is expected.

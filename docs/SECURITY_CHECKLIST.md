# Security checklist

Status legend: **Done in code** = implemented on branch `hardening/phase-1` (takes effect on
deploy). **TODO (Carl)** = one-time action by the Agency Owner outside the repo. **TODO (deploy)**
= happens when the deploy scripts/workflows run. **Deferred** = not in this phase.
Last reviewed 2026-09-16.

## Accounts and access

| Control | Implementation | Status | Verify |
|---|---|---|---|
| Separate account per person, no shared admin login | Supabase Auth users, one per person; role in `profiles.role`; invite-only (`disable_signup`) via `scripts/cloud/supabase-auth-hardening.py` | TODO (Carl): run script `--apply`, invite media buyer (see `MEDIA_BUYER_ONBOARDING.md`) | Supabase Dashboard -> Authentication -> Users: one row per person; Sign-up disabled under Providers -> Email |
| RBAC (admin / media_buyer / viewer) | `backend/app/core/policy.py`, `security.py` (`require_role`, `AdminUser`, `ApproverUser`); migration `20260917000011` widens the `profiles.role` check; UI mirror `frontend/src/lib/permissions.ts` | Done in code; TODO (deploy): apply migration 11 | `pytest backend/tests/test_policy.py`; as a viewer, `POST .../approve` returns 403 |
| Approval verification (a person, not the plugin) | `routers/actions.py` sets `approved_by_id = auth.users.id`; `routers/plugin.py` refuses `status=approved` (409) and refuses execute when `approved_by` is empty | Done in code | `pytest backend/tests/test_plugin_transitions.py`; PATCH with plugin token and `status=approved` -> 409 + `audit_log` row `recommendation.approve_denied` |
| Budget increase > 20 % owner-only; `activate` never executable | `policy.can_approve()`, `HUMAN_ONLY_ACTIONS` | Done in code | `GET /api/me` shows `approve_large_budget=false` for media_buyer |
| Tenant isolation (clients) | Single agency; all rows keyed by `client_id`; browser reads via RLS `authenticated` select; writes only via service role in the api. Per-client isolation between media buyers is not a requirement today | Done in code (single tenant) | Migrations: every table has `enable row level security` |
| Row-Level Security | All tables RLS on. Metrics/config: authenticated read, no write policies (service role writes). `audit_log`: admin reads all, users read own rows, append-only trigger. `client_secrets`, `app_settings`, `setter_*`: RLS with no policies (service role only) | Done in code | Supabase -> Database -> Policies; `select * from client_secrets` as an authenticated user returns 0 rows |
| MFA | Supabase TOTP enroll/verify enabled by hardening script; optional for media buyers, expected for the owner | TODO (Carl): enrol TOTP on the owner account | Supabase -> Authentication -> Users -> factors |
| Strong passwords | `password_min_length=12`, letters + digits required, HIBP leaked-password check, via hardening script | TODO (Carl): run script `--apply` | Script dry run prints no diff |
| Sessions | Supabase cookie session via `@supabase/ssr` (`frontend/src/proxy.ts`), refresh-token rotation on, `sessions_timebox` 12 h, reuse interval 10 s (hardening script) | Done in code / TODO (Carl): apply script | Auth config shows `sessions_timebox=43200` |

## Application

| Control | Implementation | Status | Verify |
|---|---|---|---|
| Rate limiting | Cloudflare zone rule 60 req / 10 s per IP on `/api/*` (`scripts/cloud/cloudflare-ratelimit.py`); slowapi per-IP in the api (`ratelimit.py`): default 600/min, mutations 30/min, plugin 120/min, keyed on `CF-Connecting-IP` | Done in code; TODO (Carl): run the Cloudflare script `--apply` | 31 approve calls in a minute -> 429; Cloudflare -> Security -> WAF -> Rate limiting rules |
| CSRF | `OriginCheckMiddleware`: non-GET `/api/*` with an Origin/Referer outside `allowed_origin_hosts` -> 403; SameSite cookies; CSP `form-action 'self'` | Done in code | `pytest backend/tests/test_middleware.py`; `curl -X POST -H 'Origin: https://evil.example' .../api/sync/trigger` -> 403 |
| Security headers | Next `headers()` in `frontend/next.config.ts`: CSP, HSTS (2 y, preload), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy; api adds nosniff/DENY/no-referrer/`Cache-Control: no-store` | Done in code | `curl -sI https://adbuildout.contractorscalingblueprint.com/ \| grep -iE 'strict-transport\|content-security\|x-frame'` |
| Input validation | Pydantic models with `extra="forbid"`, `max_length`, `Literal` enums, regex on query params (`routers/plugin.py`, `sync.py`, `audit.py`, `clients.py`) | Done in code | Unknown field in a plugin POST -> 422 |
| File uploads | Campaign Builder creatives: MIME allow-list (JPG/PNG/WebP, MP4/MOV), 30 MB images / 200 MB videos, image header verified with Pillow, stored in the private Supabase Storage bucket `campaign-assets` (service-role only), 1 h signed URLs, filenames sanitised (`routers/builds.py`, `services/builder/storage.py`) | Done in code | Upload a .exe → 415; a 40 MB image → 413 |
| Secrets never in frontend or git | Only `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` reach the browser; `.env*` gitignored; `backend/.env` mounted via `env_file` only | Done in code | `git ls-files \| grep -E '\.env$'` returns nothing; `grep -r SERVICE_ROLE frontend/src` returns nothing |
| Encrypted secrets at rest | Meta/Google/GHL tokens in `backend/.env` on the Mac mini (APFS, FileVault OFF, see `STARTUP_RECOVERY.md`); GHL PITs in `client_secrets` (RLS, service-only). `pgsodium` column encryption for `client_secrets.ghl_token` | Deferred (pgsodium); TODO (Carl): encrypted off-site copy of env files with `age` (see `BACKUP_RESTORE.md`) | `ls -l backend/.env` mode 600; no plaintext copies elsewhere |
| Audit logging | `audit_log` table (migration 11), writer `core/audit.py` with secret redaction, reader `routers/audit.py` (admin only), append-only trigger + revoked update/delete | Done in code; TODO (deploy): migration 11 | `pytest backend/tests/test_audit.py`; `update audit_log set action='x'` raises `audit_log is append-only` |
| API docs off in production | `docs_url=None`, `openapi_url=None` when `ENVIRONMENT=production` (`backend/app/main.py`) | Done in code | `curl -sI https://adbuildout…/api/docs` -> 404 |
| Non-root, read-only containers | `docker-compose.yml`: `read_only`, tmpfs, `cap_drop: ALL`, `no-new-privileges`, digest-pinned redis, non-root users from the images | Done in code (owned by the compose/Dockerfile agent) | `docker inspect zms-ads-api --format '{{.Config.User}}'` |
| Dependency scanning | `security.yml` weekly (`pip-audit`, `npm audit`, CodeQL) + Dependabot | Done in code (`.github/workflows/security.yml`, `.github/dependabot.yml`); TODO (Carl): GitHub Team upgrade if secret scanning / CodeQL on the private repo is wanted | GitHub -> Security tab shows runs |
| Tests as a gate | `ruff`, `pytest`, `eslint`, `tsc --noEmit`, `vitest` in `ci.yml` | Done in code (`.github/workflows/ci.yml`, 49 backend + 33 frontend tests) | `cd backend && pytest`; `cd frontend && npm test` |

## Infrastructure

| Control | Implementation | Status | Verify |
|---|---|---|---|
| No open inbound ports / no residential IP exposure | Cloudflare Tunnel is outbound-only; all compose ports bound to 127.0.0.1; no router forwarding | Done (verified 2026-09-16 on the host); TODO (Carl): confirm the router has no forwarding rules | From outside: `nmap -Pn <home IP>` shows nothing for 22/3010/8010; `docker ps` shows only `127.0.0.1:` bindings |
| No public SSH | macOS Remote Login is on locally; router status unknown. Plan 3.9: Tailscale SSH, then turn Remote Login off | TODO (Carl) | System Settings -> General -> Sharing -> Remote Login off; `tailscale status` logged in |
| HTTPS only | Cloudflare edge TLS; HSTS preload header | Done | `curl -sI http://adbuildout…/` -> 301 to https |
| Staging access control | Cloudflare Access app on `staging-adbuildout.`: one-time PIN, `@zealmediasolutions.com` (`scripts/cloud/cloudflare-access-staging.py`) | TODO (Carl): run script `--apply` | Incognito visit to staging shows the Cloudflare Access login |
| Health checks | `GET /api/health/live` (process), `GET /api/health` (Postgres, Redis, last sync per source < 26 h, 503 on failure), `GET /healthz` (web); compose `healthcheck:` on every service | Done in code | `curl -s https://adbuildout…/api/health \| jq .status` -> `ok` |
| Error monitoring / alerts | Slack daily health alert task exists (`SLACK_WEBHOOK_URL` blank by choice); external uptime monitor + Sentry recommended | TODO (Carl): pick alert channel; TODO (deploy): UptimeRobot / Healthchecks.io | See `STARTUP_RECOVERY.md` alerts section |
| Database backups | Supabase Free plan: PITR off, no managed backups. Recommendation: Pro plan. Independent nightly `pg_dump` via `scripts/backup-db.sh` + `infra/launchd/com.zms.backup-db.plist` | TODO (Carl): approve Pro, choose off-site bucket, create the `age` key, install the plist | Supabase -> Database -> Backups lists daily backups; `scripts/verify-backup.sh` passes |
| Config backups | Weekly encrypted bundle of `.env*`, compose files, `~/.cloudflared`, launchd plists (`BACKUP_RESTORE.md`) | TODO (deploy) | Bundle present off-site, decrypts with the `age` key |
| Deploy approval | GitHub Free: no branch protection on private repos. `deploy-production.yml` requires a typed confirmation and an actor allow-list; GitHub Team would add real protections | Done in code (`.github/workflows/deploy-production.yml`); TODO (Carl): set `PRODUCTION_DEPLOYERS`, decide on Team upgrade | Workflow run log shows the confirmation step |
| Source off the Mac mini | Private repo `zmsseoagency/zms-ad-reporting` (`git remote -v`) | Done | `git fetch origin` succeeds |
| Unattended reboot trade-off | FileVault OFF + auto-login `zms` so containers come back without a person typing a password. Physical theft of the Mac mini exposes `backend/.env` in plaintext | Accepted risk; mitigations: rotate all tokens if the machine is lost (`CREDENTIALS_CHECKLIST.md`), keep the Mac in a locked space | `fdesetup status` -> Off (expected) |

## Public read-only mode (since 2026-09-25)

Carl: "remove the login feature, anyone can see it if they have the domain." With
`PUBLIC_READ=true` in `backend/.env` the API treats a request without a bearer token as an
anonymous **viewer** (`app/core/security.py`), and the web proxy only redirects to /login for
`/settings`, `/build`, `/account`, `/set-password`. Every write endpoint still checks the
role (approve / dismiss / execute / builds / settings / sync / brief run / service targets),
so anonymous visitors can read every page and download the AI bundle but cannot change
anything. Pages carry `robots: noindex`. To go back to login-only, set `PUBLIC_READ=false`
and redeploy. Trade-off accepted by Carl: every client's spend, lead and booking numbers
are visible to anyone who has the URL.

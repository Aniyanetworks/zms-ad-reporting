# Deployment & hardening plan — ZMS Ads dashboard on the Mac mini

Status: **approved by Carl 2026-09-16 ("build it all out"); implementation in progress on branch
`hardening/phase-1`.** Phase 0 done (private repo `zmsseoagency/zms-ad-reporting`, rollback image tags).
Cloud/system changes that the tooling cannot perform unattended are packaged as
`scripts/cloud/*.py --apply` and listed in the PR for Carl to run.
Prepared 2026-09-16 from a read-only inspection of the Mac mini, the repo, Cloudflare,
GitHub and Supabase. Decisions taken with Carl in the same session:

| Decision | Choice |
|---|---|
| Scope | Harden and extend the **existing** dashboard (`~/zms-ad-reporting`), not a new app |
| Production hostname | `adbuildout.contractorscalingblueprint.com` (new). `ads.` stays as an alias until retired; `setter.` unchanged |
| Staging hostname | `staging-adbuildout.contractorscalingblueprint.com`, behind Cloudflare Access |
| First platform for the build flow | Meta Ads |
| Remote MCP (`mcp.` subdomain) | Deferred to a later phase; DNS name reserved, nothing deployed |

---

## 1. What exists today (verified)

| Spec requirement | Status | Evidence |
|---|---|---|
| Next.js TypeScript app | ✅ | `frontend/` (Next 15, App Router) |
| Docker Compose on Mac mini | ✅ | 5 services `zms-ads-*`, all `restart: unless-stopped`, ports bound to 127.0.0.1 |
| Managed Supabase (Postgres, Auth, RLS) | ✅ | project `ayxvikfnktlxtpgzcrok`, org `zms-ads`, us-east-2, healthy |
| Cloudflare Tunnel, HTTPS only | ✅ | tunnel `zms-seo-dashboard` (b9929fe5…), remote-managed ingress, `ads.`/`setter.` → :3010 |
| Cloudflare-managed subdomains | ✅ | zone `contractorscalingblueprint.com` on Free plan |
| Background worker | ✅ | Celery worker + beat (Meta/Google/GHL/Sheets syncs) |
| **Private GitHub repo** | ✅ (2026-09-16) | was local-only with no remote; now `github.com/zmsseoagency/zms-ad-reporting` (private), `main` pushed |
| Automated deployment | ❌ | manual `docker compose up --build` |
| Staging environment | ❌ | none |
| CI (lint, types, tests) | ❌ | no `.github/`, no eslint config, 3 pytest files exist |
| Health checks | ⚠️ | `/api/health` returns static `ok`; no DB/Redis check; no web health route; no compose `healthcheck:` on api/web/worker |
| Structured logs | ❌ | uvicorn/celery default text logs |
| Pinned image versions | ⚠️ | `redis:7-alpine`, `python:3.12-slim`, `node:22-alpine` — tag-pinned, not digest-pinned |
| Non-root containers | ❌ | both Dockerfiles run as root |
| Roles | ⚠️ | `profiles.role ∈ {admin, viewer}`; 1 admin + 1 viewer user; role is not enforced on any write route |
| Approval verification | ⚠️ | approvals go through `PATCH /api/plugin/recommendations` with the **shared plugin bearer token**; `actor` is a free-text field — not tied to a logged-in user |
| Audit log | ❌ | only `recommendations.approved_by/executed_by` and `sync_runs` |
| Strong passwords / MFA | ⚠️ | Supabase min length **6**, no character rules, leaked-password check off; TOTP MFA enabled but not enforced; **public sign-up not disabled** |
| Rate limiting / CSRF / security headers | ❌ | none in Next or FastAPI; no Cloudflare rate rule |
| Secrets | ✅/⚠️ | `.env` files gitignored, not in repo; but no encrypted off-site copy |
| Database backups | ❌ | Supabase reports **PITR off, 0 backups** (consistent with Free plan) |
| Config backups | ❌ | none |
| Error monitoring / alerts | ❌ | none (Slack webhook blank by choice) |
| Dependency/security scanning | ❌ | none |
| Mac mini: no sleep, auto-restart | ✅ | `sleep 0`, `autorestart 1`, `womp 1`, `caffeinate -dimsu` LaunchAgent |
| Docker starts at login | ✅ | Docker Desktop `AutoStart: true`; auto-login user `zms` (FileVault **off** — required for unattended reboot) |
| Tunnel starts at boot | ✅ | LaunchDaemon `com.cloudflare.cloudflared` (RunAtLoad + KeepAlive), runs as root |
| Private admin access | ⚠️ | Tailscale installed but **logged out**; macOS Remote Login (sshd) is on locally — router port-forwarding not verifiable from the host |
| UPS | ❌ | none attached |
| macOS auto-updates | ⚠️ | "Automatically install macOS updates" is **on** → unattended reboots possible |
| Supabase security advisors | ⚠️ | 1 ERROR (`v_client_scorecard` is SECURITY DEFINER), 3 WARN (`handle_new_user()` executable by anon/authenticated; leaked-password protection off) |
| Host Python | ❌ | every Homebrew Python (3.12, 3.14) has a broken `pyexpat` (libexpat mismatch) — blocks host-side tooling incl. the Google Ads write server |
| Second tenant on the box | ℹ️ | SEO dashboard stack (`zms-*`, ports 3000/8000/6379) shares the Mac mini and the tunnel — must not be disturbed |

Uncommitted work in the repo right now: setter leaderboard + booking-sheet changes (14 modified, 5 new files). Phase 0 preserves it.

---

## 2. Target architecture (delta only)

```
                    Cloudflare (DNS + TLS + WAF rate rule + Access on staging)
                                      │ tunnel b9929fe5 (outbound only)
   ┌──────────────────────────────────┴──────────────────────────────────┐
   │ Mac mini (M4, macOS 26.2, Docker Desktop)                           │
   │                                                                     │
   │  compose project zms-ads (PRODUCTION)   compose project zms-ads-stg │
   │   web  127.0.0.1:3010  ← adbuildout.*    web  127.0.0.1:3011        │
   │   api  127.0.0.1:8010    (+ ads.*, setter.*)  api  127.0.0.1:8011   │
   │   worker, beat, redis :6380              worker, beat, redis :6381  │
   │   env: backend/.env.production           env: backend/.env.staging  │
   │                                                                     │
   │  GitHub Actions self-hosted runner (user `deploy`, repo-scoped)     │
   │  nightly: pg_dump → encrypted → off-site; config bundle → off-site  │
   │  unchanged: SEO stack (3000/8000), cloudflared LaunchDaemon         │
   └─────────────────────────────────────────────────────────────────────┘
        prod → Supabase ayxvikfnktlxtpgzcrok        staging → new free Supabase project
```

Staging gets its **own Supabase project** (free tier) seeded from the production schema via
migrations, with a nightly anonymised copy of `clients`/metrics optional. Staging never
holds production tokens.

---

## 3. Phases

### Phase 0 — Safety net (repo only, no system changes) — do first

1. Commit the current working tree on branch `wip/setter-leaderboard` so nothing is lost; merge to `main` after a quick review.
2. Create **private** GitHub repo `zmsseoagency/zms-ad-reporting`, add remote, push `main`. Enable: branch protection on `main` (PR required, 1 review, status checks), Dependabot alerts + security updates, secret scanning, push protection.
3. Tag the running images (`zms-ad-reporting-*:latest`) as `:prod-2026-09-16` so a rollback target exists before any rebuild.
4. Encrypted first backup of `backend/.env`, `frontend/.env*`, `~/.cloudflared/*`, launchd plists with `age` to an off-site location (Carl's password manager or a private bucket). Documented in `docs/BACKUP_RESTORE.md`.

### Phase 1 — Application hardening (repo, deployed via the normal path)

| Area | Change |
|---|---|
| Health | `GET /api/health` → checks Postgres, Redis, last successful `sync_runs` per source (< 26 h), returns 503 on failure; `GET /healthz` in Next (static) ; compose `healthcheck:` on api, web, worker (`celery inspect ping`) |
| Roles | rename semantics: `admin` = Agency Owner, `viewer` → `media_buyer` (migration adds `'media_buyer'`, keeps `'viewer'` read-only). New FastAPI dependency `require_role()` verifying the Supabase JWT on every mutating route |
| Approval verification | new authenticated routes `POST /api/recommendations/{id}/approve|dismiss` (JWT user, role owner/media_buyer); `PATCH /api/plugin/recommendations` **loses** the `approved` transition — the plugin token can only propose/execute/fail. Execute refuses unless `approved_by` is a real `auth.users.id` |
| Human-control rules | `activate` recs remain refused by `/execute`; new `budget_change` above +20 % requires owner role; every created object is PAUSED (already true) — encoded in a `policy.py` module with tests |
| Audit log | migration `audit_log(id, at, actor_id, actor_email, action, entity_type, entity_id, client_id, before, after, request_id, ip)`; written from approve/dismiss/execute/sync-trigger/settings changes; RLS: owner reads all, media buyer reads own client rows; append-only (no update/delete grants) |
| Sessions | keep Supabase SSR cookies (HttpOnly, Secure, SameSite=Lax) + set `sessions_timebox` 12 h, refresh-token rotation already on |
| CSRF | Origin/Referer check middleware on all non-GET `/api/*` requests against the allowed hostnames; SameSite cookies |
| Security headers | Next `headers()`: CSP (self + Supabase URL), HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy |
| Rate limiting | Cloudflare rate-limiting rule (free tier: 1 rule) on `/api/*` + `slowapi` per-IP limits on login-adjacent and plugin routes |
| Input validation | already Pydantic; add `max_length` on all text fields, strict enums, reject unknown fields |
| Uploads | none exist today; when creative uploads land: Supabase Storage bucket, 25 MB, image/video MIME allow-list, signed URLs, RLS by client |
| Structured logs | JSON logs (python-json-logger) for api/worker with request id; Next uses `pino` JSON in server code; `docker logs` stays the collector |
| Graceful shutdown | uvicorn already handles SIGTERM; add `stop_grace_period: 30s` and celery `--soft-time-limit`; Next `next start` handles SIGTERM |
| Container hardening | `USER app` non-root in both Dockerfiles; images pinned by digest via `docker-compose.yml` + monthly Dependabot bump; `security_opt: [no-new-privileges:true]`; `read_only: true` + tmpfs where possible; no bind mounts except env files; `cap_drop: [ALL]` |
| Supabase config | `disable_signup: true` (invite-only), `password_min_length: 12` + letters/digits, leaked-password protection on, MFA optional-then-required for owner; fix advisors: `v_client_scorecard` → `security_invoker`, revoke `execute` on `handle_new_user()` from anon/authenticated; redirect allow-list += `adbuildout.*`, `staging-adbuildout.*` |
| Encrypted secrets | Meta/Google/GHL tokens stay in `.env` (never in the repo/browser); per-client GHL tokens in `client_secrets` get `pgsodium` column encryption; future OAuth refresh tokens use the same column type |
| Tests | `ruff` + `pytest` (backend), `eslint` + `tsc --noEmit` + `vitest` (frontend), one compose-based integration test hitting `/api/health` and an authenticated route |

### Phase 2 — Staging + CI/CD (repo + GitHub, one Mac mini change: the runner)

1. `compose.yaml` (shared) + `compose.prod.yaml` / `compose.staging.yaml` overlays: distinct project names, ports (3011/8011/6381 for staging), env files, image tags `ghcr.io/zmsseoagency/zms-ads-{api,web}:<sha>`.
2. Scripts: `scripts/deploy.sh <staging|production> <sha>` (pull, `compose up -d --wait`, health gate, keeps previous tag in `.last_good`), `scripts/rollback.sh <env>`, `scripts/backup-db.sh`, `scripts/verify-backup.sh` (restores latest dump into a throwaway Postgres container and row-counts key tables), `scripts/health.sh`.
3. GitHub Actions:
   - `ci.yml` (PRs): ruff, pytest, eslint, tsc, vitest, `supabase db diff` against a shadow DB to flag **destructive** migration statements (DROP/TRUNCATE/ALTER … DROP COLUMN → fail unless label `allow-destructive` and owner review), build images.
   - `deploy-staging.yml` (push to `main`): push images to GHCR, self-hosted runner deploys to staging, runs smoke tests against `staging-adbuildout.*`.
   - `deploy-production.yml` (manual, `environment: production` with **required reviewer = Carl**): promotes the **same SHA** verified on staging; never runs migrations automatically unless the migration check passed and a human approved; keeps previous image for `rollback.sh`.
   - `security.yml` weekly: `pip-audit`, `npm audit`, CodeQL; Dependabot for pip/npm/actions/docker.
4. Self-hosted runner: dedicated **standard (non-admin) macOS user `deploy`** in group `docker`-equivalent (Docker Desktop socket access via `com.docker.socket`), runner registered to **this one repo only**, started by a user LaunchAgent, no sudo. This is the only Phase-2 change on the machine.

### Phase 3 — Mac mini, Cloudflare, Supabase system changes (each needs a separate "yes")

| # | Change | Reversible? |
|---|---|---|
| 3.1 | Cloudflare DNS: CNAME `adbuildout` and `staging-adbuildout` → `b9929fe5….cfargotunnel.com` (proxied) | yes, delete records |
| 3.2 | Tunnel remote ingress: `adbuildout.*` → :3010, `staging-adbuildout.*` → :3011 (leave all existing rules) | yes, remove rules |
| 3.3 | Cloudflare Access application on `staging-adbuildout.*`: allow-list of Zeal emails, one-time PIN (free ≤ 50 users) | yes |
| 3.4 | Cloudflare rate-limiting rule on `/api/*` (e.g. 300 req / min / IP) and the missing WAF managed rule the `ads.` migration left out | yes |
| 3.5 | Supabase Auth: `site_url` → `https://adbuildout.…`, allow-list update, password policy, `disable_signup`, leaked-password check | yes |
| 3.6 | `DASHBOARD_URL`, CORS origins, `allowedDevOrigins`, plugin `config.json` → `adbuildout.*` (ads.* kept in allow-lists) | yes |
| 3.7 | Create macOS user `deploy` (standard), install runner | yes |
| 3.8 | System Settings → Software Update: turn **off** "Automatically install macOS updates" (keep security responses + app updates); owner schedules updates | yes |
| 3.9 | Tailscale: log in with Carl's identity, enable **Tailscale SSH** (per-user keys, ACL, session logs), then turn **off** macOS Remote Login so sshd is not on the LAN at all | yes |
| 3.10 | `brew upgrade cloudflared` (2026.5.2 → 2026.9.1) and `brew reinstall python@3.12` (fixes broken pyexpat) | yes |
| 3.11 | Recommend + attach UPS (see §5) | n/a |

Nothing in Phase 3 opens a router port, exposes SSH publicly, or reveals the residential IP: the tunnel and Tailscale are both outbound-only.

### Phase 4 — Backups, monitoring, alerts

- **Database:** upgrade Supabase to **Pro** (daily backups, 7-day retention; PITR add-on optional) — the project currently has **no backups at all**. Independently, `scripts/backup-db.sh` runs nightly from the Mac mini (Celery beat or launchd): `pg_dump --format=custom` via the pooler → `age`-encrypt → upload to an off-site bucket (Backblaze B2 or a second Supabase Storage bucket in the staging project). 30-day retention. `verify-backup.sh` runs weekly and posts the result.
- **Config:** weekly encrypted bundle of `.env.*`, compose files, `~/.cloudflared`, launchd plists, runner config → same bucket.
- **Restore:** `docs/BACKUP_RESTORE.md` covers full restore to a fresh Supabase project (create project → `supabase db push` migrations → `pg_restore` data → rotate keys → update `.env`) with a tested RTO target of 2 h.
- **Health monitoring:** external uptime check (UptimeRobot free or Cloudflare Health Check) on `https://adbuildout.…/api/health` every 5 min → email + Slack to Carl; Celery beat heartbeat to Healthchecks.io (alerts if a nightly sync is missed); Sentry free tier on api + web for error monitoring; `docker compose ps --format json` exposed via `scripts/health.sh`.
- **Owner verification:** one page `docs/HEALTH_MONITORING.md` — the three URLs to open, the one command to run, what "healthy" looks like.

### Phase 5 — Documentation deliverables (all under `docs/`)

`ARCHITECTURE.md` (with diagram) · `LOCAL_DEVELOPMENT.md` · `MAC_MINI_INSTALL.md` · `DOCKER.md` · `SUPABASE.md` (config + migrations) · `CLOUDFLARE_TUNNEL.md` · `DNS_CHECKLIST.md` · `DEPLOY_STAGING.md` · `DEPLOY_PRODUCTION.md` · `HEALTH_MONITORING.md` · `BACKUP_RESTORE.md` · `ROLLBACK.md` · `SECURITY_CHECKLIST.md` · `CREDENTIALS_CHECKLIST.md` · `MEDIA_BUYER_ONBOARDING.md` · `REMOTE_MCP.md` (design + prerequisites; marked deferred) · `STARTUP_RECOVERY.md` (sleep, Docker autostart, tunnel, outage recovery, UPS, the explicit availability warning).

---

## 4. OAuth / integration callbacks

Today the dashboard uses a Meta **system-user token** and a Google **refresh token** from `.env`; there are no live OAuth callback flows. The HTTPS hostnames make them possible when built. Reserved callback paths, kept separate per environment:

| Provider | Production | Staging | Local |
|---|---|---|---|
| Supabase Auth | `https://adbuildout.…/auth/callback` | `https://staging-adbuildout.…/auth/callback` | `http://localhost:3000/auth/callback` |
| Meta OAuth | `…/api/integrations/meta/callback` | same on staging host | localhost |
| Google OAuth | `…/api/integrations/google/callback` | same | localhost |
| GoHighLevel | `…/api/integrations/ghl/callback` | same | localhost |
| Remote MCP (future) | `https://mcp.contractorscalingblueprint.com/oauth/callback` | — | — |

Every connection row will carry `agency_id`, `created_by` (auth user) and an encrypted refresh token; tokens are never returned to the browser.

---

## 5. Availability warning and UPS

The application **will be unavailable** during: a home power outage (even with auto-restart, until power returns), an internet outage at the house, a Mac mini hardware failure, or a macOS update/dialog that needs someone at the keyboard. Data is safe in Supabase; only the UI/worker stop.

Recommended UPS: **APC Back-UPS Pro 1000VA (BR1000MS)** or CyberPower CP1000PFCLCD — pure sine wave, USB data port so macOS shuts down cleanly (System Settings → Energy → UPS). An M4 Mac mini + router + modem draw ~30 W, giving roughly 60–90 min of runtime; the modem/router must be on the UPS too or the tunnel stays down.

---

## 6. Open questions for Carl (answer before Phase 3)

1. **Supabase Pro** for the production project (~$25/mo) — approve? Without it there are no managed backups; the nightly dump is the only safety net.
2. **Off-site backup location:** Backblaze B2 (≈$1/mo) or a Supabase Storage bucket in the staging project?
3. **Staging Supabase project:** create a new free project `zms-ads-staging` under the `zms-ads` org — approve?
4. **Media buyer's email** for the invitation (and confirm the current `viewer` account is theirs).
5. **Alert channel:** email only, or also the Slack webhook that is currently blank?
6. Confirm the hostname interpretation: production = `adbuildout.`, `ads.` kept as alias, staging = `staging-adbuildout.`.

---

## 7. What I will not do without a separate explicit yes

Any Phase 3 item; creating GitHub repos or DNS records; changing Supabase Auth settings; creating macOS users; changing Software Update or Remote Login settings; installing or upgrading Homebrew packages; restarting the production stack; running any migration against production. Phase 0 items 1–2 (commit WIP, create the private repo and push) are also held for your yes because they publish the source to GitHub.


---

## 8. Implementation notes — where the build deviates from the plan above (2026-09-16)

| Plan said | Built | Why |
|---|---|---|
| Images pushed to `ghcr.io/…:<sha>` | Images are built **locally on the Mac mini** by `scripts/deploy.sh` as `zms-ads-{api,web}:<sha>`; CI builds with `push: false` only to prove the Dockerfiles | The runner and the host are the same machine; a registry adds credentials and a network dependency for no benefit |
| `compose.yaml` + `compose.prod.yaml`, `.last_good`, `backend/.env.production` | `docker-compose.yml` + `compose.production.yml` / `compose.staging.yml`; state in `<env>.current` / `.previous` / `.history`; production env stays `backend/.env` | Keeps the running project name and container names, so the first hardened deploy is an in-place recreate |
| GitHub `environment: production` with required reviewer | Actor allow-list (`PRODUCTION_DEPLOYERS`) + typed `deploy <sha>` + must equal the staging-verified sha | The org is on GitHub Free: required reviewers and branch protection are unavailable on private repos |
| `supabase db diff` against a shadow DB | `scripts/check-migrations.sh` pattern check for destructive statements | No shadow DB in CI; the check runs in seconds and fails closed |
| Staging workflow smoke-tests the public hostname | Public probe is informational (Cloudflare Access answers 302/403); the localhost health gate in `deploy.sh` is authoritative, the human checklist is in `DEPLOY_STAGING.md` | Access deliberately blocks unauthenticated requests |
| Deep health "503 on failure" | 200 `ok`, 200 `degraded` (stale syncs), 503 `unhealthy` (db/redis down) | A fresh staging DB must still pass the deploy gate |
| Approvals via plugin PATCH allowed | Plugin PATCH refuses `approved` (409); only signed-in people approve; `approved_by_id` recorded | Approval verification requirement |
| CampaignCriterion not in scope (Google Ads plugin) | n/a here — see `~/zeal-paid-ads` branch `google-ads-builder` | separate repo |

Known open items: the manual `scripts/deploy.sh staging` (as user `zms`) and the runner (user `deploy`) keep separate deploy-state directories, so only workflow-deployed staging shas can be promoted by the production workflow; `verify-backup.sh` needs the `age` private key on the box (or run the drill on the owner's laptop); the runner installs as a per-user LaunchAgent and runs only while `deploy` is logged in.

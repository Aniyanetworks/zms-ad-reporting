# Supabase

Managed Postgres + Auth for the dashboard. Two projects, one schema, migrations in the repo.
Last updated 2026-09-16.

## Projects

| | Production | Staging |
|---|---|---|
| Project ref | `ayxvikfnktlxtpgzcrok` ("ZMS Ad Dashboard") | `zms-ads-staging`, TODO (Carl): create |
| Org / region / plan | `zms-ads`, us-east-2, **Free** | `zms-ads`, us-east-2, Free |
| Used by | `backend/.env`, root `.env`, the Claude Code plugin's read-only MCP | `backend/.env.staging`, root `.env.staging` |
| Backups | PITR off, 0 managed backups (Free plan) | none needed |
| Create | exists | `python3 scripts/cloud/supabase-staging-create.py` then `--apply`; writes keys + DB password to `~/.config/zms/supabase-staging.env` (0600); then `scripts/cloud/supabase-migrate.sh staging` |

Staging never holds production tokens or production data. Optional anonymised copy of `clients`
and metrics: deferred.

## What lives there

Tables (from `supabase/migrations/*.sql`, in order of creation):

| Table / view | Purpose | Migration |
|---|---|---|
| `clients` | client registry: slug, ad account ids, GHL location, targets, filters, booking system, timezone | 01, 03, 09, 10 |
| `ad_metrics_daily` | one row per client / platform / campaign / day (Meta + Google), settled snapshots `leads_t1/t3/t7` | 01 |
| `ghl_metrics_daily` | GHL daily rollup: contacts, paid-attributed, calls, appointments, won revenue | 01, 05 |
| `sync_runs` | every sync run (source, status, rows, error) | 01 |
| `profiles` | one row per auth user: `full_name`, `role` in (`admin`, `media_buyer`, `viewer`) | 01, 11 |
| `client_secrets` | per-client GHL Private Integration token | 02 |
| `adset_metrics_daily`, `ad_level_metrics_daily` | Meta ad set and ad grain | 04 |
| `meta_ad_creatives` | creative metadata for the ad grain | 06 |
| `app_settings` | key/value app settings | 06 |
| `ghl_adset_daily` | GHL appointments attributed by ad set name (utm_medium) | 07 |
| `benchmarks`, `triage_runs`, `recommendations`, view `v_client_scorecard` | plugin proposal queue and scorecard | 08, 11 |
| `campaign_service_map` | campaign -> service tag (Services page) | 09 |
| `setter_appointments`, `setter_daily_activity` | setter leaderboard mirror of the two Google Sheets | 09b |
| `audit_log` | append-only audit trail | 11 |
| role `plugin_reader` (nologin) | read-only Postgres role for the Supabase MCP; no access to `client_secrets`, `app_settings`, `profiles` | 08, 09 |

## RLS model

| Table group | Read | Write |
|---|---|---|
| Metrics, clients, sync_runs, profiles, benchmarks, triage_runs, recommendations, campaign_service_map, ghl_adset_daily, meta_ad_creatives | `authenticated` (any signed-in user, all rows) | service role only (the api). No write policies exist |
| `audit_log` | `admin` reads all rows; every user reads rows where `actor_id = auth.uid()` | service role insert only; `update`/`delete`/`truncate` revoked and blocked by trigger `audit_log_immutable()` |
| `client_secrets`, `app_settings`, `setter_appointments`, `setter_daily_activity` | RLS enabled, **no policies**: service role only | service role only |

The browser uses the anon (publishable) key with the user's JWT, so RLS applies. The api uses
the service-role key and the pooler DB URL, bypassing RLS; role checks happen in
`backend/app/core/security.py` + `policy.py` instead.

## Keys

| Key | Where it is used | Never |
|---|---|---|
| Publishable / anon (`SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) | browser (Auth + RLS reads), Next SSR session refresh (`frontend/src/proxy.ts`) | treat as secret; it is public by design |
| Secret / service role (`SUPABASE_SERVICE_ROLE_KEY`) | api and worker only (`backend/.env`) | in `frontend/`, git, the plugin, chat |
| DB URL (`SUPABASE_DB_URL`, session-mode pooler) | asyncpg pool in the api, dlt in the worker, migrations | anywhere else |
| Personal access token (`SUPABASE_ACCESS_TOKEN`) | Management API scripts in `scripts/cloud/`, the plugin's read-only MCP | committed |
| `SUPABASE_JWT_SECRET` | blank; JWTs are verified via JWKS (ES256/RS256). HS256 fallback exists for tests | needed on new projects |

Rotation procedures: `CREDENTIALS_CHECKLIST.md`.

## Migrations

> **One-time baseline (2026-09-21).** Production has no `supabase_migrations.schema_migrations`
> table: every migration so far was applied through the SQL editor or the MCP tool, so
> `supabase db push` would replay all of them. Before the first CLI push, record the already
> applied versions once: `scripts/cloud/supabase-baseline.sh production 20260917000011 20260921000015`
> (names the two genuinely pending versions), then `scripts/cloud/supabase-migrate.sh production --dry-run`
> must list exactly those two.
 workflow

- Files: `supabase/migrations/<timestamp>_<name>.sql`, applied in filename order. Write them
  idempotent where possible (`if not exists`, `drop ... if exists` before `create policy`).
- Never destructive automatically: `scripts/check-migrations.sh` diffs new
  migration files against `origin/main` and fails on `DROP`, `TRUNCATE`, `ALTER ... DROP COLUMN`
  unless `ALLOW_DESTRUCTIVE=1` is set with owner approval. CI runs the same check on PRs.
- Apply:

```bash
# staging (SUPABASE_DB_URL from backend/.env.staging)
scripts/cloud/supabase-migrate.sh staging --dry-run
scripts/cloud/supabase-migrate.sh staging

# production (SUPABASE_DB_URL from backend/.env); asks you to type "migrate production"
scripts/cloud/supabase-migrate.sh production --dry-run
scripts/cloud/supabase-migrate.sh production
```

  The script wraps `supabase db push --db-url ...`. Run the Supabase CLI from a container if it
  is not installed on the Mac; host Pythons are broken (`brew reinstall python@3.12` fixes them).
- Order for a release: migrate staging -> deploy staging -> smoke test -> migrate production
  (only after the migration passed on staging) -> deploy production. Migrations must be
  backward-compatible with the currently running image, because the api restarts after them.
- Pending right now: `20260917000011_roles_audit_log_hardening.sql` (roles, `audit_log`,
  `approved_by_id`, advisor fixes, FK indexes). Non-destructive. TODO (deploy): apply to staging
  then production before the hardened api goes live; the api writes `audit_log` on every mutation
  and only logs (does not fail) if the table is missing.

## Auth settings hardening

`scripts/cloud/supabase-auth-hardening.py` (Management API, production ref by default):

| Setting | Today | Target |
|---|---|---|
| `disable_signup` | false (public sign-up possible) | true (invite-only) |
| `password_min_length` | 6 | 12 |
| `password_required_characters` | none | lower + upper + digits |
| `password_hibp_enabled` | off | on |
| `sessions_timebox` | unset | 43200 s (12 h) |
| `refresh_token_rotation_enabled` / reuse interval | on | on / 10 s |
| `mfa_totp_enroll_enabled` / `verify` | enabled | enabled (not enforced) |
| `site_url` | old host | `https://adbuildout.contractorscalingblueprint.com` |
| `uri_allow_list` | old hosts | adds `adbuildout.`, `staging-adbuildout.`, keeps `ads.` (both zones) and `http://localhost:3000` |

```bash
python3 scripts/cloud/supabase-auth-hardening.py            # dry run: prints the diff
python3 scripts/cloud/supabase-auth-hardening.py --apply    # TODO (Carl)
# staging project: SUPABASE_PROJECT_REF=<staging ref> python3 scripts/cloud/supabase-auth-hardening.py --site-url https://staging-adbuildout.contractorscalingblueprint.com --apply
```

Existing passwords keep working until changed. Inviting users: `MEDIA_BUYER_ONBOARDING.md`.

## Security advisors (fixed in migration 11)

| Advisor finding (2026-09-16) | Fix |
|---|---|
| ERROR: view `v_client_scorecard` is SECURITY DEFINER | `alter view v_client_scorecard set (security_invoker = true)` |
| WARN: `handle_new_user()` executable by anon/authenticated | `revoke execute ... from public, anon, authenticated` (the trigger still runs) |
| WARN: `audit_log_immutable()` (new) | execute revoked the same way |
| WARN: leaked-password protection off | Auth hardening script (`password_hibp_enabled`) |
| Performance: unindexed FKs `recommendations.triage_run_id`, `sync_runs.client_id` | indexes added |

Re-check after applying: Supabase Dashboard -> Advisors -> Security / Performance, or the
Supabase MCP `get_advisors`.

## Backups

- Free plan reality: **no managed backups, PITR off**. If the database is corrupted or deleted,
  the only recovery is a dump you made yourself.
- Recommendation (open question 1 in `DEPLOYMENT_PLAN.md`): **Supabase Pro** (~$25/mo) for daily
  backups with 7-day retention; PITR add-on optional. TODO (Carl).
- Independent safety net regardless of plan: `scripts/backup-db.sh` runs nightly
  on the Mac mini: `pg_dump --format=custom` via the pooler -> `age` encryption -> off-site bucket
  (Backblaze B2 or a Storage bucket in the staging project), 30-day retention;
  `scripts/verify-backup.sh` restores the latest dump into a throwaway Postgres container weekly
  and row-counts key tables. Full restore procedure and RTO target: `BACKUP_RESTORE.md`.
- `redis` holds only queue state; it is not backed up.

## Quick checks

```sql
-- who has access
select u.email, p.role, u.last_sign_in_at from profiles p join auth.users u on u.id = p.id;
-- RLS enabled everywhere in public
select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and relkind = 'r' and not relrowsecurity;      -- expect 0 rows
-- last sync per source (what /api/health uses)
select source, max(finished_at) from sync_runs where status = 'success' group by source;
```

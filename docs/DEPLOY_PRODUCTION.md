# Deploy to production

Production is the compose project `zms-ad-reporting` on the Mac mini (containers
`zms-ads-*`, ports 3010 / 8010 / 6380), Supabase project `ayxvikfnktlxtpgzcrok`, published as
https://adbuildout.contractorscalingblueprint.com (alias `ads.`, public `setter.`).

## The rule

1. **Only a sha that staging has run.** `deploy-production.yml` refuses anything that is not
   the runner's `staging.current` (`DEPLOY_STAGING.md`).
2. **A human approves.** GitHub Free has no required reviewers on private repos, so approval
   is enforced inside the workflow: the actor must be in the repo variable
   `PRODUCTION_DEPLOYERS`, and must type `deploy <sha>`.
3. **Migrations first, by a person, never destructive automatically.** The deploy never runs
   migrations. `scripts/cloud/supabase-migrate.sh production` runs `check-migrations.sh`,
   then prompts for `migrate production`. Destructive statements need `ALLOW_DESTRUCTIVE=1`
   and owner review (`SUPABASE.md`).
4. **A backup exists from before the change.**
5. **Automatic rollback on a failed health gate** (`scripts/deploy.sh`), manual rollback
   otherwise (`ROLLBACK.md`).

## Pre-flight checklist

- [ ] Staging runs the sha and the smoke test in `DEPLOY_STAGING.md` passed (note who, when).
- [ ] Backup taken now:

```bash
cd ~/zms-ad-reporting && scripts/backup-db.sh
```

- [ ] Pending migrations reviewed, then applied to production (dry run first):

```bash
scripts/cloud/supabase-migrate.sh production --dry-run
```

```bash
scripts/cloud/supabase-migrate.sh production
```

- [ ] `~deploy/.zms-ads/secrets/production/{backend.env,web.env}` are current (any `.env`
      change made as `zms` must be copied there, or the runner deploys stale config).
- [ ] Not during 01:00 to 02:15 PT or 06:00 to 06:30 PT (nightly syncs and the Meta second
      pass; a restart mid-sync just logs an error row, but avoid it).
- [ ] Someone can watch for 15 minutes afterwards.

## Path A: GitHub Actions (`workflow_dispatch`)

Inputs and guards of `.github/workflows/deploy-production.yml`:

| Input / guard | Requirement |
|---|---|
| `sha` | full 40-character lowercase commit sha |
| `confirm` | exactly `deploy <sha>` |
| `PRODUCTION_DEPLOYERS` | repo variable, comma-separated GitHub logins; unset means refuse |
| staging parity | `sha` == `/Users/deploy/.zms-ads/deploy/staging.current` |
| runner secrets | `~/.zms-ads/secrets/production/{backend.env,web.env}` present |

Set the allow-list once (find your login with `gh api user --jq .login`):

```bash
gh variable set PRODUCTION_DEPLOYERS -R zmsseoagency/zms-ad-reporting --body "<login1>,<login2>"
```

Run it:

```bash
gh workflow run deploy-production.yml -R zmsseoagency/zms-ad-reporting -f sha=<sha> -f confirm="deploy <sha>"
```

```bash
gh run watch -R zmsseoagency/zms-ad-reporting
```

The job runs on `[self-hosted, macmini]`, GitHub environment `production`, concurrency
`deploy-production`. Steps: guard, checkout at `sha`, `scripts/deploy.sh production <sha>`,
`scripts/health.sh production`, summary with `production.current` / `production.previous`.
Optional extra: a wait timer on the `production` environment (Settings -> Environments) works on
Free; required reviewers do not.

## Path B: manual (on the Mac mini as `zms`)

Use when the runner is down or for the first hardened deploy. The checkout must be clean and
at the sha; `deploy.sh` builds from the working tree.

```bash
cd ~/zms-ad-reporting && git fetch origin && git status --porcelain --untracked-files=no
```

```bash
git checkout <sha>
```

```bash
scripts/deploy.sh production <sha>
```

State is written to `~/zms-ad-reporting/.deploy/production.{current,previous,history}`.
Manual deploys do not update the runner's state; the next workflow deploy still records the
correct `previous` because `deploy.sh` reads the running container's image tag, not the file.

## The FIRST hardened deploy (one-time specifics)

The stack running today was started with the pre-hardening `docker-compose.yml`
(`docker compose up -d --build`), images `zms-ad-reporting-{api,web,celery-worker,celery-beat}:latest`,
also tagged `:prod-2026-09-16` as the rollback point. The hardened files change the image
names, users, read-only rootfs and healthchecks, but keep the project name and the
`zms-ad-reporting_redis-data` volume, so `up -d` replaces the containers in place.

Order:

1. Merge `hardening/phase-1` to `main`; let `ci.yml` pass; deploy to staging; smoke test.
2. The production checkout at `~/zms-ad-reporting` currently has uncommitted work on
   `hardening/phase-1`. Commit or stash it, then `git checkout <sha>`; `deploy.sh` refuses a
   dirty tree.
3. **Apply migration `20260917000011_roles_audit_log_hardening.sql` before the deploy.** The
   new api writes `audit_log`, expects `recommendations.approved_by_id` and the `media_buyer`
   role. It is non-destructive.
4. Take a backup (`scripts/backup-db.sh`). Verify it decrypts (`scripts/verify-backup.sh`);
   note that verify row-counts `audit_log`, so run it after the migration or expect
   `audit_log MISSING`.
5. Copy the current env files into `~deploy/.zms-ads/secrets/production/` if the runner will
   be used later. Add the new hardening keys from `backend/.env.example` to `backend/.env`
   (`ENVIRONMENT`, `DASHBOARD_URL`, `ALLOWED_ORIGINS`, `RATE_LIMIT_*`, `HEALTH_SYNC_STALE_HOURS`).
6. Run Path B. The container name `zms-ads-api` is unchanged, so `deploy.sh` inspects the
   running container, sees image `zms-ad-reporting-api:latest`, classifies it as `legacy:`,
   re-tags it as `zms-ads-api:pre-hardening` (and the web image as `zms-ads-web:pre-hardening`)
   and records `production.previous=pre-hardening` before building the new images.
7. Cross-boundary rollback caveat: the `pre-hardening` images run as root and expect a
   writable rootfs. `rollback.sh production pre-hardening` under the hardened compose files
   may leave worker/beat failing. The reliable rollback is to check out the pre-hardening
   commit and start the old files (`ROLLBACK.md`, "first hardened deploy").
8. Downtime: a few seconds per container while compose recreates them; the tunnel returns 502
   during that window.

## Post-deploy verification

On the Mac mini:

```bash
scripts/health.sh production
```

Expect `OVERALL: healthy`, every container `running / healthy`, `version` equal to the sha
in both `/api/health` and `/healthz`.

From **outside the LAN** (phone hotspot), the full list in `DNS_CHECKLIST.md`
"Verification from outside the LAN". Minimum:

```bash
H=adbuildout.contractorscalingblueprint.com; curl -s https://$H/healthz; echo; curl -s https://$H/api/health | head -c 400; echo; curl -s -o /dev/null -w '%{http_code}\n' https://$H/api/me
```

Expect `service":"web"` with the sha, `"status":"ok"` (or `degraded` with an explanation), and
`401` from `/api/me`. Then sign in as the owner, open a client page, confirm the Actions card
and Settings load, and check `https://setter.contractorscalingblueprint.com/leaderboard` and
the SEO dashboard hostnames (shared tunnel).

Watch logs for 15 minutes:

```bash
docker compose --env-file .env -f docker-compose.yml -f compose.production.yml logs -f --since 15m api celery-worker celery-beat
```

Next morning: `/api/health` shows every `checks.syncs.<source>.ok: true` after the 01:00 PT
runs; Settings -> Sync status has fresh rows.

## Not "publicly available" until

The application is **not to be described as live or publicly available** until, from outside
the LAN, a person has confirmed: the domain resolves through Cloudflare with a valid HTTPS
certificate and HTTP redirects to HTTPS; sign-in works for the owner and a media buyer and a
viewer cannot approve; `/api/health` is 200 and `/healthz` is 200 with the deployed sha;
staging shows the Cloudflare Access prompt and production does not; the rate rule returns 429
under a burst and `/api/docs` is 404; the home IP exposes no ports. Record the result and the
date in the deploy notes. Until then it is "deployed, verification pending".

## If it goes wrong

`deploy.sh` already rolled back if the health gate failed (check `production.history` for
`failed` then `rollback-ok`). For anything discovered later: `ROLLBACK.md`.

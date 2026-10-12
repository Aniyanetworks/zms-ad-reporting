# Rollback

How to undo a deploy, a migration, a Cloudflare or Supabase configuration change, and the
first hardened deploy specifically. Scripts: `scripts/rollback.sh`, `scripts/deploy.sh`,
`scripts/lib.sh`. Health checks afterwards: `HEALTH_MONITORING.md`.

## When to roll back

Roll back the application when, after a deploy:

- `scripts/health.sh production` is not `OVERALL: healthy` and the cause is the new code (the
  deploy health gate already does this automatically inside `deploy.sh`);
- users cannot sign in, pages error, approvals fail, or the worker stops syncing, and the
  problem appeared with the release;
- a security or data-correctness bug shipped.

Do **not** roll back the application for: Supabase or Cloudflare outages, a stale sync caused by
an expired token, or a wrong `.env` value (fix the value and `up -d`). Check `production.history`
and the container logs first; a rollback with the same broken dependency changes nothing.

## Rolling back images: `scripts/rollback.sh <env> [tag]`

```bash
cd ~/zms-ad-reporting && scripts/rollback.sh production
```

What it does:

1. `set_env production` (project `zms-ad-reporting`, overlay `compose.production.yml`,
   `backend/.env` + `.env`, or the `ZMS_SECRETS_DIR` copies).
2. Target = the explicit `[tag]` or the contents of `<state>/production.previous`, where
   `<state>` is `.deploy/` in the checkout or `ZMS_DEPLOY_STATE_DIR` (the runner uses
   `~deploy/.zms-ads/deploy/`). Fails if empty.
3. Requires `zms-ads-api:<tag>` and `zms-ads-web:<tag>` to exist locally (`deploy.sh` never
   deletes images; do not `docker image prune -a` on production).
4. `docker compose ... up -d --wait --wait-timeout 180 --remove-orphans --no-build` with
   `IMAGE_TAG=<tag>` and `GIT_SHA=<tag>`. **Compose files come from the current checkout;
   only the images change.**
5. Polls `/api/health/live`, `/api/health`, `/healthz` for `HEALTH_TIMEOUT` (120 s). On success
   swaps `production.current` and `production.previous` and appends `rollback-ok` to
   `production.history`; on failure prints the last 40 log lines, appends `rollback-failed`,
   exits 1.

Roll back to any earlier sha that was deployed from this machine:

```bash
scripts/rollback.sh production <full-sha>
```

```bash
docker images zms-ads-api --format '{{.Tag}}  {{.CreatedAt}}'
```

Staging: `scripts/rollback.sh staging`. Runner-side rollback (state under `~deploy`):
re-run `deploy-staging.yml` with `sha=<previous>`; for production, dispatch
`deploy-production.yml` only if that sha is the runner's `staging.current`, otherwise roll
back by hand as `zms`.

The `<env>.previous` tag: written by `deploy.sh` before each deploy from the **running
container's image tag** (not from the file), so it is correct even after manual deploys.
Redeploying the tag that is already running leaves `.previous` untouched.

## Rolling back a migration: forward-fix policy

Migrations in this repo are **non-destructive** (`scripts/check-migrations.sh` enforces no
`DROP TABLE/COLUMN`, `TRUNCATE`, `DROP SCHEMA`), and the api tolerates the previous schema
where practical. Therefore:

1. **Do not write a "down" migration in an incident.** Roll the application images back
   first (`rollback.sh`); the previous image runs fine against the newer, wider schema because
   nothing was removed.
2. Fix forward: write a new migration `<timestamp>_<name>.sql` that corrects the problem
   (add the missing index, fix a policy, widen a check). Committed migration files are
   immutable; never edit one that has been applied.
3. If a migration must be reverted for correctness (wrong constraint blocking writes), the
   new migration drops **only what the bad migration added** (`drop policy if exists`,
   `alter table ... drop constraint`, which the checker allows). Dropping tables or columns
   needs `ALLOW_DESTRUCTIVE=1`, an owner review and a fresh `scripts/backup-db.sh` first.
4. Apply through the normal path: staging first, then
   `scripts/cloud/supabase-migrate.sh production` (typed confirmation).

Data damage (bad UPDATE/DELETE) is not a migration rollback: restore rows from the latest
dump into a scratch schema and copy them back (`BACKUP_RESTORE.md`).

## Rolling back Cloudflare and Supabase configuration

The `scripts/cloud/*` scripts are idempotent (re-running them changes nothing once the state
matches) and dry-run by default; none of them has an undo flag. Revert by hand:

| Change (script) | Revert |
|---|---|
| DNS CNAMEs `adbuildout.`, `staging-adbuildout.` (`cloudflare-hostnames.py`) | Cloudflare -> DNS -> Records -> delete the two CNAMEs (comment "ZMS ads dashboard via tunnel (hardening 2026-09)"). Leave `ads.`, `setter.` and SEO records |
| Tunnel ingress rules for the two hostnames (same script) | Zero Trust -> Networks -> Tunnels -> `zms-seo-dashboard` -> Public Hostname -> delete the two rules; keep `http_status:404` last; SEO rules untouched. Takes effect in seconds |
| Access app "ZMS Ads - staging" (`cloudflare-access-staging.py`) | Zero Trust -> Access -> Applications -> delete the app (staging becomes reachable without PIN: only do this if staging is stopped). The one-time-PIN IdP and the Zero Trust org can stay |
| Rate-limit rule "ZMS ads API rate limit" (`cloudflare-ratelimit.py`) | Security -> WAF -> Rate limiting rules -> delete or disable the rule; or edit `requests_per_period` (60 / 10 s) instead of removing |
| Supabase Auth settings (`supabase-auth-hardening.py`) | Dashboard -> Authentication -> Providers/Settings, or `PATCH /v1/projects/<ref>/config/auth` with the previous values the dry run printed (`old -> new`; keep that output). Passwords already set under the 12-char rule keep working. Re-enabling public sign-up (`disable_signup=false`) is a security regression: owner decision only |
| Staging project (`supabase-staging-create.py`) | Supabase Dashboard -> project -> Settings -> General -> Delete project; remove `~/.config/zms/supabase-staging.env` |
| Migration 11 advisor fixes (`security_invoker`, revoked `execute`) | forward migration re-granting if something legitimately breaks; not expected |

Always keep the dry-run output of the run you are reverting; it is the record of the previous
state.

## Rolling back the FIRST hardened deploy

The pre-hardening stack ran from commit `08663ae` (last commit before the hardening work;
`72c89e0` added docs only) with root containers, writable rootfs and images named
`zms-ad-reporting-*`. Those images exist locally as
`zms-ad-reporting-{api,web,celery-worker,celery-beat}:prod-2026-09-16`, and `deploy.sh`
additionally tags the running ones `zms-ads-api:pre-hardening` / `zms-ads-web:pre-hardening`
on the first hardened deploy.

`scripts/rollback.sh production pre-hardening` **may not work**: the old images expect to
write to the rootfs and to run as root, which the hardened compose files forbid (worker and
beat are the likely casualties). The reliable cross-boundary rollback is to run the old
compose file with the old images:

```bash
cd ~/zms-ad-reporting && git stash list && git status --porcelain --untracked-files=no
```

```bash
git checkout 08663ae
```

Point the old file at the snapshot images (the old `docker-compose.yml` builds
`zms-ad-reporting-*:latest`; `:latest` may have been rebuilt, so re-tag the snapshot first):

```bash
for s in api web celery-worker celery-beat; do docker tag zms-ad-reporting-$s:prod-2026-09-16 zms-ad-reporting-$s:latest; done
```

```bash
docker compose up -d --no-build
```

The project name (`zms-ad-reporting`), container names (`zms-ads-*`), ports and the
`zms-ad-reporting_redis-data` volume are the same, so the old containers replace the new ones
in place. Then verify (below) and go back to `main` when the fix is ready. Migration 11 stays
applied; the old code ignores the new columns and table. The `deploy` user's state files are
unaffected; the next `deploy.sh` run sees `legacy:` again and re-tags.

## Verification after any rollback

```bash
scripts/health.sh production
```

Expect `OVERALL: healthy`, and `version` in `/api/health` and `/healthz` equal to the tag you
rolled back to (`pre-hardening` images report `dev` or the old static `ok`).

```bash
curl -s https://adbuildout.contractorscalingblueprint.com/healthz; echo; curl -s -o /dev/null -w '%{http_code}\n' https://adbuildout.contractorscalingblueprint.com/api/health
```

Then: sign in, open a client page, check Settings -> Sync status, confirm
`https://setter.contractorscalingblueprint.com/leaderboard` and the SEO dashboard answer, and
watch `docker compose ... logs -f --since 10m` for a few minutes. Record the rollback (from,
to, why, who) in the deploy notes and open an issue for the forward fix. Do not leave
production on a rolled-back tag without a plan to move forward.

# Backup and restore

What is backed up, where, how it is encrypted, how to prove it restores, and the step-by-step
restore into a fresh Supabase project. Scripts: `scripts/backup-db.sh`,
`scripts/backup-config.sh`, `scripts/verify-backup.sh`, shared code in
`scripts/backup-lib.sh`; schedules in `infra/launchd/`. Nothing here is installed yet:
TODO (deploy) for the jobs, TODO (Carl) for the key, the off-site remote and the Supabase plan.

## What is backed up

| Backup | Script | Contents | Output |
|---|---|---|---|
| Database | `scripts/backup-db.sh` | `pg_dump --format=custom --compress=6 --no-owner --no-privileges` of schemas `public raw_meta raw_google` (override with `DUMP_SCHEMAS`), run from a `postgres:17-alpine` container against `SUPABASE_DB_URL` read from `backend/.env` (or `$DB_ENV_FILE`) | `$BACKUP_DIR/db/zms-ads-<UTC stamp>.dump.age` |
| Host config | `scripts/backup-config.sh` | `.env`, `.env.staging`, `backend/.env`, `backend/.env.staging`, `backend/.dlt/secrets.toml`, the three compose files, `frontend/.env*`, `~/.cloudflared`, `~/.config/zms`, `~/.zms-ads/secrets`, `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`, `~/Library/LaunchAgents/com.zms.*.plist` (missing paths are skipped and logged) | `$BACKUP_DIR/config/zms-ads-config-<stamp>.tar.gz.age` (absolute paths, `tar -P`) |

Not backed up: Redis (queue state only), Docker images (rebuilt from git), the git repo (on
GitHub). Supabase Auth users live in the `auth` schema, which is **not** in the dump; see the
Supabase-side section.

## Settings (`~/.config/zms/backup.env`, mode 600)

| Variable | Default | Purpose |
|---|---|---|
| `AGE_RECIPIENT` | empty | `age1...` public key. DB dumps: without it the script **warns and keeps a plaintext dump** (mode 600). Config bundle: **required** (`ALLOW_PLAINTEXT=1` overrides for a one-off) |
| `AGE_IDENTITY` | empty | path to the private key file; needed only by `verify-backup.sh` (and a restore) |
| `BACKUP_DIR` | `~/Backups/zms-ads` | local root; `db/` and `config/` under it, mode 700 |
| `BACKUP_REMOTE` | empty | rclone remote, e.g. `b2:zms-ads-backups`; unset means local only (logged as skipped) |
| `RETENTION_DAYS` | 30 | local prune with `find -mtime +N` after each run |
| `PG_IMAGE` | `postgres:17-alpine` | dump/restore container (Supabase runs PG 17.6; the 17 client dumps 15/16/17) |
| `TOOLS_IMAGE` | `zms-ads-tools:latest` | helper image with `age`, `rclone`, PG 17 client, built on demand from `infra/tools/Dockerfile` when the host lacks the tool |

`BACKUP_CONF` can point at a different settings file.

## Encryption with `age`

Generate the key pair **once, on the owner's own machine**, not on the Mac mini:

```bash
age-keygen -o zms-ads-backup-key.txt
```

The output prints `Public key: age1...`. Put that public key in
`~/.config/zms/backup.env` as `AGE_RECIPIENT`. The private key file goes into the **owner's
password manager** (secure note or attachment) and nowhere else. The Mac mini never needs it
for backups. `verify-backup.sh` needs it to decrypt, so either run verification from a machine
that holds the key, or accept the trade-off of an `AGE_IDENTITY` file on the Mac (mode 600,
outside the repo, and the config bundle includes `~/.config/zms`, so the private key would
then travel inside its own encrypted backup). TODO (Carl): decide; the launchd verify job
assumes the file is present.

Encryption happens with host `age` if installed (`brew install age`), else inside the tools
container; the plaintext is removed on success.

## Off-site upload (rclone)

```bash
brew install rclone && rclone config
```

Create a remote (Backblaze B2 bucket `zms-ads-backups`, or a Supabase Storage S3 bucket in the
staging project; open question 2 in `DEPLOYMENT_PLAN.md`, TODO (Carl)), then set
`BACKUP_REMOTE=b2:zms-ads-backups`. Each run does `rclone copy $BACKUP_DIR/db ->
$BACKUP_REMOTE/db` and `.../config -> $BACKUP_REMOTE/config`. Without host `rclone` the
tools container is used with `~/.config/rclone/rclone.conf` (or `RCLONE_CONFIG`). Local
retention is 30 days; **remote retention is not pruned by the scripts**, so set a bucket
lifecycle rule (90 days suggested) in the provider.

## Schedule (launchd, user `zms`)

| Job | When (local) | Log |
|---|---|---|
| `com.zms.backup-db` | daily 03:15 (after the 01:00 to 02:00 PT syncs) | `~/Library/Logs/zms-ads/backup-db.log` |
| `com.zms.backup-config` | Sundays 04:00 | `~/Library/Logs/zms-ads/backup-config.log` |
| `com.zms.verify-backup` | Sundays 04:30 | `~/Library/Logs/zms-ads/verify-backup.log` |

Install steps: `MAC_MINI_INSTALL.md` section 9. Run by hand any time:

```bash
cd ~/zms-ad-reporting && scripts/backup-db.sh
```

```bash
cd ~/zms-ad-reporting && scripts/backup-config.sh
```

## Weekly verification: `scripts/verify-backup.sh [dump]`

Takes the newest `zms-ads-*.dump[.age]` in `$BACKUP_DIR/db` (or the given file), decrypts it
to a temp dir, starts a throwaway `postgres:17-alpine` container (`zms-ads-verify-<pid>`,
data on tmpfs), creates stubs for Supabase-managed objects (`anon`, `authenticated`,
`service_role`, `supabase_admin` roles, `auth.users`, `auth.uid()/role()/jwt()`, `extensions`
schema with pgcrypto and uuid-ossp), runs `pg_restore --exit-on-error`, then row-counts key
tables. Nothing touches Supabase. Reading the output:

| Line | Meaning |
|---|---|
| `verifying <file>` ... `pg_restore` | normal progress |
| `pg_restore reported errors (exit N)` + log dump | the dump does not restore cleanly: investigate before relying on it |
| `== row counts` then `clients 19`, `ad_metrics_daily 123456`, `recommendations ...`, `audit_log ...`, `sync_runs ...` | sanity numbers; compare with last week |
| `<table> MISSING` | table absent from the dump. `sync_runs` missing is tolerated; any other (`clients`, `ad_metrics_daily`, `recommendations`, `audit_log`) fails the run |
| `verify OK: <file>` | success (exit 0) |

Note: `audit_log` exists only after migration `20260917000011`; a dump taken before it was
applied fails verification with `audit_log MISSING`. Pass an explicit newer dump or accept the
failure for pre-migration dumps.

## Supabase-side story

| Plan | Managed backups | PITR |
|---|---|---|
| Free (today, project `ayxvikfnktlxtpgzcrok`) | **none** | off |
| Pro (~$25/mo, recommended, TODO (Carl)) | daily, 7-day retention, restore from the dashboard | add-on (per-minute recovery, extra cost) |

The nightly `pg_dump` is the only safety net on Free and remains the independent copy on Pro.
It does not include Auth users (`auth` schema): on a restore, users are re-created (invite or
create) and `profiles` rows are re-linked; keep a list of users and roles in the password
manager (`select u.email, p.role from profiles p join auth.users u on u.id = p.id;` weekly is
cheap). `client_secrets` (GHL PITs) **are** in `public`, so the dump contains secrets: that is
why it is encrypted.

## RESTORE procedure (full loss of the production database)

Target RTO: **2 hours** from decision to a healthy dashboard. Data loss: up to 24 h (last 03:15
dump). Work as `zms` on the Mac mini or any machine with Docker, the private key and the repo.

1. **Decide and announce.** Stop the stack so nothing writes to a half-restored DB:

```bash
cd ~/zms-ad-reporting && docker compose --env-file .env -f docker-compose.yml -f compose.production.yml stop api celery-worker celery-beat web
```

2. **New Supabase project** (org `zms-ads`, us-east-2, PG 17), via dashboard or by copying
   `scripts/cloud/supabase-staging-create.py` with a new `NAME`. Note the ref, DB password,
   anon and service-role keys, session-mode pooler URL.
3. **Apply migrations** to the empty project (creates schema, RLS, roles, `plugin_reader`):

```bash
supabase db push --db-url 'postgresql://postgres.<ref>:<password>@aws-0-us-east-2.pooler.supabase.com:5432/postgres'
```

4. **Fetch and decrypt the latest dump** (from `$BACKUP_DIR/db` or `rclone copy $BACKUP_REMOTE/db/<file> .`):

```bash
age -d -i /path/to/zms-ads-backup-key.txt -o restore.dump ~/Backups/zms-ads/db/zms-ads-<stamp>.dump.age
```

5. **pg_restore data only from the tools container** (schema already exists from step 3;
   `--data-only` avoids duplicate objects, `--disable-triggers` lets FK-ordered data load;
   requires a role that can disable triggers, which `postgres` on Supabase can for its own tables):

```bash
docker run --rm -v "$PWD/restore.dump:/work/restore.dump:ro" -e PGCONNECT_TIMEOUT=20 zms-ads-tools:latest pg_restore --no-owner --no-privileges --data-only --disable-triggers -d 'postgresql://postgres.<ref>:<password>@aws-0-us-east-2.pooler.supabase.com:5432/postgres' /work/restore.dump
```

   Alternative when triggers cannot be disabled: restore in dependency order with
   `-t clients -t ad_metrics_daily ...`, or `--section=data` per schema. Row-count afterwards:

```sql
select 'clients', count(*) from clients union all select 'ad_metrics_daily', count(*) from ad_metrics_daily union all select 'recommendations', count(*) from recommendations;
```

6. **Re-create Auth users** (Supabase -> Authentication -> Users -> Create user, auto-confirm)
   and set roles (`MEDIA_BUYER_ONBOARDING.md`). `profiles` rows restored from the dump carry the
   **old** user ids; either delete them and let `handle_new_user()` recreate, or update `id`
   to the new `auth.users.id`. Run `scripts/cloud/supabase-auth-hardening.py --apply` with
   `SUPABASE_PROJECT_REF=<new ref>`.
7. **Rotate keys.** The old project's service-role key and DB password are considered exposed
   by the incident; the new project has new ones anyway. Rotate `PLUGIN_API_TOKEN` and inform
   plugin operators (`CREDENTIALS_CHECKLIST.md`).
8. **Update env files**: `backend/.env` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`), root `.env` (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`), and the runner copies under `~deploy/.zms-ads/secrets/production/`.
   Update the plugin's read-only MCP config in `~/zeal-paid-ads` (TODO (Carl)).
9. **Redeploy** (the web image bakes the Supabase URL, so a rebuild is required):

```bash
scripts/deploy.sh production $(git rev-parse HEAD)
```

10. **Verify** (`HEALTH_MONITORING.md`): `/api/health` 200, sign in, client page renders
    history, Settings -> trigger a Meta sync and watch it succeed. Take a fresh backup.
    Write up what happened and the actual RTO.

Config restore (new Mac): decrypt the bundle with `age -d`, inspect with `tar -tzf`, extract
with `tar -xzPf` (absolute paths, so check the listing first), then follow `MAC_MINI_INSTALL.md`.

## Restore drill checklist (twice a year, and after any change to these scripts)

- [ ] Private key retrieved from the password manager and decrypts last night's dump
- [ ] `scripts/verify-backup.sh` passes on that dump and row counts are plausible
- [ ] Steps 2 to 5 performed against a **scratch** Supabase project (or the staging project,
      after telling the team); duration recorded
- [ ] A user created, role set, sign-in and one client page verified against the scratch project
      by pointing a local `npm run dev` at it (`LOCAL_DEVELOPMENT.md`)
- [ ] Config bundle decrypts and lists the expected paths
- [ ] Off-site copy exists for the last 7 days (`rclone ls $BACKUP_REMOTE/db | tail`)
- [ ] Measured RTO within the 2 h target; if not, note what to pre-stage
- [ ] Scratch project deleted; drill date and result written in the deploy notes

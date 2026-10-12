# Local development

How to work on the dashboard from a developer machine: clone, env files, run the stack,
run the tests, open a PR. Facts match branch `hardening/phase-1` (2026-09-16). Operator
docs for the Mac mini itself are in `MAC_MINI_INSTALL.md`; container internals in `DOCKER.md`.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop | 29 / Compose v5 | everything backend runs in containers |
| Node | 22 in CI and images; 26 works on the host | only for `npm run dev`, lint, typecheck, vitest |
| git + `gh` | any recent | `gh auth login` to org `zmsseoagency` |
| Python | none needed | backend tests run in Docker. Homebrew Pythons on the Mac mini are broken (`brew reinstall python@3.12` fixes them); do not depend on a host Python |
| Supabase CLI | optional | only for `scripts/cloud/supabase-migrate.sh` |

## 1. Clone

```bash
git clone git@github.com:zmsseoagency/zms-ad-reporting.git ~/zms-ad-reporting
```

```bash
cd ~/zms-ad-reporting && git checkout -b feature/<short-name> origin/main
```

## 2. Env files from the examples

There is no dev-specific compose overlay. Local development uses the **staging overlay**
(`compose.staging.yml`, ports 3011 / 8011 / 6381, project `zms-ads-staging`) with env files
that point at the **staging Supabase project**, never production.

| Copy | To | Fill in |
|---|---|---|
| `backend/.env.staging.example` | `backend/.env.staging` | staging `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`; leave Meta/Google/GHL tokens blank; `ENVIRONMENT=development` if you want `/docs` (staging also enables it) |
| `.env.example` | `.env.staging` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` of the staging project |
| `frontend/.env.example` | `frontend/.env.local` | same two public values; `API_URL=http://localhost:8011` when the api runs from the staging overlay |

```bash
cp backend/.env.staging.example backend/.env.staging && cp .env.example .env.staging && cp frontend/.env.example frontend/.env.local
```

Where the staging values come from: `~/.config/zms/supabase-staging.env` on the Mac mini
(written by `scripts/cloud/supabase-staging-create.py`), handed over via the password manager.
See `CREDENTIALS_CHECKLIST.md`. If the staging project does not exist yet: TODO (Carl), see `SUPABASE.md`.

All of `.env`, `.env.staging`, `backend/.env`, `backend/.env.staging`, `frontend/.env.local`
are gitignored. **Never commit an env file.** Check before every push:

```bash
git ls-files | grep -E '\.env($|\.)' ; echo "(must print nothing)"
```

## 3. Run the full stack locally (compose)

Base file + staging overlay + explicit project name. Without `-p` compose uses the directory
name as the project, which on the Mac mini would replace production.

```bash
docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml up -d --build --wait
```

| URL | What |
|---|---|
| http://127.0.0.1:3011 | web (amber STAGING banner) |
| http://127.0.0.1:3011/healthz | web liveness |
| http://127.0.0.1:8011/api/health | api deep health (503 `degraded`/`unhealthy` shapes in `HEALTH_MONITORING.md`) |
| http://127.0.0.1:8011/docs | FastAPI docs (disabled only when `ENVIRONMENT=production`) |

A fresh staging DB has no `sync_runs`, so `/api/health` reports `degraded` (200). That is expected.

```bash
docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml logs -f api celery-worker
```

```bash
docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml down
```

Do not add `-v` on the Mac mini: `zms-ads-staging_redis-data` is the real staging volume.

## 4. Backend tests (Docker only)

The `test` stage of `backend/Dockerfile` installs the `dev` extras from `pyproject.toml`
(pytest, pytest-asyncio, ruff, httpx, pip-audit) and runs as the non-root `app` user.

```bash
docker build --target test -t zms-ads-api-test ./backend
```

```bash
docker run --rm zms-ads-api-test
```

```bash
docker run --rm zms-ads-api-test ruff check .
```

Expected: 49 tests pass, ruff clean. Run a single file with
`docker run --rm zms-ads-api-test pytest -q tests/test_policy.py`. pytest config
(`testpaths`, `asyncio_mode=auto`) and ruff rules (`E F W I B UP S`, line length 110) live in
`backend/pyproject.toml`. Same commands as `.github/workflows/ci.yml`.

## 5. Frontend dev server with the API proxied

`next.config.ts` rewrites `/api/*` to `API_URL`. With `frontend/.env.local` pointing
`API_URL` at the api container from step 3, the dev server on port 3000 uses that api.

```bash
cd frontend && npm ci
```

```bash
cd frontend && npm run dev
```

Open http://localhost:3000. Supabase Auth must allow `http://localhost:3000/**` as a redirect
(the hardening script adds it; `SUPABASE.md`).

## 6. Lint, typecheck, test, build

```bash
cd frontend && npm run lint && npm run typecheck && npm run test && npm run build
```

| Script | Runs |
|---|---|
| `npm run lint` | `eslint .` (`frontend/eslint.config.mjs`) |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run test` | `vitest run` (`src/lib/*.test.ts`) |
| `npm run build` | `next build`; needs `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` set (dummy values are fine, CI uses `https://example.supabase.co`) |

## 7. Branch and PR workflow

1. Branch from `main`: `feature/<name>`, `fix/<name>`, `docs/<name>`, `hardening/<name>`.
2. Commit early; run section 4 and 6 before pushing.
3. Open the PR:

```bash
gh pr create --base main --fill
```

4. CI (`ci.yml`) must be green: backend tests + ruff, frontend lint/typecheck/test/build,
   migration guard, runtime image builds. `security.yml` also runs on PRs (pip-audit,
   npm audit; CodeQL is a no-op on GitHub Free).
5. GitHub Free has no branch protection on private repos, so the rule is social: **one other
   person reviews, and nothing merges to `main` with a red CI**. Merging to `main` deploys to
   staging automatically (`DEPLOY_STAGING.md`); production is a separate manual step
   (`DEPLOY_PRODUCTION.md`).
6. Dependabot opens grouped weekly PRs (pip, npm, actions, docker base images). Treat them
   like any PR.

### Commit conventions

Match the existing history: one imperative subject line, under ~72 characters, describing the
user-visible change ("Services page (per-trade CPL/CPBA), spend filter on Overview"). Body
optional, explains why. No ticket prefixes. Do not amend or force-push a branch someone else
has checked out.

## 8. Migrations

Files: `supabase/migrations/<YYYYMMDD>0000<NN>_<snake_name>.sql`, applied in filename order by
`supabase db push`. Rules (details in `SUPABASE.md`):

- Non-destructive by default. No `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP SCHEMA`.
  Widen, add, backfill; remove in a later release once nothing reads the old shape.
- Idempotent where possible (`if not exists`, `drop policy if exists` before `create policy`).
- Backward-compatible with the image that is running, because the api restarts after the
  migration.
- Committed migration files are immutable. To change one, add a new file.

Create one:

```bash
touch supabase/migrations/$(date +%Y%m%d)0000NN_short_name.sql
```

Check it against `origin/main` (this is exactly what CI's `migrations` job runs):

```bash
scripts/check-migrations.sh origin/main
```

Output is `OK: no destructive statements`, `no migration changes since origin/main`, or a
`DESTRUCTIVE statements in <file>` list with line numbers (exit 1). `ALTER TABLE ... DROP
CONSTRAINT|DEFAULT|NOT NULL|IDENTITY` is allowed. A genuinely destructive migration needs an
owner review and `ALLOW_DESTRUCTIVE=1` on the run that applies it; CI will still fail on the
PR by design, so note the owner approval in the PR.

Apply to staging (asks nothing; production prompts for `migrate production`):

```bash
scripts/cloud/supabase-migrate.sh staging --dry-run
```

```bash
scripts/cloud/supabase-migrate.sh staging
```

## 9. Useful one-liners

```bash
docker compose -p zms-ads-staging --env-file .env.staging -f docker-compose.yml -f compose.staging.yml exec api python -m app.cli backfill --all --source meta --days 30
```

```bash
docker run --rm zms-ads-api-test pytest -q -k health
```

```bash
scripts/health.sh staging
```

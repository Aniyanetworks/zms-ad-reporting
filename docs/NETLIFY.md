# Netlify — frontend hosting (set up 2026-09-23)

Architecture: **GitHub** (code, CI) → **Netlify** (Next.js frontend, auto-deploys from
`main`, a preview URL per pull request) → **Mac mini** (FastAPI API, Celery syncs,
Daily Brief — Docker behind the Cloudflare tunnel) → **Supabase** (database, auth).

The frontend never talks to Supabase' Postgres or to Meta/Google directly; it calls
`/api/*`, which Next.js proxies to `https://api-ads.contractorscalingblueprint.com`
(tunnel → `zms-ads-api` on the Mac mini). That hostname exists and answers today.

## Status (2026-09-23)
Live: **https://zms-ads-intelligence.netlify.app** (site id 569ddbaf-8e33-4731-9b3d-a1c8ce078cd5,
team `sobaa260`, Free plan). Created via the Netlify API with a **read-only GitHub deploy
key** (repo key "Netlify (zms-ads-intelligence)") plus a repo webhook to
`https://api.netlify.com/hooks/github` — so pushes to `main` and pull requests deploy
without the Netlify GitHub App. Netlify's **"Private by default"** made the first deploy
answer 401 on every path (a Netlify team-login gate, not our auth): fixed under
Project configuration → General → Visitor access → Public. DNS cut-over of
`ads.contractorscalingblueprint.com` is still pending Carl's go.

## One-time setup (done — kept for reference)
1. netlify.com → Add new site → **Import an existing project** → GitHub → authorize
   the `zmsseoagency` org → pick `zms-ad-reporting`.
2. Netlify reads `netlify.toml` from the repo root (base `frontend`, Node 22, Next.js
   plugin). Leave build command / publish dir as detected.
3. **Site configuration → Environment variables** — add these four (values are in
   the Mac mini's `~/zms-ad-reporting/.env` and `backend/.env`; never paste them in chat):
   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | the Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the Supabase publishable (anon) key |
   | `API_URL` | `https://api-ads.contractorscalingblueprint.com` (already in netlify.toml; set here only to override) |
   | `NEXT_PUBLIC_ENVIRONMENT` | `production` (already in netlify.toml) |
4. New Netlify projects are **private by default** — set Project configuration →
   General → Visitor access → **Public**, or every request returns a 401 login gate.
5. Trigger the first deploy. You get a `https://<site>.netlify.app` URL — send it to
   Claude, who then:
   - adds it to the backend's allowed origins (`ALLOWED_ORIGINS` in `backend/.env`)
     and to Supabase Auth's redirect allow-list,
   - verifies login, Overview, Daily Brief and the Actions queue on the Netlify URL.
6. **Cut-over** (when you say go): in Netlify → Domain management add
   `ads.contractorscalingblueprint.com`; Claude repoints the Cloudflare DNS record
   from the tunnel to Netlify (`CNAME ads → <site>.netlify.app`, proxied off so
   Netlify can issue its certificate) and removes the `ads` ingress from the tunnel.
   The Mac mini keeps serving `setter.contractorscalingblueprint.com` and the API.

## What changes for developers
- Merge to `main` → Netlify builds and deploys the frontend in ~3 minutes.
  Every PR gets a preview URL (badge shows *staging*) hitting the production API.
- Backend changes still deploy through `scripts/deploy.sh production` or the
  `deploy-production` workflow on the Mac mini runner (unchanged).
- The Docker `web` container keeps running as a fallback until cut-over is proven;
  after that it can be stopped (`compose.production.yml` → remove `web`).

## Gotchas
- **Netlify never builds this repo itself.** Netlify's connected GitHub account is
  `sobaa260`, the repo is owned and pushed by `zmsseoagency`, and the Free plan blocks
  builds from "unrecognized Git contributors" — so every Netlify-run build was rejected.
  Instead `.github/workflows/deploy-netlify.yml` builds the frontend on GitHub Actions
  (Node 22, `netlify deploy --build --prod`, which still runs netlify.toml's Next.js
  plugin) and uploads it. Netlify's Git builds are stopped on the site and the repo
  webhook was removed. Secrets used by the workflow: `NETLIFY_AUTH_TOKEN`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`; variable `NETLIFY_SITE_ID`.
  Deploys trigger on pushes to `main` touching `frontend/**` or `netlify.toml`, or
  manually via *Actions → Deploy frontend to Netlify → Run workflow*.
- `frontend/public/` must stay tracked (`.gitkeep`) — Next copies it at build.
- Security headers/CSP are set in `next.config.ts` and apply on Netlify too.
- The API rate limiter sees Netlify's proxy IPs, not end users — if limits ever
  bite, key them on the Supabase user id instead.

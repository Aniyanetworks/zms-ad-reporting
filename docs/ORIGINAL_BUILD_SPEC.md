ZMS Ads Intelligence Dashboard — Phase 1 Build Spec (Claude Code Prompt)
Context
Build a multi-client paid ads reporting dashboard for Zeal Media Solutions (~19 home-services clients). It aggregates Meta Ads, Google Ads, and GoHighLevel data into one high-level view. Hosted on a Mac mini behind Cloudflare Tunnel, team logs in from a web domain (e.g. `ads.zealmediasolutions.com`).
This mirrors the existing ZMS SEO Dashboard stack — reuse patterns where possible:

* Frontend: Next.js 14 (App Router) + Tailwind + shadcn/ui, dark mode default
* Backend: FastAPI (Python 3.11+)
* Jobs: Celery + Redis (scheduled syncs)
* DB/Auth: Supabase (Postgres + Supabase Auth)
* Hosting: Mac mini, exposed via Cloudflare Tunnel

Phase 1 Scope (build this now)
High-level dashboard only — account and campaign level. No ad set / creative drill-down yet (Phase 2).
Metrics per client, per date range:

* Meta: spend, impressions, clicks, CTR, leads (on-platform + form), CPL
* Google Ads: spend, impressions, clicks, CTR, conversions (leads), CPL, LSA leads if available
* GHL: contacts created (attributed to paid), calls, appointments booked, cost per booked appointment (blended spend ÷ GHL appointments)
* Blended: total spend, total leads, blended CPL, lead→appointment rate

Data Model (Supabase / Postgres)

```sql
-- Clients registry
create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  meta_ad_account_id text,          -- act_XXXXXXXX
  google_ads_customer_id text,      -- XXX-XXX-XXXX (store digits only)
  ghl_location_id text,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Daily metrics, one row per client/platform/campaign/day
create table ad_metrics_daily (
  id bigint generated always as identity primary key,
  client_id uuid references clients(id) not null,
  platform text not null check (platform in ('meta','google')),
  campaign_id text not null,
  campaign_name text,
  campaign_status text,
  date date not null,
  spend numeric(12,2) default 0,
  impressions bigint default 0,
  clicks bigint default 0,
  leads numeric(10,2) default 0,     -- Meta: lead actions; Google: conversions (live value, restated on each sync)
  leads_t1 numeric(10,2),            -- settled snapshot: value 1 day after `date`
  leads_t3 numeric(10,2),            -- settled snapshot: value 3 days after `date`
  leads_t7 numeric(10,2),            -- settled snapshot: value 7 days after `date`
  phone_calls numeric(10,2) default 0,
  account_timezone text,
  currency text default 'USD',
  raw jsonb,                          -- full API row for later drill-down
  synced_at timestamptz default now(),
  unique (client_id, platform, campaign_id, date)
);

-- GHL daily rollup
create table ghl_metrics_daily (
  id bigint generated always as identity primary key,
  client_id uuid references clients(id) not null,
  date date not null,
  contacts_created int default 0,
  contacts_paid_attributed int default 0,  -- utm_medium in ('paid','cpc','paid_social')
  inbound_calls int default 0,
  appointments_booked int default 0,
  raw jsonb,
  synced_at timestamptz default now(),
  unique (client_id, date)
);

-- Sync run log (surface failures in UI)
create table sync_runs (
  id bigint generated always as identity primary key,
  source text not null,              -- 'meta' | 'google' | 'ghl'
  client_id uuid references clients(id),
  status text not null,              -- 'success' | 'error' | 'partial'
  rows_upserted int default 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz
);

-- Team users handled by Supabase Auth; add role in profiles
create table profiles (
  id uuid primary key references auth.users(id),
  full_name text,
  role text default 'viewer' check (role in ('admin','viewer'))
);

```

Enable RLS: authenticated users can read all tables; only service role writes.
Integrations
PREFERRED APPROACH: use `dlt` (data load tool, Apache 2.0, `pip install dlt`) verified sources for Meta and Google Ads instead of hand-rolling API clients. dlt handles auth, pagination, rate-limit retries, incremental state, and schema evolution, and loads directly into Postgres/Supabase. Celery tasks invoke dlt pipelines per client. Init with `dlt init facebook_ads postgres` and `dlt init google_ads postgres`. Land dlt output in a `raw_*` schema, then transform into `ad_metrics_daily` with SQL (dbt-style staging models; use Fivetran's open-source `dbt_ad_reporting` package on GitHub as the schema/grain reference — do not copy code, copy the modeling patterns). If a dlt source proves insufficient for a specific metric, fall back to direct API calls for that metric only.
1. Meta Marketing API (via dlt facebook_ads source)

* Auth: System User token from the ZMS Business Manager (long-lived, scopes: `ads_read`, `business_management`). One token covers all client ad accounts shared to the BM.
* Campaign-level daily insights; parse `actions` for `lead`, `onsite_conversion.lead_grouped`, `offsite_conversion.fb_pixel_lead`, and phone call actions.
* Lookback window: 28 days (not 7). Meta restates conversions for up to 28 days after the click; every daily sync must re-pull the trailing 28 days and upsert. This is how Airbyte/Stitch handle it and it is required for accurate lead counts.
* Settled-data snapshots: store `leads_t1`, `leads_t3`, `leads_t7` columns (value as-of 1/3/7 days after the date) alongside the live `leads` value. Meta restates numbers silently; snapshotting prevents client billing/reporting disputes.
* API constraints (post-2025/2026 Meta changes): the API now mirrors Ads Manager attribution settings automatically (do NOT pass legacy attribution-window params — several were deprecated Jan 12, 2026); a 13-month historical limit applies to some fields/breakdowns. Cap backfill at 12 months.
* Rate limits: batch per account, exponential backoff on error codes 17/80004/613.

2. Google Ads API (via dlt google_ads source)

* Auth: OAuth refresh token + developer token under the ZMS MCC (manager account); `login-customer-id` = MCC ID, query each client `customer_id`.
* GAQL (if writing a custom resource):


```sql
SELECT campaign.id, campaign.name, campaign.status,
       metrics.cost_micros, metrics.impressions, metrics.clicks,
       metrics.conversions, metrics.phone_calls
FROM campaign
WHERE segments.date BETWEEN '{start}' AND '{end}'

```

* Divide `cost_micros` by 1,000,000. Rolling re-sync of trailing 30 days (Google conversion lag), 12-month max backfill.
* LSA: if accessible, pull via Local Services API separately; otherwise defer to Phase 2 — do not block Phase 1.

3. GoHighLevel (API v2, via official Python SDK)

* Use the official SDK: `pip install gohighlevel-api-client` (async-first, built-in token refresh + storage adapters). Per-location Private Integration token or agency OAuth. Store per-client `ghl_location_id`.
* Pull daily:
   * Contacts created (filter `dateAdded` in window), count paid-attributed via `attributionSource` / UTM fields (`utm_medium` in paid set)
   * Appointments: calendar events per location per day → count booked
   * Calls: conversations/calls endpoint if enabled per location; store 0 if unavailable rather than failing the sync
* GHL rate limit: 100 req/10s burst — throttle per location.

Timezone & currency correctness (all sources)

* Each ad account reports in its OWN timezone; store `account_timezone` on `clients` and keep daily rows in account-local dates. Do not force-convert to PT — cross-platform daily rows won't reconcile otherwise.
* Store `currency` per account; assume USD but don't hardcode.

Celery Jobs

* `sync_meta_all` — daily 6:00 AM PT, loops active clients with `meta_ad_account_id`
* `sync_google_all` — daily 6:15 AM PT
* `sync_ghl_all` — daily 6:30 AM PT
* `backfill(client_slug, source, days)` — manual CLI/endpoint
* Every job writes a `sync_runs` row. Failures in one client must not abort the loop.

FastAPI Endpoints

```
GET  /api/health
GET  /api/clients
GET  /api/overview?start=YYYY-MM-DD&end=YYYY-MM-DD
     → per-client rollup: spend, leads, CPL by platform + blended + GHL appts + lead→appt rate
GET  /api/clients/{slug}/campaigns?start=&end=&platform=
     → campaign-level table for one client
GET  /api/sync/status          → last sync_runs per source
POST /api/sync/trigger         → admin-only, kicks a Celery job

```

All endpoints require Supabase JWT (verify via Supabase JWKS). Admin role required for trigger.
Frontend (Next.js)
Pages:

1. `/login` — Supabase Auth (email/password, invite-only; no public signup)
2. `/` — Agency Overview
   * Date range picker (presets: last 7d, last 30d, MTD, last month)
   * KPI cards: total spend, total leads, blended CPL, total appointments
   * Client table (sortable): Client | Meta Spend | Meta Leads | Meta CPL | Google Spend | Google Leads | Google CPL | Blended CPL | GHL Appts | Cost/Appt | Lead→Appt %
   * Conditional formatting: CPL cells green/yellow/red vs client-configurable target (default: green < $75, red > $150 — make thresholds a column on `clients` later)
   * Row click → client detail
3. `/clients/[slug]` — Client Detail
   * Same KPIs scoped to client, spend & leads trend chart (Recharts, daily), campaign table per platform with status badges
4. `/settings` — admin only: client registry CRUD (map ad account IDs / GHL location IDs), sync status panel with last-run times and error messages, manual sync button

Dark navy theme consistent with ZMS branding (match SEO dashboard).
Deployment (Mac mini)

* `docker-compose.yml` (or launchd + pm2 if matching existing SEO dashboard setup): fastapi, celery worker, celery beat, redis, nextjs
* Cloudflare Tunnel route: `ads.zealmediasolutions.com` → Next.js; API proxied at `/api` via Next.js rewrites to FastAPI (avoids CORS)
* `.env` template:


```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
SUPABASE_JWT_SECRET=
META_SYSTEM_USER_TOKEN=
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
GHL_AGENCY_TOKEN=
REDIS_URL=redis://localhost:6379/0
TZ=America/Los_Angeles

```

Build Order (do in this sequence)

1. Repo scaffold: `/backend` (FastAPI + Celery), `/frontend` (Next.js), docker-compose, README
2. Supabase migrations (tables above + RLS)
3. Meta sync task + backfill, verified against 1 client
4. Google Ads sync task + backfill, verified against 1 client
5. GHL sync task (contacts + appointments; calls optional)
6. API endpoints with JWT auth
7. Frontend: login → overview → client detail → settings
8. Sync status panel + error surfacing
9. Seed all ~19 clients, run 12-month backfill (Meta 13-month API history cap), smoke test

Non-goals for Phase 1 (do NOT build yet)

* Ad set / creative-level breakdown
* Creative fatigue detection or "make more like this" recommendations
* Creative naming convention enforcement
* Per-creative → GHL contact attribution
* AI-generated recommendations / insights

Structure `ad_metrics_daily.raw` jsonb and the `platform/campaign_id` keys so Phase 2 (ad set + creative tables with `parent_campaign_id`) drops in without migration pain.
Definition of Done

* All active clients syncing daily with zero manual steps
* Overview page loads < 2s for 30-day range across 19 clients
* A failed client sync shows in settings without breaking others
* Team members can log in from their own machines via the domain

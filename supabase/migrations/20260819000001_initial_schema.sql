-- ZMS Ads Intelligence Dashboard — Phase 1 initial schema
-- Grain reference: Fivetran dbt_ad_reporting (one row per client/platform/campaign/day)

-- ============================================================
-- Clients registry
-- ============================================================
create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  meta_ad_account_id text,          -- act_XXXXXXXX (store with or without act_ prefix; sync strips it)
  google_ads_customer_id text,      -- digits only (dashes stripped on write)
  ghl_location_id text,
  cpl_target_green numeric(10,2) default 75,   -- CPL below this renders green
  cpl_target_red numeric(10,2) default 150,    -- CPL above this renders red
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ============================================================
-- Daily metrics, one row per client/platform/campaign/day
-- ============================================================
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
  raw jsonb,                          -- full API row for later drill-down (Phase 2: ad set / creative tables key off platform+campaign_id)
  synced_at timestamptz default now(),
  unique (client_id, platform, campaign_id, date)
);

create index idx_ad_metrics_daily_client_date on ad_metrics_daily (client_id, date);
create index idx_ad_metrics_daily_date on ad_metrics_daily (date);
create index idx_ad_metrics_daily_platform_date on ad_metrics_daily (platform, date);

-- ============================================================
-- GHL daily rollup
-- ============================================================
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

create index idx_ghl_metrics_daily_client_date on ghl_metrics_daily (client_id, date);

-- ============================================================
-- Sync run log (surfaced in settings UI)
-- ============================================================
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

create index idx_sync_runs_source_started on sync_runs (source, started_at desc);

-- ============================================================
-- Team users handled by Supabase Auth; role lives in profiles
-- ============================================================
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text default 'viewer' check (role in ('admin','viewer'))
);

-- Auto-create a profile row when a user is invited/signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- RLS: authenticated users read everything; only service role writes.
-- (Service role bypasses RLS, so no write policies are defined.)
-- ============================================================
alter table clients enable row level security;
alter table ad_metrics_daily enable row level security;
alter table ghl_metrics_daily enable row level security;
alter table sync_runs enable row level security;
alter table profiles enable row level security;

create policy "authenticated read clients" on clients
  for select to authenticated using (true);
create policy "authenticated read ad_metrics_daily" on ad_metrics_daily
  for select to authenticated using (true);
create policy "authenticated read ghl_metrics_daily" on ghl_metrics_daily
  for select to authenticated using (true);
create policy "authenticated read sync_runs" on sync_runs
  for select to authenticated using (true);
create policy "authenticated read profiles" on profiles
  for select to authenticated using (true);

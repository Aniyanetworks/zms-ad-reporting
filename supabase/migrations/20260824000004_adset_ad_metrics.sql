-- Sub-campaign drill-down: ad set and ad level daily metrics.
-- Same grain pattern as ad_metrics_daily; Google ad groups land in
-- adset_metrics_daily under platform='google' when Google Ads goes live.

create table adset_metrics_daily (
  id bigint generated always as identity primary key,
  client_id uuid references clients(id) not null,
  platform text not null check (platform in ('meta','google')),
  campaign_id text not null,
  adset_id text not null,
  adset_name text,
  date date not null,
  spend numeric(12,2) default 0,
  impressions bigint default 0,
  clicks bigint default 0,
  leads numeric(10,2) default 0,
  phone_calls numeric(10,2) default 0,
  currency text default 'USD',
  raw jsonb,
  synced_at timestamptz default now(),
  unique (client_id, platform, adset_id, date)
);

create index idx_adset_metrics_campaign on adset_metrics_daily (client_id, campaign_id, date);

create table ad_level_metrics_daily (
  id bigint generated always as identity primary key,
  client_id uuid references clients(id) not null,
  platform text not null check (platform in ('meta','google')),
  campaign_id text not null,
  adset_id text not null,
  ad_id text not null,
  ad_name text,
  date date not null,
  spend numeric(12,2) default 0,
  impressions bigint default 0,
  clicks bigint default 0,
  leads numeric(10,2) default 0,
  phone_calls numeric(10,2) default 0,
  currency text default 'USD',
  raw jsonb,
  synced_at timestamptz default now(),
  unique (client_id, platform, ad_id, date)
);

create index idx_ad_level_metrics_adset on ad_level_metrics_daily (client_id, adset_id, date);

alter table adset_metrics_daily enable row level security;
alter table ad_level_metrics_daily enable row level security;

create policy "authenticated read adset_metrics_daily" on adset_metrics_daily
  for select to authenticated using (true);
create policy "authenticated read ad_level_metrics_daily" on ad_level_metrics_daily
  for select to authenticated using (true);

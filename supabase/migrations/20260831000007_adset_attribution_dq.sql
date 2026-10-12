-- Ad-set-level GHL attribution (ZMS quirk: contact utmMedium carries the ad
-- set name) + junk-lead tracking.

create table ghl_adset_daily (
  id bigint generated always as identity primary key,
  client_id uuid references clients(id) not null,
  date date not null,
  adset_name text not null,
  contacts_paid int default 0,
  appointments int default 0,
  synced_at timestamptz default now(),
  unique (client_id, date, adset_name)
);
create index idx_ghl_adset_daily_client on ghl_adset_daily (client_id, adset_name, date);
alter table ghl_adset_daily enable row level security;
create policy "authenticated read ghl_adset_daily" on ghl_adset_daily
  for select to authenticated using (true);

-- Opportunities currently sitting in junk stages ("Not Interested", "Bad Lead"),
-- bucketed by the day they entered the stage.
alter table ghl_metrics_daily add column leads_dq integer default 0;

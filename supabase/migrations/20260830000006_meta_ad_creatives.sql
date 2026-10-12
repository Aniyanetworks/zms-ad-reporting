-- Creative metadata per Meta ad: shareable preview link + thumbnail, so winning
-- ads can be opened and iterated on directly from the dashboard.

create table meta_ad_creatives (
  ad_id text primary key,
  account_id text not null,
  ad_name text,
  status text,
  preview_link text,
  thumbnail_url text,
  updated_at timestamptz default now()
);

create index idx_meta_ad_creatives_account on meta_ad_creatives (account_id);

alter table meta_ad_creatives enable row level security;
create policy "authenticated read meta_ad_creatives" on meta_ad_creatives
  for select to authenticated using (true);

-- Small key/value store for app-managed state (e.g. the sheets export spreadsheet id).
create table app_settings (
  key text primary key,
  value text not null
);
alter table app_settings enable row level security;

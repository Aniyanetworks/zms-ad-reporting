-- Granular data for AI analysis (Carl, 2026-09-23: "collect creatives, ad sets and
-- everything, maybe not for the report, so I can give it to AI to analyze").
--
-- 1. Meta creative COPY (headline, primary text, description, CTA, media ids and the
--    full object_story_spec / asset_feed_spec) alongside the preview link we already
--    stored — an AI can't judge a creative it can't read.
-- 2. Google Ads below campaign level: ad groups, ads (RSA headlines/descriptions),
--    keywords and search terms, daily. Until now Google was campaign-level only.

alter table meta_ad_creatives
  add column if not exists creative_id       text,
  add column if not exists campaign_id       text,
  add column if not exists adset_id          text,
  add column if not exists title             text,     -- headline
  add column if not exists body              text,     -- primary text
  add column if not exists description       text,
  add column if not exists cta_type          text,
  add column if not exists image_url         text,
  add column if not exists video_id          text,
  add column if not exists object_story_spec jsonb,
  add column if not exists asset_feed_spec   jsonb,    -- dynamic creative: all headline/body variants
  add column if not exists created_time      timestamptz;

create index if not exists idx_meta_ad_creatives_campaign on meta_ad_creatives (campaign_id);

-- ------------------------------------------------------------------ Google: ad groups
create table if not exists google_adgroup_metrics_daily (
  id             bigint generated always as identity primary key,
  client_id      uuid not null references clients(id) on delete cascade,
  customer_id    text not null,
  campaign_id    text not null,
  campaign_name  text,
  ad_group_id    text not null,
  ad_group_name  text,
  ad_group_status text,
  ad_group_type  text,
  date           date not null,
  spend          numeric(12,2) not null default 0,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  conversions    numeric(12,2) not null default 0,
  phone_calls    numeric(12,2) not null default 0,
  synced_at      timestamptz not null default now(),
  unique (client_id, ad_group_id, date)
);
create index if not exists idx_google_adgroup_client_date on google_adgroup_metrics_daily (client_id, date);

-- ------------------------------------------------------------------ Google: ads (RSA copy)
create table if not exists google_ad_metrics_daily (
  id             bigint generated always as identity primary key,
  client_id      uuid not null references clients(id) on delete cascade,
  customer_id    text not null,
  campaign_id    text not null,
  ad_group_id    text not null,
  ad_group_name  text,
  ad_id          text not null,
  ad_name        text,
  ad_type        text,
  ad_status      text,
  ad_strength    text,
  final_urls     jsonb,
  headlines      jsonb,   -- RSA headline assets [{text, pinned_field}]
  descriptions   jsonb,   -- RSA description assets
  date           date not null,
  spend          numeric(12,2) not null default 0,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  conversions    numeric(12,2) not null default 0,
  synced_at      timestamptz not null default now(),
  unique (client_id, ad_id, date)
);
create index if not exists idx_google_ad_client_date on google_ad_metrics_daily (client_id, date);

-- ------------------------------------------------------------------ Google: keywords
create table if not exists google_keyword_metrics_daily (
  id             bigint generated always as identity primary key,
  client_id      uuid not null references clients(id) on delete cascade,
  customer_id    text not null,
  campaign_id    text not null,
  ad_group_id    text not null,
  criterion_id   text not null,
  keyword_text   text,
  match_type     text,
  keyword_status text,
  date           date not null,
  spend          numeric(12,2) not null default 0,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  conversions    numeric(12,2) not null default 0,
  synced_at      timestamptz not null default now(),
  unique (client_id, ad_group_id, criterion_id, date)
);
create index if not exists idx_google_keyword_client_date on google_keyword_metrics_daily (client_id, date);

-- ------------------------------------------------------------------ Google: search terms
create table if not exists google_search_terms_daily (
  id             bigint generated always as identity primary key,
  client_id      uuid not null references clients(id) on delete cascade,
  customer_id    text not null,
  campaign_id    text not null,
  ad_group_id    text not null,
  search_term    text not null,
  term_status    text,   -- ADDED / EXCLUDED / NONE — whether the term is already a keyword/negative
  date           date not null,
  spend          numeric(12,2) not null default 0,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  conversions    numeric(12,2) not null default 0,
  synced_at      timestamptz not null default now(),
  unique (client_id, ad_group_id, search_term, date)
);
create index if not exists idx_google_search_terms_client_date on google_search_terms_daily (client_id, date);

-- Same access model as the other reporting tables: signed-in dashboard users read,
-- only the service role (Celery) writes, the read-only plugin role can SELECT.
alter table google_adgroup_metrics_daily enable row level security;
alter table google_ad_metrics_daily      enable row level security;
alter table google_keyword_metrics_daily enable row level security;
alter table google_search_terms_daily    enable row level security;
create policy "authenticated read google_adgroup_metrics_daily" on google_adgroup_metrics_daily for select to authenticated using (true);
create policy "authenticated read google_ad_metrics_daily"      on google_ad_metrics_daily      for select to authenticated using (true);
create policy "authenticated read google_keyword_metrics_daily" on google_keyword_metrics_daily for select to authenticated using (true);
create policy "authenticated read google_search_terms_daily"    on google_search_terms_daily    for select to authenticated using (true);
grant select on google_adgroup_metrics_daily, google_ad_metrics_daily,
  google_keyword_metrics_daily, google_search_terms_daily to plugin_reader;

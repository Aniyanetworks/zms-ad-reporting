-- Preferred Meta pixel/dataset per client. Accounts can hold several pixels (US Pro has a
-- stale client-owned one next to the live Zeal-owned one); this is the one the Campaign
-- Builder uses for website ad sets and the one the CAPI setup instructions name.
alter table clients add column if not exists meta_pixel_id text;
comment on column clients.meta_pixel_id is 'Preferred Meta pixel/dataset id (digits). Set in Settings; used by the Campaign Builder and tracking recommendations.';
-- Carl, 2026-09-23: US Pro's live pixel is "Us pro paint" (ends in 8571).
update clients set meta_pixel_id = '26857381320598571' where slug = 'us-pro-painter-and-renovation' and meta_pixel_id is null;

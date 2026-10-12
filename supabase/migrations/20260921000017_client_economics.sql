-- Unit economics per client so CPBA can be judged against what a booked appointment
-- is WORTH, not just against other clients (Carl, 2026-09-21):
--   max_cpba = avg_job_value × close_rate × gross_margin_pct × max_ad_cost_share
-- i.e. the most we may pay for an appointment while ads consume at most
-- max_ad_cost_share of the gross profit that appointment produces on average.
-- Defaults are conservative industry-typical values; edit per client in Settings.
alter table clients add column if not exists close_rate        numeric default 0.25;  -- booked appointment → won job
alter table clients add column if not exists gross_margin_pct  numeric default 0.35;  -- gross margin on a job
alter table clients add column if not exists max_ad_cost_share numeric default 0.30;  -- share of gross profit ads may consume
-- Creative sync now records where each ad sends people and whether the ad-set UTM is on it
alter table meta_ad_creatives add column if not exists link_url text;
alter table meta_ad_creatives add column if not exists url_tags text;
alter table meta_ad_creatives add column if not exists has_adset_utm boolean;  -- null = Instant Form / no website link
alter table meta_ad_creatives add column if not exists effective_status text;

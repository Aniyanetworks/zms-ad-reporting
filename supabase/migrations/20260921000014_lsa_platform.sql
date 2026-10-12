-- Local Services Ads are reported as their own platform (Carl, 2026-09-21): they buy
-- and convert nothing like Search/PMax, so blending them into 'google' hides both.
-- LSA campaigns arrive through the Google Ads API either inside a regular account
-- (campaign name 'LocalServicesCampaign:SystemGenerated:…') or as a dedicated LSA
-- customer id, which now lives on clients.google_lsa_customer_id.
alter table ad_metrics_daily       drop constraint if exists ad_metrics_daily_platform_check;
alter table ad_metrics_daily       add  constraint ad_metrics_daily_platform_check       check (platform in ('meta','google','lsa'));
alter table adset_metrics_daily    drop constraint if exists adset_metrics_daily_platform_check;
alter table adset_metrics_daily    add  constraint adset_metrics_daily_platform_check    check (platform in ('meta','google','lsa'));
alter table ad_level_metrics_daily drop constraint if exists ad_level_metrics_daily_platform_check;
alter table ad_level_metrics_daily add  constraint ad_level_metrics_daily_platform_check check (platform in ('meta','google','lsa'));
alter table campaign_service_map   drop constraint if exists campaign_service_map_platform_check;
alter table campaign_service_map   add  constraint campaign_service_map_platform_check   check (platform in ('meta','google','lsa'));
alter table service_targets        drop constraint if exists service_targets_platform_check;
alter table service_targets        add  constraint service_targets_platform_check        check (platform in ('all','meta','google','lsa'));
alter table clients add column if not exists google_lsa_customer_id text;
-- one-time: LSA campaigns already merged under 'google' move to 'lsa'
update campaign_service_map set platform = 'lsa' where platform = 'google' and campaign_name like 'LocalServicesCampaign%';
update ad_metrics_daily     set platform = 'lsa' where platform = 'google' and campaign_name like 'LocalServicesCampaign%';

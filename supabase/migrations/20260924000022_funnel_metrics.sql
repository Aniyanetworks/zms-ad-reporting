-- Lead-gen funnel metrics (Carl's metrics guide, 2026-09-24): the Meta "ad metrics"
-- we did not collect (reach, unique link / outbound clicks, 3-second plays, ThruPlays →
-- frequency, CPMr, hook rate, hold rate) and the offline stages after "booked"
-- (confirmed, showed, no-show) so the report can read left-to-right as a funnel:
-- spend → leads → qualified → booked → shown → closed → CAC / ROAS.

-- dlt lands the new insight fields in raw_meta; declare the columns so the first
-- merge after deploy doesn't race dlt's schema evolution.
alter table if exists raw_meta.campaign_insights_daily
  add column if not exists reach bigint, add column if not exists unique_link_clicks bigint,
  add column if not exists unique_outbound_clicks bigint, add column if not exists video_3s_plays numeric,
  add column if not exists thruplays numeric;
alter table if exists raw_meta.adset_insights_daily
  add column if not exists reach bigint, add column if not exists unique_link_clicks bigint,
  add column if not exists unique_outbound_clicks bigint, add column if not exists video_3s_plays numeric,
  add column if not exists thruplays numeric;
alter table if exists raw_meta.ad_insights_daily
  add column if not exists reach bigint, add column if not exists unique_link_clicks bigint,
  add column if not exists unique_outbound_clicks bigint, add column if not exists video_3s_plays numeric,
  add column if not exists thruplays numeric;

alter table ad_metrics_daily
  add column if not exists reach bigint not null default 0,
  add column if not exists unique_link_clicks bigint not null default 0,
  add column if not exists unique_outbound_clicks bigint not null default 0,
  add column if not exists video_3s_plays numeric(12,2) not null default 0,
  add column if not exists thruplays numeric(12,2) not null default 0;
alter table adset_metrics_daily
  add column if not exists reach bigint not null default 0,
  add column if not exists unique_link_clicks bigint not null default 0,
  add column if not exists unique_outbound_clicks bigint not null default 0,
  add column if not exists video_3s_plays numeric(12,2) not null default 0,
  add column if not exists thruplays numeric(12,2) not null default 0;
alter table ad_level_metrics_daily
  add column if not exists reach bigint not null default 0,
  add column if not exists unique_link_clicks bigint not null default 0,
  add column if not exists unique_outbound_clicks bigint not null default 0,
  add column if not exists video_3s_plays numeric(12,2) not null default 0,
  add column if not exists thruplays numeric(12,2) not null default 0;

-- Offline stages after the booking (paid-attributed contacts only, from GHL calendar
-- event appointmentStatus: confirmed / showed / noshow).
alter table ghl_metrics_daily
  add column if not exists appointments_confirmed int not null default 0,
  add column if not exists appointments_showed int not null default 0,
  add column if not exists appointments_noshow int not null default 0;

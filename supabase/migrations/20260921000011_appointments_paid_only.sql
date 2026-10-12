-- appointments_booked now counts ONLY bookings whose GHL contact came from a paid
-- ad (Facebook/Instagram or Google), because it divides ad spend to give CPBA.
-- Several locations run one pipeline for Angi / BuilderTrend / website / organic
-- leads too; counting those inflated paid appointments badly (US Pro Painter:
-- 198 total vs ~50 paid in 30 days). The unfiltered total is kept here.
alter table ghl_metrics_daily add column if not exists appointments_all int not null default 0;
comment on column ghl_metrics_daily.appointments_booked is 'Bookings attributed to paid ads only — the denominator for CPBA';
comment on column ghl_metrics_daily.appointments_all is 'All bookings in the appointment stages, any source (organic, Angi, BuilderTrend, website)';

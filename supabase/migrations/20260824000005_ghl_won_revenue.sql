-- Won opportunities per day (count + monetary value) from GHL Opportunities.
-- Teams mark opportunities won in GHL; monetaryValue populates revenue once the
-- team enters job values (Hyros-style closed-loop reporting).

alter table ghl_metrics_daily
  add column jobs_won integer default 0,
  add column revenue_won numeric(12,2) default 0;

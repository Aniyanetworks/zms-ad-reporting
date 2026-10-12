-- Plugin schema additions (zeal-paid-ads Stage 2). REVIEW BEFORE APPLYING.
-- Names align with docs/schema-map.md in the plugin repo: metric tables are
-- ad_metrics_daily / adset_metrics_daily / ghl_metrics_daily (the spec's
-- ad_performance_daily / leads / appointments do not exist).

-- ============================================================
-- 1. clients: trade, economics, targets, booking system, timezone
--    (timezone was referenced by the spec but never existed — added here;
--    default matches the agency's reporting timezone)
-- ============================================================
alter table clients
  add column trade text check (trade in (
    'roofing','painting','landscaping','plumbing','decks_outdoor',
    'general_contracting','flooring_tile','remodeling','exteriors_windows','other')),
  add column avg_job_value numeric,
  add column target_cpl numeric,
  add column target_cpba numeric,
  add column booking_system text not null default 'ghl'
    check (booking_system in ('ghl','jobber','other')),
  add column timezone text not null default 'America/Los_Angeles';

comment on column clients.booking_system is
  'Non-ghl clients are excluded from appointment math and labeled as such — never shown as zero.';

-- ============================================================
-- 2. benchmarks: internal percentiles per trade + industry fallback rows
-- ============================================================
create table benchmarks (
  id bigint generated always as identity primary key,
  trade text not null,
  metric text not null check (metric in (
    'cpl','cpba','ctr','cpc','cpm','lead_form_cvr','lead_to_appt_rate','frequency')),
  window_days int not null,
  p25 numeric,
  median numeric,
  p75 numeric,
  n_adsets int,
  source text not null check (source in ('internal','industry')),
  computed_at timestamptz not null default now(),
  notes text,
  unique (trade, metric, window_days, source)
);

-- ============================================================
-- 3. triage_runs: one row per /weekly-triage (or /audit-account) execution
-- ============================================================
create table triage_runs (
  id bigint generated always as identity primary key,
  client_id uuid not null references clients(id),
  run_at timestamptz not null default now(),
  window_start date not null,
  window_end date not null,
  spend numeric,
  leads numeric,
  appointments_ghl int,
  appointments_meta_reported int,          -- fetched live from Meta at triage time
  divergence_ratio numeric,                -- |1 - meta/ghl|, null when ghl = 0
  cpl numeric,
  cpba numeric,
  lead_to_appt_rate numeric,
  score text check (score in ('green','yellow','red')),
  summary_md text,
  raw jsonb
);
create index idx_triage_runs_client on triage_runs (client_id, run_at desc);

-- ============================================================
-- 4. recommendations: the proposal queue. Only /execute may act on one,
--    and only after status = 'approved'.
-- ============================================================
create table recommendations (
  id bigint generated always as identity primary key,
  client_id uuid not null references clients(id),
  triage_run_id bigint references triage_runs(id),
  created_at timestamptz not null default now(),
  entity_type text not null check (entity_type in ('campaign','adset','ad','account')),
  entity_id text,
  entity_name text,
  action text not null check (action in (
    'budget_change','pause','activate','refresh_creative','fix_signal','investigate')),
  current_value text,
  proposed_value text,
  pct_change numeric,
  reason text not null,
  evidence jsonb,
  risk text,
  rollback_value text,
  status text not null default 'proposed' check (status in (
    'proposed','approved','executed','dismissed','failed')),
  approved_by text,
  executed_by text,
  executed_at timestamptz,
  verification jsonb
);
create index idx_recommendations_client on recommendations (client_id, status, created_at desc);

-- ============================================================
-- 5. v_client_scorecard: latest triage per client + that trade's benchmarks
--    (internal preferred, industry fallback) so the dashboard color-codes
--    without recomputing.
-- ============================================================
create view v_client_scorecard as
with latest as (
  select distinct on (client_id) *
  from triage_runs
  order by client_id, run_at desc
),
bench as (
  select distinct on (trade, metric)
         trade, metric, p25, median, p75, source
  from benchmarks
  where window_days = 90
  order by trade, metric,
           case source when 'internal' then 0 else 1 end
)
select
  c.id as client_id, c.slug, c.name, c.trade, c.booking_system,
  c.target_cpl, c.target_cpba, c.avg_job_value,
  t.run_at, t.window_start, t.window_end,
  t.spend, t.leads, t.appointments_ghl, t.appointments_meta_reported,
  t.divergence_ratio, t.cpl, t.cpba, t.lead_to_appt_rate, t.score,
  bc.p25 as cpl_p25, bc.median as cpl_median, bc.p75 as cpl_p75, bc.source as cpl_bench_source,
  ba.p25 as cpba_p25, ba.median as cpba_median, ba.p75 as cpba_p75, ba.source as cpba_bench_source
from clients c
left join latest t on t.client_id = c.id
left join bench bc on bc.trade = c.trade and bc.metric = 'cpl'
left join bench ba on ba.trade = c.trade and ba.metric = 'cpba'
where c.is_active = true;

-- ============================================================
-- 6. RLS: dashboard users read; writes go through the FastAPI service role.
-- ============================================================
alter table benchmarks enable row level security;
alter table triage_runs enable row level security;
alter table recommendations enable row level security;
create policy "authenticated read benchmarks" on benchmarks for select to authenticated using (true);
create policy "authenticated read triage_runs" on triage_runs for select to authenticated using (true);
create policy "authenticated read recommendations" on recommendations for select to authenticated using (true);

-- ============================================================
-- 7. plugin_reader: read-only Postgres role for the Supabase MCP
--    (SELECT on the reporting surface only; no secrets, no raw schemas)
-- ============================================================
create role plugin_reader nologin;
grant usage on schema public to plugin_reader;
grant select on clients, ad_metrics_daily, adset_metrics_daily, ad_level_metrics_daily,
  ghl_metrics_daily, ghl_adset_daily, meta_ad_creatives, sync_runs,
  benchmarks, triage_runs, recommendations, v_client_scorecard to plugin_reader;
-- deliberately NOT granted: client_secrets, app_settings, profiles, raw_* schemas

-- Service-based CPL/CPBA targets (Carl, 2026-09-21): a client's single CPL target
-- is wrong for multi-service clients — a $70 additions lead and a $160 kitchen-
-- refresh lead can both be "good". Targets live per service × platform; rows are
-- seeded from the portfolio's trailing-90-day averages and edited in Settings.
-- Resolution: (service, platform) → (service, 'all') → the client's own targets.
create table if not exists service_targets (
  service     text not null,
  platform    text not null default 'all' check (platform in ('all','meta','google')),
  cpl_green   numeric,
  cpl_red     numeric,
  cpba_green  numeric,
  cpba_red    numeric,
  source      text not null default 'seed' check (source in ('seed','manual')),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (service, platform)
);
alter table service_targets enable row level security;
create policy "authenticated read service_targets" on service_targets for select to authenticated using (true);
grant select on service_targets to plugin_reader;

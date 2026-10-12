-- Integration health: is each data source linked, syncing, and producing the events
-- we depend on (GHL Scheduled/Confirmed Appointment stages, Won, paid attribution,
-- ad UTMs)? Refreshed nightly (2:05 AM PT, before the Daily Brief) and on demand.
create table if not exists integration_health (
  client_id   uuid not null references clients(id) on delete cascade,
  check_key   text not null,
  status      text not null check (status in ('green','yellow','red','grey')),
  detail      text,
  checked_at  timestamptz not null default now(),
  primary key (client_id, check_key)
);
alter table integration_health enable row level security;
create policy "authenticated read integration_health" on integration_health for select to authenticated using (true);
grant select on integration_health to plugin_reader;

-- Campaign-level service tagging. A client can run several services (US Pro Painter
-- runs cabinets, exterior painting, decks, kitchens...), so per-service CPL/CPBA has
-- to come from campaign names, not clients.trade. Rows with source='auto' are
-- rewritten by app.services.classify after every sync; source='manual' rows win.

alter table clients add column if not exists default_service text;

create table if not exists campaign_service_map (
  client_id     uuid not null references clients(id) on delete cascade,
  platform      text not null check (platform in ('meta','google')),
  campaign_id   text not null,
  campaign_name text,
  service       text not null,
  source        text not null default 'auto' check (source in ('auto','manual')),
  updated_at    timestamptz not null default now(),
  primary key (client_id, platform, campaign_id)
);

alter table campaign_service_map enable row level security;
create policy "authenticated read campaign_service_map" on campaign_service_map
  for select to authenticated using (true);
grant select on campaign_service_map to plugin_reader;

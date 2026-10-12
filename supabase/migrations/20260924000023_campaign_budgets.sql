-- Current daily / lifetime budgets per campaign and Meta ad set (Carl, 2026-09-24:
-- "add the daily budget column" — the guide's far-left columns are Delivery, Budget,
-- Amount Spent). A snapshot refreshed on every sync, not a daily history.
create table if not exists campaign_budgets (
  client_id        uuid not null references clients(id) on delete cascade,
  platform         text not null check (platform in ('meta', 'google', 'lsa')),
  entity_type      text not null check (entity_type in ('campaign', 'adset')),
  entity_id        text not null,
  campaign_id      text not null,
  name             text,
  status           text,
  daily_budget     numeric(12,2),       -- null when the budget is lifetime or set at the other level (CBO / ABO)
  lifetime_budget  numeric(12,2),
  budget_source    text,                -- 'campaign' (CBO / Google campaign budget) or 'adset' (ABO)
  currency         text default 'USD',
  updated_at       timestamptz not null default now(),
  primary key (client_id, platform, entity_type, entity_id)
);
create index if not exists idx_campaign_budgets_campaign on campaign_budgets (client_id, platform, campaign_id);

alter table campaign_budgets enable row level security;
create policy "authenticated read campaign_budgets" on campaign_budgets for select to authenticated using (true);
grant select on campaign_budgets to plugin_reader;

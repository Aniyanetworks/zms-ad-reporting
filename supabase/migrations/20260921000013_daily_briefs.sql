-- One brief per client per day: what changed in the last 7 complete days, what's
-- red, and what to do. Written by app.services.brief after the 1 AM syncs. Every
-- finding with an action also becomes a `recommendations` row (status proposed)
-- unless an open one already exists for the same entity+action, so the Actions
-- queue never fills with duplicates. Nothing here touches Meta or Google.
create table if not exists daily_briefs (
  id             bigint generated always as identity primary key,
  client_id      uuid not null references clients(id) on delete cascade,
  brief_date     date not null,
  window_start   date not null,
  window_end     date not null,
  score          text check (score in ('green','yellow','red')),
  summary_md     text,
  platforms      jsonb not null default '[]',
  findings       jsonb not null default '[]',
  triage_run_id  bigint references triage_runs(id),
  created_at     timestamptz not null default now(),
  unique (client_id, brief_date)
);
alter table daily_briefs enable row level security;
create policy "authenticated read daily_briefs" on daily_briefs for select to authenticated using (true);
grant select on daily_briefs to plugin_reader;

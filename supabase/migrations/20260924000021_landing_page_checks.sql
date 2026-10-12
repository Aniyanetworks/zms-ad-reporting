-- Nightly landing-page checks for every URL paid ads send traffic to.
-- Born from the 2026-09-23 Google review: uspropaint.com (final URL of a Search
-- campaign) was serving a "Thank you, your consultation is booked" page and 853
-- clicks a month landed on it. Nobody would have noticed without opening the page.
create table if not exists landing_page_checks (
  client_id        uuid not null references clients(id) on delete cascade,
  url              text not null,
  platforms        text[] not null default '{}',      -- which platforms send traffic here
  spend_30d        numeric(12,2) not null default 0,
  http_status      int,
  final_url        text,
  title            text,
  bytes            int,
  load_ms          int,
  has_form         boolean,                            -- null when the page is client-rendered (can't tell from HTML)
  has_tel_link     boolean,
  looks_thank_you  boolean not null default false,     -- page reads like a confirmation page
  client_rendered  boolean not null default false,     -- tiny HTML shell + JS app; form/tel detection not reliable
  flags            text[] not null default '{}',       -- human-readable problems
  status           text not null default 'green' check (status in ('green','yellow','red')),
  error            text,
  checked_at       timestamptz not null default now(),
  primary key (client_id, url)
);
create index if not exists idx_landing_page_checks_status on landing_page_checks (status);

alter table landing_page_checks enable row level security;
create policy "authenticated read landing_page_checks" on landing_page_checks for select to authenticated using (true);
grant select on landing_page_checks to plugin_reader;

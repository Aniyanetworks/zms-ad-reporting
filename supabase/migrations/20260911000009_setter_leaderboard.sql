-- Appointment-setter leaderboard (2026-09-11). Two read-only Google Sheets are
-- polled every minute and mirrored here; the leaderboard API reads only these
-- tables. Both tables are replaced wholesale on every successful poll of their
-- source (one transaction each), so a failed poll leaves the previous snapshot
-- in place and the page keeps serving stale-but-valid data.
--
-- Deliberately NOT stored: the Commission column from the commission tracker.
-- The leaderboard is a competition view, not a pay-comparison tool.

-- ============================================================
-- 1. setter_appointments — one row per booked appointment
--    Source: "Appointment_Setter_Commission_Tracker_Updated" (one tab per setter)
-- ============================================================
create table setter_appointments (
  id bigint generated always as identity primary key,
  setter text not null,
  date_booked date not null,
  client text,
  lead_source text,
  customer_name text,
  appointment_date date,
  -- Raw status text from the sheet, normalised to title case:
  -- Scheduled | Show | No-Show | Cancelled | Not Interested | '' (blank)
  status text not null default '',
  source_row int,                       -- 1-based row in the setter's tab, for debugging
  synced_at timestamptz not null default now()
);
create index idx_setter_appointments_month on setter_appointments (setter, date_booked);

-- ============================================================
-- 2. setter_daily_activity — one row per setter × day × client account
--    Source: "Ads Appointment Setter Tracking - Current" (per-setter daily log tabs)
--    Booking ratio = sum(appts_set) / sum(new_leads) over the calendar month.
-- ============================================================
create table setter_daily_activity (
  id bigint generated always as identity primary key,
  setter text not null,
  date date not null,
  client text,
  new_leads int not null default 0,
  contacted int not null default 0,
  appts_set int not null default 0,
  rescheduled int not null default 0,
  dq int not null default 0,
  source_row int,
  synced_at timestamptz not null default now()
);
create index idx_setter_daily_activity_month on setter_daily_activity (setter, date);

-- Service role only (the API reads with the service key; the public leaderboard
-- endpoint returns aggregates, never customer names).
alter table setter_appointments enable row level security;
alter table setter_daily_activity enable row level security;

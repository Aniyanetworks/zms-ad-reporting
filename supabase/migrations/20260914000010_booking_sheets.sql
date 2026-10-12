-- Some clients' setters log booked appointments in a Google Sheet instead of moving
-- GHL opportunities to a Scheduled/Confirmed stage (Paradise Decks). For those,
-- booking_system='sheet': the daily GHL sync leaves appointments/jobs/revenue alone
-- and app.services.booking_sheet fills them from the sheet (public CSV export).

alter table clients drop constraint if exists clients_booking_system_check;
alter table clients add constraint clients_booking_system_check
  check (booking_system in ('ghl', 'sheet', 'jobber', 'other'));

alter table clients add column if not exists bookings_sheet_id text;
alter table clients add column if not exists bookings_sheet_gid int not null default 0;

-- Setter leaderboard (2026-10-05, Carl): show what each setter earned.
-- Commission comes from the commission tracker's own Commission column (rate card:
-- $3 per Show; the Angi $1 split was removed 2026-10-05), mirrored per appointment row.
alter table setter_appointments add column if not exists commission numeric not null default 0;

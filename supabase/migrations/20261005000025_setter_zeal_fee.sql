-- Setter leaderboard team goal = money made for Zeal Media Solutions (Carl, 2026-10-05),
-- not client job value. What Zeal earns per booked appointment, per client; the
-- leaderboard falls back to SETTER_DEFAULT_ZEAL_FEE when unset.
alter table clients add column if not exists setter_fee_per_appt numeric;
comment on column clients.setter_fee_per_appt is
  'Revenue Zeal makes per appointment the setters book for this client (USD). Drives the setter leaderboard team goal.';

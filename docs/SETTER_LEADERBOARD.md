# Setter leaderboard (`/leaderboard`, public)

A view-only, near-real-time board for the appointment setters, served without login at
**https://setter.contractorscalingblueprint.com** (same web container; `LEADERBOARD_HOST`
makes that hostname answer only `/leaderboard`). Also linked as "Setters" in the nav.

Two sections, both for the calendar month (America/Los_Angeles):

- **Team effort** — money made for Zeal Media Solutions from the appointments booked, vs a monthly goal
  (progress bar with a "where the month is" pace marker), plus booked, confirmed,
  show-up, booking ratio and team commission earned.
- **Individual effort** — horizontal bar per setter (confirmed vs still-to-happen),
  ranked by appointments booked, with earnings; then a table, then prior months.

| Metric | Source | Definition |
|---|---|---|
| Booked | Commission tracker (Sheet A, `SETTER_COMMISSION_SHEET_ID`) | rows whose **Date Booked** is in the month — the ranking number |
| Confirmed / Show-up | Sheet A | Show, and `Show ÷ (Show + No-Show)`, for rows whose **Appointment Date** is in the month — the same basis as the sheet's own Monthly Summary |
| Earned | Sheet A `Commission` column + pay rule | pay for appointments that **happen** in the month. From `SETTER_FLAT_RATE_FROM` (2026-10-01) every Show pays `SETTER_FLAT_RATE` ($3) regardless of lead source; earlier appointments use the sheet's own Commission column (rate card with the $1 Angi split) |
| Booking ratio | Tracking sheet (Sheet B, `SETTER_TRACKING_SHEET_ID`) per-setter daily logs | `Σ Appts Set ÷ Σ New Leads` over daily rows dated in the month. Weekend rows count; the sheet's Team Tracking blocks are Mon–Fri only, so they can read lower |
| Zeal revenue | Sheet A × `clients.setter_fee_per_appt` | booked, non-cancelled appointments × what Zeal earns per appointment for that client (Settings → client → "Zeal revenue per setter-booked appt"); `SETTER_DEFAULT_ZEAL_FEE` when unset (0 = flagged on the page, not invented). The team goal is `SETTER_TEAM_GOAL` |

Roster: `SETTER_NAMES` (active — always shown for the current month) and
`SETTER_FORMER_NAMES` (still synced; shown only in months where they have data).
Adding a setter: create their tabs in both sheets (copy an existing tab), add the name
to `SETTER_NAMES`, redeploy. Removing one: move the name to `SETTER_FORMER_NAMES`.
Goal and default fee can also be overridden without a deploy via `app_settings`
keys `setter_team_goal` / `setter_default_zeal_fee`.

Sync: Celery task `sync_setters` every `SETTER_SYNC_INTERVAL_SECONDS` (60) rewrites
`setter_appointments` / `setter_daily_activity` in one transaction each and logs to
`sync_runs` as `setters` (`partial` = one sheet failed, its previous snapshot kept).
The page polls every 30 s. Nothing ever writes to either Google Sheet. Sheet A must be
a native Google Sheet (converted from .xlsx on 2026-09-11; an openpyxl fallback remains
for the Drive-file case). Parser quirks handled: header spelling drift between tabs
("Appt Set" vs "Appts Set"), preamble rows above the header, the template's
"EXAMPLE" row, blank pre-filled rows.

Code: `backend/app/services/setters.py` (sync + parsers), `backend/app/routers/setters.py`
(`GET /api/setters/leaderboard?month=YYYY-MM`, no auth), `frontend/src/app/leaderboard/`.
Tests: `backend/tests/test_setters.py`.

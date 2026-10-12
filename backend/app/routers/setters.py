"""Appointment-setter leaderboard — public, read-only, aggregates only.

No auth: the page is a shared link for the setters and shows nothing that isn't
already visible to every one of them in the source sheets. Customer names never
leave the mirror tables.

Month semantics (calendar months, agency timezone America/Los_Angeles):
- Appointments Booked  = rows whose Date Booked falls in the month
- Confirmed            = rows with Status = Show whose Appointment Date falls in
                         the month (outcomes and pay land when the appointment
                         happens — same basis as the sheet's Monthly Summary)
- Show-Up Rate         = Show ÷ (Show + No-Show) on that basis; Scheduled, blank,
                         Cancelled and Not Interested are excluded from both sides
- Booking Ratio        = Σ Appts Set ÷ Σ New Leads over the daily-log rows dated
                         in the month (raw counts summed first)
- Earned               = pay for appointments that happen in the month: from
                         SETTER_FLAT_RATE_FROM (2026-10-01) every Show pays
                         SETTER_FLAT_RATE ($3); before that, the sheet's own
                         Commission column (rate card with the old $1 Angi split)
- Zeal revenue         = money made for Zeal Media Solutions: Σ over booked, not
                         cancelled appointments of the client's setter_fee_per_appt
                         (Settings → client, matched by client name) or
                         SETTER_DEFAULT_ZEAL_FEE when unset. The team goal
                         (SETTER_TEAM_GOAL) is measured against it.
Ranking is by Appointments Booked, then Appts Set, then name (ties share a rank).
Roster: the active setters always appear for the current month; former setters
appear only in months where they have data.
"""
import calendar
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query

from app.core.config import get_settings
from app.core.db import fetch, fetchrow

router = APIRouter(tags=["setters"])

AGENCY_TZ = ZoneInfo("America/Los_Angeles")

# Rows booked in the month (booked / pending / pipeline) OR scheduled to happen in
# the month (show / no-show / cancelled / earned) — the sheet's own Monthly Summary
# counts outcomes by Appointment Date, and commission is paid on that basis.
ROWS_SQL = """
select setter, client, status, commission, appointment_date,
       (date_booked >= $1 and date_booked < $2)                 as booked_in_month,
       (appointment_date >= $1 and appointment_date < $2)       as happens_in_month
from setter_appointments
where (date_booked >= $1 and date_booked < $2)
   or (appointment_date >= $1 and appointment_date < $2)
"""

DAILY_SQL = """
select setter, sum(new_leads) as new_leads, sum(appts_set) as appts_set, sum(contacted) as contacted
from setter_daily_activity
where date >= $1 and date < $2
group by setter
"""

# Months that have any real activity, newest first, never beyond the current month
# (the daily-log tabs are pre-filled with dated template rows through next year)
# and no older than the floor (a mistyped "08/2016" row exists in one tab).
MONTHS_SQL = """
select distinct to_char(d, 'YYYY-MM') as month
from (
    select date_booked as d from setter_appointments
    union all
    select date from setter_daily_activity where new_leads > 0 or appts_set > 0
) x
where d < $1 and d >= $2
order by 1 desc
"""
MONTH_HISTORY_LIMIT = 18  # months of history offered in the Prior Months selector

LAST_RUN_SQL = """
select status, finished_at, error
from sync_runs
where source = 'setters' and finished_at is not null
order by finished_at desc
limit 1
"""

LAST_OK_SQL = """
select max(finished_at) as at
from sync_runs
where source = 'setters' and status in ('success', 'partial')
"""

CLIENTS_SQL = "select name, setter_fee_per_appt from clients where is_active"
SETTINGS_SQL = "select key, value from app_settings where key in ('setter_team_goal', 'setter_default_zeal_fee')"

# Sheet client names that can't be prefix-matched to the dashboard's client names.
CLIENT_ALIASES = {
    "crba": "constructionremodelinginbayarea",
    "sna": "snahomeimprovement",
    "integratedhome": "integratehomedesigns",
    "dawnsky": "dawnskypressurewashing",
}

CANCELLED = ("Cancelled", "Not Interested")


def _norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def fee_lookup(clients: list[dict], default: float):
    """Return f(sheet_client_name) -> (zeal_fee_per_appt, 'client' | 'default').

    Matches the sheet's short names ("US Pro Paint", "Teppco") to the dashboard's
    client names by normalised exact / prefix match, with a few explicit aliases.
    """
    known = {_norm(c["name"]): c["setter_fee_per_appt"] for c in clients}

    def lookup(name: str | None) -> tuple[float, str]:
        n = _norm(name)
        n = CLIENT_ALIASES.get(n, n)
        value = known.get(n)
        if value is None and len(n) >= 4:
            hits = [k for k in known if k.startswith(n) or n.startswith(k)]
            if len(hits) == 1:
                value = known[hits[0]]
        if value:
            return float(value), "client"
        return default, "default"

    return lookup


def commission_for(status: str, sheet_commission: float | None, appointment_date: date | None,
                   flat_from: date, flat_rate: float) -> float:
    """What a row pays. Appointments on/after `flat_from` pay `flat_rate` per Show
    (the Oct 2026 rule); earlier ones pay whatever the sheet's Commission column says."""
    if appointment_date is not None and appointment_date >= flat_from:
        return flat_rate if status == "Show" else 0.0
    return float(sheet_commission or 0)


def _month_bounds(month: str) -> tuple[date, date]:
    try:
        start = datetime.strptime(month, "%Y-%m").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="month must be YYYY-MM") from None
    nxt = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    return start, nxt


def _ratio(n: float, d: float) -> float | None:
    return round(n / d, 4) if d else None


def _blank(name: str, active: bool) -> dict:
    return {
        "name": name, "active": active,
        "booked": 0, "shows": 0, "no_shows": 0, "pending": 0, "cancelled": 0,
        "earned": 0.0, "revenue": 0.0, "revenue_confirmed": 0.0, "rows_using_default": 0,
        "new_leads": 0, "appts_set": 0,
    }


@router.get("/setters/leaderboard")
async def leaderboard(month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$")) -> dict:
    settings = get_settings()
    today = datetime.now(AGENCY_TZ).date()
    current = today.strftime("%Y-%m")
    month = month or current
    start, nxt = _month_bounds(month)
    _, next_of_current = _month_bounds(current)

    overrides = {r["key"]: r["value"] for r in await fetch(SETTINGS_SQL)}
    goal = float(overrides.get("setter_team_goal") or settings.setter_team_goal)
    default_fee = float(overrides.get("setter_default_zeal_fee") or settings.setter_default_zeal_fee)
    lookup = fee_lookup([dict(c) for c in await fetch(CLIENTS_SQL)], default_fee)

    appt_rows = await fetch(ROWS_SQL, start, nxt)
    daily = {r["setter"]: r for r in await fetch(DAILY_SQL, start, nxt)}
    floor_y, floor_m = divmod(today.year * 12 + today.month - 1 - MONTH_HISTORY_LIMIT, 12)
    months = [r["month"] for r in await fetch(MONTHS_SQL, next_of_current, date(floor_y, floor_m + 1, 1))]
    last_run = await fetchrow(LAST_RUN_SQL)
    last_ok = await fetchrow(LAST_OK_SQL)

    active = list(settings.setter_names)
    by_name: dict[str, dict] = {n: _blank(n, True) for n in active}

    def row_for(name: str) -> dict:
        if name not in by_name:
            by_name[name] = _blank(name, False)  # former setter with data this month
        return by_name[name]

    for r in appt_rows:
        s = row_for(r["setter"])
        status = r["status"]
        value, source = lookup(r["client"])
        if r["booked_in_month"]:
            s["booked"] += 1
            if status in ("Scheduled", ""):
                s["pending"] += 1
            if status in CANCELLED:
                s["cancelled"] += 1
            else:
                s["revenue"] += value
                if source == "default":
                    s["rows_using_default"] += 1
        if r["happens_in_month"]:
            # Outcomes and pay land in the month the appointment happens
            s["earned"] += commission_for(status, r["commission"], r["appointment_date"],
                                          settings.setter_flat_rate_from, settings.setter_flat_rate)
            if status == "Show":
                s["shows"] += 1
                s["revenue_confirmed"] += value
            elif status == "No-Show":
                s["no_shows"] += 1

    for name, d in daily.items():
        if name in active or int(d["new_leads"]) > 0 or int(d["appts_set"]) > 0:
            s = row_for(name)
            s["new_leads"] = int(d["new_leads"])
            s["appts_set"] = int(d["appts_set"])

    rows = []
    for s in by_name.values():
        if not s["active"] and s["booked"] == 0 and s["appts_set"] == 0:
            continue
        s["show_up_rate"] = _ratio(s["shows"], s["shows"] + s["no_shows"])
        s["booking_ratio"] = _ratio(s["appts_set"], s["new_leads"])
        for k in ("earned", "revenue", "revenue_confirmed"):
            s[k] = round(s[k], 2)
        rows.append(s)

    rows.sort(key=lambda r: (-r["booked"], -r["appts_set"], r["name"]))
    rank, prev = 0, None
    for i, r in enumerate(rows, start=1):
        key = (r["booked"], r["appts_set"])
        if key != prev:
            rank, prev = i, key
        r["rank"] = rank

    def total(k: str) -> float:
        return sum(r[k] for r in rows)

    team = {
        "booked": int(total("booked")),
        "shows": int(total("shows")),
        "no_shows": int(total("no_shows")),
        "pending": int(total("pending")),
        "cancelled": int(total("cancelled")),
        "earned": round(total("earned"), 2),
        "revenue": round(total("revenue"), 2),
        "revenue_confirmed": round(total("revenue_confirmed"), 2),
        "new_leads": int(total("new_leads")),
        "appts_set": int(total("appts_set")),
    }
    team["show_up_rate"] = _ratio(team["shows"], team["shows"] + team["no_shows"])
    team["booking_ratio"] = _ratio(team["appts_set"], team["new_leads"])
    team["goal"] = goal
    team["goal_progress"] = _ratio(team["revenue"], goal) if goal > 0 else None
    days_in_month = calendar.monthrange(start.year, start.month)[1]
    team["month_elapsed"] = round(today.day / days_in_month, 4) if month == current else 1.0

    return {
        "month": month,
        "is_current": month == current,
        "months": months if current in months else [current, *months],
        # Sheet A only started in Sept 2026 — earlier months have booking ratio only.
        "booked_available": any(r["booked_in_month"] for r in appt_rows),
        "last_updated": (last_ok["at"].isoformat() if last_ok and last_ok["at"] else None),
        "sync_status": last_run["status"] if last_run else None,
        # How many booked appointments have no Zeal fee behind them (client fee unset and
        # no default) — the page tells Carl to fill Settings instead of inventing a number.
        "fee": {
            "default": default_fee,
            "rows_using_default": int(total("rows_using_default")),
            "rows_total": int(team["booked"] - team["cancelled"]),
        },
        "team": team,
        "setters": rows,
    }

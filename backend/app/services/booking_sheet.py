"""Booked appointments from a client's tracking Google Sheet.

Layout (Paradise Decks' sheet, which is the template): one row per lead —
col A ad set name (optional), col B lead date, C name, D phone, E email,
F Status ("Booked" / "Follow Up" / "Not Interested"), G "Lead MM/DD" = the
appointment date for booked rows, and a "$x,xxx" total somewhere in I/J when
the job closed. The sheet must be shared "anyone with the link can view".

Writes appointments_booked / jobs_won / revenue_won into ghl_metrics_daily for
every day from the first booking to today (zero for days without one, so a row
deleted from the sheet disappears here too) and appointments per ad set into
ghl_adset_daily. Contacts/calls columns are left to the GHL sync.
"""
import csv
import io
import json
import re
from datetime import date, timedelta

import httpx

from app.services import pg

EXPORT_URL = "https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"

_ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_US = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")
_APPT = re.compile(r"Lead\s+(\d{1,2})/(\d{1,2})", re.IGNORECASE)
_MONEY = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")


def _lead_date(s: str) -> date | None:
    s = (s or "").strip()
    if m := _ISO.match(s):
        return date(int(m[1]), int(m[2]), int(m[3]))
    if m := _US.match(s):
        return date(int(m[3]), int(m[1]), int(m[2]))
    return None


def _money(*cells: str) -> float | None:
    for c in cells:
        if m := _MONEY.search(c or ""):
            return float(m[1].replace(",", ""))
    return None


def parse_rows(rows: list[list[str]]) -> tuple[dict[date, list], dict[tuple[date, str], int]]:
    """→ ({appt_day: [(revenue|None), ...]}, {(appt_day, adset): n}).
    The 'Lead MM/DD' cell has no year: take it from the row's lead date (or the
    last parseable one above it) and roll to next year if it lands >30 days before."""
    booked: dict[date, list] = {}
    by_adset: dict[tuple[date, str], int] = {}
    last_lead: date | None = None
    for r in rows[1:]:
        r = list(r) + [""] * (10 - len(r))
        if lead := _lead_date(r[1]):
            last_lead = lead
        if r[5].strip().lower() != "booked":
            continue
        m = _APPT.search(r[6])
        base = lead or last_lead
        if not m or base is None:
            continue
        day = date(base.year, int(m[1]), int(m[2]))
        if day < base - timedelta(days=30):
            day = date(base.year + 1, int(m[1]), int(m[2]))
        booked.setdefault(day, []).append(_money(r[8], r[9]))
        if adset := r[0].strip():
            by_adset[(day, adset)] = by_adset.get((day, adset), 0) + 1
    return booked, by_adset


def sync_booking_sheet(client_id: str, sheet_id: str, gid: int = 0) -> dict:
    resp = httpx.get(EXPORT_URL.format(sheet_id=sheet_id, gid=gid), follow_redirects=True, timeout=60)
    resp.raise_for_status()
    if "text/csv" not in resp.headers.get("content-type", ""):
        raise RuntimeError("sheet export did not return CSV — is it shared 'anyone with the link'?")
    rows = list(csv.reader(io.StringIO(resp.text)))
    booked, by_adset = parse_rows(rows)
    if not booked:
        return {"rows": len(rows) - 1, "booked": 0}

    first, today = min(booked), date.today()
    day = first
    while day <= today:
        entries = booked.get(day, [])
        won = [v for v in entries if v]
        pg.execute(
            """
            insert into ghl_metrics_daily (client_id, date, appointments_booked, jobs_won, revenue_won, raw, synced_at)
            values (%s, %s, %s, %s, %s, %s, now())
            on conflict (client_id, date) do update set
                appointments_booked = excluded.appointments_booked,
                jobs_won = excluded.jobs_won,
                revenue_won = excluded.revenue_won,
                synced_at = now()
            """,
            (client_id, day, len(entries), len(won), sum(won), json.dumps({"source": "sheet", "sheet_id": sheet_id})),
        )
        day += timedelta(days=1)
    pg.execute("update ghl_adset_daily set appointments = 0 where client_id = %s and date >= %s", (client_id, first))
    for (day, adset), n in by_adset.items():
        pg.execute(
            """
            insert into ghl_adset_daily (client_id, date, adset_name, contacts_paid, appointments, synced_at)
            values (%s, %s, %s, 0, %s, now())
            on conflict (client_id, date, adset_name) do update set appointments = excluded.appointments, synced_at = now()
            """,
            (client_id, day, adset, n),
        )
    return {
        "rows": len(rows) - 1,
        "booked": sum(len(v) for v in booked.values()),
        "won": sum(1 for v in booked.values() for x in v if x),
        "revenue": round(sum(x for v in booked.values() for x in v if x), 2),
        "adset_tagged": sum(by_adset.values()),
        "first_day": first.isoformat(),
    }


def sync_all_booking_sheets() -> dict:
    out = {}
    for c in pg.query("select id, slug, bookings_sheet_id, bookings_sheet_gid from clients where is_active and booking_system = 'sheet' and bookings_sheet_id is not null"):
        try:
            out[c["slug"]] = sync_booking_sheet(str(c["id"]), c["bookings_sheet_id"], c["bookings_sheet_gid"] or 0)
        except Exception as exc:  # one bad sheet must not stop the others
            out[c["slug"]] = {"error": str(exc)[:200]}
    return out

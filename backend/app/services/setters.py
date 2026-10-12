"""Appointment-setter leaderboard sync — read-only mirror of two Google Sheets.

Sheet A  "Appointment_Setter_Commission_Tracker_Updated"
         One tab per setter, one row per booked appointment (Date Booked, Client,
         [Lead Source — Brooklyn only], Lead / Customer Name, Appointment Date,
         Status, Commission, Key). Source of truth for appointments booked and
         show-up rate. It is currently an .xlsx stored in Drive (owner
         seo@zealmediasolutions.com) and edited in Office-compat mode, so the
         Sheets API rejects it; we download the file bytes via the Drive API and
         parse with openpyxl. If it is ever converted to a native Google Sheet the
         Sheets API path is used automatically. The Commission column is mirrored
         per row since 2026-10-05 (Carl wants earnings on the board); it is the
         sheet's own rate-card result, never recomputed here.

Sheet B  "Ads Appointment Setter Tracking - Current"
         Per-setter daily log tabs (Date, Account / Client, New Leads, Contacted,
         …, Appts Set, Rescheduled, DQ'd). The Team Tracking weekly blocks and the
         Dashboard tab are derived from these daily rows, so we aggregate the daily
         rows by calendar month directly: booking ratio = Σ Appts Set ÷ Σ New Leads.
         That is the same formula as the sheet's weekly "Set Rate %", summed on raw
         counts, and it sidesteps the week-straddles-a-month problem entirely.
         (The sheet's own Dashboard monthly section is stale — it still lists
         "Setter 3/4" and shows zero for Brooklyn — so it is not used.)

Auth: a Google service account (GOOGLE_SERVICE_ACCOUNT_JSON, read-only scopes)
when configured, otherwise the existing OAuth refresh token (Carl's account —
spreadsheets + drive.file scopes, which can read Sheet B but cannot download the
.xlsx). Nothing here ever writes to Google.

All parsing functions are pure (rows in → dicts out) so they can be unit-tested
without network or database access.
"""
from __future__ import annotations

import io
import json
import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Iterable

import httpx
import jwt
import psycopg2.extras

from app.core.config import get_settings
from app.services import pg

logger = logging.getLogger(__name__)

SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
DRIVE_API = "https://www.googleapis.com/drive/v3/files"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 — URL, not a secret
READ_ONLY_SCOPES = (
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
)

# Excel/Sheets serial day 0 (the 1900 leap-year bug is baked into this epoch).
EXCEL_EPOCH = date(1899, 12, 30)

STATUS_CANON = {
    "scheduled": "Scheduled",
    "show": "Show",
    "showed": "Show",
    "no-show": "No-Show",
    "no show": "No-Show",
    "noshow": "No-Show",
    "cancelled": "Cancelled",
    "canceled": "Cancelled",
    "not interested": "Not Interested",
}

# Column headers as they appear in the sheets (matched case-insensitively).
APPT_HEADER_CELL = "date booked"
DAILY_HEADER_CELL = "date"


class OfficeFileError(Exception):
    """The Sheets API refused the document because it is an Office (.xlsx) file."""


# ------------------------------------------------------------------ coercion

def coerce_date(value: Any) -> date | None:
    """Sheet cell → date. Accepts serial numbers (UNFORMATTED_VALUE / xlsx), real
    date(time)s (openpyxl), and the string formats the setters type by hand."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)):
        # 2000-01-01 = 36526, 2100-01-01 = 73051; anything else isn't a date cell
        if 36526 <= value < 73051:
            return EXCEL_EPOCH + timedelta(days=int(value))
        return None
    text = str(value).strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y", "%m-%d-%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def coerce_int(value: Any) -> int:
    if value is None or value == "" or isinstance(value, bool):
        return 0
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return 0


def coerce_money(value: Any) -> float:
    """Commission cell → dollars. Sheets gives a number; the xlsx path or a typed
    cell may give "$3.00"."""
    if value is None or value == "" or isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("$", "").replace(",", "")
    try:
        return float(text)
    except ValueError:
        return 0.0


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def _norm(value: Any) -> str:
    return _text(value).lower()


def _cell(row: list, idx: int | None) -> Any:
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def _find_header(rows: list[list], first_cell: str) -> tuple[int, dict[str, int]]:
    """Locate the header row (first row whose column A equals `first_cell`) and map
    normalised header text → column index. Some tabs carry a title/KPI preamble
    above the header (Dylan's daily log), so this is never a fixed row number."""
    for i, row in enumerate(rows):
        if row and _norm(row[0]) == first_cell:
            return i, {_norm(c): j for j, c in enumerate(row) if _text(c)}
    raise ValueError(f"header row starting with {first_cell!r} not found")


# ------------------------------------------------------------------ Sheet A parsing

def parse_appointment_rows(setter: str, rows: list[list]) -> list[dict]:
    """Setter tab of the commission tracker → appointment dicts.

    Rows without a Date Booked are skipped (the tabs are pre-filled with hundreds
    of empty template rows whose Key formula still evaluates), as is the template's
    EXAMPLE row.
    """
    hdr, cols = _find_header(rows, APPT_HEADER_CELL)
    c_booked = cols.get("date booked")
    c_client = cols.get("client")
    c_source = cols.get("lead source")  # Brooklyn only
    c_name = cols.get("lead / customer name") or cols.get("lead/customer name") or cols.get("customer name")
    c_appt = cols.get("appointment date")
    c_status = cols.get("status")
    c_commission = cols.get("commission")
    if c_status is None or c_appt is None:
        raise ValueError(f"{setter}: unexpected header {sorted(cols)}")

    out: list[dict] = []
    for n, row in enumerate(rows[hdr + 1:], start=hdr + 2):
        booked = coerce_date(_cell(row, c_booked))
        if booked is None:
            continue
        name = _text(_cell(row, c_name))
        if "example" in name.lower():
            continue  # the template ships a "Jane Doe (EXAMPLE - overwrite me)" row
        raw_status = _text(_cell(row, c_status))
        status = STATUS_CANON.get(raw_status.lower(), raw_status.title()) if raw_status else ""
        out.append({
            "setter": setter,
            "date_booked": booked,
            "client": _text(_cell(row, c_client)) or None,
            "lead_source": _text(_cell(row, c_source)) or None,
            "customer_name": name or None,
            "appointment_date": coerce_date(_cell(row, c_appt)),
            "status": status,
            # Rate-card commission as the sheet computes it (only Show rows pay).
            "commission": coerce_money(_cell(row, c_commission)),
            "source_row": n,
        })
    return out


def workbook_rows(xlsx_bytes: bytes, tabs: Iterable[str]) -> dict[str, list[list]]:
    """Read the requested tabs (case-insensitive title match) of an .xlsx into
    plain row lists, using cached formula values."""
    import openpyxl  # imported lazily: only the xlsx path needs it

    wanted = {t.lower(): t for t in tabs}
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    out: dict[str, list[list]] = {}
    try:
        for ws in wb.worksheets:
            key = ws.title.strip().lower()
            if key in wanted:
                out[wanted[key]] = [list(r) for r in ws.iter_rows(values_only=True)]
    finally:
        wb.close()
    return out


# ------------------------------------------------------------------ Sheet B parsing

def parse_daily_rows(setter: str, rows: list[list]) -> list[dict]:
    """Setter daily-log tab of the tracking sheet → per-day-per-client dicts.

    Rows with a date but no metric values at all are the pre-filled future
    template rows and are skipped; an explicit 0 is kept.
    """
    hdr, cols = _find_header(rows, DAILY_HEADER_CELL)
    c_date = cols.get("date")
    c_client = cols.get("account / client") or cols.get("account/client") or cols.get("client")
    def first(*names: str) -> int | None:
        return next((cols[n] for n in names if n in cols), None)

    # Header spellings drift between setter tabs (Morgan's says "Appt Set").
    metric_cols = {
        "new_leads": first("new leads", "new lead", "leads"),
        "contacted": first("contacted"),
        "appts_set": first("appts set", "appt set", "appointments set", "appts. set"),
        "rescheduled": first("rescheduled"),
        "dq": first("dq'd", "dq’d", "dqd", "dq"),
    }
    if metric_cols["new_leads"] is None or metric_cols["appts_set"] is None:
        raise ValueError(f"{setter}: unexpected header {sorted(cols)}")

    out: list[dict] = []
    for n, row in enumerate(rows[hdr + 1:], start=hdr + 2):
        day = coerce_date(_cell(row, c_date))
        if day is None:
            continue
        raw = {k: _cell(row, idx) for k, idx in metric_cols.items()}
        if all(v is None or v == "" for v in raw.values()):
            continue
        rec = {"setter": setter, "date": day, "client": _text(_cell(row, c_client)) or None, "source_row": n}
        rec.update({k: coerce_int(v) for k, v in raw.items()})
        out.append(rec)
    return out


# ------------------------------------------------------------------ Google access

def _service_account_token(info: dict) -> str:
    now = int(time.time())
    assertion = jwt.encode(
        {
            "iss": info["client_email"],
            "scope": " ".join(READ_ONLY_SCOPES),
            "aud": TOKEN_URL,
            "iat": now,
            "exp": now + 3600,
        },
        info["private_key"],
        algorithm="RS256",
    )
    resp = httpx.post(
        TOKEN_URL,
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def access_token() -> str:
    """Service account when configured, else the existing OAuth refresh token."""
    raw = get_settings().google_service_account_json.strip()
    if raw:
        info = json.loads(raw) if raw.startswith("{") else json.load(open(raw))
        return _service_account_token(info)
    from app.services.sheets_export import _access_token

    return _access_token()


def _raise_for_office_file(resp: httpx.Response) -> None:
    if resp.status_code == 400 and "Office file" in resp.text:
        raise OfficeFileError(resp.text[:300])


def fetch_tab_titles(client: httpx.Client, sheet_id: str) -> list[str]:
    resp = client.get(f"{SHEETS_API}/{sheet_id}", params={"fields": "sheets.properties.title"})
    _raise_for_office_file(resp)
    resp.raise_for_status()
    return [s["properties"]["title"] for s in resp.json().get("sheets", [])]


def fetch_tabs(client: httpx.Client, sheet_id: str, tabs: list[str], last_col: str = "K") -> dict[str, list[list]]:
    """batchGet the given tabs as raw (unformatted) row lists."""
    if not tabs:
        return {}
    params = [("ranges", f"'{t}'!A1:{last_col}5000") for t in tabs]
    params += [("valueRenderOption", "UNFORMATTED_VALUE"), ("majorDimension", "ROWS")]
    resp = client.get(f"{SHEETS_API}/{sheet_id}/values:batchGet", params=params)
    _raise_for_office_file(resp)
    resp.raise_for_status()
    return {tab: vr.get("values", []) for tab, vr in zip(tabs, resp.json()["valueRanges"], strict=False)}


def download_drive_file(client: httpx.Client, file_id: str) -> bytes:
    resp = client.get(f"{DRIVE_API}/{file_id}", params={"alt": "media", "supportsAllDrives": "true"})
    resp.raise_for_status()
    return resp.content


def _match_tabs(titles: list[str], setters: list[str]) -> list[str]:
    by_norm = {t.strip().lower(): t for t in titles}
    return [by_norm[s.lower()] for s in setters if s.lower() in by_norm]


def load_appointment_rows(client: httpx.Client, sheet_id: str, setters: list[str]) -> dict[str, list[list]]:
    """Sheet A tabs → {setter: rows}. Native Sheet via the Sheets API; .xlsx via Drive."""
    try:
        titles = fetch_tab_titles(client, sheet_id)
        tabs = _match_tabs(titles, setters)
        fetched = fetch_tabs(client, sheet_id, tabs, last_col="I")
    except OfficeFileError:
        logger.info("Commission tracker is an Office file — downloading via Drive")
        fetched = workbook_rows(download_drive_file(client, sheet_id), setters)
    # key by the canonical setter name regardless of tab-title casing
    canon = {s.lower(): s for s in setters}
    return {canon[k.strip().lower()]: v for k, v in fetched.items() if k.strip().lower() in canon}


def load_daily_rows(client: httpx.Client, sheet_id: str, setters: list[str]) -> dict[str, list[list]]:
    titles = fetch_tab_titles(client, sheet_id)
    tabs = _match_tabs(titles, setters)
    fetched = fetch_tabs(client, sheet_id, tabs, last_col="K")
    canon = {s.lower(): s for s in setters}
    return {canon[k.strip().lower()]: v for k, v in fetched.items()}


# ------------------------------------------------------------------ persistence

def _replace_table(table: str, columns: tuple[str, ...], records: list[dict]) -> None:
    """Swap the whole mirror table in one transaction so readers never see a
    half-written snapshot."""
    with pg.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"delete from {table}")
            if records:
                psycopg2.extras.execute_values(
                    cur,
                    f"insert into {table} ({', '.join(columns)}) values %s",
                    [tuple(r.get(c) for c in columns) for r in records],
                    page_size=500,
                )


APPT_COLUMNS = ("setter", "date_booked", "client", "lead_source", "customer_name", "appointment_date", "status", "commission", "source_row")
DAILY_COLUMNS = ("setter", "date", "client", "new_leads", "contacted", "appts_set", "rescheduled", "dq", "source_row")


def run_sync() -> dict:
    """Poll both sheets and replace the mirror tables. Each source is independent:
    a failure in one leaves that table's previous snapshot untouched and is
    reported in `errors` so the Celery task can log a partial run."""
    settings = get_settings()
    # Former setters keep syncing so prior months still show them; the API decides
    # who is displayed for a given month.
    setters = list(dict.fromkeys([*settings.setter_names, *settings.setter_former_names]))
    result: dict[str, Any] = {"appointments": 0, "daily_rows": 0, "setters_a": [], "setters_b": [], "errors": []}

    token = access_token()
    with httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=120) as client:
        try:
            by_setter = load_daily_rows(client, settings.setter_tracking_sheet_id, setters)
            daily = [rec for s, rows in by_setter.items() for rec in parse_daily_rows(s, rows)]
            _replace_table("setter_daily_activity", DAILY_COLUMNS, daily)
            result["daily_rows"] = len(daily)
            result["setters_b"] = sorted(by_setter)
        except Exception as exc:  # noqa: BLE001 — isolate the two sources
            logger.exception("Setter tracking sheet sync failed")
            result["errors"].append(f"tracking sheet: {exc}")

        try:
            by_setter = load_appointment_rows(client, settings.setter_commission_sheet_id, setters)
            appts = [rec for s, rows in by_setter.items() for rec in parse_appointment_rows(s, rows)]
            _replace_table("setter_appointments", APPT_COLUMNS, appts)
            result["appointments"] = len(appts)
            result["setters_a"] = sorted(by_setter)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Commission tracker sync failed")
            result["errors"].append(f"commission tracker: {exc}")

    return result

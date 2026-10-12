"""Unit tests for the setter leaderboard parsers (pure functions, no network/DB).

Fixtures mirror the real layouts observed on 2026-09-11:
- commission tracker: title row, instructions row, header row; Brooklyn has a
  Lead Source column, the others don't; hundreds of blank template rows whose
  Key formula still evaluates.
- tracking sheet daily logs: header on row 1 for Brooklyn/Jonathan/Matthew, but
  Dylan's tab has a 6-row preamble (title, assigned accounts, KPI targets).
"""
import io
from datetime import date

import openpyxl
import pytest

from app.services.setters import (
    coerce_date,
    coerce_int,
    parse_appointment_rows,
    parse_daily_rows,
    workbook_rows,
)


def test_coerce_date_formats():
    assert coerce_date(46125) == date(2026, 4, 13)        # Sheets serial (UNFORMATTED_VALUE)
    assert coerce_date(46125.0) == date(2026, 4, 13)
    assert coerce_date("09/01/2026") == date(2026, 9, 1)
    assert coerce_date("2026-10-24") == date(2026, 10, 24)
    assert coerce_date("July 6, 2026") == date(2026, 7, 6)
    assert coerce_date(date(2026, 1, 2)) == date(2026, 1, 2)
    assert coerce_date("") is None
    assert coerce_date(None) is None
    assert coerce_date("Scheduled") is None
    assert coerce_date(3) is None                          # a count, not a date serial


def test_coerce_int():
    assert coerce_int("") == 0
    assert coerce_int(None) == 0
    assert coerce_int(7) == 7
    assert coerce_int(7.0) == 7
    assert coerce_int("12") == 12
    assert coerce_int("n/a") == 0


BROOKLYN_TAB = [
    ["Brooklyn — Appointment Log", None, None, None, None, None, None, None],
    ["Add one row per appointment booked. Update Status …", None, None, None, None, None, None, None],
    ["Date Booked", "Client", "Lead Source", "Lead / Customer Name", "Appointment Date", "Status", "Commission", "Key"],
    ["09/01/2026", "US Pro Paint", "Other", "Valerie Tosti Guerra", "09/09/2026", "Scheduled", 0, "Brooklyn|US Pro Paint|Other"],
    ["09/01/2026", "US Pro Paint", "Angi", "Lloyd Maclean", "09/02/2026", "Show", 1, "Brooklyn|US Pro Paint|Angi"],
    ["09/03/2026", "US Pro Paint", "Angi", "Paul Michael Perry", "09/08/2026", "Cancelled", 0, "Brooklyn|US Pro Paint|Angi"],
    ["09/04/2026", "US Pro Paint", "Other", "Janiffer Fontes", "09/07/2026", "", 0, "Brooklyn|US Pro Paint|Other"],
    [None, None, None, None, None, None, 0, "Brooklyn||"],          # blank template row
    ["09/08/2026", "US Pro Paint", "Angi", "Sharif Uddin", "09/09/2026", "no show", 0, "Brooklyn|US Pro Paint|Angi"],
    ["08/29/2026", "Hurley Construction", "N/A", "Someone", "09/01/2026", "Show", 3, "Brooklyn|Hurley Construction|N/A"],
    [None, None, None, None, None, None, 0, "Brooklyn||"],
]

JONATHAN_TAB = [
    ["Jonathan — Appointment Log", None, None, None, None, None, None],
    ["Add one row per appointment booked.", None, None, None, None, None, None],
    ["Date Booked", "Client", "Lead / Customer Name", "Appointment Date", "Status", "Commission", "Key"],
    [date(2026, 9, 1), "Dawnsky", "Obryan Kaneohe", date(2026, 9, 3), "Not Interested", 0, "Jonathan|Dawnsky|N/A"],
    [date(2026, 9, 2), "CRBA", "Alex Chaplyn", date(2026, 9, 3), "Show", 3, "Jonathan|CRBA|N/A"],
    [date(2026, 9, 7), "CRBA", "Mihir Mehta", date(2026, 9, 10), "Scheduled", 0, None],
    [None, None, None, None, None, 0, "Jonathan||N/A"],
]


def test_parse_appointment_rows_brooklyn_with_lead_source():
    rows = parse_appointment_rows("Brooklyn", BROOKLYN_TAB)
    assert len(rows) == 6  # blank template rows skipped
    first = rows[0]
    assert first["setter"] == "Brooklyn"
    assert first["date_booked"] == date(2026, 9, 1)
    assert first["appointment_date"] == date(2026, 9, 9)
    assert first["lead_source"] == "Other"
    assert first["customer_name"] == "Valerie Tosti Guerra"
    assert first["status"] == "Scheduled"
    assert first["source_row"] == 4  # 1-based row in the tab
    statuses = [r["status"] for r in rows]
    assert statuses == ["Scheduled", "Show", "Cancelled", "", "No-Show", "Show"]
    assert [r["commission"] for r in rows] == [0.0, 1.0, 0.0, 0.0, 0.0, 3.0]  # the sheet's own rate-card result


def test_parse_appointment_rows_without_lead_source_column():
    rows = parse_appointment_rows("Jonathan", JONATHAN_TAB)
    assert len(rows) == 3
    assert rows[0]["lead_source"] is None
    assert rows[0]["status"] == "Not Interested"
    assert rows[1]["client"] == "CRBA"
    assert rows[2]["appointment_date"] == date(2026, 9, 10)


def test_parse_appointment_rows_missing_header():
    with pytest.raises(ValueError):
        parse_appointment_rows("X", [["Nothing", "here"], ["", ""]])


def test_workbook_rows_reads_only_requested_tabs_case_insensitively():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "brooklyn"
    for r in BROOKLYN_TAB:
        ws.append(r)
    other = wb.create_sheet("Rate Card")
    other.append(["Key", "Setter", "Client", "Lead Source", "Rate"])
    buf = io.BytesIO()
    wb.save(buf)

    tabs = workbook_rows(buf.getvalue(), ["Brooklyn", "Dylan"])
    assert list(tabs) == ["Brooklyn"]
    parsed = parse_appointment_rows("Brooklyn", tabs["Brooklyn"])
    assert len(parsed) == 6
    assert parsed[1]["status"] == "Show"


DAILY_HEADER = ["Date", "Account / Client", "Lead Source", "New Leads", "Contacted", "F/U Attempted",
                "F/U Connected", "Appts Set", "Rescheduled", "DQ'd", "Notes"]

BROOKLYN_DAILY = [
    DAILY_HEADER,
    [46125, "US Pro Paint", "", 20, 127, "", "", 7, 1],                     # 2026-04-13
    [46126, "US Pro Paint", "", 6, 140, "", "", 4, 0],                      # 2026-04-14
    [46132, "US Pro Paint", "", 12, 206, "", "", 5, 0, 1, "Out of range"],  # 2026-04-20
    [46387, "MJ Project Solutions "],                                       # 2026-12-31 template row
    ["", "", "", "", "", "", "", "", ""],
]

DYLAN_DAILY = [
    ["DYLAN — DAILY LOG"],
    ["Assigned Accounts: US Pro Paint, Castles Flooring", "", "", "", "", "", "", "", "", "Date Started:"],
    ["Daily Targets (KPI's)  Appointments Set: 2+  |  Contact All New Leads Same Day"],
    [],
    [],
    [],
    DAILY_HEADER,
    [46232, "US Pro Paint", "", 3, 40, "", "", 0, 0, 0],                    # 2026-07-29 explicit zeros kept
    [46233, "Castles Flooring", "", 5, 12, "", "", 2, 0],
    [46752, "US Pro Paint"],                                                # 2027-01-01 template row
]


def test_parse_daily_rows_basic():
    rows = parse_daily_rows("Brooklyn", BROOKLYN_DAILY)
    assert len(rows) == 3
    assert rows[0] == {
        "setter": "Brooklyn", "date": date(2026, 4, 13), "client": "US Pro Paint", "source_row": 2,
        "new_leads": 20, "contacted": 127, "appts_set": 7, "rescheduled": 1, "dq": 0,
    }
    assert rows[2]["dq"] == 1
    assert sum(r["new_leads"] for r in rows) == 38
    assert sum(r["appts_set"] for r in rows) == 16


def test_parse_daily_rows_with_preamble_and_explicit_zeros():
    rows = parse_daily_rows("Dylan", DYLAN_DAILY)
    assert [r["date"] for r in rows] == [date(2026, 7, 29), date(2026, 7, 30)]
    assert rows[0]["appts_set"] == 0 and rows[0]["new_leads"] == 3
    assert rows[0]["source_row"] == 8


def test_parse_daily_rows_missing_header():
    with pytest.raises(ValueError):
        parse_daily_rows("X", [["Nope"]])


def test_parse_daily_rows_accepts_singular_appt_set_header():
    # Morgan's tab (added 2026-09-18) says "Appt Set" where the other tabs say "Appts Set"
    header = [h.replace("Appts Set", "Appt Set") for h in DAILY_HEADER]
    rows = parse_daily_rows("Morgan", [header, [46270, "Castles Flooring", "", 4, 30, "", "", 2, 0, 0]])
    assert rows[0]["appts_set"] == 2 and rows[0]["new_leads"] == 4


def test_commission_parsed_and_example_row_skipped():
    from app.services.setters import coerce_money

    assert coerce_money(3) == 3.0
    assert coerce_money("$1.00") == 1.0
    assert coerce_money("") == 0.0
    tab = [
        ["Natashia — Appointment Log"],
        ["Add one row per appointment booked."],
        ["Date Booked", "Client", "Lead Source", "Lead / Customer Name", "Appointment Date", "Status", "Commission", "Key"],
        [46296, "US Pro Paint", "Angi", "Jane Doe (EXAMPLE - overwrite me)", 46300, "Show", 1, "Natashia|US Pro Paint|Angi"],
        [46297, "Tree Ninjas", "N/A", "Real Person", 46300, "Show", 3, "Natashia|Tree Ninjas|N/A"],
        [46297, "Tree Ninjas", "N/A", "Other Person", 46301, "Scheduled", "$0.00", "Natashia|Tree Ninjas|N/A"],
    ]
    rows = parse_appointment_rows("Natashia", tab)
    assert [r["customer_name"] for r in rows] == ["Real Person", "Other Person"]
    assert [r["commission"] for r in rows] == [3.0, 0.0]


def test_fee_lookup_matches_sheet_names_to_clients():
    from app.routers.setters import fee_lookup

    clients = [
        {"name": "US Pro Painter & Renovation", "setter_fee_per_appt": 40},
        {"name": "Teppco General Contractors", "setter_fee_per_appt": 120},
        {"name": "Construction Remodeling In Bay Area", "setter_fee_per_appt": 300},
        {"name": "SnA Home Improvement", "setter_fee_per_appt": None},
        {"name": "Tree Ninjas", "setter_fee_per_appt": None},
    ]
    look = fee_lookup(clients, 75)
    assert look("US Pro Paint") == (40.0, "client")
    assert look("Teppco") == (120.0, "client")
    assert look("CRBA") == (300.0, "client")             # explicit alias
    assert look("SNA") == (75.0, "default")              # client known but no fee set
    assert look("Tree Ninjas") == (75.0, "default")
    assert look("Artiva") == (75.0, "default")           # not a dashboard client
    assert look(None) == (75.0, "default")
    assert fee_lookup(clients, 0)("Tree Ninjas") == (0, "default")  # nothing set yet → $0, flagged


def test_commission_rule_switches_to_flat_rate_in_october():
    from datetime import date
    from app.routers.setters import commission_for

    oct1 = date(2026, 10, 1)
    # September: the sheet's rate card rules ($1 Angi show, $3 other show, $0 otherwise)
    assert commission_for("Show", 1, date(2026, 9, 20), oct1, 3.0) == 1.0
    assert commission_for("Show", 3, date(2026, 9, 20), oct1, 3.0) == 3.0
    assert commission_for("Scheduled", 0, date(2026, 9, 20), oct1, 3.0) == 0.0
    # October onward: every Show pays the flat $3, whatever the sheet says
    assert commission_for("Show", 1, date(2026, 10, 1), oct1, 3.0) == 3.0
    assert commission_for("Show", 0, date(2026, 10, 9), oct1, 3.0) == 3.0
    assert commission_for("Cancelled", 0, date(2026, 10, 9), oct1, 3.0) == 0.0
    # no appointment date yet → fall back to the sheet
    assert commission_for("Scheduled", 0, None, oct1, 3.0) == 0.0

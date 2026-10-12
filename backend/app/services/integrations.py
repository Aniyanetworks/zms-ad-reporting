"""Integration health checks — one row per client per check in `integration_health`.

Green = linked and producing what the dashboard needs; yellow = linked but thin or
stale; red = broken or misconfigured; grey = not applicable for this client.
Checks read the settled tables plus three light GHL calls per client (location,
pipelines, won opportunities). Never writes anywhere but integration_health.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from highlevel import HighLevel

from app.services import pg

CHECKS: list[tuple[str, str, str]] = [
    # key, label, group
    ("meta_sync", "Meta Ads", "ads"),
    ("google_sync", "Google Ads", "ads"),
    ("lsa_sync", "Local Services Ads", "ads"),
    ("ghl_token", "GHL connection", "ghl"),
    ("ghl_stage_scheduled", "Scheduled Appointment stage", "ghl"),
    ("ghl_stage_confirmed", "Confirmed Appointment stage", "ghl"),
    ("ghl_won", "Won opportunities", "ghl"),
    ("ghl_paid_attribution", "Paid attribution on leads", "ghl"),
    ("ghl_appointments", "Bookings from paid leads", "ghl"),
    ("utm_tags", "Ad URL tagging", "ads"),
    ("pixel_capi", "Pixel / CAPI", "ads"),
    ("landing_pages", "Landing pages", "ads"),
]
STALE_HOURS = 30


logger = logging.getLogger(__name__)


def _row(status: str, detail: str) -> dict[str, str]:
    return {"status": status, "detail": detail}


def _sync_check(client_id: str, source: str, linked: bool, platform: str) -> dict[str, str]:
    if not linked:
        return _row("grey", "Not linked")
    hung = pg.query(
        "select started_at from sync_runs where client_id = %s and source = %s and status = 'running' and started_at < now() - interval '3 hours' order by id desc limit 1",
        (client_id, source),
    )
    if hung:
        age_h = (datetime.now(UTC) - hung[0]["started_at"]).total_seconds() / 3600
        return _row("red", f"Sync started {age_h:.0f}h ago and never finished — the nightly job is hung on this client (and blocks the clients after it)")
    last = pg.query(
        "select status, finished_at, left(error, 160) error from sync_runs where client_id = %s and source = %s and finished_at is not null order by id desc limit 1",
        (client_id, source),
    )
    recent = pg.query(
        "select coalesce(sum(spend), 0) s3, (select coalesce(sum(spend), 0) from ad_metrics_daily where client_id = %s and platform = %s and date >= current_date - 30) s30 "
        "from ad_metrics_daily where client_id = %s and platform = %s and date >= current_date - 3",
        (client_id, platform, client_id, platform),
    )[0]
    if not last:
        return _row("yellow", "Linked, never synced yet")
    last_run = last[0]
    age_h = (datetime.now(UTC) - last_run["finished_at"]).total_seconds() / 3600
    when = f"{age_h:.0f}h ago"
    if last_run["status"] == "error":
        return _row("red", f"Last sync failed {when}: {last_run['error']}")
    if age_h > STALE_HOURS:
        return _row("yellow", f"Last successful sync {when} — nightly sync may be stuck")
    if float(recent["s3"]) > 0:
        return _row("green", f"Synced {when}; ${float(recent['s3']):,.0f} spend in the last 3 days")
    if float(recent["s30"]) > 0:
        return _row("yellow", f"Synced {when}, but no spend in the last 3 days")
    return _row("yellow", f"Synced {when}; no spend in 30 days (paused account?)")


async def _ghl_checks(client: dict, token: str | None) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    loc = client["ghl_location_id"]
    if not loc:
        return {k: _row("grey", "No GHL sub-account linked") for k in ("ghl_token", "ghl_stage_scheduled", "ghl_stage_confirmed", "ghl_won")}
    sheet_won = None
    if client.get("booking_system") == "sheet":
        # Bookings and Won live in the client's booking sheet, not in GHL stages.
        w = pg.query("select coalesce(sum(jobs_won),0) won, coalesce(sum(revenue_won),0) rev from ghl_metrics_daily where client_id = %s and date >= current_date - 90", (client["id"],))[0]
        sheet_won = _row("green" if float(w["won"]) > 0 else "yellow",
                         f"{int(w['won'])} won / ${float(w['rev']):,.0f} in the booking sheet (90d)" if float(w["won"]) > 0 else "No won jobs in the booking sheet in 90 days")
    if not token:
        out["ghl_token"] = _row("red", "Sub-account linked but no location token stored")
        return out | {k: _row("grey", "Needs token") for k in ("ghl_stage_scheduled", "ghl_stage_confirmed", "ghl_won")}
    ghl = HighLevel(private_integration_token=token) if token.startswith("pit-") else HighLevel(agency_access_token=token)
    try:
        resp = await ghl.opportunities.get_pipelines(location_id=loc)
        resp = resp if isinstance(resp, dict) else json.loads(json.dumps(resp, default=lambda o: getattr(o, "__dict__", str(o))))
        out["ghl_token"] = _row("green", "Token valid, pipelines readable")
    except Exception as exc:
        msg = str(exc)[:120]
        out["ghl_token"] = _row("red", f"Token rejected or missing scope: {msg}")
        return out | {k: _row("grey", "Cannot read pipelines") for k in ("ghl_stage_scheduled", "ghl_stage_confirmed", "ghl_won")}
    stages: dict[str, list[str]] = {}
    for p in resp.get("pipelines", []) or []:
        for s in p.get("stages", []) or []:
            stages.setdefault(str(s.get("name") or "").strip().lower(), []).append(p.get("name") or "?")
    def stage(name: str, sev_missing: str, key: str) -> None:
        pipes = stages.get(name)
        if pipes:
            out[key] = _row("green", f"Present in: {', '.join(sorted(set(pipes)))[:120]}")
        else:
            out[key] = _row(sev_missing, f"No '{name.title()}' stage in any pipeline — bookings can't be counted from it")
    stage("scheduled appointment", "red", "ghl_stage_scheduled")
    stage("confirmed appointment", "yellow", "ghl_stage_confirmed")
    if sheet_won is not None:
        out["ghl_stage_scheduled"] = _row("grey", "Bookings come from the booking sheet")
        out["ghl_stage_confirmed"] = _row("grey", "Bookings come from the booking sheet")
        out["ghl_won"] = sheet_won
        return out
    # Won: any opportunity ever marked won, and are values entered?
    try:
        won = await ghl.opportunities.search_opportunity(location_id=loc, status="won", limit=20, page=1)
        won = won if isinstance(won, dict) else json.loads(json.dumps(won, default=lambda o: getattr(o, "__dict__", str(o))))
        opps = won.get("opportunities", []) or []
        total = won.get("meta", {}).get("total") if isinstance(won.get("meta"), dict) else None
        n = total if isinstance(total, int) else len(opps)
        with_value = sum(1 for o in opps if float(o.get("monetaryValue") or 0) > 0)
        if n == 0:
            out["ghl_won"] = _row("yellow", "No opportunity has ever been marked Won — revenue and close rate can't be computed")
        elif with_value == 0:
            out["ghl_won"] = _row("yellow", f"{n} Won, but none of the latest {len(opps)} carry a $ value — ask closers to enter job values")
        else:
            out["ghl_won"] = _row("green", f"{n} Won; {with_value} of the latest {len(opps)} have $ values")
    except Exception as exc:
        out["ghl_won"] = _row("yellow", f"Could not read Won opportunities: {str(exc)[:100]}")
    return out


def _attribution_checks(client: dict) -> dict[str, dict[str, str]]:
    cid = client["id"]
    if client["booking_system"] not in ("ghl", "sheet") or not client["ghl_location_id"]:
        return {"ghl_paid_attribution": _row("grey", "No GHL sub-account"), "ghl_appointments": _row("grey", "Bookings not tracked in GHL")}
    m = pg.query(
        """select coalesce((select sum(leads) from ad_metrics_daily where client_id = %s and platform in ('meta','google') and date >= current_date - 30), 0) leads,
                  coalesce(sum(contacts_paid_attributed), 0) paid, coalesce(sum(appointments_booked), 0) appts,
                  coalesce(sum(appointments_all), 0) appts_all
           from ghl_metrics_daily where client_id = %s and date >= current_date - 30""",
        (cid, cid),
    )[0]
    leads, paid, appts, appts_all = float(m["leads"]), int(m["paid"]), int(m["appts"]), int(m["appts_all"])
    out: dict[str, dict[str, str]] = {}
    if client["booking_system"] == "sheet":
        out["ghl_paid_attribution"] = _row("grey", "Bookings come from the booking sheet")
        out["ghl_appointments"] = _row("green" if appts > 0 else "yellow", f"{appts} bookings from the sheet in 30 days")
        return out
    if leads < 5:
        out["ghl_paid_attribution"] = _row("grey", f"Only {leads:.0f} Meta/Google leads in 30 days — nothing to check (LSA calls can't carry attribution)")
    elif paid == 0:
        out["ghl_paid_attribution"] = _row("red", f"{leads:.0f} ad leads in 30 days but 0 contacts carry paid attribution — GHL's Facebook form mapping isn't stamping ad set / ad id")
    elif paid < 0.5 * leads:
        out["ghl_paid_attribution"] = _row("yellow", f"Only {paid} of {leads:.0f} ad leads reached GHL as paid-attributed contacts")
    else:
        out["ghl_paid_attribution"] = _row("green", f"{paid} paid-attributed contacts for {leads:.0f} ad leads (30d)")
    if paid < 10:
        out["ghl_appointments"] = _row("grey", f"{paid} paid contacts in 30 days — too few to judge booking flow")
    elif appts == 0:
        out["ghl_appointments"] = _row("red", f"{paid} paid contacts, 0 moved to Scheduled/Confirmed Appointment" + (f" ({appts_all} non-paid bookings exist, so the stage is used — attribution gap)" if appts_all else " — setters aren't using the stage"))
    else:
        out["ghl_appointments"] = _row("green", f"{appts} paid bookings from {paid} paid contacts (30d)" + (f"; {appts_all - appts} more from other sources" if appts_all > appts else ""))
    return out


def _utm_check(client: dict) -> dict[str, str]:
    if not client["meta_ad_account_id"]:
        return _row("grey", "No Meta account")
    acct = client["meta_ad_account_id"].replace("act_", "")
    r = pg.query(
        # Only ads that spent in the last 30 days: status ACTIVE alone also matches
        # years-old boosts that never deliver (US Pro has 2017–2019 "Promoting Website" ads).
        """select count(*) filter (where has_adset_utm = false) bad,
                  count(*) filter (where has_adset_utm = true) good,
                  count(*) filter (where has_adset_utm is null) forms
           from meta_ad_creatives cr
           where cr.account_id = %s and cr.effective_status = 'ACTIVE'
             and exists (select 1 from ad_level_metrics_daily m
                         where m.ad_id = cr.ad_id and m.date >= current_date - 30 and m.spend > 0)""",
        (acct,),
    )[0]
    bad, good, forms = int(r["bad"]), int(r["good"]), int(r["forms"])
    if bad:
        return _row("red", f"{bad} active website ad{'s' if bad != 1 else ''} without utm_medium={{{{adset.name}}}} — their leads can't be attributed")
    if good:
        return _row("green", f"All {good} active website ads carry the ad-set UTM; {forms} Instant Form ads")
    if forms:
        return _row("green", f"{forms} active Instant Form ads (UTMs not needed; attribution comes from the form integration)")
    return _row("grey", "No active ads that spent in the last 30 days")


def close_stale_runs(hours: int = 3) -> int:
    """A sync_runs row left 'running' for hours means the task was killed (time limit,
    container restart). Close it as an error so it shows up instead of hiding."""
    return pg.execute(
        """update sync_runs set status = 'error', finished_at = now(),
                  error = 'hung: task never finished (killed by time limit or restart) — closed by health check'
           where status = 'running' and started_at < now() - (%s || ' hours')::interval""",
        (str(hours),),
    )


def _pixel_capi_check(client: dict) -> dict[str, str]:
    """Is Meta receiving conversion events for this account, and are any of them
    server-side (Conversions API)? Server events are what let Meta optimise on
    booked appointments instead of form fills; browser-only means no CAPI."""
    import time

    import requests

    from app.core.config import get_settings

    acct = (client.get("meta_ad_account_id") or "").replace("act_", "")
    if not acct:
        return _row("grey", "No Meta account")
    tok = get_settings().meta_system_user_token
    g = "https://graph.facebook.com/v21.0"
    try:
        pixels = requests.get(f"{g}/act_{acct}/adspixels", params={"access_token": tok, "fields": "id,name,last_fired_time"}, timeout=60).json().get("data", [])
    except Exception as exc:
        return _row("yellow", f"Could not read pixels: {str(exc)[:80]}")
    if not pixels:
        return _row("red", "No pixel on the ad account — Meta gets no conversion or booking signal")
    now = int(time.time())
    server = browser = 0
    for p in pixels:
        try:
            st = requests.get(f"{g}/{p['id']}/stats", params={"access_token": tok, "aggregation": "event_source",
                              "start_time": now - 14 * 86400, "end_time": now}, timeout=60).json()
        except Exception as exc:  # noqa: BLE001
            logger.debug("pixel stats unavailable for %s: %s", p.get("id"), exc)
            continue
        for b in st.get("data", []) or []:
            for d in b.get("data", []) or []:
                if d.get("value") == "SERVER":
                    server += int(d.get("count") or 0)
                elif d.get("value") == "BROWSER":
                    browser += int(d.get("count") or 0)
    names = ", ".join(p["name"][:20] for p in pixels[:3])
    if server:
        return _row("green", f"CAPI live: {server} server events / {browser} browser events in 14 days ({names})")
    if browser:
        return _row("yellow", f"Pixel fires from the browser only ({browser} events, 14d) — no Conversions API, so bookings never reach Meta ({names})")
    return _row("red", f"Pixel exists but sent no events in 14 days ({names}) — no signal back to Meta")


def _landing_page_check(client: dict) -> dict[str, str]:
    rows = pg.query(
        "select url, status, flags, spend_30d from landing_page_checks where client_id = %s order by spend_30d desc",
        (str(client["id"]),),
    )
    if not rows:
        return _row("grey", "No website landing pages in the last 30 days (Instant Forms / LSA only)")
    reds = [r for r in rows if r["status"] == "red"]
    yellows = [r for r in rows if r["status"] == "yellow"]
    if reds:
        r = reds[0]
        return _row("red", f"{len(reds)} broken page{'s' if len(reds) != 1 else ''}: {r['url']} — {', '.join(r['flags'])} (${float(r['spend_30d']):,.0f} sent there in 30d)")
    if yellows:
        r = yellows[0]
        return _row("yellow", f"{len(yellows)} page{'s' if len(yellows) != 1 else ''} to look at: {r['url']} — {', '.join(r['flags'])}")
    return _row("green", f"{len(rows)} landing page{'s' if len(rows) != 1 else ''} return 200 with a form and phone link")


def run_health_checks() -> dict[str, Any]:
    close_stale_runs()
    try:
        from app.services import landing_pages
        logger.info("landing page checks: %s", landing_pages.run_checks())
    except Exception:
        logger.exception("landing page checks failed")
    clients = pg.query(
        """select c.id, c.slug, c.name, c.meta_ad_account_id, c.google_ads_customer_id, c.google_lsa_customer_id,
                  c.ghl_location_id, c.booking_system, s.ghl_token
           from clients c left join client_secrets s on s.client_id = c.id
           where c.is_active order by c.name"""
    )
    summary = {"clients": 0, "red": 0, "yellow": 0}

    async def ghl_all() -> dict[str, dict]:
        res = {}
        for c in clients:
            res[str(c["id"])] = await _ghl_checks(dict(c), c["ghl_token"])
            await asyncio.sleep(0.4)
        return res

    ghl_results = asyncio.run(ghl_all())
    for c in clients:
        c = dict(c)
        cid = str(c["id"])
        checks: dict[str, dict[str, str]] = {}
        checks["meta_sync"] = _sync_check(cid, "meta", bool(c["meta_ad_account_id"]), "meta")
        checks["google_sync"] = _sync_check(cid, "google", bool(c["google_ads_customer_id"]), "google")
        checks["lsa_sync"] = _sync_check(cid, "lsa", bool(c["google_lsa_customer_id"]), "lsa") if c["google_lsa_customer_id"] \
            else (_row("green", "LSA campaigns inside the Google account are split out automatically") if pg.query(
                "select 1 from ad_metrics_daily where client_id = %s and platform = 'lsa' and date >= current_date - 30 limit 1", (cid,))
                  else _row("grey", "No Local Services account"))
        checks.update(ghl_results.get(cid, {}))
        checks.update(_attribution_checks(c))
        checks["utm_tags"] = _utm_check(c)
        checks["pixel_capi"] = _pixel_capi_check(c)
        checks["landing_pages"] = _landing_page_check(c)
        for key, v in checks.items():
            pg.execute(
                """insert into integration_health (client_id, check_key, status, detail, checked_at)
                   values (%s, %s, %s, %s, now())
                   on conflict (client_id, check_key) do update set status = excluded.status, detail = excluded.detail, checked_at = now()""",
                (cid, key, v["status"], v["detail"][:400]),
            )
        statuses = [v["status"] for v in checks.values()]
        summary["clients"] += 1
        summary["red"] += "red" in statuses
        summary["yellow"] += ("red" not in statuses and "yellow" in statuses)
    return summary

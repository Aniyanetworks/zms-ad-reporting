"""GoHighLevel sync via the official SDK (gohighlevel-api-client, API v2, async-first).

Per client/day rollup into ghl_metrics_daily:
- contacts created (dateAdded in window), paid-attributed via attributionSource /
  UTM fields (utm_medium in the paid set)
- appointments booked (calendar events per location per day, non-cancelled)
- inbound calls (conversations with call message type) — stored as 0 if the
  endpoint is unavailable for a location rather than failing the sync

Rate limit: GHL allows 100 req/10s burst per location — we throttle between calls.
"""
import asyncio
import json
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from highlevel import HighLevel

from app.core.config import get_settings
from app.services import pg

LOOKBACK_DAYS = 7  # GHL data doesn't restate like ad platforms; short rolling window
MAX_BACKFILL_DAYS = 365

PAID_UTM_MEDIUMS = {"paid", "cpc", "paid_social", "ppc", "paidsearch", "paid_search"}
CANCELLED_STATUSES = {"cancelled", "canceled", "noshow", "no_show", "invalid"}
PAGE_LIMIT = 100
THROTTLE_SECONDS = 0.15  # ~66 req/10s, under the 100/10s burst limit


def _day_bounds_ms(day: date) -> tuple[int, int]:
    start = datetime.combine(day, time.min, tzinfo=UTC)
    end = datetime.combine(day, time.max, tzinfo=UTC)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


PAID_SESSION_SOURCES = {"paid social", "paid search", "paid other"}


def _is_paid_attributed(contact: dict[str, Any]) -> bool:
    """ZMS GHL data quirk: utmMedium carries the AD SET name (e.g. "Broad Videos"),
    not a medium value. The reliable paid markers are sessionSource ("Paid Social" /
    "Paid Search") and the presence of an adId/campaignId; the classic utm_medium
    values are kept as a fallback for locations with standard UTM tagging."""
    sources = []
    for key in ("attributionSource", "lastAttributionSource"):
        if isinstance(contact.get(key), dict):
            sources.append(contact[key])
    if isinstance(contact.get("attributions"), list):
        sources.extend(a for a in contact["attributions"] if isinstance(a, dict))
    for source in sources:
        if str(source.get("sessionSource") or "").lower() in PAID_SESSION_SOURCES:
            return True
        if source.get("adId") or source.get("campaignId") or source.get("gclid") or source.get("fbclid"):
            return True
        medium = str(source.get("utmMedium") or source.get("medium") or "").lower()
        if medium in PAID_UTM_MEDIUMS:
            return True
    return False


async def _fetch_contacts_for_day(
    ghl: HighLevel, location_id: str, day: date
) -> tuple[int, int, dict[str, int]]:
    """Return (contacts_created, contacts_paid_attributed, paid-per-adset) for one
    local day. Ad set names come from the utmMedium quirk."""
    start_iso = f"{day.isoformat()}T00:00:00.000Z"
    end_iso = f"{(day + timedelta(days=1)).isoformat()}T00:00:00.000Z"
    total = 0
    paid = 0
    by_adset: dict[str, int] = {}
    search_after: list[Any] | None = None
    while True:
        body: dict[str, Any] = {
            "locationId": location_id,
            "pageLimit": PAGE_LIMIT,
            "filters": [
                {
                    "field": "dateAdded",
                    "operator": "range",
                    "value": {"gte": start_iso, "lt": end_iso},
                }
            ],
        }
        if search_after:
            body["searchAfter"] = search_after
        result = await ghl.contacts.search_contacts_advanced(request_body=body)
        result = result if isinstance(result, dict) else json.loads(json.dumps(result, default=lambda o: getattr(o, "__dict__", str(o))))
        contacts = result.get("contacts", []) or []
        total += len(contacts)
        for c in contacts:
            if _is_paid_attributed(c):
                paid += 1
                adset = _adset_of(c)
                if adset:
                    by_adset[adset] = by_adset.get(adset, 0) + 1
        if len(contacts) < PAGE_LIMIT:
            break
        search_after = contacts[-1].get("searchAfter")
        if not search_after:
            break
        await asyncio.sleep(THROTTLE_SECONDS)
    return total, paid, by_adset


async def _fetch_appointments_for_day(ghl: HighLevel, location_id: str, day: date) -> int:
    """Count non-cancelled calendar events starting on the given day, across all
    of the location's calendars."""
    start_ms, end_ms = _day_bounds_ms(day)
    calendars_resp = await ghl.calendars.get_calendars(location_id=location_id)
    calendars = getattr(calendars_resp, "calendars", None) or (
        calendars_resp.get("calendars", []) if isinstance(calendars_resp, dict) else []
    )
    booked = 0
    for calendar in calendars:
        calendar_id = calendar.get("id") if isinstance(calendar, dict) else getattr(calendar, "id", None)
        if not calendar_id:
            continue
        events_resp = await ghl.calendars.get_calendar_events(
            location_id=location_id,
            start_time=str(start_ms),
            end_time=str(end_ms),
            calendar_id=calendar_id,
        )
        events = getattr(events_resp, "events", None) or (
            events_resp.get("events", []) if isinstance(events_resp, dict) else []
        )
        for event in events:
            status = (
                event.get("appointmentStatus") if isinstance(event, dict)
                else getattr(event, "appointment_status", None)
            ) or ""
            if str(status).lower() not in CANCELLED_STATUSES:
                booked += 1
        await asyncio.sleep(THROTTLE_SECONDS)
    return booked


SHOWED_STATUSES = {"showed", "show", "completed"}
NOSHOW_STATUSES = {"noshow", "no_show", "no-show"}
CONFIRMED_STATUSES = {"confirmed"}


async def _fetch_appt_statuses(
    ghl: HighLevel, location_id: str, days: int, cache: dict[str, tuple[bool, str | None]] | None = None
) -> dict[date, dict[str, int]]:
    """Offline funnel after the booking: per appointment START day, how many
    paid-attributed appointments are confirmed / showed / no-show (GHL calendar
    event appointmentStatus). One events call per calendar for the whole window,
    plus one cached contact lookup per event for the paid check. Empty on failure."""
    cache = cache if cache is not None else {}
    out: dict[date, dict[str, int]] = {}
    try:
        today = date.today()
        start_ms, _ = _day_bounds_ms(today - timedelta(days=days))
        _, end_ms = _day_bounds_ms(today + timedelta(days=1))
        calendars_resp = await ghl.calendars.get_calendars(location_id=location_id)
        calendars = getattr(calendars_resp, "calendars", None) or (
            calendars_resp.get("calendars", []) if isinstance(calendars_resp, dict) else []
        )
        for calendar in calendars:
            calendar_id = calendar.get("id") if isinstance(calendar, dict) else getattr(calendar, "id", None)
            if not calendar_id:
                continue
            events_resp = await ghl.calendars.get_calendar_events(
                location_id=location_id, start_time=str(start_ms), end_time=str(end_ms), calendar_id=calendar_id,
            )
            events_resp = events_resp if isinstance(events_resp, dict) else json.loads(
                json.dumps(events_resp, default=lambda o: getattr(o, "__dict__", str(o)))
            )
            for event in events_resp.get("events", []) or []:
                status = str(event.get("appointmentStatus") or "").lower()
                bucket = ("confirmed" if status in CONFIRMED_STATUSES else "showed" if status in SHOWED_STATUSES
                          else "noshow" if status in NOSHOW_STATUSES else None)
                if not bucket:
                    continue
                stamp = event.get("startTime")
                try:
                    day = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).date()
                except (TypeError, ValueError):
                    continue
                contact_id = event.get("contactId")
                if not contact_id:
                    continue
                is_paid, _adset = await _contact_info(ghl, contact_id, cache)
                if not is_paid:
                    continue
                out.setdefault(day, {"confirmed": 0, "showed": 0, "noshow": 0})[bucket] += 1
            await asyncio.sleep(THROTTLE_SECONDS)
    except Exception:
        return out
    return out


async def _fetch_calls_for_day(ghl: HighLevel, location_id: str, day: date) -> int:
    """Inbound calls via conversations search; 0 if the endpoint is unavailable."""
    start_ms, end_ms = _day_bounds_ms(day)
    try:
        result = await ghl.conversations.search_conversation(
            location_id=location_id,
            last_message_type="TYPE_CALL",
            last_message_direction="inbound",
            start_date=start_ms,
            end_date=end_ms,
            limit=1,
        )
        if isinstance(result, dict):
            return int(result.get("total", 0))
        return int(getattr(result, "total", 0) or 0)
    except Exception:
        # Calls not enabled for this location — store 0 rather than failing the sync
        return 0


# Booked appointments are counted from opportunities sitting in these pipeline
# stages (ZMS process: setters move an opp to "Scheduled Appointment" when booked),
# NOT from calendar events — Carl's call, 2026-08-26. Calendar events remain the
# fallback for locations without a matching stage.
APPT_STAGE_NAMES = {"scheduled appointment", "confirmed appointment"}
# Junk leads: opportunities parked in these stages.
JUNK_STAGE_NAMES = {"not interested", "bad lead"}


def _adset_of(contact: dict[str, Any]) -> str | None:
    """ZMS quirk: utmMedium carries the AD SET name for paid contacts."""
    for key in ("attributionSource", "lastAttributionSource"):
        src = contact.get(key)
        if isinstance(src, dict) and src.get("utmMedium"):
            return str(src["utmMedium"]).strip()
    if isinstance(contact.get("attributions"), list):
        for src in contact["attributions"]:
            if isinstance(src, dict) and src.get("utmMedium"):
                return str(src["utmMedium"]).strip()
    return None


async def _fetch_stage_ids(ghl: HighLevel, location_id: str, names: set[str]) -> set[str]:
    resp = await ghl.opportunities.get_pipelines(location_id=location_id)
    resp = resp if isinstance(resp, dict) else json.loads(
        json.dumps(resp, default=lambda o: getattr(o, "__dict__", str(o)))
    )
    stage_ids: set[str] = set()
    for pipeline in resp.get("pipelines", []) or []:
        for stage in pipeline.get("stages", []) or []:
            if str(stage.get("name") or "").strip().lower() in names:
                if stage.get("id"):
                    stage_ids.add(stage["id"])
    return stage_ids


async def _contact_info(
    ghl: HighLevel, contact_id: str, cache: dict[str, tuple[bool, str | None]]
) -> tuple[bool, str | None]:
    """(came from a paid ad, ad set name) for one contact — cached, since
    appointments often share contacts. A contact we cannot fetch counts as
    not-paid: better to under-report paid bookings than to inflate them."""
    if contact_id in cache:
        return cache[contact_id]
    try:
        resp = await ghl.contacts.get_contact(contact_id=contact_id)
        resp = resp if isinstance(resp, dict) else json.loads(
            json.dumps(resp, default=lambda o: getattr(o, "__dict__", str(o)))
        )
        contact = resp.get("contact", resp) or {}
        info = (_is_paid_attributed(contact), _adset_of(contact))
    except Exception:
        info = (False, None)
    cache[contact_id] = info
    return info


def _stage_change_day(opp: dict[str, Any]) -> date | None:
    stamp = opp.get("lastStageChangeAt") or opp.get("lastStatusChangeAt") or opp.get("updatedAt")
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).date()
    except ValueError:
        return None


async def _stage_opps(ghl: HighLevel, location_id: str, stage_ids: set[str]) -> list[dict[str, Any]]:
    opps: list[dict[str, Any]] = []
    for stage_id in stage_ids:
        page = 1
        while True:
            result = await ghl.opportunities.search_opportunity(
                location_id=location_id, pipeline_stage_id=stage_id, limit=100, page=page
            )
            result = result if isinstance(result, dict) else json.loads(
                json.dumps(result, default=lambda o: getattr(o, "__dict__", str(o)))
            )
            batch = result.get("opportunities", []) or []
            opps.extend(batch)
            if len(batch) < 100:
                break
            page += 1
            await asyncio.sleep(THROTTLE_SECONDS)
        await asyncio.sleep(THROTTLE_SECONDS)
    return opps


async def _fetch_appts_by_day(
    ghl: HighLevel, location_id: str, resolve_adsets: bool = True
) -> tuple[dict[date, int], dict[tuple[date, str], int], dict[date, int]] | None:
    """Opportunities in a scheduled/confirmed-appointment stage, bucketed by the day
    they entered the stage:
      ({day: PAID appointments}, {(day, adset_name): count}, {day: ALL appointments}).

    Only bookings whose contact came from a paid ad (Facebook/Instagram or Google —
    `_is_paid_attributed`) count towards `appointments_booked`, because that number
    divides ad spend to give CPBA. Several locations run the same pipeline stages for
    Angi, BuilderTrend, website, chatbot and past-lead opportunities; counting those
    made paid CPBA look far better than it is (US Pro Painter: 198 total vs ~50 paid
    in 30 days). The unfiltered count is kept as `appointments_all` for context.
    None if the location has no matching stage or the token lacks the scope
    (caller falls back to calendars)."""
    try:
        stage_ids = await _fetch_stage_ids(ghl, location_id, APPT_STAGE_NAMES)
        if not stage_ids:
            return None
        paid_appts: dict[date, int] = {}
        all_appts: dict[date, int] = {}
        by_adset: dict[tuple[date, str], int] = {}
        cache: dict[str, tuple[bool, str | None]] = {}
        for opp in await _stage_opps(ghl, location_id, stage_ids):
            day = _stage_change_day(opp)
            if day is None:
                continue
            all_appts[day] = all_appts.get(day, 0) + 1
            contact_id = opp.get("contactId") or (opp.get("contact") or {}).get("id")
            if not contact_id:
                continue
            is_paid, adset = await _contact_info(ghl, contact_id, cache)
            await asyncio.sleep(THROTTLE_SECONDS)
            if not is_paid:
                continue
            paid_appts[day] = paid_appts.get(day, 0) + 1
            if resolve_adsets and adset:
                key = (day, adset)
                by_adset[key] = by_adset.get(key, 0) + 1
        return paid_appts, by_adset, all_appts
    except Exception:
        return None


async def _fetch_junk_by_day(ghl: HighLevel, location_id: str) -> dict[date, int]:
    """Opportunities parked in junk stages (Not Interested / Bad Lead), bucketed
    by the day they were moved there. Empty on any failure."""
    try:
        stage_ids = await _fetch_stage_ids(ghl, location_id, JUNK_STAGE_NAMES)
        if not stage_ids:
            return {}
        junk: dict[date, int] = {}
        for opp in await _stage_opps(ghl, location_id, stage_ids):
            day = _stage_change_day(opp)
            if day is not None:
                junk[day] = junk.get(day, 0) + 1
        return junk
    except Exception:
        return {}


def _won_day(opp: dict[str, Any]) -> date | None:
    """Day an opportunity was marked won — lastStatusChangeAt, falling back to updatedAt."""
    stamp = opp.get("lastStatusChangeAt") or opp.get("updatedAt") or opp.get("createdAt")
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).date()
    except ValueError:
        return None


async def _fetch_won_by_day(ghl: HighLevel, location_id: str) -> dict[date, tuple[int, float]]:
    """All won opportunities for the location, bucketed by the day they were won:
    {day: (jobs_won, revenue_won)}. Empty dict if the token lacks the
    opportunities.readonly scope (older PITs) — the sync must not fail on it."""
    won: dict[date, tuple[int, float]] = {}
    page = 1
    try:
        while True:
            result = await ghl.opportunities.search_opportunity(
                location_id=location_id, status="won", limit=100, page=page
            )
            result = result if isinstance(result, dict) else json.loads(
                json.dumps(result, default=lambda o: getattr(o, "__dict__", str(o)))
            )
            opportunities = result.get("opportunities", []) or []
            for opp in opportunities:
                day = _won_day(opp)
                if day is None:
                    continue
                try:
                    value = float(opp.get("monetaryValue") or 0)
                except (TypeError, ValueError):
                    value = 0.0
                jobs, revenue = won.get(day, (0, 0.0))
                won[day] = (jobs + 1, revenue + value)
            if len(opportunities) < 100:
                break
            page += 1
            await asyncio.sleep(THROTTLE_SECONDS)
    except Exception:
        # Scope missing or endpoint unavailable — report zeros rather than failing
        return {}
    return won


async def sync_ghl_client(
    client_id: str, location_id: str, days: int = LOOKBACK_DAYS, token: str | None = None
) -> int:
    """Roll up the trailing `days` for one location; upsert ghl_metrics_daily rows.

    GHL only offers the contacts/calendars/conversations scopes on LOCATION-level
    private integrations, so each client carries its own token (client_secrets);
    the agency env token is only a fallback.
    """
    settings = get_settings()
    days = min(days, MAX_BACKFILL_DAYS)
    token = token or settings.ghl_agency_token
    # Private Integration tokens are prefixed "pit-"; anything else is an agency OAuth token
    if token.startswith("pit-"):
        ghl = HighLevel(private_integration_token=token)
    else:
        ghl = HighLevel(agency_access_token=token)
    rows_upserted = 0
    # booking_system='sheet': appointments/jobs/revenue come from the client's
    # tracking sheet (app.services.booking_sheet) — never overwrite them here.
    bs = pg.query("select booking_system from clients where id = %s", (client_id,))
    sheet_booked = bool(bs) and bs[0]["booking_system"] == "sheet"
    try:
        won_by_day = await _fetch_won_by_day(ghl, location_id)
        junk_by_day = await _fetch_junk_by_day(ghl, location_id)
        appt_result = await _fetch_appts_by_day(ghl, location_id)
        appts_by_day = appt_result[0] if appt_result else None
        appts_by_adset = appt_result[1] if appt_result else {}
        all_appts_by_day = appt_result[2] if appt_result else {}
        statuses_by_day = await _fetch_appt_statuses(ghl, location_id, days)
        today = date.today()
        adset_rows: dict[tuple[date, str], dict[str, int]] = {}
        for (day, adset), n in appts_by_adset.items():
            adset_rows.setdefault((day, adset), {"contacts_paid": 0, "appointments": 0})["appointments"] = n
        for offset in range(days, -1, -1):
            day = today - timedelta(days=offset)
            contacts_created, contacts_paid, paid_by_adset = await _fetch_contacts_for_day(ghl, location_id, day)
            for adset, n in paid_by_adset.items():
                adset_rows.setdefault((day, adset), {"contacts_paid": 0, "appointments": 0})["contacts_paid"] = n
            await asyncio.sleep(THROTTLE_SECONDS)
            if appts_by_day is not None:
                appointments = appts_by_day.get(day, 0)
                appointments_all = all_appts_by_day.get(day, 0)
            else:
                # Calendar fallback has no attribution data — paid and all are the same.
                appointments = await _fetch_appointments_for_day(ghl, location_id, day)
                appointments_all = appointments
            await asyncio.sleep(THROTTLE_SECONDS)
            calls = await _fetch_calls_for_day(ghl, location_id, day)
            jobs_won, revenue_won = won_by_day.get(day, (0, 0.0))
            pg.execute(
                """
                insert into ghl_metrics_daily (
                    client_id, date, contacts_created, contacts_paid_attributed,
                    inbound_calls, appointments_booked, appointments_all, jobs_won, revenue_won, leads_dq, raw, synced_at,
                    appointments_confirmed, appointments_showed, appointments_noshow
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), %s, %s, %s)
                on conflict (client_id, date) do update set
                    appointments_confirmed = excluded.appointments_confirmed,
                    appointments_showed = excluded.appointments_showed,
                    appointments_noshow = excluded.appointments_noshow,
                    contacts_created = excluded.contacts_created,
                    contacts_paid_attributed = excluded.contacts_paid_attributed,
                    inbound_calls = excluded.inbound_calls,
                    appointments_booked = case when %s then ghl_metrics_daily.appointments_booked else excluded.appointments_booked end,
                    appointments_all = case when %s then ghl_metrics_daily.appointments_all else excluded.appointments_all end,
                    jobs_won = case when %s then ghl_metrics_daily.jobs_won else excluded.jobs_won end,
                    revenue_won = case when %s then ghl_metrics_daily.revenue_won else excluded.revenue_won end,
                    leads_dq = excluded.leads_dq,
                    raw = excluded.raw,
                    synced_at = excluded.synced_at
                """,
                (
                    client_id,
                    day,
                    contacts_created,
                    contacts_paid,
                    calls,
                    appointments,
                    appointments_all,
                    jobs_won,
                    revenue_won,
                    junk_by_day.get(day, 0),
                    json.dumps({"location_id": location_id}),
                    statuses_by_day.get(day, {}).get("confirmed", 0),
                    statuses_by_day.get(day, {}).get("showed", 0),
                    statuses_by_day.get(day, {}).get("noshow", 0),
                    sheet_booked, sheet_booked, sheet_booked, sheet_booked,
                ),
            )
            rows_upserted += 1
            await asyncio.sleep(THROTTLE_SECONDS)
        for (day, adset), vals in adset_rows.items():
            pg.execute(
                """
                insert into ghl_adset_daily (client_id, date, adset_name, contacts_paid, appointments, synced_at)
                values (%s, %s, %s, %s, %s, now())
                on conflict (client_id, date, adset_name) do update set
                    contacts_paid = greatest(excluded.contacts_paid, ghl_adset_daily.contacts_paid),
                    appointments = case when %s then ghl_adset_daily.appointments else excluded.appointments end,
                    synced_at = now()
                """,
                (client_id, day, adset[:255], vals["contacts_paid"], vals["appointments"], sheet_booked),
            )
    finally:
        await ghl.close()
    return rows_upserted


def run_ghl_sync(
    client_id: str, location_id: str, days: int = LOOKBACK_DAYS, token: str | None = None
) -> int:
    """Sync entrypoint for Celery (sync context)."""
    return asyncio.run(sync_ghl_client(client_id, location_id, days, token=token))

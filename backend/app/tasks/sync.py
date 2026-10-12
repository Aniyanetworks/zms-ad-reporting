"""Scheduled sync tasks. Every job writes a sync_runs row; a failure in one client
must never abort the loop over the others."""
import logging
from datetime import date, timedelta

from app.celery_app import celery
from app.services import ghl, google, meta, pg, sync_log, transform

logger = logging.getLogger(__name__)


def _window(days: int) -> tuple[date, date]:
    end = date.today()
    return end - timedelta(days=days), end


# ---------------------------------------------------------------- Meta

def _sync_meta_client(client: dict, days: int) -> None:
    run_id = sync_log.start_run("meta", client["id"])
    try:
        meta.run_meta_pipeline(client["slug"], client["meta_ad_account_id"], days=days)
        start, end = _window(min(days, meta.MAX_BACKFILL_DAYS))
        rows = transform.merge_meta(client["id"], client["meta_ad_account_id"], start, end,
                                    campaign_filter=client.get("meta_campaign_filter"))
        try:  # budget snapshot (Delivery / Budget columns) — never fails the sync
            from app.core.config import get_settings
            meta.sync_budgets(str(client["id"]), client["meta_ad_account_id"], get_settings().meta_system_user_token)
        except Exception:
            logger.exception("Meta budget snapshot failed for %s", client["slug"])
        sync_log.finish_run(run_id, "success", rows_upserted=rows)
    except Exception as exc:
        logger.exception("Meta sync failed for %s", client["slug"])
        sync_log.finish_run(run_id, "error", error=str(exc))


def _load_client(client_id: str) -> dict | None:
    rows = pg.query(
        "select c.*, s.ghl_token from clients c left join client_secrets s on s.client_id = c.id where c.id = %s",
        (client_id,),
    )
    return rows[0] if rows else None


# One Celery task per client. The worker's global --time-limit (60 min) used to
# apply to the whole 22-client loop: US Pro Painter's 900+ ads pushed it over,
# the task was killed mid-client (leaving its sync_runs row 'running' forever)
# and every client after it alphabetically never synced. Per-client tasks get
# their own limit and run 4-wide (worker --concurrency=4).
@celery.task(name="app.tasks.sync.sync_meta_client", soft_time_limit=2100, time_limit=2400)
def sync_meta_client(client_id: str, days: int = meta.LOOKBACK_DAYS) -> dict:
    client = _load_client(client_id)
    if not client or not client.get("meta_ad_account_id"):
        return {"skipped": client_id}
    _sync_meta_client(client, days)
    _retag_services()
    return {"client": client["slug"]}


@celery.task(name="app.tasks.sync.sync_meta_all")
def sync_meta_all(days: int = meta.LOOKBACK_DAYS) -> dict:
    """Daily 1:00 / 6:00 AM PT — fan out one task per active Meta client."""
    clients = pg.get_active_clients("meta_ad_account_id")
    for client in clients:
        sync_meta_client.delay(str(client["id"]), days)
    return {"dispatched": len(clients)}


def _retag_services() -> None:
    """Keep campaign_service_map current for the Services page; never fatal."""
    try:
        from app.services.classify import refresh_campaign_services
        refresh_campaign_services()
    except Exception:
        logger.exception("campaign service re-tagging failed")


# ---------------------------------------------------------------- Google

def _sync_google_client(client: dict, days: int, lsa: bool = False) -> None:
    """One Google Ads customer id. lsa=True syncs the client's dedicated Local Services
    account (google_lsa_customer_id) and files every campaign under platform 'lsa'."""
    customer_id = client["google_lsa_customer_id"] if lsa else client["google_ads_customer_id"]
    run_id = sync_log.start_run("lsa" if lsa else "google", client["id"])
    try:
        google.run_google_pipeline(client["slug"] + ("_lsa" if lsa else ""), customer_id, days=days)
        start, end = _window(min(days, google.MAX_BACKFILL_DAYS))
        rows = transform.merge_google(client["id"], customer_id, start, end,
                                      platform_override="lsa" if lsa else None)
        try:
            google.sync_budgets(str(client["id"]), customer_id, platform_override="lsa" if lsa else None)
        except Exception:
            logger.exception("Google budget snapshot failed for %s", client["slug"])
        if not lsa:
            # Ad groups / ads / keywords / search terms for AI analysis — best-effort,
            # never fails the campaign-level sync the dashboard depends on.
            try:
                logger.info("Google granular sync %s: %s", client["slug"],
                            google.sync_granular(str(client["id"]), customer_id, start, end))
            except Exception:
                logger.exception("Google granular sync failed for %s", client["slug"])
        sync_log.finish_run(run_id, "success", rows_upserted=rows)
    except Exception as exc:
        logger.exception("Google sync failed for %s (lsa=%s)", client["slug"], lsa)
        sync_log.finish_run(run_id, "error", error=str(exc))


@celery.task(name="app.tasks.sync.sync_google_client", soft_time_limit=1500, time_limit=1800)
def sync_google_client(client_id: str, lsa: bool = False, days: int = google.LOOKBACK_DAYS) -> dict:
    client = _load_client(client_id)
    key = "google_lsa_customer_id" if lsa else "google_ads_customer_id"
    if not client or not client.get(key):
        return {"skipped": client_id}
    _sync_google_client(client, days, lsa=lsa)
    _retag_services()
    return {"client": client["slug"], "lsa": lsa}


@celery.task(name="app.tasks.sync.sync_google_all")
def sync_google_all(days: int = google.LOOKBACK_DAYS) -> dict:
    """Daily 1:15 AM PT — fan out one task per Google account (regular and LSA)."""
    clients = pg.get_active_clients("google_ads_customer_id")
    for client in clients:
        sync_google_client.delay(str(client["id"]), False, days)
    lsa_clients = pg.get_active_clients("google_lsa_customer_id")
    for client in lsa_clients:
        sync_google_client.delay(str(client["id"]), True, days)
    return {"dispatched": len(clients) + len(lsa_clients)}


# ---------------------------------------------------------------- GHL

def _sync_ghl_client(client: dict, days: int) -> None:
    run_id = sync_log.start_run("ghl", client["id"])
    try:
        rows = ghl.run_ghl_sync(client["id"], client["ghl_location_id"], days=days, token=client.get("ghl_token"))
        sync_log.finish_run(run_id, "success", rows_upserted=rows)
    except Exception as exc:
        logger.exception("GHL sync failed for %s", client["slug"])
        sync_log.finish_run(run_id, "error", error=str(exc))


@celery.task(name="app.tasks.sync.sync_ghl_client", soft_time_limit=3000, time_limit=3300)
def sync_ghl_client(client_id: str, days: int = ghl.LOOKBACK_DAYS) -> dict:
    client = _load_client(client_id)
    if not client or not client.get("ghl_location_id"):
        return {"skipped": client_id}
    _sync_ghl_client(client, days)
    return {"client": client["slug"]}


@celery.task(name="app.tasks.sync.sync_ghl_all")
def sync_ghl_all(days: int = ghl.LOOKBACK_DAYS) -> dict:
    """Daily 1:30 AM PT — fan out one task per GHL sub-account (paid-only
    appointment counting fetches every booked contact, so big locations are slow)."""
    clients = pg.get_active_clients("ghl_location_id")
    for client in clients:
        sync_ghl_client.delay(str(client["id"]), days)
    return {"dispatched": len(clients)}


# ---------------------------------------------------------------- Sheets export

@celery.task(name="app.tasks.sync.sync_booking_sheets")
def sync_booking_sheets() -> dict:
    """Daily 1:45 AM PT — booked appointments for clients whose setters track them
    in a Google Sheet (booking_system='sheet'), after the GHL sync."""
    from app.services.booking_sheet import sync_all_booking_sheets
    return sync_all_booking_sheets()


@celery.task(name="app.tasks.sync.integration_health")
def integration_health() -> dict:
    """Daily 2:05 AM PT — after the syncs, before the brief: is every data source
    linked, syncing and producing the events we count on?"""
    from app.services import integrations

    run_id = sync_log.start_run("health", None)
    try:
        result = integrations.run_health_checks()
        sync_log.finish_run(run_id, "success", rows_upserted=result["clients"])
        return result
    except Exception as exc:
        logger.exception("Integration health failed")
        sync_log.finish_run(run_id, "error", error=str(exc))
        raise


@celery.task(name="app.tasks.sync.daily_brief")
def daily_brief() -> dict:
    """Daily 2:15 AM PT — after every sync: brief each client on the last 7 complete
    days and propose recommendations. Reads Supabase only; never touches Meta/Google."""
    from app.services import brief

    run_id = sync_log.start_run("brief", None)
    try:
        result = brief.run_daily_brief()
        errors = [r for r in result["results"] if r.get("error")]
        sync_log.finish_run(run_id, "partial" if errors else "success", rows_upserted=result["clients"],
                            error="; ".join(f"{e['slug']}: {e['error']}" for e in errors) or None)
        return result
    except Exception as exc:
        logger.exception("Daily brief failed")
        sync_log.finish_run(run_id, "error", error=str(exc))
        raise


@celery.task(name="app.tasks.sync.export_sheets")
def export_sheets() -> dict:
    """Daily 7:00 AM PT — rewrite the ZMS Ads Daily Export spreadsheet
    (Daily / Weekly / Monthly tabs) after all syncs have run."""
    from app.services import sheets_export

    run_id = sync_log.start_run("sheets", None)
    try:
        result = sheets_export.run_sheets_export()
        sync_log.finish_run(run_id, "success", rows_upserted=sum(
            v for k, v in result.items() if isinstance(v, int)
        ))
        return result
    except Exception as exc:
        logger.exception("Sheets export failed")
        sync_log.finish_run(run_id, "error", error=str(exc))
        raise


@celery.task(name="app.tasks.sync.slack_daily_report")
def slack_daily_report() -> dict:
    """Daily 7:00 AM PT — leads and booked appointments per client (yesterday / 7d / 30d)
    plus the Kill/Scale SOP actions and brief findings, posted to the report channel."""
    from app.services import slack_report

    run_id = sync_log.start_run("slack", None)
    try:
        result = slack_report.send_daily_report()
        sync_log.finish_run(run_id, "success" if result.get("posted") else "partial",
                            rows_upserted=result.get("clients", 0), error=result.get("skipped"))
        return result
    except Exception as exc:
        logger.exception("Slack daily report failed")
        sync_log.finish_run(run_id, "error", error=str(exc))
        raise


@celery.task(name="app.tasks.sync.slack_health_alerts")
def slack_health_alerts() -> dict:
    """Daily 7:05 AM PT — post the health-check alerts to Slack (no-op until
    SLACK_WEBHOOK_URL is set)."""
    from app.services import sheets_export

    return sheets_export.send_slack_health_alerts()


# ---------------------------------------------------------------- Setter leaderboard

@celery.task(name="app.tasks.sync.sync_setters", time_limit=240, soft_time_limit=200)
def sync_setters() -> dict:
    """Every minute (beat) — mirror the two appointment-setter sheets into
    setter_appointments / setter_daily_activity. Each sheet is independent: one
    failing leaves its previous snapshot in place and the run is logged as
    'partial'; both failing logs 'error'. Never writes to Google."""
    from app.services import setters

    run_id = sync_log.start_run("setters", None)
    try:
        result = setters.run_sync()
    except Exception as exc:  # e.g. token minting failed before either fetch
        logger.exception("Setter sync failed")
        sync_log.finish_run(run_id, "error", error=str(exc))
        raise
    rows = result["appointments"] + result["daily_rows"]
    if not result["errors"]:
        sync_log.finish_run(run_id, "success", rows_upserted=rows)
    elif len(result["errors"]) == 1:
        sync_log.finish_run(run_id, "partial", rows_upserted=rows, error="; ".join(result["errors"]))
    else:
        sync_log.finish_run(run_id, "error", error="; ".join(result["errors"]))
    return result


# ---------------------------------------------------------------- Backfill

@celery.task(name="app.tasks.sync.backfill")
def backfill(client_slug: str, source: str, days: int = 365) -> dict:
    """Manual backfill for one client + source. Capped at 12 months
    (Meta's API applies a 13-month history limit to some fields)."""
    rows = pg.query(
        """
        select c.*, s.ghl_token from clients c
        left join client_secrets s on s.client_id = c.id
        where c.slug = %s
        """,
        (client_slug,),
    )
    if not rows:
        return {"error": f"unknown client slug: {client_slug}"}
    client = rows[0]

    if source == "meta":
        if not client["meta_ad_account_id"]:
            return {"error": "client has no meta_ad_account_id"}
        _sync_meta_client(client, days)
    elif source == "google":
        if not client["google_ads_customer_id"] and not client.get("google_lsa_customer_id"):
            return {"error": "client has no google_ads_customer_id"}
        if client["google_ads_customer_id"]:
            _sync_google_client(client, days)
        if client.get("google_lsa_customer_id"):
            _sync_google_client(client, days, lsa=True)
    elif source == "ghl":
        if not client["ghl_location_id"]:
            return {"error": "client has no ghl_location_id"}
        _sync_ghl_client(client, days)
    else:
        return {"error": f"unknown source: {source}"}
    return {"client": client_slug, "source": source, "days": days}

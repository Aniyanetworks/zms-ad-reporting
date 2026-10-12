"""Celery application for ZMS Ads Intelligence background jobs."""
import logging

from celery import Celery
from celery.schedules import crontab
from celery.signals import after_setup_logger, after_setup_task_logger

from app.core.config import get_settings
from app.core.logging import JsonFormatter

settings = get_settings()


@after_setup_logger.connect
@after_setup_task_logger.connect
def _json_logs(logger: logging.Logger, **_kwargs) -> None:
    """Structured JSON lines for worker/beat, same shape as the API."""
    for h in logger.handlers:
        h.setFormatter(JsonFormatter("worker"))
    # httpx logs full request URLs at INFO — Graph API URLs carry the access token.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

celery = Celery(
    "zms_ads",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=["app.tasks.sync", "app.tasks.builds", "app.tasks.tracking"],
)

celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="America/Los_Angeles",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    result_expires=86400 * 7,
    # Graceful shutdown: SIGTERM lets running tasks finish (compose
    # stop_grace_period); nothing is re-queued twice thanks to acks_late.
    worker_cancel_long_running_tasks_on_connection_loss=True,
    broker_connection_retry_on_startup=True,
    worker_hijack_root_logger=False,
)

celery.conf.beat_schedule = {
    # Main daily resync at 1 AM PT (Carl, 2026-09-10): yesterday is complete in
    # every client's account timezone by then, and the sheet is fresh before anyone
    # is up. Meta gets a second pass at 6 AM to pick up late-attributed leads.
    "sync-meta-all-daily": {
        "task": "app.tasks.sync.sync_meta_all",
        "schedule": crontab(hour=1, minute=0),  # 1:00 AM PT
    },
    "sync-google-all-daily": {
        "task": "app.tasks.sync.sync_google_all",
        "schedule": crontab(hour=1, minute=15),  # 1:15 AM PT
    },
    "sync-ghl-all-daily": {
        "task": "app.tasks.sync.sync_ghl_all",
        "schedule": crontab(hour=1, minute=30),  # 1:30 AM PT
    },
    "sync-booking-sheets-daily": {
        "task": "app.tasks.sync.sync_booking_sheets",
        "schedule": crontab(hour=1, minute=45),  # 1:45 AM PT, after GHL
    },
    "integration-health": {
        "task": "app.tasks.sync.integration_health",
        "schedule": crontab(hour=2, minute=5),  # 2:05 AM PT, after syncs, before the brief
    },
    "daily-brief": {
        "task": "app.tasks.sync.daily_brief",
        "schedule": crontab(hour=2, minute=15),  # 2:15 AM PT, after all syncs + booking sheets
    },
    "export-sheets-daily": {
        "task": "app.tasks.sync.export_sheets",
        "schedule": crontab(hour=2, minute=0),  # 2:00 AM PT, after all syncs
    },
    "sync-meta-all-refresh": {
        "task": "app.tasks.sync.sync_meta_all",
        "schedule": crontab(hour=6, minute=0),  # 6:00 AM PT second pass
    },
    # Daily Slack report (Carl, 2026-09-28): leads + booked per client for yesterday / 7d /
    # 30d and the SOP "what to improve" list. Replaces the old health-alert post — the
    # report includes the red integrations.
    "slack-daily-report": {
        "task": "app.tasks.sync.slack_daily_report",
        "schedule": crontab(hour=5, minute=0),  # 5:00 AM PT (Carl, 2026-09-28) — after syncs (1:00–1:45) and the brief (2:15)
    },
    # Setter leaderboard: near-real-time read-only poll of the two setter sheets
    # (SETTER_SYNC_INTERVAL_SECONDS, default 60). Two Sheets reads + one Drive
    # download per run — well inside Google's per-minute quotas.
    "sync-setters": {
        "task": "app.tasks.sync.sync_setters",
        "schedule": float(settings.setter_sync_interval_seconds),
        "options": {"expires": settings.setter_sync_interval_seconds},
    },
}

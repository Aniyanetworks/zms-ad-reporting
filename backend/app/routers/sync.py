"""Sync status + manual trigger (admin only)."""
from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core import audit
from app.core.db import fetch
from app.core.ratelimit import LIMIT_MUTATION, limiter
from app.core.security import AdminUser, CurrentUser

router = APIRouter(tags=["sync"])

STATUS_SQL = """
select distinct on (source, client_id)
    s.id, s.source, s.client_id, c.name as client_name, c.slug as client_slug,
    s.status, s.rows_upserted, s.error, s.started_at, s.finished_at
from sync_runs s
left join clients c on c.id = s.client_id
order by source, client_id, started_at desc
"""

LAST_PER_SOURCE_SQL = """
select distinct on (source)
    source, status, started_at, finished_at
from sync_runs
order by source, started_at desc
"""


class TriggerBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(pattern="^(meta|google|ghl|setters)$")
    client_slug: str | None = Field(default=None, max_length=100, pattern=r"^[a-z0-9-]+$")  # omit = all clients
    days: int | None = Field(default=None, ge=1, le=365)


@router.get("/sync/status")
async def sync_status(user: CurrentUser) -> dict:
    runs = await fetch(STATUS_SQL)
    last = await fetch(LAST_PER_SOURCE_SQL)
    return {
        "last_per_source": [dict(r) for r in last],
        "latest_runs": [dict(r) for r in runs],
    }


@router.post("/sync/trigger", status_code=202)
@limiter.limit(LIMIT_MUTATION)
async def trigger_sync(request: Request, body: TriggerBody, user: AdminUser) -> dict:
    # Import here so the API process doesn't need broker connectivity at startup
    from app.tasks.sync import backfill, sync_ghl_all, sync_google_all, sync_meta_all, sync_setters

    if body.source == "setters":
        task = sync_setters.delay()
    elif body.client_slug:
        task = backfill.delay(body.client_slug, body.source, days=body.days or 28)
    else:
        task_map = {"meta": sync_meta_all, "google": sync_google_all, "ghl": sync_ghl_all}
        task_fn = task_map[body.source]
        task = task_fn.delay(days=body.days) if body.days else task_fn.delay()
    await audit.record(
        action="sync.trigger", actor=user, entity_type="sync", entity_id=task.id,
        after=body.model_dump(), request=request,
    )
    return {"task_id": task.id, "source": body.source, "client_slug": body.client_slug}

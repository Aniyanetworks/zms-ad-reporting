"""Daily Brief — read the nightly briefs; admins can (re)run one on demand."""
import asyncio
from datetime import date

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.core.db import fetch
from app.core.security import AdminUser, CurrentUser
from app.services import brief as B

router = APIRouter(tags=["brief"])


class RunIn(BaseModel):
    as_of: date | None = None  # last complete day of the 7-day window; default yesterday


@router.get("/brief/dates")
async def brief_dates(user: CurrentUser) -> list[str]:
    rows = await fetch("select distinct brief_date from daily_briefs order by brief_date desc limit 30")
    return [r["brief_date"].isoformat() for r in rows]


@router.get("/brief")
async def get_brief(user: CurrentUser, date_: date | None = Query(default=None, alias="date")) -> dict:
    if date_ is None:
        latest = await fetch("select max(brief_date) d from daily_briefs")
        date_ = latest[0]["d"] if latest and latest[0]["d"] else None
    if date_ is None:
        return {"date": None, "clients": []}
    rows = await fetch(
        """
        select b.*, c.slug, c.name, c.booking_system
        from daily_briefs b join clients c on c.id = b.client_id
        where b.brief_date = $1
        order by case b.score when 'red' then 0 when 'yellow' then 1 else 2 end, c.name
        """,
        date_,
    )
    out = []
    for r in rows:
        d = dict(r)
        for k in ("brief_date", "window_start", "window_end", "created_at"):
            d[k] = d[k].isoformat()
        d["client_id"] = str(d["client_id"])
        out.append(d)
    return {"date": date_.isoformat(), "clients": out}


@router.post("/brief/run")
async def run_brief(body: RunIn, user: AdminUser) -> dict:
    return await asyncio.to_thread(B.run_daily_brief, body.as_of)

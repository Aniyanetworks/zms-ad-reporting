"""Today board + per-client plays + creative health — the dashboard side of the daily
Slack report (same builder, so the page and the post always agree)."""
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool

from app.core.db import fetchrow
from app.core.security import CurrentUser

router = APIRouter(tags=["today"])


def _jsonable(v):
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    if isinstance(v, date):
        return v.isoformat()
    return v


@router.get("/today")
async def today(user: CurrentUser, as_of: date | None = Query(default=None)) -> dict:
    from app.services import slack_report
    return _jsonable(await run_in_threadpool(slack_report.build_cards, as_of))


@router.get("/clients/{slug}/plays")
async def client_plays(slug: str, user: CurrentUser) -> dict:
    from app.services import slack_report
    data = await run_in_threadpool(slack_report.build_cards, None)
    card = next((c for c in data["clients"] if c["slug"] == slug), None)
    return _jsonable({"date": data["date"], "brief_date": data["brief_date"], "legend": data["legend"], "card": card})


@router.get("/clients/{slug}/creative-health")
async def creative_health(slug: str, user: CurrentUser, end: date | None = Query(default=None)) -> dict:
    from app.services import creative_diag
    client = await fetchrow("select id from clients where slug = $1", slug)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    end = end or (date.today() - timedelta(days=1))
    r = await run_in_threadpool(creative_diag.analyze, str(client["id"]), end)
    return _jsonable({"end": end, "window_days": 7, "ft_median": r["ft_median"], "ads": r["ads"], "signals": r["signals"],
                      "benchmarks": {"hook_low": creative_diag.HOOK_LOW, "hook_border": creative_diag.HOOK_BORDER,
                                     "hold_low": creative_diag.HOLD_LOW, "hold_high": creative_diag.HOLD_HIGH,
                                     "ctr_low": creative_diag.CTR_LOW, "cpc_warn": creative_diag.CPC_WARN,
                                     "lpv_low": creative_diag.LPV_LOW, "ft_low": creative_diag.FT_ABS_LOW}})

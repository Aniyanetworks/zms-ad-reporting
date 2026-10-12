"""Health endpoints.

/api/health/live  — process is up (used by the container HEALTHCHECK; no I/O).
/api/health       — deep check: Postgres, Redis, last successful sync per source.
                    200 when db+redis are fine (status ok|degraded), 503 otherwise.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Response

from app.core.config import get_settings
from app.core.db import fetch, fetchrow

router = APIRouter(tags=["health"])
logger = logging.getLogger(__name__)

SYNC_SOURCES = ("meta", "google", "ghl")


async def check_db() -> dict:
    try:
        row = await asyncio.wait_for(fetchrow("select 1 as ok"), timeout=3)
        return {"ok": bool(row and row["ok"] == 1)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": type(exc).__name__}


async def check_redis() -> dict:
    try:
        import redis.asyncio as aioredis

        client = aioredis.from_url(get_settings().redis_url, socket_connect_timeout=2, socket_timeout=2)
        try:
            pong = await asyncio.wait_for(client.ping(), timeout=3)
        finally:
            await client.aclose()
        return {"ok": bool(pong)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": type(exc).__name__}


async def check_syncs() -> dict:
    stale_after = timedelta(hours=get_settings().health_sync_stale_hours)
    now = datetime.now(UTC)
    out: dict[str, dict] = {s: {"ok": False, "last_success": None} for s in SYNC_SOURCES}
    try:
        rows = await asyncio.wait_for(
            fetch(
                """
                select source, max(finished_at) as last_success
                from sync_runs where status = 'success' and source = any($1::text[])
                group by source
                """,
                list(SYNC_SOURCES),
            ),
            timeout=3,
        )
        for r in rows:
            ts = r["last_success"]
            out[r["source"]] = {
                "ok": ts is not None and (now - ts) <= stale_after,
                "last_success": ts.isoformat() if ts else None,
            }
    except Exception as exc:  # noqa: BLE001
        for s in SYNC_SOURCES:
            out[s]["error"] = type(exc).__name__
    return out


@router.get("/health/live")
async def live() -> dict:
    return {"status": "ok"}


@router.get("/health")
async def health(response: Response) -> dict:
    settings = get_settings()
    db, rds, syncs = await asyncio.gather(check_db(), check_redis(), check_syncs())
    critical_ok = db["ok"] and rds["ok"]
    syncs_ok = all(v["ok"] for v in syncs.values())
    status = "ok" if critical_ok and syncs_ok else ("degraded" if critical_ok else "unhealthy")
    response.status_code = 200 if critical_ok else 503
    response.headers["Cache-Control"] = "no-store"
    return {
        "status": status,
        "service": "api",
        "environment": settings.environment,
        "version": settings.git_sha or "dev",
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "checks": {"db": db, "redis": rds, "syncs": syncs},
    }

"""Integration health matrix — read for everyone, re-run for admins."""
import asyncio

from fastapi import APIRouter

from app.core.db import fetch
from app.core.security import AdminUser, CurrentUser
from app.services import integrations as I
from app.services import tracking as T

router = APIRouter(tags=["integrations"])

RANK = {"red": 0, "yellow": 1, "green": 2, "grey": 3}


@router.get("/integrations")
async def get_integrations(user: CurrentUser) -> dict:
    rows = await fetch(
        """select h.client_id, c.slug, c.name, c.booking_system, h.check_key, h.status, h.detail, h.checked_at
           from integration_health h join clients c on c.id = h.client_id
           where c.is_active order by c.name"""
    )
    clients: dict[str, dict] = {}
    checked_at = None
    for r in rows:
        cid = str(r["client_id"])
        c = clients.setdefault(cid, {"client_id": cid, "slug": r["slug"], "name": r["name"], "booking_system": r["booking_system"], "checks": {}})
        c["checks"][r["check_key"]] = {"status": r["status"], "detail": r["detail"]}
        checked_at = max(checked_at, r["checked_at"]) if checked_at else r["checked_at"]
    out = []
    for c in clients.values():
        statuses = [v["status"] for v in c["checks"].values() if v["status"] != "grey"]
        c["overall"] = "red" if "red" in statuses else "yellow" if "yellow" in statuses else "green" if statuses else "grey"
        out.append(c)
    out.sort(key=lambda c: (RANK[c["overall"]], c["name"]))
    return {
        "checked_at": checked_at.isoformat() if checked_at else None,
        "checks": [{"key": k, "label": label, "group": g} for k, label, g in I.CHECKS],
        "clients": out,
    }


@router.post("/integrations/run")
async def run_integrations(user: AdminUser) -> dict:
    return await asyncio.to_thread(I.run_health_checks)


@router.post("/integrations/propose-tracking")
async def propose_tracking(user: AdminUser) -> dict:
    """Write proposed recommendations for missing UTMs, missing pixels and missing /
    non-standard Conversions API events across all Meta clients (Actions queue)."""
    return await asyncio.to_thread(T.propose_tracking_fixes)

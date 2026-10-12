"""Service × platform CPL/CPBA targets: read for everyone, edit for admins."""
import asyncio

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.core.security import AdminUser, CurrentUser
from app.services import targets as T

router = APIRouter(tags=["service-targets"])


class TargetIn(BaseModel):
    service: str = Field(min_length=1, max_length=80)
    platform: str = Field(pattern="^(all|meta|google)$")
    cpl_green: float | None = Field(default=None, ge=0)
    cpl_red: float | None = Field(default=None, ge=0)
    cpba_green: float | None = Field(default=None, ge=0)
    cpba_red: float | None = Field(default=None, ge=0)


def _ser(d: dict) -> dict:
    return {k: (float(v) if k in ("cpl_green", "cpl_red", "cpba_green", "cpba_red") and v is not None
                else v.isoformat() if hasattr(v, "isoformat") else v) for k, v in d.items()}


@router.get("/service-targets")
async def list_targets(user: CurrentUser) -> list[dict]:
    """Every service×platform seen in the last 90 days, with actuals next to its target (if any)."""
    tg = await load()
    actuals = await asyncio.to_thread(T.portfolio_actuals, 90)
    seen = set()
    out = []
    for a in sorted(actuals, key=lambda x: -x["spend"]):
        key = (a["service"], a["platform"])
        seen.add(key)
        out.append({**a, "target": _ser(tg[key]) if key in tg else None,
                    "fallback": _ser(tg[(a["service"], "all")]) if key not in tg and (a["service"], "all") in tg else None})
    for key, t in tg.items():  # targets with no recent traffic still show, so they can be edited/removed
        if key not in seen:
            out.append({"service": key[0], "platform": key[1], "clients": 0, "spend": 0, "leads": 0,
                        "appointments": 0, "cpl": None, "cpba": None, "target": _ser(t), "fallback": None})
    return out


async def load():
    return await T.load_targets()


@router.put("/service-targets")
async def put_target(body: TargetIn, user: AdminUser) -> dict:
    row = await T.upsert_manual(body.service, body.platform, body.model_dump(exclude={"service", "platform"}),
                                user.get("email") or user["id"])
    return _ser(row)


@router.delete("/service-targets/{service}/{platform}", status_code=204)
async def delete_target(service: str, platform: str, user: AdminUser) -> None:
    await T.delete_target(service, platform)


@router.post("/service-targets/reseed")
async def reseed(user: AdminUser) -> dict:
    """Fill targets for service×platform pairs that have none yet. Manual rows are never touched."""
    n = await asyncio.to_thread(T.seed_missing)
    return {"seeded": n}

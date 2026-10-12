"""Client registry — list for all authenticated users, CRUD for admins (settings page)."""
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core import audit
from app.core.db import fetch, fetchrow
from app.core.ratelimit import LIMIT_MUTATION, limiter
from app.core.security import AdminUser, CurrentUser

router = APIRouter(tags=["clients"])

CLIENT_COLUMNS = """
    c.id, c.name, c.slug, c.meta_ad_account_id, c.google_ads_customer_id, c.google_lsa_customer_id, c.ghl_location_id,
    c.avg_job_value, c.close_rate, c.gross_margin_pct, c.max_ad_cost_share, c.setter_fee_per_appt, c.default_service, c.trade, c.booking_system,
    c.meta_campaign_filter, c.meta_pixel_id, c.cpl_target_green, c.cpl_target_red, c.is_active, c.created_at
"""


class ClientIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=500)

    name: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9-]+$")
    meta_ad_account_id: str | None = Field(default=None, max_length=40, pattern=r"^(act_)?\d*$")
    google_ads_customer_id: str | None = Field(default=None, max_length=20)
    google_lsa_customer_id: str | None = None
    avg_job_value: float | None = None
    close_rate: float | None = None
    gross_margin_pct: float | None = None
    max_ad_cost_share: float | None = None
    setter_fee_per_appt: float | None = None  # what Zeal earns per setter-booked appointment
    ghl_location_id: str | None = Field(default=None, max_length=60)
    ghl_token: str | None = Field(default=None, max_length=500)  # stored in client_secrets (service-role only)
    meta_campaign_filter: str | None = Field(default=None, max_length=200)  # ILIKE pattern for shared ad accounts
    meta_pixel_id: str | None = Field(default=None, max_length=40, pattern=r"^\d*$")  # preferred pixel/dataset
    cpl_target_green: float = 75
    cpl_target_red: float = 150
    is_active: bool = True


class ClientUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=500)

    name: str | None = Field(default=None, min_length=1, max_length=200)
    meta_ad_account_id: str | None = Field(default=None, max_length=40, pattern=r"^(act_)?\d*$")
    google_ads_customer_id: str | None = Field(default=None, max_length=20)
    google_lsa_customer_id: str | None = None
    avg_job_value: float | None = None
    close_rate: float | None = None
    gross_margin_pct: float | None = None
    max_ad_cost_share: float | None = None
    setter_fee_per_appt: float | None = None
    ghl_location_id: str | None = Field(default=None, max_length=60)
    ghl_token: str | None = Field(default=None, max_length=500)  # write-only; stored in client_secrets
    meta_campaign_filter: str | None = Field(default=None, max_length=200)
    meta_pixel_id: str | None = Field(default=None, max_length=40, pattern=r"^\d*$")
    cpl_target_green: float | None = None
    cpl_target_red: float | None = None
    is_active: bool | None = None


def _normalize(data: dict) -> dict:
    # Google Ads customer IDs are stored digits-only
    for k in ("google_ads_customer_id", "google_lsa_customer_id"):
        if data.get(k):
            data[k] = re.sub(r"\D", "", data[k])
    return data


@router.get("/clients")
async def list_clients(user: CurrentUser) -> list[dict]:
    rows = await fetch(
        f"""
        select {CLIENT_COLUMNS}, (s.ghl_token is not null) as has_ghl_token
        from clients c left join client_secrets s on s.client_id = c.id
        order by name
        """
    )
    return [dict(r) for r in rows]


@router.post("/clients", status_code=201)
@limiter.limit(LIMIT_MUTATION)
async def create_client(request: Request, body: ClientIn, user: AdminUser) -> dict:
    data = _normalize(body.model_dump())
    ghl_token = data.pop("ghl_token", None)
    row = await fetchrow(
        f"""
        insert into clients as c (name, slug, meta_ad_account_id, google_ads_customer_id,
                             ghl_location_id, meta_campaign_filter, cpl_target_green, cpl_target_red, is_active,
                             google_lsa_customer_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning {CLIENT_COLUMNS}
        """,
        data["name"], data["slug"], data["meta_ad_account_id"], data["google_ads_customer_id"],
        data["ghl_location_id"], data["meta_campaign_filter"], data["cpl_target_green"], data["cpl_target_red"], data["is_active"],
        data.get("google_lsa_customer_id"),
    )
    if ghl_token:
        await _upsert_ghl_token(str(row["id"]), ghl_token)
    result = dict(row)
    result["has_ghl_token"] = bool(ghl_token)
    await audit.record(
        action="client.create", actor=user, entity_type="client", entity_id=row["id"], client_id=str(row["id"]),
        after={**result, "ghl_token": ghl_token}, request=request,  # redacted by audit.record
    )
    return result


@router.patch("/clients/{client_id}")
@limiter.limit(LIMIT_MUTATION)
async def update_client(request: Request, client_id: str, body: ClientUpdate, user: AdminUser) -> dict:
    before = await fetchrow(f"select {CLIENT_COLUMNS} from clients c where c.id = $1", client_id)
    if before is None:
        raise HTTPException(status_code=404, detail="Client not found")
    data = _normalize(body.model_dump(exclude_unset=True))
    ghl_token = data.pop("ghl_token", None)
    if not data and not ghl_token:
        raise HTTPException(status_code=400, detail="No fields to update")
    if data:
        sets = ", ".join(f"{col} = ${i + 2}" for i, col in enumerate(data))
        row = await fetchrow(
            f"update clients c set {sets} where id = $1 returning {CLIENT_COLUMNS}",
            client_id, *data.values(),
        )
    else:
        row = await fetchrow(f"select {CLIENT_COLUMNS} from clients c where c.id = $1", client_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Client not found")
    if ghl_token:
        await _upsert_ghl_token(client_id, ghl_token)
    token_row = await fetchrow("select 1 from client_secrets where client_id = $1 and ghl_token is not null", client_id)
    result = dict(row)
    result["has_ghl_token"] = token_row is not None
    await audit.record(
        action="client.update", actor=user, entity_type="client", entity_id=client_id, client_id=client_id,
        before=dict(before), after={**data, **({"ghl_token": ghl_token} if ghl_token else {})}, request=request,
    )
    return result


async def _upsert_ghl_token(client_id: str, token: str) -> None:
    from app.core.db import execute

    await execute(
        """
        insert into client_secrets (client_id, ghl_token) values ($1, $2)
        on conflict (client_id) do update set ghl_token = excluded.ghl_token, updated_at = now()
        """,
        client_id, token,
    )

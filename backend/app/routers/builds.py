"""Campaign Builder API — drafts, creatives, chat (SSE), validation, approval.

Roles: admin and media_buyer create/edit/chat; approval is role- and
budget-gated (guards.approver_max_daily_cents); viewer reads only.
Objects are created PAUSED by the Celery executor after approval; nothing here
talks to Meta except reads (account context, geo search, collision checks).
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.core import audit, policy
from app.core.db import execute, fetch, fetchrow
from app.core.ratelimit import LIMIT_MUTATION, limiter
from app.core.security import CurrentUser
from app.services.builder import chat, guards, meta_graph, storage
from app.services.builder.schema import Brief, GeoTarget, Plan

router = APIRouter(prefix="/builds", tags=["builds"])

EDITABLE = ("draft", "planned", "failed")


class BuildIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_slug: str = Field(max_length=100, pattern=r"^[a-z0-9-]+$")
    platform: str = Field(default="meta", pattern=r"^meta$")
    title: str | None = Field(default=None, max_length=200)


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=8000)


def _ser(v: Any) -> Any:
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def _row(r) -> dict:
    return {k: _ser(v) for k, v in dict(r).items()}


def _require_builder(user: dict) -> None:
    if not policy.can_create_build(user["role"]):
        raise HTTPException(status_code=403, detail="Your role cannot create or edit builds")


async def _asset_rows(build_id: str, with_urls: bool = True) -> list[dict]:
    rows = [_row(r) for r in await fetch("select * from campaign_build_assets where build_id = $1::uuid order by created_at", build_id)]
    if with_urls:
        for a in rows:
            a["url"] = await storage.signed_url(a["storage_path"])
    return rows


async def _load(build_id: str, user: dict | None = None) -> dict:
    try:
        uuid.UUID(build_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Build not found") from None
    r = await fetchrow(
        """
        select b.*, c.slug as client_slug, c.name as client_name, c.meta_ad_account_id, c.meta_campaign_filter
        from campaign_builds b join clients c on c.id = b.client_id where b.id = $1::uuid
        """,
        build_id,
    )
    if r is None:
        raise HTTPException(status_code=404, detail="Build not found")
    return _row(r)


async def _full(build_id: str) -> dict:
    b = await _load(build_id)
    b["assets"] = await _asset_rows(build_id)
    b.pop("meta_ad_account_id", None)
    return b


async def _client_row(client_id: str) -> dict:
    return _row(await fetchrow("select * from clients where id = $1::uuid", client_id))


# ---------------------------------------------------------------- CRUD

@router.get("")
async def list_builds(user: CurrentUser, client_slug: str | None = None, status: str | None = None) -> list[dict]:
    rows = await fetch(
        """
        select b.id, b.client_id, c.slug as client_slug, c.name as client_name, b.platform, b.title, b.status,
               b.plan_version, b.plan->'campaign'->>'name' as campaign_name,
               (b.plan->'campaign'->>'daily_budget_cents')::int as daily_budget_cents,
               b.created_by_email, b.approved_by_email, b.approved_at, b.created_at, b.updated_at,
               (select count(*) from campaign_build_assets a where a.build_id = b.id) as asset_count
        from campaign_builds b join clients c on c.id = b.client_id
        where ($1::text is null or c.slug = $1) and ($2::text is null or b.status = $2)
        order by b.updated_at desc limit 200
        """,
        client_slug, status,
    )
    return [_row(r) for r in rows]


@router.post("", status_code=201)
@limiter.limit(LIMIT_MUTATION)
async def create_build(request: Request, body: BuildIn, user: CurrentUser) -> dict:
    _require_builder(user)
    client = await fetchrow("select * from clients where slug = $1 and is_active", body.client_slug)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    if not client["meta_ad_account_id"]:
        raise HTTPException(status_code=422, detail="Client has no Meta ad account configured")
    try:
        ctx = await meta_graph.account_context(client["meta_ad_account_id"], preferred_pixel=client.get("meta_pixel_id"))
    except meta_graph.GraphError as e:
        raise HTTPException(status_code=502, detail=f"Meta API: {e}") from e
    brief = Brief(service=client.get("default_service")).model_dump(exclude_none=True)
    row = await fetchrow(
        """
        insert into campaign_builds (client_id, platform, title, brief, account_context, created_by, created_by_email)
        values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::uuid, $7) returning id
        """,
        client["id"], body.platform, body.title, json.dumps(brief), json.dumps(ctx), user["id"], user.get("email"),
    )
    await audit.record(action="campaign_build.create", actor=user, entity_type="campaign_build", entity_id=row["id"],
                       client_id=str(client["id"]), after={"platform": body.platform, "title": body.title}, request=request)
    return await _full(str(row["id"]))


@router.get("/{build_id}")
async def get_build(build_id: str, user: CurrentUser) -> dict:
    return await _full(build_id)


@router.delete("/{build_id}")
@limiter.limit(LIMIT_MUTATION)
async def cancel_build(request: Request, build_id: str, user: CurrentUser) -> dict:
    _require_builder(user)
    b = await _load(build_id)
    if b["status"] not in (*EDITABLE, "cancelled"):
        raise HTTPException(status_code=409, detail=f"Cannot cancel a build in status {b['status']}")
    await execute("update campaign_builds set status = 'cancelled' where id = $1::uuid", build_id)
    await audit.record(action="campaign_build.cancel", actor=user, entity_type="campaign_build", entity_id=build_id,
                       client_id=b["client_id"], before={"status": b["status"]}, request=request)
    return await _full(build_id)


@router.patch("/{build_id}/brief")
@limiter.limit("120/minute")
async def patch_brief(request: Request, build_id: str, body: dict, user: CurrentUser) -> dict:
    _require_builder(user)
    b = await _load(build_id)
    if b["status"] not in EDITABLE:
        raise HTTPException(status_code=409, detail=f"Build is {b['status']}; the brief is locked")
    merged = {**(b.get("brief") or {}), **body}
    try:
        brief = Brief.model_validate(merged)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=str(e)[:2000]) from None
    await execute("update campaign_builds set brief = $2::jsonb where id = $1::uuid", build_id, brief.model_dump_json(exclude_none=True))
    return await _full(build_id)


@router.get("/{build_id}/geo")
async def geo_search(build_id: str, user: CurrentUser, q: str = "") -> list[dict]:
    await _load(build_id)
    q = q.strip()
    if len(q) < 2:
        return []
    try:
        return [GeoTarget.model_validate(g).model_dump() for g in await meta_graph.search_geo(q[:80])]
    except meta_graph.GraphError as e:
        raise HTTPException(status_code=502, detail=f"Meta API: {e}") from e


# ---------------------------------------------------------------- assets

@router.post("/{build_id}/assets")
@limiter.limit("60/minute")
async def upload_assets(request: Request, build_id: str, user: CurrentUser, files: list[UploadFile] = File(...)) -> list[dict]:
    _require_builder(user)
    b = await _load(build_id)
    if b["status"] not in EDITABLE:
        raise HTTPException(status_code=409, detail=f"Build is {b['status']}; creatives are locked")
    if len(files) > 20:
        raise HTTPException(status_code=413, detail="At most 20 files per upload")
    for f in files:
        ctype = (f.content_type or "").lower()
        if ctype in storage.IMAGE_TYPES:
            kind, ext, limit = "image", storage.IMAGE_TYPES[ctype], storage.MAX_IMAGE_BYTES
        elif ctype in storage.VIDEO_TYPES:
            kind, ext, limit = "video", storage.VIDEO_TYPES[ctype], storage.MAX_VIDEO_BYTES
        else:
            raise HTTPException(status_code=415, detail=f"Unsupported type {ctype or 'unknown'} ({f.filename}); use JPG/PNG/WebP or MP4/MOV")
        data = await f.read()
        if len(data) > limit:
            raise HTTPException(status_code=413, detail=f"{f.filename} is larger than {limit // (1024*1024)} MB")
        if not data:
            raise HTTPException(status_code=422, detail=f"{f.filename} is empty")
        width = height = None
        if kind == "image":
            try:
                import io

                from PIL import Image

                with Image.open(io.BytesIO(data)) as im:
                    width, height = im.size
            except Exception:  # noqa: BLE001
                raise HTTPException(status_code=422, detail=f"{f.filename} is not a readable image") from None
        asset_id = str(uuid.uuid4())
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", f.filename or f"upload.{ext}")[:120]
        path = f"{build_id}/{asset_id}.{ext}"
        await storage.upload(path, ctype, data)
        await execute(
            """
            insert into campaign_build_assets (id, build_id, kind, filename, content_type, size_bytes, width, height, storage_bucket, storage_path)
            values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
            """,
            asset_id, build_id, kind, safe_name, ctype, len(data), width, height, storage.BUCKET, path,
        )
    await audit.record(action="campaign_build.assets_upload", actor=user, entity_type="campaign_build", entity_id=build_id,
                       client_id=b["client_id"], after={"files": [f.filename for f in files]}, request=request)
    return await _asset_rows(build_id)


@router.delete("/{build_id}/assets/{asset_id}")
@limiter.limit(LIMIT_MUTATION)
async def delete_asset(request: Request, build_id: str, asset_id: str, user: CurrentUser) -> list[dict]:
    _require_builder(user)
    b = await _load(build_id)
    if b["status"] not in EDITABLE:
        raise HTTPException(status_code=409, detail=f"Build is {b['status']}; creatives are locked")
    a = await fetchrow("delete from campaign_build_assets where id = $1::uuid and build_id = $2::uuid returning storage_path", asset_id, build_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    await storage.delete(a["storage_path"])
    return await _asset_rows(build_id)


# ---------------------------------------------------------------- chat

@router.get("/{build_id}/messages")
async def list_messages(build_id: str, user: CurrentUser) -> list[dict]:
    await _load(build_id)
    rows = await fetch(
        "select id, role, text, tool_name, tool_status, plan_version, created_at from campaign_build_messages where build_id = $1::uuid order by id",
        build_id,
    )
    return [_row(r) for r in rows if r["text"] or r["role"] == "tool"]


@router.post("/{build_id}/messages")
@limiter.limit("30/minute")
async def post_message(request: Request, build_id: str, body: MessageIn, user: CurrentUser) -> StreamingResponse:
    _require_builder(user)
    b = await _load(build_id)
    if b["status"] in ("approved", "creating"):
        raise HTTPException(status_code=409, detail=f"Build is {b['status']}; wait for it to finish")
    client = await _client_row(b["client_id"])
    assets = await _asset_rows(build_id, with_urls=False)

    async def gen():
        def sse(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"

        try:
            async for event, data in chat.run_turn(b, client, assets, body.content, user):
                yield sse(event, data)
            yield sse("done", {"build": await _full(build_id)})
        except Exception as e:  # noqa: BLE001
            yield sse("error", {"message": f"{type(e).__name__}: {e}"})

    await audit.record(action="campaign_build.message", actor=user, entity_type="campaign_build", entity_id=build_id,
                       client_id=b["client_id"], after={"chars": len(body.content)}, request=request)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- plan / validation / approval

async def _validate(b: dict, user_role: str | None = None, live: bool = False) -> dict:
    plan = Plan.model_validate(b["plan"])
    ctx = b.get("account_context") or {}
    if live:
        client = await _client_row(b["client_id"])
        ctx = await meta_graph.account_context(b["meta_ad_account_id"], preferred_pixel=client.get("meta_pixel_id"))
        await execute("update campaign_builds set account_context = $2::jsonb where id = $1::uuid", b["id"], json.dumps(ctx))
    assets = {str(a["id"]) for a in await _asset_rows(b["id"], with_urls=False)}
    v = guards.validate_plan(
        plan, asset_ids=assets,
        existing_campaign_names=set(ctx.get("existing_campaign_names", [])),
        existing_adset_names=set(ctx.get("existing_adset_names", [])),
        campaign_filter=b.get("meta_campaign_filter"),
        known_lead_forms={f["id"] for f in ctx.get("lead_forms", [])},
        max_daily_cents_for_approver=guards.approver_max_daily_cents(user_role) if user_role else None,
    )
    return v.model_dump()


@router.put("/{build_id}/plan")
@limiter.limit(LIMIT_MUTATION)
async def put_plan(request: Request, build_id: str, body: dict, user: CurrentUser) -> dict:
    _require_builder(user)
    b = await _load(build_id)
    if b["status"] not in EDITABLE:
        raise HTTPException(status_code=409, detail=f"Build is {b['status']}; the plan is locked")
    try:
        plan = Plan.model_validate(body)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail={"ok": False, "problems": [{"level": "error", "code": "schema", "message": str(e)[:2000]}]}) from None
    plan.version = int(b.get("plan_version") or 0) + 1
    b["plan"] = plan.model_dump()
    v = await _validate(b)
    if not v["ok"]:
        raise HTTPException(status_code=422, detail=v)
    await execute(
        """
        update campaign_builds set plan = $2::jsonb, plan_version = $3, validation = $4::jsonb,
               status = case when status in ('draft','planned','failed') then 'planned' else status end
        where id = $1::uuid
        """,
        build_id, plan.model_dump_json(), plan.version, json.dumps(v),
    )
    await audit.record(action="campaign_build.plan_edit", actor=user, entity_type="campaign_build", entity_id=build_id,
                       client_id=b["client_id"], after={"plan_version": plan.version}, request=request)
    return await _full(build_id)


@router.post("/{build_id}/validate")
@limiter.limit(LIMIT_MUTATION)
async def validate_build(request: Request, build_id: str, user: CurrentUser) -> dict:
    b = await _load(build_id)
    if not b.get("plan"):
        raise HTTPException(status_code=409, detail="No plan to validate yet")
    try:
        v = await _validate(b, live=True)
    except meta_graph.GraphError as e:
        raise HTTPException(status_code=502, detail=f"Meta API: {e}") from e
    # A failed build returns to planning once its plan validates again ("Back to planning").
    await execute(
        """
        update campaign_builds set validation = $2::jsonb,
               status = case when status = 'failed' and $3::bool then 'planned' else status end
        where id = $1::uuid
        """,
        build_id, json.dumps(v), bool(v["ok"]),
    )
    return await _full(build_id)


@router.post("/{build_id}/approve", status_code=202)
@limiter.limit(LIMIT_MUTATION)
async def approve_build(request: Request, build_id: str, user: CurrentUser) -> dict:
    b = await _load(build_id)
    if b["status"] != "planned" or not b.get("plan"):
        raise HTTPException(status_code=409, detail=f"Only a planned build can be approved (status {b['status']})")
    cap = guards.approver_max_daily_cents(user["role"])
    if cap == 0:
        raise HTTPException(status_code=403, detail="Your role cannot approve builds")
    budget = int(b["plan"]["campaign"]["daily_budget_cents"])
    if cap is not None and budget > cap:
        await audit.record(action="campaign_build.approve_denied", actor=user, entity_type="campaign_build", entity_id=build_id,
                           client_id=b["client_id"], after={"budget_cents": budget, "cap_cents": cap}, request=request)
        raise HTTPException(status_code=403, detail=f"Daily budget {budget/100:.2f} exceeds your approval limit ({cap/100:.0f}/day); Agency Owner approval required")
    try:
        v = await _validate(b, user_role=user["role"], live=True)
    except meta_graph.GraphError as e:
        raise HTTPException(status_code=502, detail=f"Meta API: {e}") from e
    if not v["ok"]:
        await execute("update campaign_builds set validation = $2::jsonb where id = $1::uuid", build_id, json.dumps(v))
        raise HTTPException(status_code=422, detail=v)
    row = await fetchrow(
        """
        update campaign_builds set status = 'approved', validation = $2::jsonb, approved_by_id = $3::uuid,
               approved_by_email = $4, approved_at = now()
        where id = $1::uuid and status = 'planned' returning id
        """,
        build_id, json.dumps(v), user["id"], user.get("email") or user["id"],
    )
    if row is None:
        raise HTTPException(status_code=409, detail="Build changed while approving; reload")
    await audit.record(action="campaign_build.approve", actor=user, entity_type="campaign_build", entity_id=build_id,
                       client_id=b["client_id"], after={"plan_version": b["plan_version"], "campaign": b["plan"]["campaign"]}, request=request)
    from app.tasks.builds import execute_build

    task = execute_build.delay(build_id)
    return {"task_id": task.id, "build": await _full(build_id)}

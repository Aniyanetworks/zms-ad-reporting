"""Write path for the zeal-paid-ads Claude Code plugin.

Bearer-token protected (PLUGIN_API_TOKEN). The plugin never touches Postgres
directly; every proposal, run, and status transition lands here so the
dashboard is the single approval queue. Tables come from
supabase/migrations/20260909000008_plugin_tables.sql.
"""
import json
import secrets
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core import audit, policy
from app.core.config import get_settings
from app.core.db import execute, fetch, fetchrow
from app.core.ratelimit import LIMIT_PLUGIN, limiter

router = APIRouter(prefix="/plugin", tags=["plugin"])


def require_plugin_token(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = get_settings().plugin_api_token
    if not expected:
        raise HTTPException(status_code=503, detail="PLUGIN_API_TOKEN not configured")
    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid plugin token")


PluginAuth = Depends(require_plugin_token)

# The plugin can propose, execute, fail or dismiss — never approve. Approval is
# a signed-in person's action in the dashboard (app/routers/actions.py).
STATUS_TRANSITIONS = policy.PLUGIN_ALLOWED_TRANSITIONS
PLUGIN_ACTOR = {"name": "zeal-paid-ads plugin"}


# ---------------------------------------------------------------- clients

@router.get("/clients", dependencies=[PluginAuth])
async def plugin_clients() -> list[dict]:
    rows = await fetch(
        """
        select id, slug, name, trade, avg_job_value, target_cpl, target_cpba,
               cpl_target_green, cpl_target_red, booking_system,
               meta_ad_account_id, meta_campaign_filter, google_ads_customer_id,
               ghl_location_id, timezone, is_active
        from clients where is_active = true order by name
        """
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- benchmarks

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=4000)


class BenchmarkIn(StrictModel):
    trade: str = Field(max_length=50)
    metric: Literal["cpl", "cpba", "ctr", "cpc", "cpm", "lead_form_cvr", "lead_to_appt_rate", "frequency"]
    window_days: int
    p25: float | None = None
    median: float | None = None
    p75: float | None = None
    n_adsets: int | None = None
    source: Literal["internal", "industry"]
    notes: str | None = None


@router.post("/benchmarks", dependencies=[PluginAuth])
@limiter.limit(LIMIT_PLUGIN)
async def upsert_benchmarks(request: Request, rows: list[BenchmarkIn]) -> dict:
    for b in rows:
        await execute(
            """
            insert into benchmarks (trade, metric, window_days, p25, median, p75, n_adsets, source, notes, computed_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
            on conflict (trade, metric, window_days, source) do update set
                p25 = excluded.p25, median = excluded.median, p75 = excluded.p75,
                n_adsets = excluded.n_adsets, notes = excluded.notes, computed_at = now()
            """,
            b.trade, b.metric, b.window_days, b.p25, b.median, b.p75, b.n_adsets, b.source, b.notes,
        )
    return {"upserted": len(rows)}


# ---------------------------------------------------------------- triage runs

class TriageRunIn(StrictModel):
    client_id: str = Field(max_length=64)
    window_start: str
    window_end: str
    spend: float | None = None
    leads: float | None = None
    appointments_ghl: int | None = None
    appointments_meta_reported: int | None = None
    divergence_ratio: float | None = None
    cpl: float | None = None
    cpba: float | None = None
    lead_to_appt_rate: float | None = None
    score: Literal["green", "yellow", "red"] | None = None
    summary_md: str | None = None
    raw: dict[str, Any] | None = None


@router.post("/triage-runs", status_code=201, dependencies=[PluginAuth])
@limiter.limit(LIMIT_PLUGIN)
async def create_triage_run(request: Request, body: TriageRunIn) -> dict:
    row = await fetchrow(
        """
        insert into triage_runs (client_id, window_start, window_end, spend, leads,
            appointments_ghl, appointments_meta_reported, divergence_ratio, cpl, cpba,
            lead_to_appt_rate, score, summary_md, raw)
        values ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
        returning id, run_at
        """,
        body.client_id, body.window_start, body.window_end, body.spend, body.leads,
        body.appointments_ghl, body.appointments_meta_reported, body.divergence_ratio,
        body.cpl, body.cpba, body.lead_to_appt_rate, body.score, body.summary_md,
        json.dumps(body.raw) if body.raw is not None else None,
    )
    await audit.record(
        action="triage_run.create", actor=PLUGIN_ACTOR, actor_type="plugin", entity_type="triage_run",
        entity_id=row["id"], client_id=body.client_id, after={"score": body.score, "window": [body.window_start, body.window_end]},
        request=request,
    )
    return {"id": row["id"], "run_at": row["run_at"].isoformat()}


# ---------------------------------------------------------------- recommendations

class RecommendationIn(StrictModel):
    client_id: str = Field(max_length=64)
    triage_run_id: int | None = None
    entity_type: Literal["campaign", "adset", "ad", "account"]
    entity_id: str | None = Field(default=None, max_length=200)
    entity_name: str | None = Field(default=None, max_length=500)
    action: Literal["budget_change", "pause", "activate", "refresh_creative", "fix_signal", "investigate"]
    current_value: str | None = None
    proposed_value: str | None = None
    pct_change: float | None = None
    reason: str = Field(min_length=1, max_length=4000)
    evidence: dict[str, Any] | None = None
    risk: str | None = Field(default=None, max_length=2000)
    rollback_value: str | None = Field(default=None, max_length=500)


@router.post("/recommendations", status_code=201, dependencies=[PluginAuth])
@limiter.limit(LIMIT_PLUGIN)
async def create_recommendations(request: Request, rows: list[RecommendationIn]) -> dict:
    if len(rows) > 100:
        raise HTTPException(status_code=413, detail="At most 100 recommendations per request")
    ids = []
    for r in rows:
        row = await fetchrow(
            """
            insert into recommendations (client_id, triage_run_id, entity_type, entity_id, entity_name,
                action, current_value, proposed_value, pct_change, reason, evidence, risk, rollback_value)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
            returning id
            """,
            r.client_id, r.triage_run_id, r.entity_type, r.entity_id, r.entity_name, r.action,
            r.current_value, r.proposed_value, r.pct_change, r.reason,
            json.dumps(r.evidence) if r.evidence is not None else None, r.risk, r.rollback_value,
        )
        ids.append(row["id"])
        await audit.record(
            action="recommendation.propose", actor=PLUGIN_ACTOR, actor_type="plugin", entity_type="recommendation",
            entity_id=row["id"], client_id=r.client_id, after=r.model_dump(), request=request,
        )
    return {"ids": ids}


class RecommendationPatch(StrictModel):
    # 'approved' is accepted by the schema so the plugin gets a clear 409 with
    # the rule spelled out, instead of an opaque validation error.
    status: Literal["approved", "executed", "dismissed", "failed"]
    actor: str = Field(min_length=1, max_length=200, description="who executed — the operator's name or email")
    verification: dict[str, Any] | None = None


@router.patch("/recommendations/{rec_id}", dependencies=[PluginAuth])
@limiter.limit(LIMIT_PLUGIN)
async def patch_recommendation(request: Request, rec_id: int, body: RecommendationPatch) -> dict:
    """Plugin status transitions: approved→executed/failed/dismissed, proposed→dismissed.
    'approved' is refused here — a person approves in the dashboard."""
    current = await fetchrow("select * from recommendations where id = $1", rec_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")
    if body.status == "approved":
        await audit.record(
            action="recommendation.approve_denied", actor={"name": body.actor}, actor_type="plugin",
            entity_type="recommendation", entity_id=rec_id, client_id=str(current["client_id"]),
            after={"reason": "plugin token attempted approval"}, request=request,
        )
        raise HTTPException(
            status_code=409,
            detail="Approval is a human action: a signed-in Agency Owner or media buyer approves in the dashboard "
                   "(Actions card). The plugin token cannot approve.",
        )
    if not policy.plugin_can_transition(current["status"], body.status):
        allowed = STATUS_TRANSITIONS.get(current["status"], frozenset())
        raise HTTPException(
            status_code=409,
            detail=f"Cannot move from '{current['status']}' to '{body.status}' (allowed: {sorted(allowed)})",
        )
    if body.status in ("executed", "failed") and not current["approved_by"]:
        raise HTTPException(status_code=409, detail="Recommendation was never approved by a person")
    if body.status in ("executed", "failed"):
        row = await fetchrow(
            """
            update recommendations set status = $2, executed_by = $3, executed_at = now(),
                verification = $4::jsonb
            where id = $1 returning *
            """,
            rec_id, body.status, body.actor,
            json.dumps(body.verification) if body.verification is not None else None,
        )
    else:  # dismissed
        row = await fetchrow(
            """
            update recommendations set status = 'dismissed',
                verification = coalesce(verification, '{}'::jsonb) || jsonb_build_object('dismissed_by', $2::text)
            where id = $1 returning *
            """,
            rec_id, body.actor,
        )
    await audit.record(
        action=f"recommendation.{body.status}", actor={"name": body.actor}, actor_type="plugin",
        entity_type="recommendation", entity_id=rec_id, client_id=str(current["client_id"]),
        before=dict(current), after=dict(row) if row else None, request=request,
    )
    return {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in dict(row).items()}


# ---------------------------------------------------------------- notify

class NotifyIn(BaseModel):
    client_slug: str
    text: str = Field(min_length=1, max_length=4000)


@router.post("/notify", dependencies=[PluginAuth])
async def notify(body: NotifyIn) -> dict:
    """Short Slack summary with a link to the client page. Uses the agency
    webhook (SLACK_WEBHOOK_URL); per-client fb-client-* channel routing needs
    per-channel webhooks — see ops notes."""
    settings = get_settings()
    if not settings.slack_webhook_url:
        return {"skipped": "SLACK_WEBHOOK_URL not configured"}
    link = f"{settings.dashboard_url}/clients/{body.client_slug}"
    payload = {"text": f"{body.text}\n<{link}|Open in dashboard>"}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(settings.slack_webhook_url, json=payload)
        resp.raise_for_status()
    return {"posted": True}

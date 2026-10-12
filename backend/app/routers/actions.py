"""Dashboard-side view of the plugin's proposal queue: recommendations to
approve/dismiss, the per-client scorecard (latest triage + trade benchmarks),
and the cross-client portfolio view. Dashboard JWT auth; approving here is what
makes a recommendation eligible for the plugin's /execute."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.core import audit, policy
from app.core.db import fetch, fetchrow
from app.core.ratelimit import LIMIT_MUTATION, limiter
from app.core.security import CurrentUser
from app.services.economics import cpba_color, max_cpba

router = APIRouter(tags=["actions"])


def _ser(row) -> dict:
    return {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in dict(row).items()}


async def _client_id(slug: str) -> str:
    row = await fetchrow("select id from clients where slug = $1", slug)
    if row is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return str(row["id"])


@router.get("/clients/{slug}/recommendations")
async def list_recommendations(slug: str, user: CurrentUser, status: str = "open") -> list[dict]:
    """status=open → proposed + approved; status=all → everything (latest 100)."""
    cid = await _client_id(slug)
    if status == "open":
        rows = await fetch(
            """
            select r.*, t.window_start, t.window_end, t.score as run_score
            from recommendations r left join triage_runs t on t.id = r.triage_run_id
            where r.client_id = $1 and r.status in ('proposed','approved')
            order by r.created_at desc
            """,
            cid,
        )
    else:
        rows = await fetch(
            """
            select r.*, t.window_start, t.window_end, t.score as run_score
            from recommendations r left join triage_runs t on t.id = r.triage_run_id
            where r.client_id = $1 order by r.created_at desc limit 100
            """,
            cid,
        )
    return [_ser(r) for r in rows]


@router.post("/clients/{slug}/recommendations/{rec_id}/approve")
@limiter.limit(LIMIT_MUTATION)
async def approve_recommendation(request: Request, slug: str, rec_id: int, user: CurrentUser) -> dict:
    """A signed-in person approves one proposed recommendation. Role rules live
    in app.core.policy; the plugin token can never reach this route."""
    cid = await _client_id(slug)
    before = await fetchrow("select * from recommendations where id = $1 and client_id = $2", rec_id, cid)
    if before is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")
    allowed, reason = policy.can_approve(user["role"], before["action"], before["pct_change"])
    if not allowed:
        await audit.record(
            action="recommendation.approve_denied", actor=user, entity_type="recommendation",
            entity_id=rec_id, client_id=cid, before=dict(before), after={"reason": reason}, request=request,
        )
        raise HTTPException(status_code=403, detail=reason)
    row = await fetchrow(
        """
        update recommendations
        set status = 'approved', approved_by = $3, approved_by_id = $4::uuid, approved_at = now()
        where id = $1 and client_id = $2 and status = 'proposed'
        returning *
        """,
        rec_id, cid, user.get("email") or user["id"], user["id"],
    )
    if row is None:
        raise HTTPException(status_code=409, detail="Recommendation not in 'proposed' state")
    await audit.record(
        action="recommendation.approve", actor=user, entity_type="recommendation", entity_id=rec_id,
        client_id=cid, before=dict(before), after=dict(row), request=request,
    )
    return _ser(row)


@router.post("/clients/{slug}/recommendations/{rec_id}/dismiss")
@limiter.limit(LIMIT_MUTATION)
async def dismiss_recommendation(request: Request, slug: str, rec_id: int, user: CurrentUser) -> dict:
    cid = await _client_id(slug)
    if not policy.can_dismiss(user["role"]):
        raise HTTPException(status_code=403, detail="Your role cannot dismiss recommendations")
    before = await fetchrow("select * from recommendations where id = $1 and client_id = $2", rec_id, cid)
    if before is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")
    row = await fetchrow(
        """
        update recommendations set status = 'dismissed',
            verification = coalesce(verification, '{}'::jsonb) || jsonb_build_object('dismissed_by', $3::text)
        where id = $1 and client_id = $2 and status in ('proposed','approved')
        returning *
        """,
        rec_id, cid, user.get("email") or user["id"],
    )
    if row is None:
        raise HTTPException(status_code=409, detail="Recommendation already closed")
    await audit.record(
        action="recommendation.dismiss", actor=user, entity_type="recommendation", entity_id=rec_id,
        client_id=cid, before=dict(before), after=dict(row), request=request,
    )
    return _ser(row)


EXECUTABLE = ("fix_utm", "create_pixel", "fix_tracking")
TRACKING_ACTIONS = ("fix_tracking", "fix_utm", "create_pixel")


@router.get("/recommendations/tracking")
async def tracking_queue(user: CurrentUser) -> list[dict]:
    """Every open tracking-rollout item across clients (for the Integrations page)."""
    rows = await fetch(
        """
        select r.id, r.client_id, c.slug as client_slug, c.name as client_name, r.action, r.entity_type, r.entity_name,
               r.status, r.reason, r.risk, r.proposed_value, r.approved_by, r.approved_at, r.executed_at, r.verification,
               coalesce(jsonb_array_length(r.evidence->'ads'), 0) as ads, r.evidence->>'pixel_id' as pixel_id,
               r.evidence->>'campaign_name' as campaign_name, r.created_at
        from recommendations r join clients c on c.id = r.client_id
        where r.action = any($1::text[]) and r.status in ('proposed','approved','executed','failed')
          and r.created_at > now() - interval '14 days'
        order by case r.status when 'proposed' then 0 when 'approved' then 1 when 'failed' then 2 else 3 end, c.name, r.action
        """,
        list(TRACKING_ACTIONS),
    )
    return [_ser(r) for r in rows]


class BulkIds(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[int] = Field(min_length=1, max_length=200)


@router.post("/recommendations/bulk-approve")
@limiter.limit(LIMIT_MUTATION)
async def bulk_approve(request: Request, body: BulkIds, user: CurrentUser) -> dict:
    """Approve many tracking items at once. Same rules as single approval; the
    signed-in user is recorded as approver on every row."""
    approved, denied = [], []
    for rec_id in body.ids:
        before = await fetchrow("select * from recommendations where id = $1 and action = any($2::text[])", rec_id, list(TRACKING_ACTIONS))
        if before is None or before["status"] != "proposed":
            denied.append({"id": rec_id, "reason": "not a proposed tracking item"})
            continue
        ok, reason = policy.can_approve(user["role"], before["action"], before["pct_change"])
        if not ok:
            denied.append({"id": rec_id, "reason": reason})
            continue
        row = await fetchrow(
            """
            update recommendations set status = 'approved', approved_by = $2, approved_by_id = $3::uuid, approved_at = now()
            where id = $1 and status = 'proposed' returning *
            """,
            rec_id, user.get("email") or user["id"], user["id"],
        )
        if row is None:
            denied.append({"id": rec_id, "reason": "changed concurrently"})
            continue
        approved.append(rec_id)
        await audit.record(action="recommendation.approve", actor=user, entity_type="recommendation", entity_id=rec_id,
                           client_id=str(before["client_id"]), before=dict(before), after=dict(row), request=request)
    return {"approved": approved, "denied": denied}


@router.post("/recommendations/bulk-execute", status_code=202)
@limiter.limit(LIMIT_MUTATION)
async def bulk_execute(request: Request, body: BulkIds, user: CurrentUser) -> dict:
    """Queue execution for many APPROVED tracking items."""
    if not policy.can_dismiss(user["role"]):
        raise HTTPException(status_code=403, detail="Your role cannot execute recommendations")
    from app.tasks.tracking import execute_recommendation as task

    queued, skipped = [], []
    for rec_id in body.ids:
        rec = await fetchrow("select * from recommendations where id = $1", rec_id)
        if rec is not None and rec["status"] == "failed" and rec["approved_by"] and rec["action"] in EXECUTABLE:
            # Retry: the person's approval stands; only the execution is repeated (ads already done are skipped).
            rec = await fetchrow("update recommendations set status = 'approved' where id = $1 and status = 'failed' returning *", rec_id)
            await audit.record(action="recommendation.retry", actor=user, entity_type="recommendation", entity_id=rec_id,
                               client_id=str(rec["client_id"]), request=request)
        if rec is None or rec["status"] != "approved" or not rec["approved_by"] or rec["action"] not in EXECUTABLE:
            skipped.append(rec_id)
            continue
        await audit.record(action="recommendation.execute_requested", actor=user, entity_type="recommendation", entity_id=rec_id,
                           client_id=str(rec["client_id"]), before=dict(rec), request=request)
        task.delay(rec_id, user.get("email") or user["id"])
        queued.append(rec_id)
    return {"queued": queued, "skipped": skipped}


@router.post("/clients/{slug}/recommendations/{rec_id}/execute", status_code=202)
@limiter.limit(LIMIT_MUTATION)
async def execute_recommendation(request: Request, slug: str, rec_id: int, user: CurrentUser) -> dict:
    """Perform an APPROVED recommendation the dashboard knows how to execute
    (fix_utm, create_pixel). Everything else is still the plugin's /execute."""
    cid = await _client_id(slug)
    if not policy.can_dismiss(user["role"]):  # admin or media_buyer
        raise HTTPException(status_code=403, detail="Your role cannot execute recommendations")
    rec = await fetchrow("select * from recommendations where id = $1 and client_id = $2", rec_id, cid)
    if rec is None:
        raise HTTPException(status_code=404, detail="Recommendation not found")
    if rec["status"] != "approved" or not rec["approved_by"]:
        raise HTTPException(status_code=409, detail="Only an approved recommendation can be executed")
    if rec["action"] not in EXECUTABLE:
        raise HTTPException(status_code=409, detail=f"'{rec['action']}' is executed via the Claude Code plugin (/execute {rec_id}), not the dashboard")
    await audit.record(action="recommendation.execute_requested", actor=user, entity_type="recommendation", entity_id=rec_id,
                       client_id=cid, before=dict(rec), request=request)
    from app.tasks.tracking import execute_recommendation as task

    t = task.delay(rec_id, user.get("email") or user["id"])
    return {"task_id": t.id, "id": rec_id}


# Scorecard numbers come from the latest weekly triage when one exists; until
# then (or when it is older than 8 days) they fall back to the live trailing 30
# days so the Portfolio is never blank.
SCORECARD_SQL = """
with live as (
    select c.id as client_id,
           coalesce(sum(a.spend), 0) as spend, coalesce(sum(a.leads), 0) as leads,
           coalesce((select sum(appointments_booked) from ghl_metrics_daily g
                     where g.client_id = c.id and g.date >= current_date - 30), 0) as appointments
    from clients c
    left join ad_metrics_daily a on a.client_id = c.id and a.date >= current_date - 30
    group by c.id
)
select s.*,
       case when s.run_at is not null and s.run_at > now() - interval '8 days' then 'triage' else 'live_30d' end as metrics_source,
       coalesce(s.window_start, (current_date - 30)::text::date) as window_start_eff,
       coalesce(s.window_end, current_date) as window_end_eff,
       case when s.run_at is not null and s.run_at > now() - interval '8 days' then s.spend else l.spend end as spend_eff,
       case when s.run_at is not null and s.run_at > now() - interval '8 days' then s.leads else l.leads end as leads_eff,
       case when s.run_at is not null and s.run_at > now() - interval '8 days' then s.appointments_ghl else l.appointments end as appts_eff,
       (select count(*) from recommendations r where r.client_id = s.client_id and r.status = 'proposed') as open_recs
from v_client_scorecard s
join live l on l.client_id = s.client_id
"""
ECON_SQL = "select id, avg_job_value, close_rate, gross_margin_pct, max_ad_cost_share from clients"


def _scorecard(row, econ: dict | None = None) -> dict:
    d = _ser(row)
    spend = float(d.pop("spend_eff") or 0)
    leads = float(d.pop("leads_eff") or 0)
    appts = float(d.pop("appts_eff") or 0)
    d["window_start"] = d.pop("window_start_eff")
    d["window_end"] = d.pop("window_end_eff")
    d["spend"], d["leads"], d["appointments_ghl"] = round(spend, 2), leads, int(appts)
    d["cpl"] = round(spend / leads, 2) if leads else None
    d["cpba"] = round(spend / appts, 2) if appts and d.get("booking_system") in ("ghl", "sheet") else None
    d["lead_to_appt_rate"] = round(appts / leads, 4) if leads else None
    for m in ("cpl", "cpba"):
        med = d.get(f"{m}_median")
        d[f"{m}_vs_median"] = round(d[m] / float(med), 3) if d[m] is not None and med else None
    e = econ.get(d["client_id"]) if econ else None
    d["cpba_max"] = max_cpba(e["avg_job_value"], e["close_rate"], e["gross_margin_pct"], e["max_ad_cost_share"]) if e else None
    d["cpba_color"] = cpba_color(d["cpba"], d["cpba_max"])
    return d


@router.get("/clients/{slug}/scorecard")
async def client_scorecard(slug: str, user: CurrentUser) -> dict | None:
    row = await fetchrow(SCORECARD_SQL + " where s.slug = $1", slug)
    econ = {str(r["id"]): dict(r) for r in await fetch(ECON_SQL)}
    return _scorecard(row, econ) if row else None


@router.get("/portfolio")
async def portfolio(user: CurrentUser) -> list[dict]:
    """All active clients, worst-first by CPBA vs trade median, then CPL vs median."""
    econ = {str(r["id"]): dict(r) for r in await fetch(ECON_SQL)}
    rows = [_scorecard(r, econ) for r in await fetch(SCORECARD_SQL)]
    rows.sort(key=lambda d: (
        -(d["cpba_vs_median"] if d["cpba_vs_median"] is not None else -1),
        -(d["cpl_vs_median"] if d["cpl_vs_median"] is not None else -1),
        d["name"],
    ))
    return rows

"""Agency overview — per-client rollup for a date range, plus agency totals."""
from datetime import date

from fastapi import APIRouter, Query

from app.core.db import fetch
from app.core.security import CurrentUser
from app.services import targets
from app.services.economics import cpba_color, max_cpba

router = APIRouter(tags=["overview"])

# Lead-weighted service mix per client and platform, so the status badge can use
# "what a lead should cost for THIS client's services" instead of one flat target.
MIX_SQL = """
select m.client_id, m.platform,
       coalesce(csm.service, c.default_service, 'Unclassified') as service,
       sum(m.leads) as leads, sum(m.spend) as spend
from ad_metrics_daily m
join clients c on c.id = m.client_id
left join campaign_service_map csm
  on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
where m.date between $1 and $2
group by 1, 2, 3
"""


def _expected(mix_rows: list, tg, client_green: float, client_red: float) -> tuple[float, float] | None:
    """Weighted (by leads, else spend) CPL green/red for a set of service rows."""
    wg = wr = wsum = 0.0
    for r in mix_rows:
        t = targets.resolve(tg, r["service"], r["platform"])
        g = float(t["cpl_green"]) if t and t.get("cpl_green") is not None else client_green
        rd = float(t["cpl_red"]) if t and t.get("cpl_red") is not None else (g * 1.5 if t else client_red)
        w = float(r["leads"] or 0) or float(r["spend"] or 0) * 0.01
        if w <= 0:
            continue
        wg += g * w
        wr += rd * w
        wsum += w
    if wsum == 0:
        return None
    return round(wg / wsum, 2), round(wr / wsum, 2)

OVERVIEW_SQL = """
with ads as (
    select client_id,
           sum(spend) filter (where platform = 'meta')    as meta_spend,
           sum(leads) filter (where platform = 'meta')    as meta_leads,
           sum(spend) filter (where platform = 'google')  as google_spend,
           sum(leads) filter (where platform = 'google')  as google_leads,
           sum(spend) filter (where platform = 'lsa')     as lsa_spend,
           sum(leads) filter (where platform = 'lsa')     as lsa_leads,
           sum(spend)                                     as total_spend,
           sum(leads)                                     as total_leads
    from ad_metrics_daily
    where date between $1 and $2
    group by client_id
),
ghl as (
    select client_id,
           sum(contacts_created)         as contacts_created,
           sum(contacts_paid_attributed) as contacts_paid_attributed,
           sum(inbound_calls)            as inbound_calls,
           sum(appointments_booked)      as appointments_booked
    from ghl_metrics_daily
    where date between $1 and $2
    group by client_id
)
select
    c.id, c.name, c.slug, c.cpl_target_green, c.cpl_target_red,
    c.avg_job_value, c.close_rate, c.gross_margin_pct, c.max_ad_cost_share,
    coalesce(a.meta_spend, 0)    as meta_spend,
    coalesce(a.meta_leads, 0)    as meta_leads,
    coalesce(a.google_spend, 0)  as google_spend,
    coalesce(a.google_leads, 0)  as google_leads,
    coalesce(a.lsa_spend, 0)     as lsa_spend,
    coalesce(a.lsa_leads, 0)     as lsa_leads,
    coalesce(a.total_spend, 0)   as total_spend,
    coalesce(a.total_leads, 0)   as total_leads,
    coalesce(g.contacts_created, 0)         as ghl_contacts_created,
    coalesce(g.contacts_paid_attributed, 0) as ghl_contacts_paid,
    coalesce(g.inbound_calls, 0)            as ghl_inbound_calls,
    coalesce(g.appointments_booked, 0)      as ghl_appointments
from clients c
left join ads a on a.client_id = c.id
left join ghl g on g.client_id = c.id
where c.is_active = true
order by c.name
"""


SPARK_SQL = """
select client_id, date, sum(spend) as spend,
       sum(spend) filter (where platform = 'meta')   as meta_spend,
       sum(spend) filter (where platform = 'google') as google_spend,
       sum(spend) filter (where platform = 'lsa')    as lsa_spend
from ad_metrics_daily
where date between $1 and $2
group by client_id, date
order by date
"""


def _safe_div(numerator: float, denominator: float) -> float | None:
    return round(numerator / denominator, 2) if denominator else None


@router.get("/overview")
async def overview(
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
) -> dict:
    rows = await fetch(OVERVIEW_SQL, start, end)
    spark_rows = await fetch(SPARK_SQL, start, end)
    tg = await targets.load_targets()
    mix: dict = {}
    for m in await fetch(MIX_SQL, start, end):
        mix.setdefault(m["client_id"], []).append(dict(m))
    sparks: dict = {}
    sparks_meta: dict = {}
    sparks_google: dict = {}
    sparks_lsa: dict = {}
    for s in spark_rows:
        sparks.setdefault(s["client_id"], []).append(float(s["spend"] or 0))
        sparks_meta.setdefault(s["client_id"], []).append(float(s["meta_spend"] or 0))
        sparks_google.setdefault(s["client_id"], []).append(float(s["google_spend"] or 0))
        sparks_lsa.setdefault(s["client_id"], []).append(float(s["lsa_spend"] or 0))
    clients = []
    for r in rows:
        d = dict(r)
        for k in ("meta_spend", "meta_leads", "google_spend", "google_leads", "lsa_spend", "lsa_leads",
                  "total_spend", "total_leads", "cpl_target_green", "cpl_target_red"):
            d[k] = float(d[k]) if d[k] is not None else 0.0
        d["meta_cpl"] = _safe_div(d["meta_spend"], d["meta_leads"])
        d["google_cpl"] = _safe_div(d["google_spend"], d["google_leads"])
        d["lsa_cpl"] = _safe_div(d["lsa_spend"], d["lsa_leads"])
        d["blended_cpl"] = _safe_div(d["total_spend"], d["total_leads"])
        # blended spend ÷ GHL booked appointments
        d["cost_per_appointment"] = _safe_div(d["total_spend"], d["ghl_appointments"])
        d["cpba_max"] = max_cpba(d.pop("avg_job_value"), d.pop("close_rate"), d.pop("gross_margin_pct"), d.pop("max_ad_cost_share"))
        d["cpba_color"] = cpba_color(d["cost_per_appointment"], d["cpba_max"])
        # lead→appointment rate: GHL appointments ÷ total platform leads
        d["lead_to_appt_rate"] = (
            round(d["ghl_appointments"] / d["total_leads"], 4) if d["total_leads"] else None
        )
        rows_all = mix.get(d["id"], [])
        for plat, key in (("meta", "meta"), ("google", "google"), ("lsa", "lsa"), (None, "blended")):
            sub = [r for r in rows_all if plat is None or r["platform"] == plat]
            exp = _expected(sub, tg, d["cpl_target_green"], d["cpl_target_red"])
            d[f"{key}_target_green"], d[f"{key}_target_red"] = exp if exp else (None, None)
        d["spark"] = sparks.get(d["id"], [])
        d["spark_meta"] = sparks_meta.get(d["id"], [])
        d["spark_google"] = sparks_google.get(d["id"], [])
        d["spark_lsa"] = sparks_lsa.get(d["id"], [])
        clients.append(d)

    totals = {
        "total_spend": round(sum(c["total_spend"] for c in clients), 2),
        "total_leads": round(sum(c["total_leads"] for c in clients), 2),
        "total_appointments": sum(c["ghl_appointments"] for c in clients),
    }
    totals["blended_cpl"] = _safe_div(totals["total_spend"], totals["total_leads"])
    totals["cost_per_appointment"] = _safe_div(totals["total_spend"], totals["total_appointments"])

    return {"start": start.isoformat(), "end": end.isoformat(), "totals": totals, "clients": clients}

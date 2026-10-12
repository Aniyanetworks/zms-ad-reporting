"""Client detail — campaign-level table and daily trend series."""
from datetime import date

from fastapi import APIRouter, HTTPException, Query

from app.core.db import fetch, fetchrow
from app.core.security import CurrentUser
from app.services import targets

router = APIRouter(tags=["campaigns"])

CAMPAIGNS_SQL = """
select
    platform, campaign_id,
    max(campaign_name)  as campaign_name,
    max(campaign_status) as campaign_status,
    sum(spend)        as spend,
    sum(impressions)  as impressions,
    sum(clicks)       as clicks,
    sum(leads)        as leads,
    sum(phone_calls)  as phone_calls,
    max(currency)     as currency
from ad_metrics_daily
where client_id = $1 and date between $2 and $3
  and ($4::text is null or platform = $4)
group by platform, campaign_id
order by sum(spend) desc
"""

# Booked appointments per campaign for the client page. GHL tags a booking with
# the ad set NAME only; names repeat across campaigns and most bookings carry no
# tag, so: tagged bookings are split across same-named ad sets by lead share and
# the client's untagged bookings are spread over its campaigns by lead share
# (exact for one-service clients, an estimate otherwise).
CAMPAIGN_APPTS_SQL = """
with camp as (
    select platform, campaign_id, sum(leads) leads from ad_metrics_daily
    where client_id = $1 and date between $2 and $3 group by 1, 2
),
adsets as (
    select campaign_id, adset_name, sum(leads) leads, sum(spend) spend from adset_metrics_daily
    where client_id = $1 and platform = 'meta' and date between $2 and $3 group by 1, 2
),
same_name as (select adset_name, sum(leads) leads, sum(spend) spend from adsets group by 1),
booked as (
    select adset_name, sum(appointments) appointments from ghl_adset_daily
    where client_id = $1 and date between $2 and $3 group by 1
),
tagged as (
    select a.campaign_id,
           sum(b.appointments * case when s.leads > 0 then a.leads / s.leads
                                     when s.spend > 0 then a.spend / s.spend else 0 end) appointments
    from booked b join same_name s on s.adset_name = b.adset_name
    join adsets a on a.adset_name = b.adset_name
    group by 1
),
totals as (
    select (select coalesce(sum(appointments_booked), 0) from ghl_metrics_daily where client_id = $1 and date between $2 and $3) total,
           (select coalesce(sum(appointments), 0) from tagged) tagged_total,
           (select coalesce(sum(leads), 0) from camp) leads
)
select c.platform, c.campaign_id,
       coalesce(t.appointments, 0)
         + greatest(totals.total - totals.tagged_total, 0)
           * case when totals.leads > 0 then c.leads / totals.leads else 0 end as appointments
from camp c cross join totals
left join tagged t on t.campaign_id = c.campaign_id
"""

# Service tag per campaign plus the portfolio-wide CPL/CPBA for that service over
# the same range, so a multi-service client's campaigns can each be judged
# against their own yardstick instead of one client-level target.
CAMPAIGN_SERVICES_SQL = """
with tagged as (
    select m.client_id, m.platform, m.campaign_id,
           coalesce(csm.service, c.default_service, 'Unclassified') service,
           sum(m.spend) spend, sum(m.leads) leads
    from ad_metrics_daily m
    join clients c on c.id = m.client_id and c.is_active
    left join campaign_service_map csm
      on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
    where m.date between $2 and $3
    group by 1, 2, 3, 4
),
portfolio as (
    select service, sum(spend) spend, sum(leads) leads, count(distinct client_id) clients
    from tagged where spend > 0 group by 1
)
select t.platform, t.campaign_id, t.service,
       p.clients as service_clients,
       case when p.leads > 0 then p.spend / p.leads end as service_cpl
from tagged t left join portfolio p on p.service = t.service
where t.client_id = $1
"""

TREND_SQL = """
select date,
       sum(spend) filter (where platform = 'meta')   as meta_spend,
       sum(spend) filter (where platform = 'google') as google_spend,
       sum(leads) filter (where platform = 'meta')   as meta_leads,
       sum(leads) filter (where platform = 'google') as google_leads,
       sum(spend) as spend,
       sum(leads) as leads
from ad_metrics_daily
where client_id = $1 and date between $2 and $3
group by date
order by date
"""


ADSETS_SQL = """
select
    m.adset_id,
    max(m.adset_name)   as adset_name,
    sum(m.spend)        as spend,
    sum(m.impressions)  as impressions,
    sum(m.clicks)       as clicks,
    sum(m.leads)        as leads,
    sum(m.phone_calls)  as phone_calls,
    max(m.currency)     as currency,
    coalesce(max(g.appointments), 0) as ghl_appointments
from adset_metrics_daily m
left join lateral (
    -- ZMS quirk: GHL contact utmMedium carries the ad set name, letting us
    -- attribute booked appointments to the ad set that produced them.
    select sum(appointments) as appointments from ghl_adset_daily gh
    where gh.client_id = m.client_id and gh.adset_name = m.adset_name
      and gh.date between $4 and $5
) g on true
where m.client_id = $1 and m.platform = $2 and m.campaign_id = $3 and m.date between $4 and $5
group by m.adset_id
order by sum(m.spend) desc
"""

ADS_SQL = """
select
    m.ad_id,
    max(m.ad_name)      as ad_name,
    sum(m.spend)        as spend,
    sum(m.impressions)  as impressions,
    sum(m.clicks)       as clicks,
    sum(m.leads)        as leads,
    sum(m.phone_calls)  as phone_calls,
    max(m.currency)     as currency,
    max(c.preview_link)  as preview_link,
    max(c.thumbnail_url) as thumbnail_url
from ad_level_metrics_daily m
left join meta_ad_creatives c on c.ad_id = m.ad_id
where m.client_id = $1 and m.platform = $2 and m.adset_id = $3 and m.date between $4 and $5
group by m.ad_id
order by sum(m.spend) desc
"""

# Per-ad totals plus first-half/second-half splits of the range (for fatigue trend).
CREATIVES_SQL = """
select
    m.ad_id, m.platform,
    max(m.ad_name)       as ad_name,
    max(cn.campaign_name) as campaign_name,
    sum(m.spend)         as spend,
    sum(m.impressions)   as impressions,
    sum(m.clicks)        as clicks,
    sum(m.leads)         as leads,
    sum(m.phone_calls)   as phone_calls,
    max(m.currency)      as currency,
    sum(m.spend) filter (where m.date <  $4) as spend_a,
    sum(m.leads) filter (where m.date <  $4) as leads_a,
    sum(m.spend) filter (where m.date >= $4) as spend_b,
    sum(m.leads) filter (where m.date >= $4) as leads_b,
    max(m.date)          as last_active,
    max(c.preview_link)  as preview_link,
    max(c.thumbnail_url) as thumbnail_url
from ad_level_metrics_daily m
left join meta_ad_creatives c on c.ad_id = m.ad_id
left join lateral (
    select a.campaign_name from ad_metrics_daily a
    where a.client_id = m.client_id and a.platform = m.platform and a.campaign_id = m.campaign_id
    order by a.date desc limit 1
) cn on true
where m.client_id = $1 and m.date between $2 and $3
group by m.ad_id, m.platform
order by sum(m.leads) desc, sum(m.spend) desc
"""


def _grade_creative(spend: float, leads: float, green: float, red: float) -> str:
    """Plain-language verdict the team can act on. 'learning' = hasn't spent
    enough to judge (less than one red-target CPL with no leads)."""
    if leads > 0:
        cpl = spend / leads
        if cpl <= green:
            return "winner"
        if cpl <= red:
            return "ok"
        return "underperforming"
    return "underperforming" if spend >= red else "learning"


def _trend(spend_a, leads_a, spend_b, leads_b, red: float) -> str | None:
    """Fatigue signal: CPL in the second half of the range vs the first.
    Needs real spend in both halves to say anything."""
    spend_a, spend_b = float(spend_a or 0), float(spend_b or 0)
    leads_a, leads_b = float(leads_a or 0), float(leads_b or 0)
    if spend_a < red or spend_b < red:
        return None
    cpl_a = spend_a / leads_a if leads_a else None
    cpl_b = spend_b / leads_b if leads_b else None
    if cpl_a is None and cpl_b is None:
        return None
    if cpl_b is None:  # was producing, stopped
        return "fatiguing"
    if cpl_a is None:  # started producing
        return "improving"
    if cpl_b > cpl_a * 1.5:
        return "fatiguing"
    if cpl_b < cpl_a * 0.67:
        return "improving"
    return "stable"


TOP_ADS_SQL = """
select
    m.ad_id, m.platform,
    max(m.ad_name)       as ad_name,
    max(m.campaign_id)   as campaign_id,
    sum(m.spend)         as spend,
    sum(m.impressions)   as impressions,
    sum(m.clicks)        as clicks,
    sum(m.leads)         as leads,
    sum(m.phone_calls)   as phone_calls,
    max(m.currency)      as currency,
    max(c.preview_link)  as preview_link,
    max(c.thumbnail_url) as thumbnail_url
from ad_level_metrics_daily m
left join meta_ad_creatives c on c.ad_id = m.ad_id
where m.client_id = $1 and m.date between $2 and $3
group by m.ad_id, m.platform
having sum(m.leads) > 0
order by sum(m.leads) desc, sum(m.spend) asc
limit $4
"""


def _safe_div(numerator: float, denominator: float) -> float | None:
    return round(numerator / denominator, 2) if denominator else None


def _thresholds(target: dict | None, service_cpl, green: float, red: float) -> tuple[float, float, str]:
    """(green_max, red_max, source) for a campaign's CPL. A service target wins;
    without one, ±15% around the portfolio CPL for the service; else the client's
    own targets."""
    if target and target.get("cpl_green") is not None:
        g = float(target["cpl_green"])
        r = float(target["cpl_red"]) if target.get("cpl_red") is not None else g * 1.5
        return g, r, "service"
    if service_cpl:
        return service_cpl * 0.85, service_cpl * 1.15, "portfolio"
    return green, red, "client"


def _score(cpl, leads: float, green_max: float, red_max: float) -> str | None:
    """green/yellow/red for one campaign; None until it has 3 leads."""
    if cpl is None or leads < 3:
        return None
    return "green" if cpl <= green_max else "yellow" if cpl <= red_max else "red"


def _finish_row(r: dict) -> dict:
    d = dict(r)
    for k in ("spend", "leads", "phone_calls"):
        d[k] = float(d[k] or 0)
    d["impressions"] = int(d["impressions"] or 0)
    d["clicks"] = int(d["clicks"] or 0)
    d["ctr"] = round(d["clicks"] / d["impressions"], 4) if d["impressions"] else None
    d["cpl"] = _safe_div(d["spend"], d["leads"])
    return d


async def _client_or_404(slug: str) -> dict:
    client = await fetchrow(
        "select id, name, slug, cpl_target_green, cpl_target_red from clients where slug = $1", slug
    )
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return client


@router.get("/clients/{slug}/campaigns")
async def client_campaigns(
    slug: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
    platform: str | None = Query(default=None, pattern="^(meta|google)$"),
) -> dict:
    client = await _client_or_404(slug)

    rows = await fetch(CAMPAIGNS_SQL, client["id"], start, end, platform)
    campaigns = [_finish_row(r) for r in rows]
    appts = {(a["platform"], a["campaign_id"]): float(a["appointments"] or 0)
             for a in await fetch(CAMPAIGN_APPTS_SQL, client["id"], start, end)}
    svc = {(r["platform"], r["campaign_id"]): r for r in await fetch(CAMPAIGN_SERVICES_SQL, client["id"], start, end)}
    tg = await targets.load_targets()
    for c in campaigns:
        c["appointments"] = round(appts.get((c["platform"], c["campaign_id"]), 0.0), 1)
        c["cost_per_appt"] = _safe_div(c["spend"], c["appointments"])
        s_ = svc.get((c["platform"], c["campaign_id"]))
        c["service"] = s_["service"] if s_ else None
        c["service_cpl"] = round(float(s_["service_cpl"]), 2) if s_ and s_["service_cpl"] is not None else None
        c["service_clients"] = int(s_["service_clients"] or 0) if s_ else 0
        g, r, src = _thresholds(targets.resolve(tg, c["service"], c["platform"]), c["service_cpl"],
                                float(client["cpl_target_green"]), float(client["cpl_target_red"]))
        c["target_cpl_green"], c["target_cpl_red"], c["target_source"] = round(g, 2), round(r, 2), src
        c["score"] = _score(c["cpl"], c["leads"], g, r)

    trend_rows = await fetch(TREND_SQL, client["id"], start, end)
    trend = [
        {
            "date": r["date"].isoformat(),
            "meta_spend": float(r["meta_spend"] or 0),
            "google_spend": float(r["google_spend"] or 0),
            "meta_leads": float(r["meta_leads"] or 0),
            "google_leads": float(r["google_leads"] or 0),
            "spend": float(r["spend"] or 0),
            "leads": float(r["leads"] or 0),
        }
        for r in trend_rows
    ]

    ghl = await fetchrow(
        """
        select coalesce(sum(contacts_created), 0)         as contacts_created,
               coalesce(sum(contacts_paid_attributed), 0) as contacts_paid_attributed,
               coalesce(sum(inbound_calls), 0)            as inbound_calls,
               coalesce(sum(appointments_booked), 0)      as appointments_booked
        from ghl_metrics_daily where client_id = $1 and date between $2 and $3
        """,
        client["id"], start, end,
    )

    return {
        "client": dict(client),
        "campaigns": campaigns,
        "trend": trend,
        "ghl": dict(ghl) if ghl else None,
    }


# Period rollup: ad spend/leads + GHL funnel, one row per day/week/month.
# full outer join because either side can have activity the other lacks.
PERIODS_SQL = """
with ads as (
    select date_trunc($4, date)::date as period,
           sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(leads) as leads, sum(phone_calls) as phone_calls
    from ad_metrics_daily
    where client_id = $1 and date between $2 and $3
      and ($5::text is null or platform = $5)
    group by 1
),
ghl as (
    select date_trunc($4, date)::date as period,
           sum(contacts_created) as ghl_contacts, sum(contacts_paid_attributed) as ghl_paid,
           sum(inbound_calls) as ghl_calls, sum(appointments_booked) as appointments,
           sum(jobs_won) as jobs_won, sum(revenue_won) as revenue_won
    from ghl_metrics_daily
    where client_id = $1 and date between $2 and $3
    group by 1
)
select coalesce(a.period, g.period) as period,
       coalesce(a.spend, 0) as spend, coalesce(a.impressions, 0) as impressions,
       coalesce(a.clicks, 0) as clicks, coalesce(a.leads, 0) as leads,
       coalesce(a.phone_calls, 0) as phone_calls,
       coalesce(g.ghl_contacts, 0) as ghl_contacts, coalesce(g.ghl_paid, 0) as ghl_paid,
       coalesce(g.ghl_calls, 0) as ghl_calls, coalesce(g.appointments, 0) as appointments,
       coalesce(g.jobs_won, 0) as jobs_won, coalesce(g.revenue_won, 0) as revenue_won
from ads a full outer join ghl g using (period)
order by period desc
"""

GRANULARITIES = {"daily": "day", "weekly": "week", "monthly": "month"}


@router.get("/clients/{slug}/periods")
async def client_periods(
    slug: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
    granularity: str = Query(default="weekly", pattern="^(daily|weekly|monthly)$"),
    platform: str | None = Query(default=None, pattern="^(meta|google)$"),
) -> dict:
    """Spend + lead funnel rolled up per day, ISO week (Mon-start), or month."""
    client = await _client_or_404(slug)
    rows = await fetch(PERIODS_SQL, client["id"], start, end, GRANULARITIES[granularity], platform)
    periods = []
    for r in rows:
        d = dict(r)
        d["period"] = d["period"].isoformat()
        for k in ("spend", "leads", "phone_calls", "revenue_won"):
            d[k] = float(d[k] or 0)
        for k in ("impressions", "clicks", "ghl_contacts", "ghl_paid", "ghl_calls", "appointments", "jobs_won"):
            d[k] = int(d[k] or 0)
        d["ctr"] = round(d["clicks"] / d["impressions"], 4) if d["impressions"] else None
        d["cpl"] = _safe_div(d["spend"], d["leads"])
        d["cost_per_appt"] = _safe_div(d["spend"], d["appointments"])
        d["roas"] = _safe_div(d["revenue_won"], d["spend"])
        periods.append(d)
    return {"client": dict(client), "granularity": granularity, "periods": periods}


@router.get("/clients/{slug}/creatives")
async def creatives(
    slug: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
) -> list[dict]:
    """Every ad active in the range, graded against the client's CPL targets
    (winner / ok / underperforming / learning) with a fatigue trend."""
    client = await _client_or_404(slug)
    green, red = float(client["cpl_target_green"]), float(client["cpl_target_red"])
    mid = start + (end - start) / 2
    rows = await fetch(CREATIVES_SQL, client["id"], start, end, mid)
    out = []
    for r in rows:
        d = _finish_row(r)
        d["last_active"] = d["last_active"].isoformat() if d.get("last_active") else None
        d["grade"] = _grade_creative(d["spend"], d["leads"], green, red)
        d["trend"] = _trend(r["spend_a"], r["leads_a"], r["spend_b"], r["leads_b"], red)
        for k in ("spend_a", "leads_a", "spend_b", "leads_b"):
            d.pop(k, None)
        out.append(d)
    return out


@router.get("/clients/{slug}/top-ads")
async def top_ads(
    slug: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
    limit: int = Query(default=6, ge=1, le=25),
) -> list[dict]:
    """Winning creatives: the ads that generated the most leads in the range,
    with shareable preview links for creative iteration."""
    client = await _client_or_404(slug)
    rows = await fetch(TOP_ADS_SQL, client["id"], start, end, limit)
    return [_finish_row(r) for r in rows]


@router.get("/clients/{slug}/campaigns/{campaign_id}/adsets")
async def campaign_adsets(
    slug: str,
    campaign_id: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
    platform: str = Query(default="meta", pattern="^(meta|google)$"),
) -> list[dict]:
    """Ad sets (Google: ad groups) inside one campaign, aggregated over the range."""
    client = await _client_or_404(slug)
    rows = await fetch(ADSETS_SQL, client["id"], platform, campaign_id, start, end)
    out = []
    for r in rows:
        d = _finish_row(r)
        d["ghl_appointments"] = int(d.get("ghl_appointments") or 0)
        d["cost_per_appt"] = _safe_div(d["spend"], d["ghl_appointments"])
        out.append(d)
    return out


@router.get("/clients/{slug}/adsets/{adset_id}/ads")
async def adset_ads(
    slug: str,
    adset_id: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
    platform: str = Query(default="meta", pattern="^(meta|google)$"),
) -> list[dict]:
    """Individual ads inside one ad set, aggregated over the range."""
    client = await _client_or_404(slug)
    rows = await fetch(ADS_SQL, client["id"], platform, adset_id, start, end)
    return [_finish_row(r) for r in rows]

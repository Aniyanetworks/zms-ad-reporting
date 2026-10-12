"""Per-service rollup — what each service (cabinet painting, decks, bathroom
remodeling...) costs across the portfolio for a date range. Services come from
campaign_service_map (campaign-name rules + client default, see
app.services.classify). Averages are spend-weighted (total spend ÷ total leads).
Appointments are attributed to a service through the GHL ad-set attribution
(ghl_adset_daily → ad set → campaign), so appointments whose ad set can't be
matched are not counted here."""
from datetime import date

from fastapi import APIRouter, Query

from app.core.db import fetch
from app.core.security import CurrentUser

router = APIRouter(tags=["services"])

SERVICES_SQL = """
with svc as (
    select m.client_id, m.platform, m.campaign_id,
           coalesce(csm.service, c.default_service, 'Unclassified') as service,
           sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads
    from ad_metrics_daily m
    join clients c on c.id = m.client_id
    left join campaign_service_map csm
      on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
    where m.date between $1 and $2 and c.is_active
    group by 1, 2, 3, 4
),
adsets as (
    select client_id, campaign_id, adset_name, sum(leads) leads, sum(spend) spend
    from adset_metrics_daily
    where platform = 'meta' and date between $1 and $2
    group by 1, 2, 3
),
same_name as (
    select client_id, adset_name, sum(leads) leads, sum(spend) spend from adsets group by 1, 2
),
booked as (
    select client_id, adset_name, sum(appointments) appointments
    from ghl_adset_daily where date between $1 and $2 group by 1, 2
),
appts as (
    -- GHL only knows the ad set NAME (utm_medium). Names like "Broad" repeat across
    -- campaigns, so split each name's appointments across the campaigns that ran an
    -- ad set with that name, in proportion to their leads (spend if no leads).
    select a.client_id, a.campaign_id,
           sum(b.appointments * case
                 when s.leads > 0 then a.leads / s.leads
                 when s.spend > 0 then a.spend / s.spend
                 else 0 end) appointments
    from booked b
    join same_name s on s.client_id = b.client_id and s.adset_name = b.adset_name
    join adsets a on a.client_id = b.client_id and a.adset_name = b.adset_name
    group by 1, 2
),
client_tot as (
    select client_id, sum(appointments_booked) appointments
    from ghl_metrics_daily where date between $1 and $2 group by 1
),
client_attr as (
    select client_id, sum(appointments) appointments from appts group by 1
),
client_leads as (
    select client_id, sum(leads) leads from svc group by 1
)
-- Bookings with no usable ad-set tag (most of them, for some clients) are split
-- across the client's campaigns by lead share: exact when the client sells one
-- service, an estimate when it sells several.
select c.slug, c.name, c.booking_system, svc.service, svc.platform, svc.campaign_id,
       svc.spend, svc.impressions, svc.clicks, svc.leads,
       coalesce(ap.appointments, 0)
         + greatest(coalesce(ct.appointments, 0) - coalesce(ca.appointments, 0), 0)
           * case when coalesce(cl.leads, 0) > 0 then svc.leads / cl.leads else 0 end as appointments
from svc
join clients c on c.id = svc.client_id
left join appts ap on ap.client_id = svc.client_id and ap.campaign_id = svc.campaign_id
left join client_tot ct on ct.client_id = svc.client_id
left join client_attr ca on ca.client_id = svc.client_id
left join client_leads cl on cl.client_id = svc.client_id
"""

UNATTRIBUTED_SQL = """
select coalesce((select sum(appointments_booked) from ghl_metrics_daily where date between $1 and $2), 0)
     - coalesce((select sum(b.appointments) from ghl_adset_daily b
                 where b.date between $1 and $2
                   and exists (select 1 from adset_metrics_daily a
                               where a.client_id = b.client_id and a.adset_name = b.adset_name
                                 and a.platform = 'meta' and a.date between $1 and $2)), 0) as unattributed
"""


def _div(n: float, d: float, places: int = 2) -> float | None:
    return round(n / d, places) if d else None


def _ratios(row: dict) -> None:
    row["ctr"] = _div(row["clicks"], row["impressions"], 4)
    row["cpc"] = _div(row["spend"], row["clicks"])
    row["cpl"] = _div(row["spend"], row["leads"])
    row["cpba"] = _div(row["spend"], row["appointments"])
    row["lead_to_appt_rate"] = _div(row["appointments"], row["leads"], 4)


def _bucket(store: dict, key, **init) -> dict:
    return store.setdefault(key, {**init, "spend": 0.0, "impressions": 0, "clicks": 0, "leads": 0.0, "appointments": 0, "campaigns": 0})


def _add(bucket: dict, r: dict) -> None:
    bucket["spend"] += r["spend"]
    bucket["impressions"] += r["impressions"]
    bucket["clicks"] += r["clicks"]
    bucket["leads"] += r["leads"]
    bucket["appointments"] += r["appointments"]
    bucket["campaigns"] += 1


@router.get("/services")
async def services(user: CurrentUser, start: date = Query(...), end: date = Query(...)) -> dict:
    rows = await fetch(SERVICES_SQL, start, end)
    groups: dict[str, dict] = {}
    for raw in rows:
        r = dict(raw)
        r["spend"], r["leads"] = float(r["spend"]), float(r["leads"])
        r["impressions"], r["clicks"], r["appointments"] = int(r["impressions"]), int(r["clicks"]), float(r["appointments"])
        if r["spend"] <= 0:
            continue
        # One row per service PER PLATFORM — Meta and Google buy differently, so a
        # blended CPL for a service running on both hides which channel works.
        g = _bucket(groups, (r["service"], r["platform"]), service=r["service"],
                    platform=r["platform"], clients={}, rows=[])
        _add(g, r)
        cb = _bucket(g["clients"], r["slug"], slug=r["slug"], name=r["name"])
        _add(cb, r)

    out = []
    for g in groups.values():
        clients = []
        for cb in g.pop("clients").values():
            cb["spend"] = round(cb["spend"], 2)
            cb["appointments"] = round(cb["appointments"], 1)
            _ratios(cb)
            clients.append(cb)
        clients.sort(key=lambda c: -c["spend"])
        g["rows"] = clients
        g["clients"] = len(clients)
        g["spend"] = round(g["spend"], 2)
        g["appointments"] = round(g["appointments"], 1)
        _ratios(g)
        out.append(g)
    out.sort(key=lambda g: (-g["spend"],))

    unattributed = await fetch(UNATTRIBUTED_SQL, start, end)
    plat = {}
    for g in out:
        p_ = plat.setdefault(g["platform"], {"platform": g["platform"], "spend": 0.0, "leads": 0.0, "appointments": 0.0, "services": 0})
        p_["spend"] += g["spend"]
        p_["leads"] += g["leads"]
        p_["appointments"] += g["appointments"]
        p_["services"] += 1
    for p_ in plat.values():
        p_["spend"] = round(p_["spend"], 2)
        p_["appointments"] = round(p_["appointments"], 1)
        p_["cpl"] = _div(p_["spend"], p_["leads"])
        p_["cpba"] = _div(p_["spend"], p_["appointments"])
    totals = {
        "platforms": sorted(plat.values(), key=lambda x: -x["spend"]),
        "services": len({g["service"] for g in out}),
        "spend": round(sum(g["spend"] for g in out), 2),
        "leads": sum(g["leads"] for g in out),
        "appointments": round(sum(g["appointments"] for g in out), 1),
        # booked in GHL without a usable ad-set tag — these were split by lead share above
        "appointments_unattributed": float(unattributed[0]["unattributed"] or 0),
    }
    totals["cpl"] = _div(totals["spend"], totals["leads"])
    totals["cpba"] = _div(totals["spend"], totals["appointments"])
    totals["lead_to_appt_rate"] = _div(totals["appointments"], totals["leads"], 4)
    return {"start": start.isoformat(), "end": end.isoformat(), "totals": totals, "services": out}

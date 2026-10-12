"""Service × platform CPL/CPBA targets — the yardstick for every colored number.

`resolve()` walks (service, platform) → (service, 'all') → None; callers fall back
to the client's own cpl_target_green/red when it returns None. `seed_missing()`
fills rows that don't exist yet from the trailing-90-day portfolio averages
(green = the average, red = 1.5× the average) and never touches manual edits.
"""
from typing import Any

from app.core.db import execute, fetch
from app.services import pg

Targets = dict[tuple[str, str], dict[str, Any]]

ACTUALS_SQL = """
with svc as (
  select m.platform, coalesce(csm.service, c.default_service, 'Unclassified') service,
         m.client_id, m.campaign_id, sum(m.spend) spend, sum(m.leads) leads
  from ad_metrics_daily m
  join clients c on c.id = m.client_id and c.is_active
  left join campaign_service_map csm
    on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
  where m.date >= current_date - %(days)s
  group by 1, 2, 3, 4
),
appts as (
  select client_id, sum(appointments_booked) appts from ghl_metrics_daily
  where date >= current_date - %(days)s group by 1
),
cl as (select client_id, sum(leads) leads from svc group by 1)
select s.service, s.platform,
       count(distinct s.client_id) clients, sum(s.spend) spend, sum(s.leads) leads,
       sum(coalesce(a.appts, 0) * case when cl.leads > 0 then s.leads / cl.leads else 0 end) appts
from svc s
left join appts a on a.client_id = s.client_id
left join cl on cl.client_id = s.client_id
group by 1, 2
"""


async def load_targets() -> Targets:
    rows = await fetch("select * from service_targets")
    return {(r["service"], r["platform"]): dict(r) for r in rows}


def resolve(targets: Targets, service: str | None, platform: str | None) -> dict[str, Any] | None:
    if not service:
        return None
    return targets.get((service, platform or "all")) or targets.get((service, "all"))


def portfolio_actuals(days: int = 90) -> list[dict[str, Any]]:
    out = []
    for r in pg.query(ACTUALS_SQL, {"days": days}):
        spend, leads, appts = float(r["spend"] or 0), float(r["leads"] or 0), float(r["appts"] or 0)
        out.append({
            "service": r["service"], "platform": r["platform"], "clients": int(r["clients"]),
            "spend": round(spend, 2), "leads": leads, "appointments": round(appts, 1),
            "cpl": round(spend / leads, 2) if leads else None,
            "cpba": round(spend / appts, 2) if appts >= 1 else None,
        })
    return out


def seed_missing(min_leads: int = 10, red_multiplier: float = 1.5) -> int:
    """Insert seed targets for service×platform pairs with enough volume and no row yet."""
    existing = {(r["service"], r["platform"]) for r in pg.query("select service, platform from service_targets")}
    n = 0
    for a in portfolio_actuals():
        if (a["service"], a["platform"]) in existing or a["leads"] < min_leads or a["cpl"] is None:
            continue
        cpl_g = round(a["cpl"])
        cpba_g = round(a["cpba"]) if a["cpba"] else None
        pg.execute(
            """
            insert into service_targets (service, platform, cpl_green, cpl_red, cpba_green, cpba_red, source, updated_by)
            values (%s, %s, %s, %s, %s, %s, 'seed', 'portfolio 90d average')
            on conflict do nothing
            """,
            (a["service"], a["platform"], cpl_g, round(cpl_g * red_multiplier),
             cpba_g, round(cpba_g * red_multiplier) if cpba_g else None),
        )
        n += 1
    return n


async def upsert_manual(service: str, platform: str, values: dict[str, Any], who: str) -> dict[str, Any]:
    row = await fetch(
        """
        insert into service_targets (service, platform, cpl_green, cpl_red, cpba_green, cpba_red, source, updated_at, updated_by)
        values ($1, $2, $3, $4, $5, $6, 'manual', now(), $7)
        on conflict (service, platform) do update set
          cpl_green = excluded.cpl_green, cpl_red = excluded.cpl_red,
          cpba_green = excluded.cpba_green, cpba_red = excluded.cpba_red,
          source = 'manual', updated_at = now(), updated_by = excluded.updated_by
        returning *
        """,
        service, platform, values.get("cpl_green"), values.get("cpl_red"),
        values.get("cpba_green"), values.get("cpba_red"), who,
    )
    return dict(row[0])


async def delete_target(service: str, platform: str) -> None:
    await execute("delete from service_targets where service = $1 and platform = $2", service, platform)

"""Lead-gen funnel report (Carl's metrics guide, 2026-09-24).

Columns left → right in the order the guide prescribes: the money metrics first
(spend, results/leads, CPL), then the ad metrics (unique link or outbound clicks,
cost per click, CTR), then delivery (impressions, reach, frequency, CPM, CPMr), video
(hook rate = 3-second plays / impressions, hold rate = ThruPlays / 3-second plays),
and finally the offline funnel (qualified → booked → confirmed → shown → closed → CAC,
revenue, ROAS) that lives in GHL, not Ads Manager.

Rows: the client as a whole, then each campaign, then each Meta ad set. Offline stages
after "booked" are only known per client (GHL doesn't tag shows/wins by campaign), so
campaign and ad-set rows carry spend → leads → booked and the client row carries the
full funnel."""
from datetime import date

from fastapi import APIRouter, HTTPException, Query

from app.core.db import fetch, fetchrow
from app.core.security import CurrentUser
from app.routers.campaigns import CAMPAIGN_APPTS_SQL

router = APIRouter(tags=["funnel"])

CLIENT_SQL = """
select id, name, slug, booking_system, cpl_target_green, cpl_target_red, avg_job_value
from clients where slug = $1
"""

ADS_TOTALS_SQL = """
select platform,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(leads) leads, sum(phone_calls) phone_calls,
       sum(reach) reach, sum(unique_link_clicks) unique_link_clicks, sum(unique_outbound_clicks) unique_outbound_clicks,
       sum(video_3s_plays) video_3s_plays, sum(thruplays) thruplays
from ad_metrics_daily where client_id = $1 and date between $2 and $3
group by platform
"""

CAMPAIGNS_SQL = """
select m.platform, m.campaign_id, max(m.campaign_name) campaign_name, max(m.campaign_status) campaign_status,
       coalesce(max(csm.service), 'Unclassified') service,
       sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads, sum(m.phone_calls) phone_calls,
       sum(m.reach) reach, sum(m.unique_link_clicks) unique_link_clicks, sum(m.unique_outbound_clicks) unique_outbound_clicks,
       sum(m.video_3s_plays) video_3s_plays, sum(m.thruplays) thruplays
from ad_metrics_daily m
left join campaign_service_map csm on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
where m.client_id = $1 and m.date between $2 and $3
group by m.platform, m.campaign_id order by sum(m.spend) desc
"""

ADSETS_SQL = """
select m.campaign_id, m.adset_id, max(m.adset_name) adset_name,
       sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads, sum(m.phone_calls) phone_calls,
       sum(m.reach) reach, sum(m.unique_link_clicks) unique_link_clicks, sum(m.unique_outbound_clicks) unique_outbound_clicks,
       sum(m.video_3s_plays) video_3s_plays, sum(m.thruplays) thruplays,
       coalesce(max(g.contacts_paid), 0) ghl_contacts, coalesce(max(g.appointments), 0) ghl_appointments
from adset_metrics_daily m
left join lateral (
    select sum(contacts_paid) contacts_paid, sum(appointments) appointments from ghl_adset_daily gh
    where gh.client_id = m.client_id and gh.adset_name = m.adset_name and gh.date between $2 and $3
) g on true
where m.client_id = $1 and m.platform = 'meta' and m.date between $2 and $3
group by m.campaign_id, m.adset_id order by sum(m.spend) desc
"""

VIDEO_IMPS_SQL = """
select campaign_id, adset_id, sum(impressions) video_impressions
from ad_level_metrics_daily
where client_id = $1 and platform = 'meta' and date between $2 and $3 and video_3s_plays > 0
group by campaign_id, adset_id
"""

BUDGETS_SQL = """
select platform, entity_type, entity_id, campaign_id, status, daily_budget, lifetime_budget, budget_source
from campaign_budgets where client_id = $1
"""

GHL_SQL = """
select sum(contacts_created) contacts, sum(contacts_paid_attributed) contacts_paid, sum(leads_dq) leads_dq,
       sum(inbound_calls) inbound_calls, sum(appointments_booked) booked, sum(appointments_all) booked_all,
       sum(appointments_confirmed) confirmed, sum(appointments_showed) showed, sum(appointments_noshow) noshow,
       sum(jobs_won) won, sum(revenue_won) revenue
from ghl_metrics_daily where client_id = $1 and date between $2 and $3
"""

# Benchmarks from the guide.
CTR_RED, CTR_YELLOW = 0.01, 0.015
CPC_YELLOW = 3.0
HOOK_GOOD, HOOK_GREAT = 0.20, 0.35
HOLD_GOOD, HOLD_GREAT = 0.20, 0.40
FREQUENCY_WATCH = 3.0


def _f(v) -> float:
    return float(v or 0)


def _div(a: float, b: float, nd: int = 2) -> float | None:
    return round(a / b, nd) if b else None


def _ad_metrics(d: dict) -> dict:
    """Derived ad / delivery / video metrics for any aggregated row.
    Unique clicks: outbound (website funnels) when present, else link clicks
    (Instant Form / on-platform funnels) — the guide's two column sets."""
    spend, imps, clicks = _f(d.get("spend")), _f(d.get("impressions")), _f(d.get("clicks"))
    reach, ulc, uoc = _f(d.get("reach")), _f(d.get("unique_link_clicks")), _f(d.get("unique_outbound_clicks"))
    v3, thru = _f(d.get("video_3s_plays")), _f(d.get("thruplays"))
    leads, calls = _f(d.get("leads")), _f(d.get("phone_calls"))
    outbound_funnel = uoc > 0 and uoc >= 0.5 * ulc
    unique = uoc if outbound_funnel else ulc
    # Hook rate only makes sense over VIDEO impressions; image ads dilute it. Callers
    # pass video_impressions (impressions of ad-days that had 3-second plays).
    vimps = _f(d.get("video_impressions")) or imps
    has_video = v3 > 0
    out = {
        "spend": round(spend, 2), "impressions": int(imps), "clicks": int(clicks), "leads": leads, "phone_calls": calls,
        "cpl": _div(spend, leads),
        "unique_clicks": int(unique), "unique_click_kind": "outbound" if outbound_funnel else "link" if ulc > 0 else None,
        "cost_per_unique_click": _div(spend, unique) if unique else None, "unique_ctr": _div(unique, imps, 4) if unique else None,
        "ctr": _div(clicks, imps, 4), "cpc": _div(spend, clicks),
        "reach": int(reach), "frequency": _div(imps, reach, 2),
        "cpm": _div(spend * 1000, imps), "cpmr": _div(spend * 1000, reach),
        "video_3s_plays": v3, "thruplays": thru,
        "video_impressions": int(vimps) if has_video else 0,
        "hook_rate": _div(v3, vimps, 4) if has_video else None, "hold_rate": _div(thru, v3, 4) if has_video else None,
    }
    out["signals"] = _signals(out)
    return out


def _signals(m: dict) -> list[dict]:
    s: list[dict] = []
    ctr = m["unique_ctr"] if m["unique_ctr"] is not None else m["ctr"]  # unique_ctr is None without unique-click data
    if m["impressions"] >= 1000 and ctr is not None:
        if ctr < CTR_RED:
            s.append({"level": "red", "metric": "ctr", "text": f"CTR {ctr:.2%} — under 1%, the ad isn't compelling enough"})
        elif ctr < CTR_YELLOW:
            s.append({"level": "yellow", "metric": "ctr", "text": f"CTR {ctr:.2%} — aim for ≥1.5%"})
    cpc = m["cost_per_unique_click"] or m["cpc"]
    if cpc is not None and m["clicks"] >= 30 and cpc > CPC_YELLOW:
        label = "unique click" if m["cost_per_unique_click"] else "click"
        s.append({"level": "yellow", "metric": "cpc", "text": f"${cpc:.2f} per {label} — above the $3 comfort range"})
    if m["frequency"] is not None and m["reach"] >= 1000 and m["frequency"] > FREQUENCY_WATCH:
        s.append({"level": "yellow", "metric": "frequency", "text": f"Frequency {m['frequency']:.1f} — same people seeing it repeatedly; watch CPMr and refresh creative"})
    if m["hook_rate"] is not None and m["video_impressions"] >= 1000 and m["video_3s_plays"] > 0:
        if m["hook_rate"] < HOOK_GOOD:
            s.append({"level": "yellow", "metric": "hook", "text": f"Hook rate {m['hook_rate']:.0%} — under 20%, first 3 seconds aren't grabbing"})
        elif m["hook_rate"] >= HOOK_GREAT:
            s.append({"level": "green", "metric": "hook", "text": f"Hook rate {m['hook_rate']:.0%} — very good"})
    if m["hold_rate"] is not None and m["video_3s_plays"] >= 200:
        if m["hold_rate"] < HOLD_GOOD:
            s.append({"level": "yellow", "metric": "hold", "text": f"Hold rate {m['hold_rate']:.0%} — attention doesn't stick past the hook"})
        elif m["hold_rate"] >= HOLD_GREAT:
            s.append({"level": "green", "metric": "hold", "text": f"Hold rate {m['hold_rate']:.0%} — extremely good"})
    return s


def _funnel(spend: float, leads: float, g: dict, avg_job_value) -> dict:
    """Offline funnel for the client. Qualified = paid contacts minus junk-stage leads
    (when GHL is linked); booked / confirmed / showed / won are paid-attributed."""
    contacts, contacts_paid = _f(g.get("contacts")), _f(g.get("contacts_paid"))
    dq_all = _f(g.get("leads_dq"))
    # Junk-stage leads are counted for every source; scale to the paid share of contacts
    # so "qualified" compares like with like (an estimate, labelled as such in the UI).
    dq = dq_all * (contacts_paid / contacts) if contacts > 0 and contacts_paid > 0 else dq_all
    booked, confirmed, showed, noshow = _f(g.get("booked")), _f(g.get("confirmed")), _f(g.get("showed")), _f(g.get("noshow"))
    won, revenue = _f(g.get("won")), _f(g.get("revenue"))
    base = contacts_paid if contacts_paid > 0 else leads
    qualified = max(base - dq, booked) if base else booked
    # Stages the client's GHL actually records: setters who never mark showed/no-show
    # (US Pro, 2026-09-24) would otherwise show a 0% show rate.
    confirmed_tracked = confirmed > 0 or booked == 0
    showed_tracked = (showed + noshow) > 0 or booked == 0
    won_tracked = won > 0 or booked == 0
    stages = [
        {"key": "leads", "label": "Leads", "count": leads, "pct_of_prev": None, "cost_per": _div(spend, leads), "tracked": True},
        {"key": "qualified", "label": "Qualified", "count": round(qualified, 1), "pct_of_prev": _div(qualified, base, 4), "cost_per": _div(spend, qualified), "tracked": contacts_paid > 0, "estimate": True},
        {"key": "booked", "label": "Booked", "count": booked, "pct_of_prev": _div(booked, qualified or base, 4), "cost_per": _div(spend, booked), "tracked": True},
        {"key": "confirmed", "label": "Confirmed", "count": confirmed, "pct_of_prev": _div(confirmed, booked, 4) if confirmed_tracked else None, "cost_per": _div(spend, confirmed) if confirmed_tracked else None, "tracked": confirmed_tracked},
        {"key": "showed", "label": "Showed", "count": showed, "pct_of_prev": _div(showed, booked, 4) if showed_tracked else None, "cost_per": _div(spend, showed) if showed_tracked else None, "tracked": showed_tracked},
        {"key": "won", "label": "Closed", "count": won, "pct_of_prev": _div(won, showed or booked, 4) if won_tracked else None, "cost_per": _div(spend, won) if won_tracked else None, "tracked": won_tracked},
    ]
    return {
        "contacts": contacts, "contacts_paid": contacts_paid, "junk": round(dq, 1), "junk_all": dq_all, "inbound_calls": _f(g.get("inbound_calls")),
        "booked_all": _f(g.get("booked_all")), "noshow": noshow, "noshow_rate": _div(noshow, booked, 4) if showed_tracked else None,
        "tracked": {"confirmed": confirmed_tracked, "showed": showed_tracked, "won": won_tracked},
        "stages": stages,
        "cac": _div(spend, won) if won_tracked else None, "revenue": revenue, "roas": _div(revenue, spend, 2) if revenue else None,
        "expected_revenue": round(won * _f(avg_job_value), 2) if avg_job_value and won and not revenue else None,
        "bottleneck": _bottleneck(leads, qualified, booked, showed, won, noshow),
    }


def _bottleneck(leads, qualified, booked, showed, won, noshow) -> str | None:
    """The guide's diagnosis rules, applied to whichever stage leaks most."""
    if leads >= 20 and qualified / leads < 0.4:
        return "Lots of leads but few qualified — ads are attracting the wrong people (ads & messaging problem)."
    if booked >= 10 and noshow / booked > 0.35:
        return "Lots of bookings but many no-shows — automation, follow-up or confirmation-page problem."
    if showed >= 8 and won / showed < 0.15:
        return "Plenty of shows but few closes — pre-call education or sales problem; train the closers."
    if qualified >= 20 and booked / qualified < 0.2:
        return "Qualified leads aren't getting booked — setter speed-to-lead and follow-up problem."
    return None


@router.get("/clients/{slug}/funnel")
async def funnel_report(
    slug: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
) -> dict:
    client = await fetchrow(CLIENT_SQL, slug)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    cid = client["id"]
    platforms = {r["platform"]: dict(r) for r in await fetch(ADS_TOTALS_SQL, cid, start, end)}
    # (platform rows use plain impressions for hook rate; the client/campaign rows are video-corrected)
    total = {k: sum(_f(p.get(k)) for p in platforms.values()) for k in
             ("spend", "impressions", "clicks", "leads", "phone_calls", "reach", "unique_link_clicks",
              "unique_outbound_clicks", "video_3s_plays", "thruplays")}
    budgets = {(r["platform"], r["entity_type"], r["entity_id"]): dict(r) for r in await fetch(BUDGETS_SQL, cid)}

    def budget_of(platform: str, entity_type: str, entity_id: str) -> dict:
        b = budgets.get((platform, entity_type, entity_id))
        if not b:
            return {"delivery": None, "daily_budget": None, "lifetime_budget": None, "budget_source": None}
        return {"delivery": b["status"], "daily_budget": _f(b["daily_budget"]) or None,
                "lifetime_budget": _f(b["lifetime_budget"]) or None, "budget_source": b["budget_source"]}
    ghl = await fetchrow(GHL_SQL, cid, start, end)
    g = dict(ghl) if ghl else {}
    vimps_rows = [dict(r) for r in await fetch(VIDEO_IMPS_SQL, cid, start, end)]
    vimps_campaign: dict[str, float] = {}
    vimps_adset: dict[str, float] = {}
    for r in vimps_rows:
        vimps_campaign[r["campaign_id"]] = vimps_campaign.get(r["campaign_id"], 0.0) + _f(r["video_impressions"])
        vimps_adset[r["adset_id"]] = vimps_adset.get(r["adset_id"], 0.0) + _f(r["video_impressions"])
    total["video_impressions"] = sum(vimps_campaign.values())
    client_row = _ad_metrics(total)
    # client-level daily budget = every ACTIVE campaign/ad-set daily budget, counted once per campaign
    active_daily = 0.0
    for (platform, etype, _eid), b in budgets.items():
        if str(b["status"] or "").upper() not in ("ACTIVE", "ENABLED"):
            continue
        if etype == "campaign" and b["budget_source"] == "campaign" and b["daily_budget"]:
            active_daily += _f(b["daily_budget"])
        elif etype == "adset" and b["budget_source"] == "adset" and b["daily_budget"]:
            active_daily += _f(b["daily_budget"])
    client_row["daily_budget"] = round(active_daily, 2) or None
    client_row["delivery"] = None
    client_row["funnel"] = _funnel(total["spend"], total["leads"], g, client["avg_job_value"])

    appts = {(r["platform"], r["campaign_id"]): _f(r["appointments"]) for r in await fetch(CAMPAIGN_APPTS_SQL, cid, start, end)}
    campaigns = []
    for r in await fetch(CAMPAIGNS_SQL, cid, start, end):
        d = dict(r)
        d["video_impressions"] = vimps_campaign.get(d["campaign_id"], 0.0)
        m = _ad_metrics(d)
        m.update({"platform": d["platform"], "campaign_id": d["campaign_id"], "campaign_name": d["campaign_name"],
                  "campaign_status": d["campaign_status"], "service": d["service"]})
        m.update(budget_of(d["platform"], "campaign", d["campaign_id"]))
        m["booked"] = round(appts.get((d["platform"], d["campaign_id"]), 0.0), 1)
        m["booked_rate"] = _div(m["booked"], m["leads"], 4)
        m["cost_per_booked"] = _div(m["spend"], m["booked"])
        campaigns.append(m)

    adsets = []
    for r in await fetch(ADSETS_SQL, cid, start, end):
        d = dict(r)
        d["video_impressions"] = vimps_adset.get(d["adset_id"], 0.0)
        m = _ad_metrics(d)
        m.update({"campaign_id": d["campaign_id"], "adset_id": d["adset_id"], "adset_name": d["adset_name"],
                  "ghl_contacts": int(d["ghl_contacts"] or 0), "booked": int(d["ghl_appointments"] or 0)})
        m.update(budget_of("meta", "adset", d["adset_id"]))
        m["booked_rate"] = _div(m["booked"], m["leads"], 4)
        m["cost_per_booked"] = _div(m["spend"], m["booked"])
        adsets.append(m)

    return {
        "client": {"name": client["name"], "slug": client["slug"], "booking_system": client["booking_system"],
                   "cpl_target_green": float(client["cpl_target_green"]), "cpl_target_red": float(client["cpl_target_red"])},
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "benchmarks": {"ctr_red": CTR_RED, "ctr_yellow": CTR_YELLOW, "cpc_yellow": CPC_YELLOW, "hook_good": HOOK_GOOD,
                       "hook_great": HOOK_GREAT, "hold_good": HOLD_GOOD, "hold_great": HOLD_GREAT, "frequency_watch": FREQUENCY_WATCH},
        "totals": client_row,
        "platforms": {k: _ad_metrics(v) for k, v in platforms.items()},
        "campaigns": campaigns,
        "adsets": adsets,
    }

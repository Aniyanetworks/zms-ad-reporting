"""AI analysis bundle — everything we collect for one client (or every active
client) as a single JSON document, meant to be handed to an AI reviewer rather
than read by a person. Carl, 2026-09-23: "collect creatives, ad sets and everything,
maybe not for the report, so I can give it to AI to analyze."

Read-only; any signed-in dashboard role may download it (no secrets inside)."""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from app.core.db import fetch, fetchrow
from app.core.security import CurrentUser

router = APIRouter(tags=["export"])

CLIENT_SQL = """
select id, name, slug, trade, default_service, booking_system, timezone,
       meta_ad_account_id, google_ads_customer_id, google_lsa_customer_id,
       cpl_target_green, cpl_target_red, target_cpl, target_cpba,
       avg_job_value, close_rate, gross_margin_pct, max_ad_cost_share
from clients where slug = $1
"""

CAMPAIGNS_SQL = """
select m.platform, m.campaign_id, max(m.campaign_name) campaign_name, max(m.campaign_status) campaign_status,
       max(coalesce(csm.service, c.default_service)) service,
       sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks,
       sum(m.leads) leads, sum(m.phone_calls) phone_calls, max(m.currency) currency,
       min(m.date) first_date, max(m.date) last_date
from ad_metrics_daily m
join clients c on c.id = m.client_id
left join campaign_service_map csm on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
where m.client_id = $1 and m.date between $2 and $3
group by m.platform, m.campaign_id
order by sum(m.spend) desc
"""

CAMPAIGN_DAILY_SQL = """
select platform, campaign_id, date, spend, impressions, clicks, leads, phone_calls
from ad_metrics_daily where client_id = $1 and date between $2 and $3
order by platform, campaign_id, date
"""

ADSETS_SQL = """
select campaign_id, adset_id, max(adset_name) adset_name,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(leads) leads,
       min(date) first_date, max(date) last_date
from adset_metrics_daily where client_id = $1 and platform = 'meta' and date between $2 and $3
group by campaign_id, adset_id order by sum(spend) desc
"""

ADSET_DAILY_SQL = """
select adset_id, date, spend, impressions, clicks, leads
from adset_metrics_daily where client_id = $1 and platform = 'meta' and date between $2 and $3
order by adset_id, date
"""

ADS_SQL = """
select m.campaign_id, m.adset_id, m.ad_id, max(m.ad_name) ad_name,
       sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads,
       min(m.date) first_date, max(m.date) last_date,
       max(c.status) status, max(c.effective_status) effective_status, max(c.created_time) created_time,
       max(c.title) title, max(c.body) body, max(c.description) description, max(c.cta_type) cta_type,
       max(c.link_url) link_url, max(c.url_tags) url_tags, bool_or(c.has_adset_utm) has_adset_utm,
       max(c.preview_link) preview_link, max(c.thumbnail_url) thumbnail_url,
       max(c.image_url) image_url, max(c.video_id) video_id,
       (array_agg(c.asset_feed_spec) filter (where c.asset_feed_spec is not null))[1] asset_feed_spec
from ad_level_metrics_daily m
left join meta_ad_creatives c on c.ad_id = m.ad_id
where m.client_id = $1 and m.platform = 'meta' and m.date between $2 and $3
group by m.campaign_id, m.adset_id, m.ad_id order by sum(m.spend) desc
"""

AD_DAILY_SQL = """
select ad_id, date, spend, impressions, clicks, leads
from ad_level_metrics_daily where client_id = $1 and platform = 'meta' and date between $2 and $3
order by ad_id, date
"""

G_ADGROUPS_SQL = """
select campaign_id, max(campaign_name) campaign_name, ad_group_id, max(ad_group_name) ad_group_name,
       max(ad_group_status) status, max(ad_group_type) type,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions, sum(phone_calls) phone_calls
from google_adgroup_metrics_daily where client_id = $1 and date between $2 and $3
group by campaign_id, ad_group_id order by sum(spend) desc
"""

G_ADS_SQL = """
select campaign_id, ad_group_id, max(ad_group_name) ad_group_name, ad_id, max(ad_name) ad_name, max(ad_type) ad_type,
       max(ad_status) status, max(ad_strength) ad_strength,
       (array_agg(final_urls order by date desc))[1] final_urls,
       (array_agg(headlines order by date desc))[1] headlines,
       (array_agg(descriptions order by date desc))[1] descriptions,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
from google_ad_metrics_daily where client_id = $1 and date between $2 and $3
group by campaign_id, ad_group_id, ad_id order by sum(spend) desc
"""

G_KEYWORDS_SQL = """
select campaign_id, ad_group_id, criterion_id, max(keyword_text) keyword_text, max(match_type) match_type,
       max(keyword_status) status,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
from google_keyword_metrics_daily where client_id = $1 and date between $2 and $3
group by campaign_id, ad_group_id, criterion_id order by sum(spend) desc
"""

G_SEARCH_TERMS_SQL = """
select campaign_id, ad_group_id, search_term, max(term_status) term_status,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
from google_search_terms_daily where client_id = $1 and date between $2 and $3
group by campaign_id, ad_group_id, search_term order by sum(spend) desc, sum(impressions) desc
limit 2000
"""

GHL_DAILY_SQL = """
select date, contacts_created, contacts_paid_attributed, inbound_calls, leads_dq,
       appointments_booked as appointments_paid, appointments_all, jobs_won, revenue_won
from ghl_metrics_daily where client_id = $1 and date between $2 and $3 order by date
"""

GHL_ADSET_SQL = """
select adset_name, sum(contacts_paid) contacts_paid, sum(appointments) appointments
from ghl_adset_daily where client_id = $1 and date between $2 and $3
group by adset_name order by sum(appointments) desc
"""

TARGETS_SQL = "select service, platform, cpl_green, cpl_red, cpba_green, cpba_red, source from service_targets order by service, platform"

BRIEF_SQL = """
select brief_date, window_start, window_end, score, summary_md, platforms, findings
from daily_briefs where client_id = $1 order by brief_date desc limit 1
"""

RECS_SQL = """
select created_at, entity_type, entity_id, entity_name, action, current_value, proposed_value, pct_change,
       reason, evidence, risk, status
from recommendations where client_id = $1 and created_at >= $2 order by created_at desc limit 200
"""


def _plain(v: Any) -> Any:
    """asyncpg Record / Decimal / date → JSON-safe."""
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if hasattr(v, "keys"):  # asyncpg.Record
        return {k: _plain(v[k]) for k in v.keys()}
    return v


def _derive(d: dict) -> dict:
    spend = float(d.get("spend") or 0)
    imps = int(d.get("impressions") or 0)
    clicks = int(d.get("clicks") or 0)
    leads = float(d.get("leads") if d.get("leads") is not None else d.get("conversions") or 0)
    d["ctr"] = round(clicks / imps, 4) if imps else None
    d["cpm"] = round(spend / imps * 1000, 2) if imps else None
    d["cpc"] = round(spend / clicks, 2) if clicks else None
    d["cpl"] = round(spend / leads, 2) if leads else None
    return d


def _attach_daily(rows: list[dict], daily: list[dict], key: tuple[str, ...]) -> None:
    by_key: dict[tuple, list] = {}
    for r in daily:
        by_key.setdefault(tuple(r[k] for k in key), []).append({k: v for k, v in r.items() if k not in key})
    for r in rows:
        r["daily"] = by_key.get(tuple(r[k] for k in key), [])


async def build_bundle(slug: str, start: date, end: date, include_daily: bool = True) -> dict:
    client = await fetchrow(CLIENT_SQL, slug)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    cid = client["id"]

    campaigns = [_derive(_plain(r)) for r in await fetch(CAMPAIGNS_SQL, cid, start, end)]
    adsets = [_derive(_plain(r)) for r in await fetch(ADSETS_SQL, cid, start, end)]
    ads = [_derive(_plain(r)) for r in await fetch(ADS_SQL, cid, start, end)]
    if include_daily:
        _attach_daily(campaigns, [_plain(r) for r in await fetch(CAMPAIGN_DAILY_SQL, cid, start, end)], ("platform", "campaign_id"))
        _attach_daily(adsets, [_plain(r) for r in await fetch(ADSET_DAILY_SQL, cid, start, end)], ("adset_id",))
        _attach_daily(ads, [_plain(r) for r in await fetch(AD_DAILY_SQL, cid, start, end)], ("ad_id",))

    google = {
        "ad_groups": [_derive(_plain(r)) for r in await fetch(G_ADGROUPS_SQL, cid, start, end)],
        "ads": [_derive(_plain(r)) for r in await fetch(G_ADS_SQL, cid, start, end)],
        "keywords": [_derive(_plain(r)) for r in await fetch(G_KEYWORDS_SQL, cid, start, end)],
        "search_terms": [_derive(_plain(r)) for r in await fetch(G_SEARCH_TERMS_SQL, cid, start, end)],
    }
    brief = await fetchrow(BRIEF_SQL, cid)
    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "notes": {
            "leads": "platform-reported leads (Meta lead forms / website leads, Google conversions)",
            "appointments_paid": "GHL bookings whose contact came from paid Meta/Google traffic (the number the dashboard uses)",
            "appointments_all": "every booking in the GHL 'scheduled' stage regardless of source",
            "meta_ads.asset_feed_spec": "dynamic-creative variants (all headlines/bodies/descriptions) when present",
            "google.search_terms": "capped at the top 2,000 terms by spend for the range",
        },
        "client": _plain(client),
        "service_targets": [_plain(r) for r in await fetch(TARGETS_SQL)],
        "campaigns": campaigns,
        "meta_adsets": adsets,
        "meta_ads": ads,
        "google": google,
        "ghl_daily": [_plain(r) for r in await fetch(GHL_DAILY_SQL, cid, start, end)],
        "ghl_by_adset": [_plain(r) for r in await fetch(GHL_ADSET_SQL, cid, start, end)],
        "latest_brief": _plain(brief) if brief else None,
        "recommendations": [_plain(r) for r in await fetch(RECS_SQL, cid, datetime.combine(start, datetime.min.time()))],
    }


@router.get("/clients/{slug}/ai-bundle")
async def client_ai_bundle(
    slug: str,
    user: CurrentUser,
    start: date = Query(default=None),
    end: date = Query(default=None),
    daily: bool = Query(default=True, description="include per-day series under each campaign/ad set/ad"),
    download: bool = Query(default=False, description="send as a file attachment"),
):
    """One client's full dataset for the range (default: last 30 complete days)."""
    end = end or (date.today() - timedelta(days=1))
    start = start or (end - timedelta(days=29))
    if (end - start).days > 400:
        raise HTTPException(status_code=400, detail="range too large (max 400 days)")
    bundle = await build_bundle(slug, start, end, include_daily=daily)
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{slug}-ads-data-{start}_{end}.json"'
    return JSONResponse(bundle, headers=headers)


@router.get("/export/ai-bundle")
async def portfolio_ai_bundle(
    user: CurrentUser,
    start: date = Query(default=None),
    end: date = Query(default=None),
    daily: bool = Query(default=False),
    download: bool = Query(default=False),
):
    """Every active client in one document (daily series off by default to keep it small)."""
    end = end or (date.today() - timedelta(days=1))
    start = start or (end - timedelta(days=29))
    if (end - start).days > 120:
        raise HTTPException(status_code=400, detail="range too large for the portfolio bundle (max 120 days)")
    slugs = [r["slug"] for r in await fetch("select slug from clients where is_active order by slug")]
    bundles = [await build_bundle(s, start, end, include_daily=daily) for s in slugs]
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="zms-portfolio-ads-data-{start}_{end}.json"'
    return JSONResponse(
        {"generated_at": datetime.utcnow().isoformat() + "Z", "range": {"start": start.isoformat(), "end": end.isoformat()},
         "clients": bundles},
        headers=headers,
    )

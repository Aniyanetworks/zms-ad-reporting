"""Google Ads decision report for one client: campaign → ad groups → ads (RSA copy),
keywords, search terms, landing pages, with the waste signals that the 2026-09-23
review found by hand (unmanaged search-term spend, junk-traffic pattern, competitor
terms, weak RSAs, broken landing pages)."""
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.core.db import fetch, fetchrow
from app.core.security import CurrentUser

router = APIRouter(tags=["google-ads"])

CAMPAIGNS_SQL = """
select m.campaign_id, max(m.campaign_name) campaign_name, max(m.campaign_status) campaign_status,
       sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) conversions,
       sum(m.phone_calls) phone_calls, min(m.date) first_date, max(m.date) last_date,
       sum(m.spend) filter (where m.date > $3::date - 7) spend_7d,
       sum(m.leads) filter (where m.date > $3::date - 7) conv_7d
from ad_metrics_daily m
where m.client_id = $1 and m.platform = 'google' and m.date between $2 and $3
group by m.campaign_id order by sum(m.spend) desc
"""

ADGROUPS_SQL = """
select campaign_id, ad_group_id, max(ad_group_name) ad_group_name, max(ad_group_status) status, max(ad_group_type) type,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions, sum(phone_calls) phone_calls
from google_adgroup_metrics_daily where client_id = $1 and date between $2 and $3
group by campaign_id, ad_group_id order by sum(spend) desc
"""

ADS_SQL = """
select campaign_id, ad_group_id, max(ad_group_name) ad_group_name, ad_id, max(ad_type) ad_type, max(ad_status) status,
       max(ad_strength) ad_strength,
       (array_agg(final_urls order by date desc))[1] final_urls,
       (array_agg(headlines order by date desc))[1] headlines,
       (array_agg(descriptions order by date desc))[1] descriptions,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
from google_ad_metrics_daily where client_id = $1 and date between $2 and $3
group by campaign_id, ad_group_id, ad_id order by sum(spend) desc
"""

KEYWORDS_SQL = """
select campaign_id, ad_group_id, criterion_id, max(keyword_text) keyword_text, max(match_type) match_type,
       max(keyword_status) status, sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
from google_keyword_metrics_daily where client_id = $1 and date between $2 and $3
group by campaign_id, ad_group_id, criterion_id order by sum(spend) desc
"""

TERMS_SQL = """
select campaign_id, search_term, max(term_status) term_status,
       sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
from google_search_terms_daily where client_id = $1 and date between $2 and $3
group by campaign_id, search_term order by sum(spend) desc, sum(clicks) desc
"""

LANDING_SQL = """
select url, platforms, spend_30d, http_status, final_url, title, has_form, has_tel_link, looks_thank_you,
       client_rendered, flags, status, error, checked_at
from landing_page_checks where client_id = $1 order by spend_30d desc
"""

# Words that mean the searcher wanted something we don't sell or a competitor.
OFF_INTENT = ("how to", "diy", "ideas", "pictures", "jobs", "salary", "near me free", "cheap", "free ",
              "repair", "fix", "windshield", "car ", "auto ", "paint for", "spray paint", "home depot", "lowes", "ikea",
              "wikipedia", "reddit", "youtube", "software", "template", "course")


def _f(v) -> float:
    return float(v or 0)


def _derive(d: dict) -> dict:
    spend, clicks, imps = _f(d.get("spend")), int(d.get("clicks") or 0), int(d.get("impressions") or 0)
    conv = _f(d.get("conversions"))
    d["spend"], d["clicks"], d["impressions"], d["conversions"] = spend, clicks, imps, conv
    d["ctr"] = round(clicks / imps, 4) if imps else None
    d["cpc"] = round(spend / clicks, 2) if clicks else None
    d["cost_per_conv"] = round(spend / conv, 2) if conv else None
    for k in ("first_date", "last_date", "checked_at"):
        if d.get(k) is not None and hasattr(d[k], "isoformat"):
            d[k] = d[k].isoformat()
    return d


def _term_flag(t: dict) -> str | None:
    text = f" {t['search_term'].lower()} "
    if any(w in text for w in OFF_INTENT):
        return "off-intent"
    if t["conversions"] > 0:
        return "converting"
    if t["term_status"] == "NONE" and t["clicks"] >= 3 and t["conversions"] == 0:
        return "unmanaged, no conv"
    if t["term_status"] == "NONE":
        return "not a keyword"
    return None


def _campaign_flags(c: dict, adgroups: list, ads: list, keywords: list, terms: list, landing: dict[str, dict],
                    green: float, red: float) -> list[dict]:
    flags: list[dict] = []
    spend, clicks, conv = c["spend"], c["clicks"], c["conversions"]
    # Junk-traffic pattern: sub-$1.50 CPC, hundreds of clicks, nothing converts (search partners / display expansion / broad).
    if clicks >= 200 and c["cpc"] is not None and c["cpc"] < 1.5 and conv == 0:
        flags.append({"level": "red", "text": f"{clicks} clicks at ${c['cpc']:.2f} CPC and 0 conversions — junk traffic (broad match, search partners or display expansion). Pause or rebuild."})
    elif spend >= max(150.0, 2 * green) and conv == 0:
        flags.append({"level": "red", "text": f"${spend:,.0f} spent, 0 conversions."})
    if c["cost_per_conv"] is not None and conv >= 3 and c["cost_per_conv"] > red:
        flags.append({"level": "yellow", "text": f"${c['cost_per_conv']:,.0f} per conversion vs ≤${red:,.0f} red line."})
    if c.get("spend_7d", 0) >= 300 and c.get("conv_7d", 0) == 0 and conv > 0:
        flags.append({"level": "red", "text": f"No conversions in the last 7 days on ${c['spend_7d']:,.0f} — check the conversion tag before touching bids."})
    tspend = sum(t["spend"] for t in terms)
    unmanaged = sum(t["spend"] for t in terms if t["term_status"] == "NONE")
    if tspend >= 200 and unmanaged / tspend > 0.5:
        flags.append({"level": "yellow", "text": f"{unmanaged / tspend:.0%} of search-term spend (${unmanaged:,.0f}) is on queries that aren't keywords — add negatives and move winners to exact."})
    off = sum(t["spend"] for t in terms if t.get("flag") == "off-intent")
    if off >= 50:
        flags.append({"level": "yellow", "text": f"${off:,.0f} on off-intent queries (repair / DIY / how-to / auto)."})
    broad = sum(k["spend"] for k in keywords if k["match_type"] == "BROAD")
    kspend = sum(k["spend"] for k in keywords)
    if kspend >= 100 and broad / kspend > 0.5:
        flags.append({"level": "yellow", "text": f"{broad / kspend:.0%} of keyword spend is broad match."})
    weak = [a for a in ads if a["ad_type"] == "RESPONSIVE_SEARCH_AD" and (len(a["headlines"] or []) < 8 or (a["ad_strength"] or "") in ("POOR", "AVERAGE"))]
    if weak:
        flags.append({"level": "yellow", "text": f"{len(weak)} RSA{'s' if len(weak) != 1 else ''} with under 8 headlines or Poor/Average strength."})
    urls = {u for a in ads for u in (a["final_urls"] or [])}
    for u in urls:
        lp = landing.get(u)
        if lp and lp["status"] == "red":
            flags.append({"level": "red", "text": f"Landing page {u}: {', '.join(lp['flags']) or lp['error'] or 'failing'}."})
    if len(adgroups) == 1 and len(keywords) >= 15:
        intents = {k["keyword_text"].split()[-1] for k in keywords if k["keyword_text"]}
        if len(intents) >= 4:
            flags.append({"level": "info", "text": f"One ad group holds {len(keywords)} keywords across mixed intents — split by intent so each RSA matches its query."})
    return flags


@router.get("/clients/{slug}/google-ads")
async def google_ads_report(
    slug: str,
    user: CurrentUser,
    start: date = Query(...),
    end: date = Query(...),
    limit: int = Query(default=25, ge=5, le=200),
) -> dict[str, Any]:
    client = await fetchrow(
        "select id, name, slug, google_ads_customer_id, cpl_target_green, cpl_target_red from clients where slug = $1", slug)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    cid = client["id"]
    green, red = float(client["cpl_target_green"]), float(client["cpl_target_red"])

    campaigns = [_derive(dict(r)) for r in await fetch(CAMPAIGNS_SQL, cid, start, end)]
    adgroups = [_derive(dict(r)) for r in await fetch(ADGROUPS_SQL, cid, start, end)]
    ads = [_derive(dict(r)) for r in await fetch(ADS_SQL, cid, start, end)]
    keywords = [_derive(dict(r)) for r in await fetch(KEYWORDS_SQL, cid, start, end)]
    terms = [_derive(dict(r)) for r in await fetch(TERMS_SQL, cid, start, end)]
    for t in terms:
        t["flag"] = _term_flag(t)
    landing_rows = [_derive(dict(r)) for r in await fetch(LANDING_SQL, cid)]
    budgets = {r["campaign_id"]: dict(r) for r in await fetch(
        "select campaign_id, status, daily_budget, lifetime_budget from campaign_budgets where client_id = $1 and platform = 'google' and entity_type = 'campaign'", cid)}
    landing = {r["url"]: r for r in landing_rows}

    for c in campaigns:
        c["spend_7d"], c["conv_7d"] = _f(c.get("spend_7d")), _f(c.get("conv_7d"))
        b = budgets.get(c["campaign_id"]) or {}
        c["daily_budget"] = _f(b.get("daily_budget")) or None
        c["lifetime_budget"] = _f(b.get("lifetime_budget")) or None
        c_ag = [a for a in adgroups if a["campaign_id"] == c["campaign_id"]]
        c_ads = [a for a in ads if a["campaign_id"] == c["campaign_id"]]
        c_kw = [k for k in keywords if k["campaign_id"] == c["campaign_id"]]
        c_terms = [t for t in terms if t["campaign_id"] == c["campaign_id"]]
        tspend = sum(t["spend"] for t in c_terms)
        c["ad_groups"] = c_ag
        c["ads"] = c_ads
        c["keywords"] = c_kw[:limit]
        c["keyword_count"] = len(c_kw)
        c["match_mix"] = {mt: round(sum(k["spend"] for k in c_kw if k["match_type"] == mt), 2) for mt in ("EXACT", "PHRASE", "BROAD")}
        c["search_terms"] = c_terms[:limit]
        c["converting_terms"] = [t for t in c_terms if t["conversions"] > 0][:limit]
        c["term_stats"] = {
            "terms": len(c_terms), "spend": round(tspend, 2),
            "unmanaged_spend": round(sum(t["spend"] for t in c_terms if t["term_status"] == "NONE"), 2),
            "off_intent_spend": round(sum(t["spend"] for t in c_terms if t.get("flag") == "off-intent"), 2),
            "zero_conv_spend": round(sum(t["spend"] for t in c_terms if t["clicks"] >= 3 and t["conversions"] == 0), 2),
            "converting_spend": round(sum(t["spend"] for t in c_terms if t["conversions"] > 0), 2),
        }
        c["landing_pages"] = [landing[u] for a in c_ads for u in (a["final_urls"] or []) if u in landing]
        # dedupe landing pages preserving order
        seen: set[str] = set()
        c["landing_pages"] = [lp for lp in c["landing_pages"] if not (lp["url"] in seen or seen.add(lp["url"]))]
        c["flags"] = _campaign_flags(c, c_ag, c_ads, c_kw, c_terms, landing, green, red)

    totals = {
        "spend": round(sum(c["spend"] for c in campaigns), 2),
        "clicks": sum(c["clicks"] for c in campaigns),
        "conversions": round(sum(c["conversions"] for c in campaigns), 1),
        "phone_calls": round(sum(_f(c.get("phone_calls")) for c in campaigns), 1),
        "term_spend": round(sum(t["spend"] for t in terms), 2),
        "unmanaged_spend": round(sum(t["spend"] for t in terms if t["term_status"] == "NONE"), 2),
        "off_intent_spend": round(sum(t["spend"] for t in terms if t.get("flag") == "off-intent"), 2),
        "match_mix": {mt: round(sum(k["spend"] for k in keywords if k["match_type"] == mt), 2) for mt in ("EXACT", "PHRASE", "BROAD")},
        "red_flags": sum(1 for c in campaigns for f in c["flags"] if f["level"] == "red"),
        "yellow_flags": sum(1 for c in campaigns for f in c["flags"] if f["level"] == "yellow"),
    }
    return {
        "client": {"name": client["name"], "slug": client["slug"], "customer_id": client["google_ads_customer_id"],
                   "cpl_target_green": green, "cpl_target_red": red},
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "totals": totals,
        "campaigns": campaigns,
        "landing_pages": landing_rows,
    }

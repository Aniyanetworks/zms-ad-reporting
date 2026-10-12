"""Creative / structure diagnostics from the Meta Ad Mastery material (lead-gen-systems skill:
meta-lead-gen-ops.md + kill-scale-sop.md §4), computed nightly per client for Meta.

Each signal names ONE play — the specific change to make — so the brief, the Slack report
and the dashboard can say "new hook" / "new angle" / "fix the form" instead of a generic
"creative problem". Checks (last 7 complete days vs the 7 before):

1. Form-through rate = leads ÷ unique link clicks (the course's custom metric). Good CTR +
   low form-through = the form / offer, not the ad.
2. Click → landing-page-view ratio on website ads. Low = page speed or ad/page mismatch.
3. Hook vs hold on video ads: hook <20% new hook; 20–25% sharpen; good hook + hold <20% =
   attention without payoff; low hook + high hold = right audience, swap the first 3 s only.
4. Lead death pattern: strong first week, collapsing second = the angle doesn't scale →
   new angle (offer, then creative), not a tweak.
5. Real fatigue = frequency AND cost-per-1,000-reached (CPMr) rising together while
   results drop and the ad set's bookings aren't holding up. Never a pause signal —
   "fatigue is a limiting belief": launch the replacement as a fresh test.
6. Structure: 3–5 ads per ad set (~1 per $10/day); budget that can't buy one lead a day →
   consolidate; <1 conversion a day → the ad set "gets lost".
7. Creative diversity: one concept with copy variations is not diversity.
8. Cost per unique link click above $3–4 (with CTR under 1%).

Thresholds the course states are used as given; those it leaves open (form-through, the
landing-page-view ratio) are labelled as working thresholds in the evidence.
Read-only: never touches Meta.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from statistics import median

from app.services import pg

# --- thresholds (course values unless marked "working")
HOOK_LOW, HOOK_BORDER = 0.20, 0.25
HOLD_LOW, HOLD_HIGH = 0.20, 0.40
VIDEO_SHARE = 0.05              # 3-second plays ≥ 5% of impressions → treat the ad as video
MIN_IMPS = 1500
CTR_LOW = 0.01
CPC_WARN = 4.0                  # "$3–$4 upper range for cost per unique link click"
FT_MIN_CLICKS = 40
FT_ABS_LOW = 0.05               # working threshold: <5% of clickers submit
LPV_MIN_CLICKS = 30
LPV_LOW = 0.60                  # working threshold: <60% of clicks load the page
PAGE_CVR_LOW = 0.03             # working threshold: page loads but <3% become leads
FATIGUE_RISE = 0.20             # frequency and CPMr both up ≥20%
FATIGUE_MIN_SPEND = 100.0
LEAD_DEATH_DROP = 0.40          # last-7 leads ≤ 40% of first-7
ADS_PER_BUDGET = 10.0           # ~1 ad per $10/day
MAX_SIGNALS = 8

PLAY = {
    "new_hook": "New hook", "sharper_hook": "Sharpen hook", "fix_promise": "Deliver the promise sooner",
    "swap_open": "Swap the first 3 seconds", "new_angle": "New angle", "fix_form": "Fix form / offer",
    "fix_page": "Fix landing page", "fresh_test": "Launch fresh test", "trim_ads": "Too many ads",
    "add_ads": "Add ads", "consolidate": "Consolidate budget", "add_diversity": "Add a new concept",
}

AD_SQL = """
select l.ad_id, l.adset_id, l.campaign_id, (l.date > %(end)s - 7) cur, max(l.ad_name) ad_name,
       sum(l.spend) spend, sum(l.impressions) imps, sum(l.clicks) clicks, sum(l.leads) leads, sum(l.reach) reach,
       sum(l.unique_link_clicks) ulc, sum(l.unique_outbound_clicks) uoc,
       sum(l.video_3s_plays) v3, sum(l.thruplays) thru,
       sum((select coalesce(sum((a->>'value')::numeric), 0) from jsonb_array_elements(coalesce(l.raw->'actions', '[]'::jsonb)) a
            where a->>'action_type' = 'landing_page_view')) lpv
from ad_level_metrics_daily l
where l.client_id = %(cid)s and l.platform = 'meta' and l.date > %(end)s - 14 and l.date <= %(end)s
group by l.ad_id, l.adset_id, l.campaign_id, (l.date > %(end)s - 7)
"""

NAMES_SQL = """
select 'campaign' kind, campaign_id id, max(campaign_name) name from ad_metrics_daily
 where client_id = %(cid)s and platform = 'meta' and date > %(end)s - 30 group by campaign_id
union all
select 'adset', adset_id, max(adset_name) from adset_metrics_daily
 where client_id = %(cid)s and platform = 'meta' and date > %(end)s - 30 group by adset_id
"""

CREATIVES_SQL = """
select cr.ad_id, cr.title, cr.body, cr.video_id, cr.image_url, cr.link_url, cr.effective_status
from meta_ad_creatives cr
where cr.ad_id = any(%(ads)s)
"""

BOOKINGS_SQL = """
select adset_name, sum(appointments) filter (where date > %(end)s - 7) cur, sum(appointments) filter (where date <= %(end)s - 7) prev
from ghl_adset_daily where client_id = %(cid)s and date > %(end)s - 14 and date <= %(end)s group by adset_name
"""

BUDGETS_SQL = """
select entity_type, entity_id, campaign_id, status, daily_budget, budget_source
from campaign_budgets where client_id = %(cid)s and platform = 'meta'
"""

CAMPAIGN_DAILY_SQL = """
select campaign_id, date, sum(leads) leads, sum(spend) spend
from ad_metrics_daily where client_id = %(cid)s and platform = 'meta' and date > %(end)s - 45 and date <= %(end)s
group by campaign_id, date
"""


def _f(v) -> float:
    return float(v or 0)


def _m(v: float | None) -> str:
    return "—" if v is None else (f"${v:,.0f}" if v >= 100 else f"${v:,.2f}")


def _pct(v: float | None, nd: int = 0) -> str:
    return "—" if v is None else f"{v * 100:.{nd}f}%"


def _norm(s: str | None, n: int) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()[:n]


def _is_form(link: str | None) -> bool:
    return not link or "fb.me" in link or "facebook.com" in link


def _signal(play: str, sev: str, entity_type: str, entity_id: str, entity_name: str, campaign: str | None,
            text: str, next_step: str, spend: float, evidence: dict) -> dict:
    return {"kind": "creative_signal", "play": play, "label": PLAY[play], "severity": sev,
            "entity_type": entity_type, "entity_id": entity_id, "entity_name": entity_name,
            "campaign": campaign, "message": f"{entity_name}: {PLAY[play].lower()} — {text}",
            "text": text, "next_step": next_step, "spend": round(spend, 2), "evidence": evidence,
            "action": None}


def _struggling(bookings: dict, adset_name: str | None, leads_cur: float, leads_prev: float) -> bool:
    """The course judges creative on results: a check only turns yellow when the ad set's
    bookings (or, without bookings, its leads) are zero or falling."""
    b_cur, b_prev = bookings.get(adset_name or "", (None, None))
    if b_cur is not None and (b_cur or b_prev):
        return b_cur == 0 or b_cur < b_prev
    return leads_cur == 0 or (leads_prev > 0 and leads_cur < 0.7 * leads_prev)


def analyze(client_id: str, a_end: date) -> dict:
    """Return {"ads": [per-ad metrics rows], "signals": [creative_signal findings]}."""
    p = {"cid": client_id, "end": a_end}
    names = {(r["kind"], r["id"]): r["name"] for r in pg.query(NAMES_SQL, p)}
    rows = [dict(r) for r in pg.query(AD_SQL, p)]
    ads: dict[str, dict] = {}
    for r in rows:
        a = ads.setdefault(r["ad_id"], {"ad_id": r["ad_id"], "adset_id": r["adset_id"], "campaign_id": r["campaign_id"],
                                        "ad_name": r["ad_name"], "cur": {}, "prev": {}})
        a["cur" if r["cur"] else "prev"] = {k: _f(r[k]) for k in ("spend", "imps", "clicks", "leads", "reach", "ulc", "uoc", "v3", "thru", "lpv")}
        if r["cur"]:
            a["ad_name"] = r["ad_name"] or a["ad_name"]
    if not ads:
        return {"ads": [], "signals": []}
    creatives = {r["ad_id"]: dict(r) for r in pg.query(CREATIVES_SQL, {"ads": list(ads)})}
    bookings = {r["adset_name"]: (_f(r["cur"]), _f(r["prev"])) for r in pg.query(BOOKINGS_SQL, p)}
    budgets = {(r["entity_type"], r["entity_id"]): dict(r) for r in pg.query(BUDGETS_SQL, p)}

    signals: list[dict] = []
    out_rows: list[dict] = []

    # ---- per-ad metrics
    for a in ads.values():
        c, pv = a["cur"], a["prev"]
        cr = creatives.get(a["ad_id"], {})
        form = _is_form(cr.get("link_url"))
        a["campaign"] = names.get(("campaign", a["campaign_id"]))
        a["adset"] = names.get(("adset", a["adset_id"]))
        a["format"] = "video" if (cr.get("video_id") or (c.get("imps") and c.get("v3", 0) >= VIDEO_SHARE * c["imps"])) else "image"
        a["destination"] = "instant form" if form else "website"
        imps = c.get("imps", 0)
        unique = (c.get("uoc", 0) if (not form and c.get("uoc", 0) >= 0.5 * c.get("ulc", 0) and c.get("uoc", 0) > 0) else c.get("ulc", 0)) or c.get("clicks", 0)
        a["m"] = m = {
            "spend": c.get("spend", 0), "imps": imps, "leads": c.get("leads", 0), "unique_clicks": unique,
            "ctr": unique / imps if imps else None,
            "cpc": c.get("spend", 0) / unique if unique else None,
            "cpl": c.get("spend", 0) / c["leads"] if c.get("leads") else None,
            "hook": c.get("v3", 0) / imps if imps and c.get("v3") else None,
            "hold": c.get("thru", 0) / c["v3"] if c.get("v3") else None,
            "form_through": c.get("leads", 0) / c["ulc"] if form and c.get("ulc") else None,
            "lpv_ratio": c.get("lpv", 0) / unique if not form and unique else None,
            "page_cvr": c.get("leads", 0) / c["lpv"] if not form and c.get("lpv") else None,
            "freq": imps / c["reach"] if c.get("reach") else None,
            "freq_prev": pv.get("imps", 0) / pv["reach"] if pv.get("reach") else None,
            "cpmr": c.get("spend", 0) * 1000 / c["reach"] if c.get("reach") else None,
            "cpmr_prev": pv.get("spend", 0) * 1000 / pv["reach"] if pv.get("reach") else None,
            "cpl_prev": pv.get("spend", 0) / pv["leads"] if pv.get("leads") else None,
            "spend_prev": pv.get("spend", 0), "leads_prev": pv.get("leads", 0),
        }

    live = [a for a in ads.values() if a["m"]["spend"] > 0]
    fts = [a["m"]["form_through"] for a in live if a["m"]["form_through"] is not None and a["cur"].get("ulc", 0) >= FT_MIN_CLICKS]
    ft_median = median(fts) if len(fts) >= 3 else None

    for a in live:
        m, name, camp = a["m"], a["ad_name"] or a["ad_id"], a["campaign"]
        ad_signals: list[dict] = []
        ev = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()}
        # 3. hook vs hold (video only)
        if a["format"] == "video" and m["imps"] >= MIN_IMPS and m["hook"] is not None and m["hook"] >= VIDEO_SHARE:
            hook, hold = m["hook"], m["hold"]
            if hook < HOOK_LOW and hold is not None and hold >= HOLD_HIGH:
                ad_signals.append(_signal("swap_open", "yellow", "ad", a["ad_id"], name, camp,
                    f"hook {_pct(hook)} (<20%) but hold {_pct(hold)} — the right people stay, too few are stopped",
                    "Re-cut only the first 3 seconds (new opening shot / on-screen text); keep the rest of the video", m["spend"], ev))
            elif hook < HOOK_LOW:
                ad_signals.append(_signal("new_hook", "yellow", "ad", a["ad_id"], name, camp,
                    f"hook {_pct(hook)} (<20%) — the first 3 seconds aren't stopping the scroll",
                    "Test 2–3 new openings on the same video in a fresh test", m["spend"], ev))
            elif hook < HOOK_BORDER:
                ad_signals.append(_signal("sharper_hook", "info", "ad", a["ad_id"], name, camp,
                    f"hook {_pct(hook)} — borderline (20–25%)", "Test a sharper opening line / visual", m["spend"], ev))
            elif hold is not None and hold < HOLD_LOW and a["cur"].get("v3", 0) >= 300:
                ad_signals.append(_signal("fix_promise", "yellow", "ad", a["ad_id"], name, camp,
                    f"hook {_pct(hook)} is good but hold {_pct(hold)} (<20%) — attention without payoff",
                    "Deliver the offer / result in the first 5–7 seconds after the hook", m["spend"], ev))
        # 8 + message: low CTR
        if m["imps"] >= 2000 and m["ctr"] is not None and m["ctr"] < CTR_LOW:
            cpc = f", {_m(m['cpc'])} per unique click" if m["cpc"] else ""
            weak = _struggling(bookings, a["adset"], m["leads"], m["leads_prev"])
            ad_signals.append(_signal("new_angle", "yellow" if weak else "info", "ad", a["ad_id"], name, camp,
                f"unique CTR {_pct(m['ctr'], 2)} (<1%){cpc} — the message isn't landing"
                + ("" if weak else "; the ad set is still booking, so keep it running"),
                "Test a different angle / promise, not a copy tweak" if weak else "Test a new angle alongside it in a fresh test", m["spend"], ev))
        elif m["cpc"] is not None and m["cpc"] > CPC_WARN and m["unique_clicks"] >= 30:
            ad_signals.append(_signal("new_angle", "info", "ad", a["ad_id"], name, camp,
                f"{_m(m['cpc'])} per unique click (above the $3–4 range)", "Watch; test a stronger angle if bookings are weak", m["spend"], ev))
        # 1. form-through (instant forms)
        if m["form_through"] is not None and a["cur"].get("ulc", 0) >= FT_MIN_CLICKS and (m["ctr"] or 0) >= CTR_LOW:
            low_rel = ft_median is not None and m["form_through"] < 0.5 * ft_median
            if m["form_through"] < FT_ABS_LOW or low_rel:
                rel = f" vs {_pct(ft_median)} across this client's ads" if ft_median else ""
                ad_signals.append(_signal("fix_form", "yellow", "ad", a["ad_id"], name, camp,
                    f"only {_pct(m['form_through'])} of clickers submit{rel} — CTR is fine, so it's the form or offer",
                    "Rewrite the greeting screen and offer headline; keep fields and questions minimal until volume returns", m["spend"],
                    {**ev, "working_threshold": "form-through <5% or <half the client median"}))
        # 2. click → landing page view, page conversion (website ads)
        if m["lpv_ratio"] is not None and m["unique_clicks"] >= LPV_MIN_CLICKS:
            if m["lpv_ratio"] < LPV_LOW:
                ad_signals.append(_signal("fix_page", "yellow", "ad", a["ad_id"], name, camp,
                    f"only {_pct(m['lpv_ratio'])} of clicks load the page — slow page or ad/page mismatch",
                    "Check load time on mobile (<3 s) and that the page headline matches the ad", m["spend"],
                    {**ev, "working_threshold": "landing-page views <60% of unique clicks"}))
            elif m["page_cvr"] is not None and a["cur"].get("lpv", 0) >= 30 and m["page_cvr"] < PAGE_CVR_LOW:
                ad_signals.append(_signal("fix_page", "yellow", "ad", a["ad_id"], name, camp,
                    f"page loads fine but only {_pct(m['page_cvr'], 1)} of visitors become leads",
                    "Repair the page's offer, proof and form placement", m["spend"],
                    {**ev, "working_threshold": "leads <3% of landing-page views"}))
        # 5. real fatigue
        if (m["spend"] >= FATIGUE_MIN_SPEND and m["spend_prev"] >= FATIGUE_MIN_SPEND and m["freq"] and m["freq_prev"]
                and m["cpmr"] and m["cpmr_prev"]):
            f_up = m["freq"] / m["freq_prev"] - 1
            r_up = m["cpmr"] / m["cpmr_prev"] - 1
            worse = (m["cpl"] is None and m["leads_prev"] > 0) or (m["cpl"] and m["cpl_prev"] and m["cpl"] > 1.3 * m["cpl_prev"])
            b_cur, b_prev = bookings.get(a["adset"] or "", (0.0, 0.0))
            holding = b_cur > 0 and b_cur >= b_prev
            if f_up >= FATIGUE_RISE and r_up >= FATIGUE_RISE and worse and not holding:
                ad_signals.append(_signal("fresh_test", "yellow", "ad", a["ad_id"], name, camp,
                    f"frequency {m['freq_prev']:.1f}→{m['freq']:.1f} and cost per 1,000 reached {_m(m['cpmr_prev'])}→{_m(m['cpmr'])} while CPL rose — Meta is stuck in the same audience",
                    "Launch the replacement as a fresh test (new campaign/ad set); keep this ad running until the replacement proves itself — don't pause it", m["spend"],
                    {**ev, "adset_bookings_cur": b_cur, "adset_bookings_prev": b_prev}))
        signals += ad_signals
        a["plays"] = [s["play"] for s in ad_signals]

    # ---- per ad set: structure + diversity (6, 7)
    by_adset: dict[str, list[dict]] = {}
    for a in live:
        by_adset.setdefault(a["adset_id"], []).append(a)
    camp_adsets: dict[str, set[str]] = {}
    for a in live:
        camp_adsets.setdefault(a["campaign_id"], set()).add(a["adset_id"])
    camp_spend: dict[str, float] = {}
    for a in live:
        camp_spend[a["campaign_id"]] = camp_spend.get(a["campaign_id"], 0) + a["m"]["spend"]
    for adset_id, items in by_adset.items():
        camp_id = items[0]["campaign_id"]
        adset_name, camp = items[0]["adset"] or adset_id, items[0]["campaign"]
        spend7 = sum(i["m"]["spend"] for i in items)
        leads7 = sum(i["m"]["leads"] for i in items)
        b = budgets.get(("adset", adset_id))
        cb = budgets.get(("campaign", camp_id))
        budget, src = None, None
        if b and _f(b["daily_budget"]):
            budget, src = _f(b["daily_budget"]), "ad set"
        elif cb and _f(cb["daily_budget"]) and camp_spend.get(camp_id):
            budget, src = _f(cb["daily_budget"]) * spend7 / camp_spend[camp_id], "share of CBO"
        n = len(items)
        ev = {"ads": n, "daily_budget": round(budget, 2) if budget else None, "budget_source": src,
              "spend_7": round(spend7, 2), "leads_7": leads7}
        if budget and n > 5 and n > budget / ADS_PER_BUDGET + 1:
            signals.append(_signal("trim_ads", "yellow", "adset", adset_id, adset_name, camp,
                f"{n} ads on about {_m(budget)}/day ({src}) — about one ad per $10/day; spend is spread too thin for any ad to reach conversion volume",
                "Keep the 3–5 ads with the most bookings; move new creative into a fresh test", spend7, ev))
        cpl7 = spend7 / leads7 if leads7 else None
        if spend7 >= 100 and leads7 < 7:
            can_buy = f"can't buy one lead a day at a {_m(cpl7)} CPL" if (budget and cpl7 and budget < cpl7) else "under one lead a day"
            if (budget and cpl7 and budget < cpl7) or leads7 < 7:
                signals.append(_signal("consolidate", "yellow" if leads7 < 3 else "info", "adset", adset_id, adset_name, camp,
                    f"{leads7:.0f} lead{'s' if leads7 != 1 else ''} this week on {_m(spend7)}" + (f" (about {_m(budget)}/day)" if budget else "") + f" — {can_buy}; ad sets without 1–2 conversions a day get lost",
                    "Consolidate into one ad set with a budget of at least 2× CPL per day", spend7, ev))
        # 7. diversity
        if n >= 3:
            concepts = {(_norm(creatives.get(i["ad_id"], {}).get("title"), 40), _norm(creatives.get(i["ad_id"], {}).get("body"), 80)) for i in items}
            concepts.discard(("", ""))
            formats = {i["format"] for i in items}
            leads_prev = sum(i["m"]["leads_prev"] for i in items)
            if len(concepts) == 1:
                weak = _struggling(bookings, items[0]["adset"], leads7, leads_prev)
                signals.append(_signal("add_diversity", "yellow" if weak else "info", "adset", adset_id, adset_name, camp,
                    f"{n} ads but one concept ({'/'.join(sorted(formats))}) — copy variations of one angle aren't diversity; campaigns built this way die in week 2",
                    "Add a second angle (different promise or pain point), video first, in a fresh test", spend7, {**ev, "concepts": 1, "formats": sorted(formats)}))
        elif n < 3 and budget and budget >= 30 and spend7 >= 100:
            signals.append(_signal("add_ads", "info", "adset", adset_id, adset_name, camp,
                f"only {n} ad{'s' if n != 1 else ''} on ~{_m(budget)}/day", "Test 3–5 ads per ad set", spend7, ev))

    # ---- per campaign: lead death pattern (4)
    daily: dict[str, list[tuple[date, float]]] = {}
    for r in pg.query(CAMPAIGN_DAILY_SQL, p):
        daily.setdefault(r["campaign_id"], []).append((r["date"], _f(r["leads"])))
    for camp_id, pts in daily.items():
        pts.sort()
        first = pts[0][0]
        age = (a_end - first).days + 1
        if not 10 <= age <= 35:
            continue
        first7 = sum(l for d, l in pts if d < first + timedelta(days=7))
        last7 = sum(l for d, l in pts if d > a_end - timedelta(days=7))
        if first7 >= 10 and last7 <= LEAD_DEATH_DROP * first7:
            name = names.get(("campaign", camp_id)) or camp_id
            signals.append(_signal("new_angle", "yellow", "campaign", camp_id, name, name,
                f"lead death pattern — {first7:.0f} leads in week 1 → {last7:.0f} in the last 7 days ({age} days live); Meta used up the warm pocket and the angle didn't scale",
                "Biggest levers are offer, then creative: launch a new angle as a fresh test — don't tweak this one", 0.0,
                {"first7_leads": first7, "last7_leads": last7, "age_days": age}))

    # rank: yellow before info, then by spend; cap
    rank = {"red": 0, "yellow": 1, "info": 2}
    signals.sort(key=lambda s: (rank[s["severity"]], -s["spend"]))
    for a in live:
        out_rows.append({"ad_id": a["ad_id"], "ad_name": a["ad_name"], "campaign": a["campaign"], "adset": a["adset"],
                         "format": a["format"], "destination": a["destination"], "plays": a.get("plays", []),
                         **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in a["m"].items()}})
    out_rows.sort(key=lambda r: -r["spend"])
    return {"ads": out_rows, "signals": signals[:MAX_SIGNALS], "ft_median": ft_median}

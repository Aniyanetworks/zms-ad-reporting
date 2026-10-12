"""Daily brief — the rules engine behind the Daily Brief page and the nightly
recommendations.

For each active client it compares the last 7 complete days with the 7 before,
per platform and per campaign, judges every number against the service targets
(app.services.targets → portfolio ±15% → client targets), and emits findings.
Findings that call for a change become `recommendations` rows in status
`proposed`; a human approves them in the dashboard and the plugin's /execute
performs them. This module never writes to Meta or Google.

Everything reads settled Supabase tables, so a full run is seconds and safe to
re-run for any date (it replaces that date's briefs).
"""
from __future__ import annotations

import json
from datetime import date, timedelta

from app.services import pg

WINDOW_DAYS = 7
MIN_LEADS_TO_SCORE = 3
SCALE_MIN_LEADS = 10
FATIGUE_MIN_SPEND = 100.0

# ---------------------------------------------------------------- data

CLIENTS_SQL = """
select c.id, c.slug, c.name, c.booking_system, c.default_service,
       c.cpl_target_green, c.cpl_target_red,
       c.avg_job_value, c.close_rate, c.gross_margin_pct, c.max_ad_cost_share
from clients c
where c.is_active
  and exists (select 1 from ad_metrics_daily m where m.client_id = c.id and m.date between %(b_start)s and %(a_end)s and m.spend > 0)
order by c.name
"""

PLATFORM_SQL = """
select platform,
       sum(spend) filter (where date between %(a_start)s and %(a_end)s) spend_a,
       sum(leads) filter (where date between %(a_start)s and %(a_end)s) leads_a,
       sum(spend) filter (where date between %(b_start)s and %(b_end)s) spend_b,
       sum(leads) filter (where date between %(b_start)s and %(b_end)s) leads_b
from ad_metrics_daily where client_id = %(cid)s and date between %(b_start)s and %(a_end)s
group by platform
"""

GHL_SQL = """
select
  sum(appointments_booked)      filter (where date between %(a_start)s and %(a_end)s) appts_a,
  sum(appointments_all)         filter (where date between %(a_start)s and %(a_end)s) appts_all_a,
  sum(contacts_paid_attributed) filter (where date between %(a_start)s and %(a_end)s) paid_a,
  sum(appointments_booked)      filter (where date between %(b_start)s and %(b_end)s) appts_b,
  sum(contacts_paid_attributed) filter (where date between %(b_start)s and %(b_end)s) paid_b
from ghl_metrics_daily where client_id = %(cid)s and date between %(b_start)s and %(a_end)s
"""

CAMPAIGNS_SQL = """
select m.platform, m.campaign_id, max(m.campaign_name) name, max(m.campaign_status) status,
       coalesce(max(csm.service), max(c.default_service), 'Unclassified') service,
       sum(m.spend) filter (where m.date between %(a_start)s and %(a_end)s) spend_a,
       sum(m.leads) filter (where m.date between %(a_start)s and %(a_end)s) leads_a,
       sum(m.clicks) filter (where m.date between %(a_start)s and %(a_end)s) clicks_a,
       sum(m.spend) filter (where m.date between %(b_start)s and %(b_end)s) spend_b,
       sum(m.leads) filter (where m.date between %(b_start)s and %(b_end)s) leads_b,
       (select min(x.date) from ad_metrics_daily x where x.client_id = m.client_id and x.campaign_id = m.campaign_id) first_seen
from ad_metrics_daily m
join clients c on c.id = m.client_id
left join campaign_service_map csm
  on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
where m.client_id = %(cid)s and m.date between %(b_start)s and %(a_end)s
group by m.platform, m.campaign_id, m.client_id
"""

# Active website ads whose URL lacks utm_medium={{adset.name}} — GHL can't tie their
# leads (or bookings) back to a campaign. Grouped per campaign.
MISSING_UTM_SQL = """
select a.campaign_id, max(a.campaign_name) campaign_name, count(distinct cr.ad_id) ads, sum(m.spend) spend
from meta_ad_creatives cr
join ad_level_metrics_daily m on m.ad_id = cr.ad_id and m.client_id = %(cid)s and m.date between %(a_start)s and %(a_end)s
join ad_metrics_daily a on a.client_id = m.client_id and a.platform = 'meta' and a.campaign_id = m.campaign_id and a.date = m.date
where cr.has_adset_utm = false and cr.effective_status = 'ACTIVE'
group by a.campaign_id
having sum(m.spend) > 0
"""

# Google search-term waste and junk-traffic signals per campaign (last 7 days).
GOOGLE_TERMS_SQL = """
select t.campaign_id, sum(t.spend) term_spend,
       sum(t.spend) filter (where t.term_status = 'NONE') unmanaged_spend,
       sum(t.spend) filter (where t.conversions > 0) converting_spend
from google_search_terms_daily t
where t.client_id = %(cid)s and t.date between %(a_start)s and %(a_end)s
group by t.campaign_id
"""
LANDING_SQL = """
select url, flags, spend_30d, error from landing_page_checks where client_id = %(cid)s and status = 'red' order by spend_30d desc
"""

ADS_SQL = """
select m.ad_id, max(m.ad_name) ad_name, m.campaign_id,
       sum(m.spend) filter (where m.date between %(a_start)s and %(a_end)s) spend_a,
       sum(m.leads) filter (where m.date between %(a_start)s and %(a_end)s) leads_a,
       sum(m.clicks) filter (where m.date between %(a_start)s and %(a_end)s) clicks_a,
       sum(m.spend) filter (where m.date between %(b_start)s and %(b_end)s) spend_b,
       sum(m.leads) filter (where m.date between %(b_start)s and %(b_end)s) leads_b
from ad_level_metrics_daily m
where m.client_id = %(cid)s and m.platform = 'meta' and m.date between %(b_start)s and %(a_end)s
group by m.ad_id, m.campaign_id
"""


def _f(v) -> float:
    return float(v or 0)


def _cpl(spend: float, leads: float) -> float | None:
    return round(spend / leads, 2) if leads else None


def _pct(now: float, before: float) -> float | None:
    return round((now - before) / before * 100) if before else None


# ---------------------------------------------------------------- targets

def _load_targets() -> dict[tuple[str, str], dict]:
    return {(r["service"], r["platform"]): dict(r) for r in pg.query("select * from service_targets")}


def _thresholds(targets, service: str, platform: str, client_green: float, client_red: float) -> tuple[float, float, float | None, float | None, str]:
    """(cpl_green, cpl_red, cpba_green, cpba_red, source) for a service on a platform."""
    t = targets.get((service, platform)) or targets.get((service, "all"))
    if t and t.get("cpl_green") is not None:
        g = float(t["cpl_green"])
        r = float(t["cpl_red"]) if t.get("cpl_red") is not None else g * 1.5
        bg = float(t["cpba_green"]) if t.get("cpba_green") is not None else None
        br = float(t["cpba_red"]) if t.get("cpba_red") is not None else (bg * 1.5 if bg else None)
        return g, r, bg, br, "service"
    return client_green, client_red, None, None, "client"


def _weighted(rows: list[dict], key_g: int, key_r: int) -> tuple[float, float] | None:
    """Lead-weighted (spend as tiebreak) average of per-campaign thresholds."""
    wg = wr = ws = 0.0
    for c in rows:
        w = c["leads_a"] or c["spend_a"] * 0.01
        if w <= 0 or c["thr"][key_g] is None:
            continue
        wg += c["thr"][key_g] * w
        wr += (c["thr"][key_r] or c["thr"][key_g] * 1.5) * w
        ws += w
    return (round(wg / ws, 2), round(wr / ws, 2)) if ws else None


# ---------------------------------------------------------------- findings

def _finding(severity: str, kind: str, message: str, *, entity_type: str = "account", entity_id: str | None = None,
             entity_name: str | None = None, action: str | None = None, proposed_value: str | None = None,
             pct_change: float | None = None, risk: str | None = None, evidence: dict | None = None) -> dict:
    return {
        "severity": severity, "kind": kind, "message": message,
        "entity_type": entity_type, "entity_id": entity_id, "entity_name": entity_name,
        "action": action, "proposed_value": proposed_value, "pct_change": pct_change,
        "risk": risk, "evidence": evidence or {},
    }


def _money(v: float | None) -> str:
    return "—" if v is None else f"${v:,.0f}"


def analyze_client(client: dict, targets: dict, a_start: date, a_end: date, b_start: date, b_end: date) -> dict:
    p = {"cid": client["id"], "a_start": a_start, "a_end": a_end, "b_start": b_start, "b_end": b_end}
    cg, cr = float(client["cpl_target_green"]), float(client["cpl_target_red"])
    findings: list[dict] = []

    # --- campaigns, with thresholds for their service
    campaigns = []
    for r in pg.query(CAMPAIGNS_SQL, p):
        c = dict(r)
        for k in ("spend_a", "leads_a", "clicks_a", "spend_b", "leads_b"):
            c[k] = _f(c[k])
        c["cpl_a"], c["cpl_b"] = _cpl(c["spend_a"], c["leads_a"]), _cpl(c["spend_b"], c["leads_b"])
        c["thr"] = _thresholds(targets, c["service"], c["platform"], cg, cr)
        c["days_running"] = (a_end - c["first_seen"]).days + 1 if c.get("first_seen") else None
        campaigns.append(c)

    # --- platform roll-up
    platforms = []
    for r in pg.query(PLATFORM_SQL, p):
        d = {k: _f(v) if k != "platform" else v for k, v in dict(r).items()}
        d["cpl_a"], d["cpl_b"] = _cpl(d["spend_a"], d["leads_a"]), _cpl(d["spend_b"], d["leads_b"])
        exp = _weighted([c for c in campaigns if c["platform"] == d["platform"]], 0, 1)
        d["expected_green"], d["expected_red"] = exp if exp else (cg, cr)
        d["spend_delta_pct"], d["leads_delta_pct"] = _pct(d["spend_a"], d["spend_b"]), _pct(d["leads_a"], d["leads_b"])
        if d["spend_a"] == 0 and d["spend_b"] == 0:
            continue
        platforms.append(d)

    spend_a = sum(d["spend_a"] for d in platforms)
    spend_b = sum(d["spend_b"] for d in platforms)
    leads_a = sum(d["leads_a"] for d in platforms)
    leads_b = sum(d["leads_b"] for d in platforms)
    cpl_a, cpl_b = _cpl(spend_a, leads_a), _cpl(spend_b, leads_b)
    exp_all = _weighted(campaigns, 0, 1) or (cg, cr)
    exp_cpba = _weighted(campaigns, 2, 3)

    # --- GHL
    g = dict(pg.query(GHL_SQL, p)[0]) if client["booking_system"] in ("ghl", "sheet") else {}
    appts_a, appts_all_a, paid_a = _f(g.get("appts_a")), _f(g.get("appts_all_a")), _f(g.get("paid_a"))
    appts_b = _f(g.get("appts_b"))
    cpba_a = round(spend_a / appts_a, 2) if appts_a else None
    tracks_appts = client["booking_system"] in ("ghl", "sheet")

    # ---- account-level rules
    if spend_b >= 100 and spend_a < 0.1 * spend_b:
        findings.append(_finding("red", "spend_stopped",
            f"Spend stopped: {_money(spend_a)} this week vs {_money(spend_b)} last week — check delivery, billing, or a paused campaign.",
            action="investigate", evidence={"spend_a": spend_a, "spend_b": spend_b}))
    elif spend_b >= 100 and abs(_pct(spend_a, spend_b) or 0) >= 40:
        findings.append(_finding("info", "spend_change",
            f"Spend {'up' if spend_a > spend_b else 'down'} {abs(_pct(spend_a, spend_b))}% week over week ({_money(spend_b)} → {_money(spend_a)}).",
            evidence={"spend_a": spend_a, "spend_b": spend_b}))
    if leads_a >= 5 and leads_b >= 5 and cpl_a and cpl_b and cpl_a > cpl_b * 1.4:
        findings.append(_finding("yellow", "cpl_spike",
            f"CPL jumped {_pct(cpl_a, cpl_b)}% week over week ({_money(cpl_b)} → {_money(cpl_a)}).",
            evidence={"cpl_a": cpl_a, "cpl_b": cpl_b}))
    meta_leads_a = sum(d["leads_a"] for d in platforms if d["platform"] == "meta")
    if tracks_appts and client["booking_system"] == "ghl" and meta_leads_a >= 10 and paid_a < 0.6 * meta_leads_a:
        findings.append(_finding("yellow", "signal_gap",
            f"Only {paid_a:.0f} of {meta_leads_a:.0f} Meta leads reached GHL as paid-attributed contacts — check the Instant Form → GHL integration and utm_medium={{{{adset.name}}}} on every ad.",
            action="fix_signal", evidence={"meta_leads": meta_leads_a, "paid_contacts": paid_a},
            risk="Bookings from these leads can't be attributed to campaigns"))
    if tracks_appts and leads_a >= 10 and appts_a == 0:
        findings.append(_finding("yellow", "no_appointments",
            f"{leads_a:.0f} paid leads this week and no booked appointment from paid traffic — setter follow-up or the appointment stage isn't being used.",
            action="investigate", evidence={"leads_a": leads_a, "appts_all_a": appts_all_a}))
    from app.services.economics import max_cpba
    ceiling = max_cpba(client.get("avg_job_value"), client.get("close_rate"), client.get("gross_margin_pct"), client.get("max_ad_cost_share"))
    if tracks_appts and ceiling and appts_a >= 3 and cpba_a and cpba_a > ceiling:
        findings.append(_finding("red", "cpba_unprofitable",
            f"Cost per booked appointment {_money(cpba_a)} is above the {_money(ceiling)} ceiling that's profitable at a "
            f"{_money(float(client['avg_job_value']))} job × {float(client['close_rate'] or 0):.0%} close × {float(client['gross_margin_pct'] or 0):.0%} margin "
            f"× {float(client['max_ad_cost_share'] or 0):.0%} ad share — ads are eating the profit.",
            action="investigate", evidence={"cpba": cpba_a, "ceiling": ceiling},
            risk="Continued spend at this CPBA loses money on every job"))
    for r in pg.query(MISSING_UTM_SQL, p):
        findings.append(_finding("yellow", "missing_utm",
            f"{r['campaign_name']}: {r['ads']} active website ad{'s' if r['ads'] != 1 else ''} ({_money(_f(r['spend']))} this week) send traffic without "
            "utm_medium={{adset.name}} — GHL can't attribute their leads or bookings. Add the URL parameters in Ads Manager.",
            entity_type="campaign", entity_id=r["campaign_id"], entity_name=r["campaign_name"], action="fix_signal",
            evidence={"ads": r["ads"], "spend_a": _f(r["spend"])}))
    if tracks_appts and exp_cpba and appts_a >= 3 and cpba_a and cpba_a > exp_cpba[1] and not (ceiling and cpba_a > ceiling):
        findings.append(_finding("yellow", "cpba_over",
            f"Cost per booked appointment {_money(cpba_a)} vs ≤{_money(exp_cpba[1])} red line for this service mix.",
            evidence={"cpba": cpba_a, "expected_red": exp_cpba[1]}))

    # ---- campaign rules
    for c in campaigns:
        g_, r_, _bg, _br, src = c["thr"]
        ent = dict(entity_type="campaign", entity_id=c["campaign_id"], entity_name=c["name"])
        label = f"{c['name']} ({c['platform']}, {c['service']})"
        if c["spend_a"] >= max(2 * g_, 150) and c["leads_a"] == 0:
            findings.append(_finding("red", "no_leads",
                f"{label}: {_money(c['spend_a'])} this week, zero leads. Pause or fix before more spend.",
                action="pause", risk="Turns off a running campaign", **ent,
                evidence={"spend_a": c["spend_a"], "target_green": g_}))
            continue
        if c["leads_a"] >= MIN_LEADS_TO_SCORE and c["cpl_a"] is not None:
            if c["cpl_a"] > r_:
                worsening = c["cpl_b"] is not None and c["cpl_a"] > c["cpl_b"] * 1.25 and (c["days_running"] or 0) >= 14
                action = "refresh_creative" if worsening else "investigate"
                why = "CPL is rising on a campaign that has run 2+ weeks — creative fatigue is the usual cause" if worsening else "audience, offer or landing page needs a look"
                findings.append(_finding("red", "over_target",
                    f"{label}: CPL {_money(c['cpl_a'])} vs ≤{_money(r_)} red line ({src} target); {why}.",
                    action=action, **ent, evidence={"cpl_a": c["cpl_a"], "cpl_b": c["cpl_b"], "target_red": r_, "leads_a": c["leads_a"]}))
            elif c["cpl_a"] > g_:
                findings.append(_finding("yellow", "watch",
                    f"{label}: CPL {_money(c['cpl_a'])} — between the {_money(g_)} green and {_money(r_)} red lines.",
                    **ent, evidence={"cpl_a": c["cpl_a"], "target_green": g_, "target_red": r_}))
            elif c["leads_a"] >= SCALE_MIN_LEADS and c["cpl_a"] <= g_ * 0.85:
                findings.append(_finding("info", "scale_candidate",
                    f"{label}: {c['leads_a']:.0f} leads at {_money(c['cpl_a'])} (green line {_money(g_)}) — candidate for +20% budget.",
                    action="budget_change", proposed_value="+20%", pct_change=20,
                    risk="Raising more than ~20% at once can reset Meta's learning phase", **ent,
                    evidence={"cpl_a": c["cpl_a"], "leads_a": c["leads_a"], "target_green": g_}))

    # ---- Google Ads: junk traffic, unmanaged search terms, broken landing pages
    gterms = {r["campaign_id"]: r for r in pg.query(GOOGLE_TERMS_SQL, p)}
    for c in campaigns:
        if c["platform"] != "google":
            continue
        ent = dict(entity_type="campaign", entity_id=c["campaign_id"], entity_name=c["name"])
        clicks = _f(c.get("clicks_a"))
        if clicks >= 100 and c["spend_a"] / clicks < 1.5 and c["leads_a"] == 0:
            findings.append(_finding("red", "google_junk_traffic",
                f"{c['name']} (google): {clicks:.0f} clicks at ${c['spend_a'] / clicks:.2f} each and no conversions this week — "
                "the pattern of broad match + search partners / display expansion. Pause it or rebuild on exact/phrase, search network only.",
                action="pause", risk="Turns off a running campaign", **ent,
                evidence={"clicks_a": clicks, "spend_a": c["spend_a"]}))
        g = gterms.get(c["campaign_id"])
        if g and _f(g["term_spend"]) >= 150 and _f(g["unmanaged_spend"]) / _f(g["term_spend"]) > 0.5:
            findings.append(_finding("yellow", "google_unmanaged_terms",
                f"{c['name']} (google): {_f(g['unmanaged_spend']) / _f(g['term_spend']):.0%} of search-term spend "
                f"({_money(_f(g['unmanaged_spend']))}) went to queries that aren't keywords — review the search terms tab, add negatives, move converters to exact.",
                action="investigate", **ent,
                evidence={"term_spend": _f(g["term_spend"]), "unmanaged_spend": _f(g["unmanaged_spend"]), "converting_spend": _f(g["converting_spend"])}))
    for r in pg.query(LANDING_SQL, p):
        findings.append(_finding("red", "landing_page_broken",
            f"Landing page {r['url']} is failing ({', '.join(r['flags']) or r['error']}) with {_money(_f(r['spend_30d']))} of ad traffic sent there in 30 days.",
            entity_type="account", entity_id=r["url"], entity_name=r["url"], action="fix_tracking",
            risk="Every click to this page is wasted until it's fixed", evidence={"flags": list(r["flags"]), "spend_30d": _f(r["spend_30d"])}))

    # ---- Kill / Scale SOP verdicts (lead-gen-systems skill) — one per campaign
    try:
        from app.services import sop
        verdicts = sop.evaluate(client, campaigns, a_end, tracks_appts, ceiling)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("SOP evaluation failed for %s", client["slug"])
        verdicts = []
    findings = verdicts + findings

    # ---- creative / structure diagnostics (Meta Ad Mastery checks, services/creative_diag.py).
    # Replaces the old CPL-only "fatigue" rule: the course calls fatigue a limiting belief —
    # an ad is only flagged when frequency AND cost per 1,000 reached rise while results fall
    # and its ad set isn't booking, and the play is always "fresh test", never "pause".
    try:
        from app.services import creative_diag
        findings.extend(creative_diag.analyze(str(client["id"]), a_end)["signals"])
    except Exception:
        import logging
        logging.getLogger(__name__).exception("creative diagnostics failed for %s", client["slug"])

    sev_rank = {"red": 0, "yellow": 1, "info": 2}
    findings.sort(key=lambda f: sev_rank[f["severity"]])
    score = "red" if any(f["severity"] == "red" for f in findings) else "yellow" if any(f["severity"] == "yellow" for f in findings) else "green"

    # ---- one-paragraph summary
    status = "on target" if cpl_a is not None and cpl_a <= exp_all[0] else "watch" if cpl_a is not None and cpl_a <= exp_all[1] else "over target"
    parts = [f"Spent {_money(spend_a)}" + (f" ({'▲' if spend_a >= spend_b else '▼'}{abs(_pct(spend_a, spend_b))}% wk/wk)" if _pct(spend_a, spend_b) is not None else "")
             + f" for {leads_a:.0f} leads at {_money(cpl_a)} CPL — {status} (expected ≤{_money(exp_all[0])} for this service mix)."]
    if tracks_appts:
        parts.append(f"{appts_a:.0f} paid bookings" + (f" at {_money(cpba_a)} each" if cpba_a else "")
                     + (f"; {appts_all_a - appts_a:.0f} more from non-paid sources" if appts_all_a > appts_a else "") + ".")
    vc: dict[str, int] = {}
    for f in findings:
        if f.get("kind") == "sop_verdict":
            vc[f["verdict"]] = vc.get(f["verdict"], 0) + 1
    if vc:
        order = ["fix", "kill", "kill_or_rebuild", "quality_fail", "diagnose", "scale", "micro_scale", "hold", "no_verdict"]
        parts.append("SOP: " + ", ".join(f"{vc[k]} {k.replace('_', ' ')}" for k in order if k in vc) + ".")
    reds = [f for f in findings if f["severity"] == "red"]
    if reds:
        parts.append(f"{len(reds)} red flag{'s' if len(reds) != 1 else ''}: " + "; ".join(f["kind"].replace("_", " ") for f in reds) + ".")
    summary = " ".join(parts)

    return {
        "client_id": str(client["id"]), "slug": client["slug"], "name": client["name"],
        "booking_system": client["booking_system"], "score": score, "summary_md": summary,
        "window_start": a_start, "window_end": a_end,
        "totals": {"spend_a": spend_a, "spend_b": spend_b, "leads_a": leads_a, "leads_b": leads_b,
                   "cpl_a": cpl_a, "cpl_b": cpl_b, "expected_green": exp_all[0], "expected_red": exp_all[1],
                   "appts_a": appts_a, "appts_b": appts_b, "appts_all_a": appts_all_a, "cpba_a": cpba_a,
                   "expected_cpba_green": exp_cpba[0] if exp_cpba else None, "expected_cpba_red": exp_cpba[1] if exp_cpba else None,
                   "cpba_max": ceiling},
        "platforms": platforms, "findings": findings,
        "campaigns": [{k: v for k, v in c.items() if k not in ("thr", "first_seen")} | {"target_green": c["thr"][0], "target_red": c["thr"][1]} for c in campaigns],
    }


# ---------------------------------------------------------------- persistence

def _persist(b: dict, brief_date: date) -> dict:
    cid = b["client_id"]
    t = b["totals"]
    run = pg.query(
        """
        insert into triage_runs (client_id, window_start, window_end, spend, leads, appointments_ghl,
                                 cpl, cpba, lead_to_appt_rate, score, summary_md, raw)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) returning id
        """,
        (cid, b["window_start"], b["window_end"], t["spend_a"], t["leads_a"], int(t["appts_a"]),
         t["cpl_a"], t["cpba_a"], round(t["appts_a"] / t["leads_a"], 4) if t["leads_a"] else None,
         b["score"], b["summary_md"], json.dumps({"type": "daily", "findings": b["findings"]}, default=str)),
    )
    run_id = run[0]["id"]
    open_recs = {(r["entity_id"], r["action"]) for r in pg.query(
        "select entity_id, action from recommendations where client_id = %s and status in ('proposed','approved')", (cid,))}
    proposed = 0
    for f in b["findings"]:
        if not f["action"] or (f["entity_id"], f["action"]) in open_recs:
            continue
        pg.execute(
            """
            insert into recommendations (client_id, triage_run_id, entity_type, entity_id, entity_name, action,
                                         proposed_value, pct_change, reason, evidence, risk, status)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'proposed')
            """,
            (cid, run_id, f["entity_type"], f["entity_id"], f["entity_name"], f["action"],
             f["proposed_value"], f["pct_change"], f["message"], json.dumps(f["evidence"], default=str), f["risk"]),
        )
        f["recommendation"] = "proposed"
        open_recs.add((f["entity_id"], f["action"]))
        proposed += 1
    for f in b["findings"]:
        f.setdefault("recommendation", "already open" if f["action"] else None)
    pg.execute("delete from daily_briefs where client_id = %s and brief_date = %s", (cid, brief_date))
    pg.execute(
        """
        insert into daily_briefs (client_id, brief_date, window_start, window_end, score, summary_md, platforms, findings, triage_run_id)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (cid, brief_date, b["window_start"], b["window_end"], b["score"], b["summary_md"],
         json.dumps({"platforms": b["platforms"], "totals": b["totals"], "campaigns": b["campaigns"]}, default=str),
         json.dumps(b["findings"], default=str), run_id),
    )
    return {"slug": b["slug"], "score": b["score"], "findings": len(b["findings"]), "proposed": proposed}


def run_daily_brief(as_of: date | None = None) -> dict:
    """Brief every active client for the 7 complete days ending `as_of` (default yesterday)."""
    as_of = as_of or (date.today() - timedelta(days=1))
    a_start, a_end = as_of - timedelta(days=WINDOW_DAYS - 1), as_of
    b_start, b_end = a_start - timedelta(days=WINDOW_DAYS), a_start - timedelta(days=1)
    targets = _load_targets()
    results = []
    for client in pg.query(CLIENTS_SQL, {"a_end": a_end, "b_start": b_start}):
        try:
            b = analyze_client(dict(client), targets, a_start, a_end, b_start, b_end)
            results.append(_persist(b, as_of))
        except Exception as exc:  # one client must never block the rest
            results.append({"slug": client["slug"], "error": str(exc)[:200]})
    return {"date": as_of.isoformat(), "clients": len(results), "results": results}

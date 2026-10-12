"""Kill / Scale SOP verdicts — the lead-gen-systems skill's decision matrix applied
nightly to every campaign, so the Daily Brief says hold / diagnose / kill / scale
with the gate that justified it and a five-part decision block (decision, evidence,
confidence, expected impact, next step). Source: zeal-paid-ads
plugins/meta-ads/skills/lead-gen-systems/references/kill-scale-sop.md.

Verdict metric is cost per scheduled appointment (CPAₛ) against the service's target
Tₛ (service_targets.cpba_green → client target_cpba → economics ceiling). CPL only
diagnoses. Scheduled appointments per campaign are GHL paid bookings: tagged ones plus
a lead-share slice of untagged ones (the dashboard's allocation), so campaign counts are
estimates on multi-service clients and are labelled as such.
"""
from __future__ import annotations

from datetime import date, timedelta

from app.services import pg

# --- SOP gates
MIN_DAYS = 3                 # Gate A: three complete delivery days before any read
ZERO_EVENT_MULT = 3.0        # Gate B: 0 scheduled after ≥3×Tₛ ≈ 95% zero-event gate
DECISION_GRADE = 10          # Gate C: ≥10 scheduled = decision-grade
STRONG_READ = 20
MICRO_SCALE_MIN = 5
SCALE_PCT, EXCEPTIONAL_PCT, MICRO_PCT = 20, 25, 10
NEAR_TARGET_HI, WEAK_MULT, EXCEPTIONAL_MULT, MICRO_MULT = 1.2, 1.3, 0.8, 0.8
QUALITY_MIN_BOOKED, QUALITY_MIN_CONFIRM_RATE = 10, 0.25

WINDOWS_SQL = """
select platform, campaign_id,
       sum(spend) filter (where date > %(end)s - 7)  spend_7,  sum(leads) filter (where date > %(end)s - 7)  leads_7,
       sum(spend) filter (where date > %(end)s - 14) spend_14, sum(leads) filter (where date > %(end)s - 14) leads_14,
       sum(spend) filter (where date > %(end)s - 30) spend_30, sum(leads) filter (where date > %(end)s - 30) leads_30,
       sum(impressions) filter (where date > %(end)s - 7) imps_7, sum(clicks) filter (where date > %(end)s - 7) clicks_7,
       sum(unique_link_clicks) filter (where date > %(end)s - 7) ulc_7, sum(unique_outbound_clicks) filter (where date > %(end)s - 7) uoc_7,
       sum(video_3s_plays) filter (where date > %(end)s - 7) v3_7, sum(thruplays) filter (where date > %(end)s - 7) thru_7,
       sum((select coalesce(sum((a->>'value')::numeric), 0) from jsonb_array_elements(coalesce(raw->'actions', '[]'::jsonb)) a
            where a->>'action_type' = 'landing_page_view')) filter (where date > %(end)s - 7) lpv_7,
       min(date) first_seen
from ad_metrics_daily where client_id = %(cid)s and date between %(end)s - 60 and %(end)s
group by platform, campaign_id
"""

# Paid bookings per campaign for one window (same allocation as the client page).
APPTS_SQL = """
with camp as (
    select platform, campaign_id, sum(leads) leads from ad_metrics_daily
    where client_id = %(cid)s and date between %(start)s and %(end)s group by 1, 2
),
adsets as (
    select campaign_id, adset_name, sum(leads) leads, sum(spend) spend from adset_metrics_daily
    where client_id = %(cid)s and platform = 'meta' and date between %(start)s and %(end)s group by 1, 2
),
same_name as (select adset_name, sum(leads) leads, sum(spend) spend from adsets group by 1),
booked as (
    select adset_name, sum(appointments) appointments from ghl_adset_daily
    where client_id = %(cid)s and date between %(start)s and %(end)s group by 1
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
    select (select coalesce(sum(appointments_booked), 0) from ghl_metrics_daily where client_id = %(cid)s and date between %(start)s and %(end)s) total,
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

CONFIRM_SQL = """
select sum(appointments_booked) booked, sum(appointments_confirmed) confirmed, sum(appointments_showed) showed,
       sum(appointments_noshow) noshow
from ghl_metrics_daily where client_id = %(cid)s and date between %(end)s - 29 and %(end)s
"""

HARD_FAIL_SQL = """
select x.campaign_id, x.platform, array_agg(distinct x.problem) problems
from (
    -- landing pages (Meta website ads and Google final URLs) whose nightly check is red
    select m.campaign_id, 'meta' platform, 'landing page ' || l.url || ': ' || array_to_string(l.flags, ', ') problem
    from meta_ad_creatives cr
    join ad_level_metrics_daily m on m.ad_id = cr.ad_id and m.client_id = %(cid)s and m.date > %(end)s - 7
    join landing_page_checks l on l.client_id = %(cid)s and l.url = cr.link_url and l.status = 'red'
    union all
    select g.campaign_id, 'google', 'landing page ' || l.url || ': ' || array_to_string(l.flags, ', ')
    from google_ad_metrics_daily g, jsonb_array_elements_text(coalesce(g.final_urls, '[]'::jsonb)) u
    join landing_page_checks l on l.client_id = %(cid)s and l.url = u and l.status = 'red'
    where g.client_id = %(cid)s and g.date > %(end)s - 7
    union all
    -- active website ads without the ad-set UTM: bookings can't be attributed
    select m.campaign_id, 'meta', count(distinct cr.ad_id) || ' active website ad(s) without utm_medium={{adset.name}}'
    from meta_ad_creatives cr
    join ad_level_metrics_daily m on m.ad_id = cr.ad_id and m.client_id = %(cid)s and m.date > %(end)s - 7
    where cr.has_adset_utm = false and cr.effective_status = 'ACTIVE'
    group by m.campaign_id
) x group by 1, 2
"""

BUDGET_SQL = """
select platform, campaign_id,
       coalesce(max(daily_budget) filter (where entity_type = 'campaign'),
                sum(daily_budget) filter (where entity_type = 'adset' and status in ('ACTIVE', 'ENABLED'))) daily_budget
from campaign_budgets where client_id = %(cid)s group by 1, 2
"""


def _f(v) -> float:
    return float(v or 0)


def _money(v: float | None) -> str:
    return "—" if v is None else f"${v:,.0f}"


def _cpa(spend: float, n: float) -> float | None:
    return round(spend / n, 2) if n else None


def _layer(w: dict, leads: float, scheduled: float) -> str | None:
    """SOP §4: read the funnel from the ad downward and name the first leaking layer."""
    imps, clicks = _f(w.get("imps_7")), _f(w.get("clicks_7"))
    uoc, ulc = _f(w.get("uoc_7")), _f(w.get("ulc_7"))
    # Dominant click type: outbound only for website funnels (outbound ≥ half of link clicks);
    # Instant Form campaigns carry a trickle of outbound clicks that would fake a ~0.05% CTR.
    unique = uoc if (uoc > 0 and uoc >= 0.5 * ulc) else (ulc or clicks)
    v3 = _f(w.get("v3_7"))
    hook = v3 / imps if imps and v3 else None
    ctr = unique / imps if imps else None
    # 3-second plays / ALL impressions understates hook on mixed image+video campaigns; only
    # call it a hook problem when the campaign is clearly video-led (plays ≥ 5% of impressions).
    if hook is not None and imps >= 1000 and hook >= 0.05 and hook < 0.20:
        return f"creative — hook rate {hook:.0%} (<20%): new hook or visual"
    if ctr is not None and imps >= 1000 and ctr < 0.01:
        return f"creative / message — unique CTR {ctr:.2%} (<1%): new angle or promise"
    website = uoc > 0 and uoc >= 0.5 * ulc
    lpv = _f(w.get("lpv_7"))
    if website and unique >= 30 and lpv / unique < 0.60:
        return f"landing page — only {lpv / unique:.0%} of clicks load the page: fix speed or ad/page mismatch"
    if not website and ulc >= 50 and leads / ulc < 0.05:
        return f"form / offer — only {leads / ulc:.0%} of clickers submit (form-through): fix the greeting screen and offer"
    if leads >= 10 and scheduled < 0.15 * leads:
        return "lead quality / speed-to-lead — leads aren't becoming appointments: audit intent, form, contact speed"
    if clicks >= 50 and leads == 0:
        return "page / form — clicks but no leads: repair the conversion surface"
    return None


def _decision(kind: str, **kw) -> dict:
    return {"decision": kind, **kw}


def evaluate(client: dict, campaigns: list[dict], a_end: date, tracks_appts: bool, ceiling: float | None) -> list[dict]:
    """One SOP verdict per campaign that spent in the last 14 days. Returns finding dicts
    (compatible with brief._finding output) carrying `verdict`, `gate`, `layer`,
    `decision` (five-part block) and `sop` evidence."""
    cid = client["id"]
    p = {"cid": cid, "end": a_end}
    windows = {(r["platform"], r["campaign_id"]): dict(r) for r in pg.query(WINDOWS_SQL, p)}
    appts = {}
    if tracks_appts:
        for days in (7, 14, 30):
            rows = pg.query(APPTS_SQL, {"cid": cid, "start": a_end - timedelta(days=days - 1), "end": a_end})
            for r in rows:
                appts[(r["platform"], r["campaign_id"], days)] = _f(r["appointments"])
    conf = dict(pg.query(CONFIRM_SQL, p)[0]) if tracks_appts else {}
    booked30, confirmed30 = _f(conf.get("booked")), _f(conf.get("confirmed"))
    confirm_tracked = confirmed30 > 0
    confirm_rate = confirmed30 / booked30 if booked30 else None
    quality_block = confirm_tracked and booked30 >= QUALITY_MIN_BOOKED and confirm_rate is not None and confirm_rate < QUALITY_MIN_CONFIRM_RATE
    hard = {(r["platform"], r["campaign_id"]): list(r["problems"]) for r in pg.query(HARD_FAIL_SQL, p)}
    budgets = {(r["platform"], r["campaign_id"]): _f(r["daily_budget"]) for r in pg.query(BUDGET_SQL, p)}
    client_ts = _f(client.get("target_cpba")) or None
    # Tₛ fallback chain: (service, platform) target → (service, 'all') → the same service on any
    # platform → client target_cpba → economics ceiling. No target → no verdict (SOP: targets are approved, not inferred).
    svc_targets: dict[str, list[float]] = {}
    for r in pg.query("select service, platform, cpba_green from service_targets where cpba_green is not null"):
        svc_targets.setdefault(r["service"], []).append((0 if r["platform"] == "all" else 1, _f(r["cpba_green"])))

    def _service_ts(service: str | None) -> float | None:
        rows = sorted(svc_targets.get(service or "", []))
        return rows[0][1] if rows else None

    out: list[dict] = []
    for c in campaigns:
        key = (c["platform"], c["campaign_id"])
        w = windows.get(key)
        if not w or _f(w.get("spend_14")) <= 0:
            continue
        spend7, spend14, spend30 = _f(w["spend_7"]), _f(w["spend_14"]), _f(w["spend_30"])
        leads7, leads14 = _f(w["leads_7"]), _f(w["leads_14"])
        s7, s14, s30 = appts.get(key + (7,), 0.0), appts.get(key + (14,), 0.0), appts.get(key + (30,), 0.0)
        days = (a_end - w["first_seen"]).days + 1 if w.get("first_seen") else None
        ts = c["thr"][2] or _service_ts(c["service"]) or client_ts or ceiling
        budget = budgets.get(key)
        name, label = c["name"], f"{c['name']} ({c['platform']}, {c['service']})"
        ent = dict(entity_type="campaign", entity_id=c["campaign_id"], entity_name=name)
        ev = {"spend_7": spend7, "spend_14": spend14, "spend_30": spend30, "leads_7": leads7, "leads_14": leads14,
              "scheduled_7": round(s7, 1), "scheduled_14": round(s14, 1), "scheduled_30": round(s30, 1),
              "cpa_s_7": _cpa(spend7, s7), "cpa_s_14": _cpa(spend14, s14), "target_ts": ts, "days_running": days,
              "daily_budget": budget, "confirm_rate_30": round(confirm_rate, 3) if confirm_rate is not None else None,
              "estimate": "scheduled per campaign = tagged bookings + lead-share slice of untagged"}
        layer = _layer(w, leads7, s7)
        base = dict(kind="sop_verdict", **ent, evidence=ev, layer=layer)

        def mk(severity, verdict, gate, message, action=None, proposed_value=None, pct_change=None, risk=None,
               decision=None, confidence="medium", impact="", next_step=""):
            d = dict(base, severity=severity, verdict=verdict, gate=gate, message=message, action=action,
                     proposed_value=proposed_value, pct_change=pct_change, risk=risk,
                     decision={"decision": decision or verdict, "evidence": message, "confidence": confidence,
                               "expected_impact": impact, "next_step": next_step})
            return d

        # 1. Hard failure overrides everything (safety & validity)
        if key in hard:
            problems = "; ".join(hard[key])
            out.append(mk("red", "fix", "hard failure",
                f"{label}: {problems}. Repair before reading economics — the test is invalid until then.",
                action="fix_tracking", decision="fix tracking", confidence="high",
                impact="Restores a valid read; every dollar until then is ungraded",
                next_step="Fix the page / UTM today; re-grade after 3 complete days of clean delivery"))
            continue
        # 2. No appointment truth → no verdict (SOP: attribution blocks a verdict)
        if not tracks_appts:
            out.append(mk("info", "no_verdict", "no CRM truth",
                f"{label}: {_money(spend14)} / {leads14:.0f} leads in 14d, but no booking source is linked — the SOP can't grade it on appointments.",
                decision="hold", confidence="low", impact="", next_step="Link GHL (or a booking sheet) so scheduled appointments can be counted"))
            continue
        if ts is None:
            out.append(mk("info", "no_verdict", "no target",
                f"{label}: no approved cost-per-appointment target (service target, client target or economics ceiling) — set Tₛ before grading.",
                decision="hold", confidence="low", next_step="Approve Tₛ / T꜀ for this service in Settings → service targets"))
            continue
        cpa7, cpa14 = _cpa(spend7, s7), _cpa(spend14, s14)
        # 3. Too early (Gate A)
        if days is not None and days < MIN_DAYS:
            out.append(mk("info", "hold", "Gate A: <3 complete days",
                f"{label}: {days} day{'s' if days != 1 else ''} live, {_money(spend7)} spent — no verdict until 3 complete days.",
                decision="hold", confidence="low", next_step=f"Re-read on day {MIN_DAYS + 1}; kill only on a hard failure"))
            continue
        # 4. Zero-event spend gate (Gate B) on the trailing 30 days
        if s30 == 0:
            mult = spend30 / ts if ts else 0
            if mult >= ZERO_EVENT_MULT:
                out.append(mk("red", "kill", f"Gate B: 0 scheduled after {mult:.1f}×Tₛ",
                    f"{label}: {_money(spend30)} in 30d ({mult:.1f}× the {_money(ts)} target) with zero scheduled appointments — ~95% zero-event gate. "
                    f"Recommend kill; relaunch a new angle as a fresh test.{' First leak: ' + layer + '.' if layer else ''}",
                    action="pause", risk="Turns off a running campaign; relaunch is a new test, not an edit", decision="kill",
                    confidence="high", impact=f"Stops ~{_money(spend7)}/week of ungraded spend",
                    next_step="Pause on approval, freeze the evidence in the testing log, relaunch one new angle in a clean campaign"))
            elif mult >= 2:
                out.append(mk("yellow", "diagnose", f"Gate B: 0 scheduled after {mult:.1f}×Tₛ",
                    f"{label}: {_money(spend30)} in 30d, zero scheduled — strong warning (2–3×Tₛ). Prepare the replacement test now.{' First leak: ' + layer + '.' if layer else ''}",
                    action="investigate", decision="diagnose", confidence="medium",
                    impact="Replacement ready before the kill gate", next_step=f"Kill gate at {_money(ts * ZERO_EVENT_MULT)} cumulative; draft the next angle now"))
            elif mult >= 1:
                out.append(mk("yellow", "diagnose", f"Gate B: 0 scheduled after {mult:.1f}×Tₛ",
                    f"{label}: {_money(spend30)} in 30d, zero scheduled — concerning, not decisive.{' First leak: ' + layer + '.' if layer else ''}",
                    action="investigate", decision="diagnose", confidence="low", next_step=f"Repair the named layer; kill gate at {_money(ts * ZERO_EVENT_MULT)}"))
            else:
                out.append(mk("info", "hold", "Gate B: <1×Tₛ spent",
                    f"{label}: {_money(spend30)} spent, no scheduled yet — too thin to read.",
                    decision="hold", confidence="low", next_step=f"Next read at {_money(ts)} cumulative spend"))
            continue
        # 5. Event-count confidence (Gate C) on the 14-day window
        n = s14
        if n < MICRO_SCALE_MIN:
            out.append(mk("info", "hold", f"Gate C: {n:.0f} scheduled (thin)",
                f"{label}: {n:.1f} scheduled in 14d on {_money(spend14)} (CPAₛ {_money(cpa14)} vs Tₛ {_money(ts)}) — directional only, no scale.{' Watch: ' + layer + '.' if layer else ''}",
                decision="hold", confidence="low", next_step=f"Decision-grade at {DECISION_GRADE} scheduled; next threshold {MICRO_SCALE_MIN}"))
            continue
        ratio14 = cpa14 / ts if cpa14 else None
        ratio7 = cpa7 / ts if cpa7 else None
        if n < DECISION_GRADE:
            if ratio7 is not None and ratio7 <= MICRO_MULT and not quality_block:
                pv = f"+{MICRO_PCT}%" + (f" → {_money(budget * (1 + MICRO_PCT / 100))}/day" if budget else "")
                out.append(mk("info", "micro_scale", f"Gate C: {n:.0f} scheduled (moderate), CPAₛ ≤0.8×Tₛ",
                    f"{label}: {n:.1f} scheduled in 14d, 7-day CPAₛ {_money(cpa7)} vs Tₛ {_money(ts)} — directional scale +{MICRO_PCT}%, not a validated winner.",
                    action="budget_change", proposed_value=pv, pct_change=MICRO_PCT, decision="micro-scale", confidence="medium",
                    impact=f"~{MICRO_PCT}% more volume at current efficiency if it holds", next_step=f"Raise {pv}; reassess after 3 full days; decision-grade at {DECISION_GRADE} scheduled"))
            else:
                out.append(mk("info", "hold", f"Gate C: {n:.0f} scheduled (moderate)",
                    f"{label}: {n:.1f} scheduled in 14d, CPAₛ {_money(cpa14)} vs Tₛ {_money(ts)} — hold; {DECISION_GRADE - n:.0f} more scheduled before a standard decision.",
                    decision="hold", confidence="medium", next_step=f"Re-read at {DECISION_GRADE} scheduled"))
            continue
        # decision-grade
        if ratio14 is not None and ratio14 > WEAK_MULT and ratio7 is not None and ratio7 > WEAK_MULT:
            out.append(mk("red", "kill_or_rebuild", "two-window: CPAₛ >1.3×Tₛ in 7d and 14d",
                f"{label}: CPAₛ {_money(cpa7)} (7d) and {_money(cpa14)} (14d) vs Tₛ {_money(ts)} with {n:.0f} scheduled — weak in both windows. "
                f"Kill, or rebuild the failing layer{': ' + layer if layer else ''}.",
                action="investigate", decision="kill or rebuild", confidence="high" if n >= STRONG_READ else "medium",
                impact=f"Removes {_money(spend7)}/week running >30% over target", next_step="Name the layer; if it's creative/angle, kill and relaunch; if page/speed, repair and re-read in 7 days"))
        elif quality_block and ratio14 is not None and ratio14 <= 1.0:
            out.append(mk("yellow", "quality_fail", f"confirmation rate {confirm_rate:.0%} on {booked30:.0f} booked",
                f"{label}: CPAₛ {_money(cpa14)} beats Tₛ {_money(ts)} but only {confirm_rate:.0%} of bookings confirm — do not scale; fix confirmation / follow-up first.",
                action="investigate", decision="hold (quality)", confidence="medium", next_step="Fix reminders and expectation-setting; re-check confirmation rate in 7 days"))
        elif n >= STRONG_READ and ratio14 is not None and ratio14 <= EXCEPTIONAL_MULT:
            pv = f"+{EXCEPTIONAL_PCT}%" + (f" → {_money(budget * (1 + EXCEPTIONAL_PCT / 100))}/day" if budget else "")
            out.append(mk("info", "scale", f"Gate C: {n:.0f} scheduled (strong), CPAₛ ≤0.8×Tₛ",
                f"{label}: {n:.0f} scheduled in 14d at CPAₛ {_money(cpa14)} vs Tₛ {_money(ts)} — exceptional. Scale +{EXCEPTIONAL_PCT}%.",
                action="budget_change", proposed_value=pv, pct_change=EXCEPTIONAL_PCT, decision="scale", confidence="high",
                risk="Raising more than ~20–30% at once can reset learning", impact=f"~{EXCEPTIONAL_PCT}% more appointments at ≤ target",
                next_step=f"Raise {pv}; hold 3 full days; next move only if CPAₛ stays ≤ Tₛ"))
        elif ratio14 is not None and ratio14 <= 1.0:
            pv = f"+{SCALE_PCT}%" + (f" → {_money(budget * (1 + SCALE_PCT / 100))}/day" if budget else "")
            out.append(mk("info", "scale", f"Gate C: {n:.0f} scheduled, CPAₛ ≤ Tₛ",
                f"{label}: {n:.0f} scheduled in 14d at CPAₛ {_money(cpa14)} vs Tₛ {_money(ts)} — efficient. Scale +{SCALE_PCT}%.",
                action="budget_change", proposed_value=pv, pct_change=SCALE_PCT, decision="scale", confidence="high" if n >= STRONG_READ else "medium",
                risk="Raising more than ~20% at once can reset learning", impact=f"~{SCALE_PCT}% more appointments at ≤ target",
                next_step=f"Raise {pv}; hold 3 full days; reassess on the 7-day CPAₛ"))
        elif ratio14 is not None and ratio14 <= NEAR_TARGET_HI:
            out.append(mk("yellow", "diagnose", "near target: CPAₛ 1.0–1.2×Tₛ",
                f"{label}: CPAₛ {_money(cpa14)} vs Tₛ {_money(ts)} ({ratio14:.2f}×) with {n:.0f} scheduled — hold and repair one layer{': ' + layer if layer else ''}.",
                action="investigate", decision="diagnose", confidence="medium", next_step="Change one variable on the named layer; re-read in 7 days"))
        else:
            out.append(mk("yellow", "diagnose", f"CPAₛ {ratio14:.2f}×Tₛ (14d) — one window over",
                f"{label}: CPAₛ {_money(cpa14)} (14d) vs Tₛ {_money(ts)}; 7-day {_money(cpa7)} — over in one window, not both. Diagnose{': ' + layer if layer else ''}.",
                action="investigate", decision="diagnose", confidence="medium", next_step="Two-window kill rule applies if 7d and 14d both exceed 1.3×Tₛ next read"))
    return out

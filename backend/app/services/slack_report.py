"""Daily report (Carl, 2026-09-28) — one "card" per spending client with its numbers and
its plays (the specific change to make), used by BOTH the Slack post and the dashboard's
Today page / client "Today's plays" card, so they always say the same thing.

Card = leads and booked for yesterday / 7d / 30d, 7-day spend, CPL, cost per booked vs
target, a status (red / yellow / green / grey) and a list of issues, each with a play:
⛔ kill · 🛠 fix tracking · 🐢 fix landing page · 📝 fix form/offer · 🎣 new hook ·
🎬 deliver the promise sooner · 💡 new angle · 🔁 fresh test · 🎨 new concept ·
✂️ too many ads · 🧱 consolidate · 📞 fix follow-up · ⚠️ fix confirmations · 🚀 scale …

Sources: alerts computed here (no leads in 3 days, CPL up week over week, bookings stopped,
cost per booked vs target), the Kill/Scale SOP verdicts and creative diagnostics written by
the nightly brief, other brief findings, and red integration checks.

Slack: SLACK_REPORT_WEBHOOK_URL (falls back to SLACK_WEBHOOK_URL), 5:00 AM PT, split into
several messages (Slack allows 50 blocks per message). Read-only.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

import httpx

from app.core.config import get_settings
from app.services import pg

CLIENT_SQL = """
with ads as (
    select client_id,
           sum(spend) filter (where date = %(y)s) spend_1, sum(leads) filter (where date = %(y)s) leads_1,
           sum(spend) filter (where date > %(y)s - 3) spend_3, sum(leads) filter (where date > %(y)s - 3) leads_3,
           sum(spend) filter (where date > %(y)s - 7) spend_7, sum(leads) filter (where date > %(y)s - 7) leads_7,
           sum(spend) filter (where date > %(y)s - 30) spend_30, sum(leads) filter (where date > %(y)s - 30) leads_30,
           sum(spend) filter (where date > %(y)s - 14 and date <= %(y)s - 7) spend_prev7,
           sum(leads) filter (where date > %(y)s - 14 and date <= %(y)s - 7) leads_prev7,
           max(date) filter (where leads > 0) last_lead
    from ad_metrics_daily where date > %(y)s - 60 and date <= %(y)s group by client_id
),
ghl as (
    select client_id,
           sum(appointments_booked) filter (where date = %(y)s) booked_1,
           sum(appointments_booked) filter (where date > %(y)s - 7) booked_7,
           sum(appointments_booked) filter (where date > %(y)s - 30) booked_30,
           sum(appointments_booked) filter (where date > %(y)s - 14 and date <= %(y)s - 7) booked_prev7
    from ghl_metrics_daily where date > %(y)s - 30 and date <= %(y)s group by client_id
)
select c.id, c.name, c.slug, c.booking_system, c.target_cpba, c.ghl_location_id,
       a.spend_1, a.leads_1, a.spend_3, a.leads_3, a.spend_7, a.leads_7, a.spend_30, a.leads_30,
       a.spend_prev7, a.leads_prev7, a.last_lead,
       g.booked_1, g.booked_7, g.booked_30, g.booked_prev7
from clients c join ads a on a.client_id = c.id left join ghl g on g.client_id = c.id
where c.is_active and (coalesce(a.spend_7, 0) > 0 or coalesce(a.spend_prev7, 0) > 0)
"""

DRY_CAMPAIGNS_SQL = """
select client_id, platform, max(campaign_name) name, sum(spend) spend_3
from ad_metrics_daily where date > %(y)s - 3 and date <= %(y)s
group by client_id, platform, campaign_id
having sum(spend) >= 75 and sum(leads) = 0
order by sum(spend) desc
"""

AD_CAMPAIGN_SQL = """
select l.ad_id, max(m.campaign_name) campaign_name
from ad_level_metrics_daily l
join ad_metrics_daily m on m.client_id = l.client_id and m.campaign_id = l.campaign_id and m.date = l.date
where l.date > %(y)s - 14 and l.date <= %(y)s
group by l.ad_id
"""

BRIEF_SQL = """
select c.slug, b.brief_date, b.score, b.findings, b.platforms from daily_briefs b join clients c on c.id = b.client_id
where b.brief_date = (select max(brief_date) from daily_briefs)
"""

HEALTH_SQL = """
select c.slug, h.check_key from integration_health h join clients c on c.id = h.client_id
where h.status = 'red' and c.is_active
"""

try:
    from app.services.integrations import CHECKS as _CHECKS
    LABELS = {k: label for k, label, _group in _CHECKS}
except Exception:  # integrations imports the GHL SDK; the report must not depend on it
    LABELS = {}

# play → (icon, label). One vocabulary for Slack, the Today page and the client page.
PLAYS: dict[str, tuple[str, str]] = {
    "kill": ("⛔", "Kill"), "kill_or_rebuild": ("⛔", "Kill or rebuild"), "fix_tracking": ("🛠", "Fix tracking"),
    "fix_page": ("🐢", "Fix landing page"), "fix_form": ("📝", "Fix form / offer"), "new_hook": ("🎣", "New hook"),
    "sharper_hook": ("🎣", "Sharpen hook"), "swap_open": ("🎣", "Swap first 3 seconds"), "fix_promise": ("🎬", "Deliver the promise sooner"),
    "new_angle": ("💡", "New angle"), "fresh_test": ("🔁", "Launch fresh test"), "add_diversity": ("🎨", "Add a new concept"),
    "trim_ads": ("✂️", "Too many ads"), "add_ads": ("➕", "Add ads"), "consolidate": ("🧱", "Consolidate budget"),
    "fix_followup": ("📞", "Fix lead follow-up"), "quality": ("⚠️", "Fix confirmations"), "diagnose": ("🔎", "Diagnose"),
    "scale": ("🚀", "Scale"), "micro_scale": ("📈", "Micro-scale"), "no_leads": ("📉", "No leads"),
    "no_bookings": ("📅", "No bookings"), "over_target": ("💸", "Over target"), "cpl_up": ("🔺", "CPL rising"),
    "spend_stopped": ("⏸", "Spend stopped"), "search_terms": ("🔍", "Search-term waste"), "junk_traffic": ("🗑", "Junk traffic"),
    "integration": ("🔌", "Integration"), "note": ("ℹ️", "Note"),
}
LEGEND = "⛔ kill · 🛠 fix tracking · 🐢 fix page · 📝 fix form · 🎣 new hook · 🎬 promise sooner · 💡 new angle · 🔁 fresh test · 🎨 new concept · ✂️ too many ads · 🧱 consolidate · 📞 follow-up · 🚀 scale"

VERDICT_PLAY = {"fix": ("fix_tracking", "red"), "kill": ("kill", "red"), "kill_or_rebuild": ("kill_or_rebuild", "red"),
                "quality_fail": ("quality", "yellow"), "diagnose": ("diagnose", "yellow"),
                "scale": ("scale", "green"), "micro_scale": ("micro_scale", "green")}
KIND_PLAY = {"landing_page_broken": "fix_page", "missing_utm": "fix_tracking", "signal_gap": "fix_tracking",
             "google_junk_traffic": "junk_traffic", "google_unmanaged_terms": "search_terms",
             "cpba_unprofitable": "over_target", "no_appointments": "no_bookings", "spend_stopped": "spend_stopped"}
RANK = {"red": 0, "yellow": 1, "green": 2, "grey": 3, "info": 4}
DOT = {"red": "🔴", "yellow": "🟡", "green": "🟢", "grey": "⚪"}
STATUS_LABEL = {"red": "Needs action", "yellow": "Watch", "green": "On target", "grey": "Not graded"}

NO_LEADS_MIN_SPEND = 50.0
CPL_UP = 0.30
CPL_MIN_LEADS = 3
SLACK_ISSUES_PER_CLIENT = 5


# ---------------------------------------------------------------- helpers

def _f(v) -> float:
    return float(v or 0)


def _money(v: float | None) -> str:
    if v is None:
        return "—"
    if v >= 10000:
        return f"${v / 1000:,.1f}k"
    return f"${v:,.0f}" if v >= 100 else f"${v:,.2f}"


def _n(v) -> str:
    v = _f(v)
    return f"{v:.0f}" if abs(v - round(v)) < 0.05 else f"{v:.1f}"


def _delta(now: float, before: float) -> int | None:
    if before <= 0:
        return None
    pct = round((now - before) / before * 100)
    return pct if abs(pct) >= 10 else None


def _human(s: str | None) -> str:
    """SOP jargon → plain words."""
    s = s or ""
    s = re.sub(r"Gate [ABC]:\s*", "", s)
    s = s.replace("CPAₛ", "cost per booked").replace("Tₛ", "target").replace("T꜀", "confirmed target")
    s = s.replace("scheduled", "booked").replace("two-window: ", "")
    s = re.sub(r"(\d+(?:\.\d+)?)×\s?target", r"\1× target", s)
    s = s.replace("0 booked after", "0 booked after spending").replace("× target", "× the target") if "0 booked after" in s else s.replace("×target", "× target")
    s = s.replace("≤", "at or under ").replace("in 7d and 14d", "in both 7 and 14 days")
    s = re.sub(r"\s{2,}", " ", s).replace("near target: ", "")
    return s.strip()


def _first_sentence(s: str | None, n: int = 110) -> str:
    s = (s or "").split(";")[0].split(". ")[0].strip().rstrip(".")
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _issue(play: str, sev: str, text: str, campaign: str | None = None, next_step: str | None = None) -> dict:
    icon, label = PLAYS.get(play, PLAYS["note"])
    text = text.strip()
    for prefix in (label, label.split(" ")[0] + " " + (label.split(" ")[1] if " " in label else "")):
        if prefix.strip() and text.lower().startswith(prefix.strip().lower()):
            rest = text[len(prefix.strip()):].lstrip(" :—-")
            text = (rest[:1].upper() + rest[1:]) if rest else text
            break
    return {"play": play, "icon": icon, "label": label, "sev": sev, "campaign": campaign,
            "text": text.strip().rstrip("."), "next": _first_sentence(next_step) if next_step else None}


def _tracks(c: dict) -> bool:
    return c["booking_system"] == "sheet" or (c["booking_system"] == "ghl" and bool(c.get("ghl_location_id")))


def _layer_play(layer: str | None) -> str:
    l = (layer or "").lower()
    if "hook" in l:
        return "new_hook"
    if "ctr" in l or "angle" in l:
        return "new_angle"
    if "landing page" in l or "page /" in l:
        return "fix_page"
    if "form" in l:
        return "fix_form"
    if "lead quality" in l or "speed" in l:
        return "fix_followup"
    return "diagnose"


def _campaign_of(f: dict, ad_campaigns: dict[str, str]) -> str | None:
    if f.get("campaign"):
        return f["campaign"]
    if f.get("entity_type") == "campaign":
        return f.get("entity_name")
    if f.get("entity_type") == "ad":
        return ad_campaigns.get(str(f.get("entity_id")))
    return None


def _strip_campaign(msg: str, campaign: str | None) -> str:
    if not campaign:
        return msg
    msg = msg.replace(f" in {campaign}", "")
    if msg.startswith(campaign):
        msg = re.sub(r"^\s*\([^)]*\)", "", msg[len(campaign):]).lstrip(" :—-")
    return msg


# ---------------------------------------------------------------- issues

def _alert_issues(c: dict, dry: list[dict]) -> list[dict]:
    out = []
    spend3, leads3 = _f(c["spend_3"]), _f(c["leads_3"])
    if spend3 >= NO_LEADS_MIN_SPEND and leads3 == 0:
        since = f"last lead {c['last_lead'].strftime('%b %-d')}" if c.get("last_lead") else "none in 60 days"
        out.append(_issue("no_leads", "red", f"No leads in the last 3 days on {_money(spend3)} ({since})",
                          next_step="Check delivery, the form and the creative today"))
    else:
        for d in dry[:4]:
            out.append(_issue("no_leads", "yellow", f"No leads in 3 days on {_money(_f(d['spend_3']))} ({d['platform']})", campaign=d["name"]))
    l7, lp = _f(c["leads_7"]), _f(c["leads_prev7"])
    if l7 >= CPL_MIN_LEADS and lp >= CPL_MIN_LEADS:
        cpl7, cplp = _f(c["spend_7"]) / l7, _f(c["spend_prev7"]) / lp
        if cplp and (cpl7 - cplp) / cplp >= CPL_UP:
            out.append(_issue("cpl_up", "yellow", f"CPL up {(cpl7 - cplp) / cplp:.0%} week over week, {_money(cplp)} → {_money(cpl7)}",
                              next_step="Diagnostic only — bookings decide; check the plays below"))
    if _tracks(c) and _f(c["booked_7"]) == 0 and _f(c["booked_prev7"]) >= 2:
        out.append(_issue("no_bookings", "red", f"Bookings stopped: 0 this week vs {_n(c['booked_prev7'])} last week",
                          next_step="Check GHL stages and setter follow-up"))
    return out


def _brief_issues(brief: dict | None, ad_campaigns: dict[str, str]) -> list[dict]:
    out = []
    if not brief:
        return out
    findings = brief["findings"] or []
    for f in findings:
        if f.get("kind") == "sop_verdict" and f.get("verdict") in VERDICT_PLAY:
            play, sev = VERDICT_PLAY[f["verdict"]]
            if play == "diagnose":
                play = _layer_play(f.get("layer"))
            d = f.get("decision") or {}
            text = _human(f.get("gate"))
            if f.get("proposed_value"):
                text = f"{f['proposed_value']} — {text}"
            if f.get("layer") and sev != "green":
                text += f"; {_human(f['layer'].split(':')[0])}"
            out.append(_issue(play, sev, text, campaign=f.get("entity_name"), next_step=d.get("next_step")))
    for f in findings:
        if f.get("kind") == "creative_signal" and f.get("severity") in ("yellow", "info"):
            out.append(_issue(f["play"], f["severity"], f.get("text") or f["message"],
                              campaign=_campaign_of(f, ad_campaigns) if f.get("entity_type") != "campaign" else f.get("entity_name"),
                              next_step=f.get("next_step"))
                       | {"where": f.get("entity_name") if f.get("entity_type") in ("ad", "adset") else None,
                          "where_type": f.get("entity_type"), "advice": True})
    for kind, play in KIND_PLAY.items():
        seen: set = set()
        for f in findings:
            if f.get("kind") != kind or f.get("severity") not in ("red", "yellow"):
                continue
            camp = _campaign_of(f, ad_campaigns)
            if camp in seen or len(seen) >= 3:
                continue
            seen.add(camp)
            out.append(_issue(play, f["severity"], _strip_campaign(f["message"], camp)[:220], campaign=camp))
            if camp is None:
                break
    return out


# ---------------------------------------------------------------- cards

def build_cards(as_of: date | None = None) -> dict:
    s = get_settings()
    y = as_of or (date.today() - timedelta(days=1))
    base = s.dashboard_url.rstrip("/")
    clients = [dict(r) for r in pg.query(CLIENT_SQL, {"y": y})]
    briefs = {r["slug"]: dict(r) for r in pg.query(BRIEF_SQL)}
    ad_campaigns = {str(r["ad_id"]): r["campaign_name"] for r in pg.query(AD_CAMPAIGN_SQL, {"y": y})}
    dry: dict[str, list[dict]] = {}
    for r in pg.query(DRY_CAMPAIGNS_SQL, {"y": y}):
        dry.setdefault(str(r["client_id"]), []).append(dict(r))
    reds: dict[str, set[str]] = {}
    for r in pg.query(HEALTH_SQL):
        reds.setdefault(r["slug"], set()).add(LABELS.get(r["check_key"], r["check_key"].replace("_", " ")))

    cards = []
    for c in clients:
        brief = briefs.get(c["slug"])
        tracks = _tracks(c)
        b7, spend7, leads7 = _f(c["booked_7"]), _f(c["spend_7"]), _f(c["leads_7"])
        cpba7 = spend7 / b7 if b7 else None
        bt = ((brief or {}).get("platforms") or {}).get("totals") or {}
        ts = _f(c["target_cpba"]) or _f(bt.get("expected_cpba_green")) or _f(bt.get("cpba_max")) or None

        status, first = "grey", []
        if tracks and ts:
            if b7 >= 3 and cpba7 is not None:
                status = "green" if cpba7 <= ts else "yellow" if cpba7 <= ts * 1.3 else "red"
                if status != "green":
                    first.append(_issue("over_target", status, f"Cost per booked {_money(cpba7)} vs {_money(ts)} target ({cpba7 / ts:.1f}×) on {_n(b7)} bookings"))
            elif b7 > 0 and cpba7 is not None:
                status = "green" if cpba7 <= ts else "yellow"
                if status == "yellow":
                    first.append(_issue("over_target", "yellow", f"Cost per booked {_money(cpba7)} vs {_money(ts)} target, only {_n(b7)} booking{'s' if b7 != 1 else ''} — too thin to act on"))
            elif spend7 >= max(ts, 150):
                status = "red"
                first.append(_issue("no_bookings", "red", f"No bookings this week on {_money(spend7)} ({spend7 / ts:.1f}× the {_money(ts)} target)",
                                    next_step="Audit lead quality and setter follow-up"))
        elif tracks and b7 == 0 and spend7 >= 150:
            status = "red"
            first.append(_issue("no_bookings", "red", f"No bookings this week on {_money(spend7)}"))

        issues = first + _alert_issues(c, dry.get(str(c["id"]), [])) + _brief_issues(brief, ad_campaigns)
        if c["slug"] in reds:
            issues.append(_issue("integration", "yellow", f"{', '.join(sorted(reds[c['slug']]))} not working — see the Integrations page"))
        if not tracks:
            issues.append(_issue("note", "info", "Bookings not tracked — no GHL location or booking sheet linked"))
        for i in issues:
            if (i["sev"] in ("red", "yellow") and i["play"] not in ("note", "integration") and not i.get("advice")
                    and RANK[i["sev"]] < RANK[status]):
                status = i["sev"]
        issues.sort(key=lambda i: (RANK[i["sev"]], 0 if not i["campaign"] else 1))

        cards.append({
            "slug": c["slug"], "name": c["name"], "status": status, "url": f"{base}/clients/{c['slug']}",
            "tracks_bookings": tracks, "target_cpba": ts,
            "leads": {"y": _f(c["leads_1"]), "d7": leads7, "d30": _f(c["leads_30"]), "delta7": _delta(leads7, _f(c["leads_prev7"]))},
            "booked": {"y": _f(c["booked_1"]), "d7": b7, "d30": _f(c["booked_30"]), "delta7": _delta(b7, _f(c["booked_prev7"]))} if tracks else None,
            "spend": {"y": _f(c["spend_1"]), "d7": spend7, "d30": _f(c["spend_30"])},
            "cpl7": spend7 / leads7 if leads7 else None, "cpba7": cpba7,
            "issues": issues, "spend30": _f(c["spend_30"]),
        })
    cards.sort(key=lambda x: (RANK[x["status"]], -x["spend30"]))
    counts = {k: sum(1 for x in cards if x["status"] == k) for k in ("red", "yellow", "green", "grey")}
    tot = lambda k, w: sum(_f(x[k][w]) if x.get(k) else 0 for x in cards)
    totals = {k: {w: tot(k, w) for w in ("y", "d7", "d30")} for k in ("spend", "leads", "booked")}
    # top actions across the portfolio: red plays first, then yellow, biggest clients first
    top = []
    for x in cards:
        for i in x["issues"]:
            if i["sev"] in ("red", "yellow") and i["play"] not in ("note", "integration", "cpl_up"):
                top.append({**i, "client": x["name"], "slug": x["slug"], "spend30": x["spend30"]})
    top.sort(key=lambda i: (RANK[i["sev"]], -i["spend30"]))
    wins = [{**i, "client": x["name"], "slug": x["slug"]} for x in cards for i in x["issues"] if i["play"] in ("scale", "micro_scale")]
    brief_date = next((b["brief_date"].isoformat() for b in briefs.values() if b.get("brief_date")), None)
    return {"date": y.isoformat(), "brief_date": brief_date, "counts": counts, "totals": totals,
            "top_actions": top[:8], "wins": wins, "clients": cards, "legend": LEGEND, "dashboard_url": base}


# ---------------------------------------------------------------- Slack rendering

def _issue_line(i: dict) -> str:
    where = f"*{i['campaign']}*" if i.get("campaign") else ""
    sub = f" · {i['where']}" if i.get("where") and i.get("where") != i.get("campaign") and i.get("where_type") == "ad" else ""
    head = f"{i['icon']} {where}{sub} — *{i['label']}*" if where else f"{i['icon']} *{i['label']}*"
    line = f"{head}: {i['text']}"
    if i.get("next") and i["play"] not in ("over_target",):
        line += f"\n        _→ {i['next']}_"
    return line


def _play_line(i: dict, indent: str) -> str:
    sub = f"{i['where']}: " if i.get("where") and i.get("where_type") == "ad" else ""
    line = f"{indent}{i['icon']} *{i['label']}* — {sub}{i['text']}"
    if i.get("next") and i["play"] not in ("over_target",):
        line += f"\n{indent}      _→ {i['next']}_"
    return line


def _grouped_lines(issues: list[dict]) -> list[str]:
    """Account-level issues first, then each campaign in bold with its plays under it."""
    lines = [_play_line(i, "") for i in issues if not i.get("campaign")]
    order: list[str] = []
    by: dict[str, list[dict]] = {}
    for i in issues:
        if i.get("campaign"):
            if i["campaign"] not in by:
                order.append(i["campaign"])
            by.setdefault(i["campaign"], []).append(i)
    for camp in order:
        lines.append(f"*{camp}*")
        lines += [_play_line(i, "    ") for i in by[camp]]
    return lines


def _client_blocks(card: dict, base: str) -> list[dict]:
    b = card["booked"]
    arrow = lambda d: "" if d is None else (f" ▲{d}%" if d > 0 else f" ▼{abs(d)}%")
    fields = [
        {"type": "mrkdwn", "text": f"*Leads*  _yday · 7d · 30d_\n{_n(card['leads']['y'])} · {_n(card['leads']['d7'])}{arrow(card['leads']['delta7'])} · {_n(card['leads']['d30'])}"},
        {"type": "mrkdwn", "text": (f"*Booked*  _yday · 7d · 30d_\n{_n(b['y'])} · {_n(b['d7'])}{arrow(b['delta7'])} · {_n(b['d30'])}" if b else "*Booked*\n_not tracked_")},
        {"type": "mrkdwn", "text": f"*7-day spend · CPL*\n{_money(card['spend']['d7'])} · {_money(card['cpl7'])}"},
        {"type": "mrkdwn", "text": f"*Cost per booked*  _7d_\n{_money(card['cpba7'])}" + (f"  vs {_money(card['target_cpba'])} target" if card["target_cpba"] and card["cpba7"] else "")},
    ]
    shown = [i for i in card["issues"] if i["sev"] in ("red", "yellow", "green")][:SLACK_ISSUES_PER_CLIENT]
    hidden = len([i for i in card["issues"] if i["sev"] in ("red", "yellow", "green")]) - len(shown)
    blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": f"{DOT[card['status']]}  *<{card['url']}|{card['name']}>*"}, "fields": fields}]
    if shown:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(_grouped_lines(shown))[:2900]}})
    else:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": "✅ Nothing to change"}]})
    if hidden > 0:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"+{hidden} more · <{card['url']}|open client> · <{base}/today|today>"}]})
    blocks.append({"type": "divider"})
    return blocks


def render_slack(data: dict) -> list[list[dict]]:
    """Messages (each a block list, ≤50 blocks) in posting order."""
    base = data["dashboard_url"]
    y = date.fromisoformat(data["date"])
    t, cnt = data["totals"], data["counts"]
    summary = [
        {"type": "header", "text": {"type": "plain_text", "text": f"📊 Ads daily report · {y.strftime('%a, %b %-d')}"}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*🔴 Needs action*\n{cnt['red']} clients"},
            {"type": "mrkdwn", "text": f"*🟡 Watch*\n{cnt['yellow']} clients"},
            {"type": "mrkdwn", "text": f"*🟢 On target*\n{cnt['green']} clients"},
            {"type": "mrkdwn", "text": f"*⚪ Not graded*\n{cnt['grey']} clients"},
            {"type": "mrkdwn", "text": f"*Spend*  _yday · 7d · 30d_\n{_money(t['spend']['y'])} · {_money(t['spend']['d7'])} · {_money(t['spend']['d30'])}"},
            {"type": "mrkdwn", "text": f"*Leads · Booked*  _7d_\n{_n(t['leads']['d7'])} leads · {_n(t['booked']['d7'])} booked"},
        ]},
    ]
    if data["top_actions"]:
        lines = [f"{n}. {i['icon']} *{i['client']}*" + (f" · {i['campaign']}" if i.get("campaign") else "") + f" — *{i['label']}*: {_first_sentence(i['text'], 90)}"
                 for n, i in enumerate(data["top_actions"][:6], 1)]
        summary.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Top actions today*\n" + "\n".join(lines)}})
    if data["wins"]:
        summary.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Ready to scale*\n" + "\n".join(
            f"{i['icon']} *{i['client']}* · {i['campaign']} — {_first_sentence(i['text'], 70)}" for i in data["wins"][:4])}})
    summary.append({"type": "context", "elements": [
        {"type": "mrkdwn", "text": f"{LEGEND}\nKills and scales wait in the Actions queue — nothing changes until someone approves. <{base}/today|Open today's board>"}]})

    messages = [summary]
    current: list[dict] = []
    group = None
    for card in data["clients"]:
        blocks = _client_blocks(card, base)
        head = []
        if card["status"] != group:
            group = card["status"]
            head = [{"type": "header", "text": {"type": "plain_text", "text": f"{DOT[group]} {STATUS_LABEL[group]} ({cnt[group]})"}}]
        if current and len(current) + len(head) + len(blocks) > 48:
            messages.append(current)
            current = []
        current += head + blocks
    if current:
        messages.append(current)
    return messages


def build_report(as_of: date | None = None) -> dict:
    data = build_cards(as_of)
    msgs = render_slack(data)
    text = "\n\n".join(b["text"]["text"] for m in msgs for b in m if b.get("type") == "section" and b.get("text"))
    return {"text": text, "messages": msgs, "clients": len(data["clients"]),
            "actions": sum(len(c["issues"]) for c in data["clients"]), "date": data["date"]}


def send_daily_report(as_of: date | None = None) -> dict:
    s = get_settings()
    url = s.slack_report_webhook_url or s.slack_webhook_url
    report = build_report(as_of)
    if not url:
        return {"skipped": "no SLACK_REPORT_WEBHOOK_URL / SLACK_WEBHOOK_URL configured", "clients": report["clients"], "date": report["date"]}
    for n, blocks in enumerate(report["messages"]):
        fallback = f"Ads daily report {report['date']}" + ("" if n == 0 else f" (part {n + 1})")
        resp = httpx.post(url, json={"text": fallback, "blocks": blocks}, timeout=30)
        resp.raise_for_status()
    return {"posted": True, "messages": len(report["messages"]), "clients": report["clients"], "actions": report["actions"], "date": report["date"]}

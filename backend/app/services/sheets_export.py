"""Daily Google Sheets export: the dashboard's period rollups written to one
spreadsheet with Daily / Weekly / Monthly tabs (all clients, one row per
client per period).

Auth: OAuth refresh token (spreadsheets + drive.file scopes) minted from the
same OAuth client as Google Ads. The spreadsheet is created by this app on
first run (drive.file only reaches files the app itself created), shared with
the team, and its id kept in app_settings.
"""
import logging
from datetime import date, timedelta
from typing import Any

import httpx

from app.core.config import get_settings
from app.services import pg

logger = logging.getLogger(__name__)

SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
DRIVE_API = "https://www.googleapis.com/drive/v3/files"
SPREADSHEET_TITLE = "ZMS Ads Daily Export"
SHARE_WITH = ["carl@zealmediasolutions.com", "mopaidads@gmail.com"]

TABS = {
    "Daily": ("day", 92),
    "Weekly": ("week", 7 * 26),
    "Monthly": ("month", 366),
}

HEADER = [
    "Period", "Client", "Spend", "Impressions", "Clicks", "CTR", "CPC", "CPM",
    "Leads", "CPL", "Ad Phone Calls", "GHL Contacts", "Paid Contacts", "Junk Leads",
    "Inbound Calls", "Appointments", "Lead→Appt %", "Cost/Appt",
    "Jobs Won", "Revenue Won", "ROAS",
]

HEALTH_TAB = "Health Check"

# Google Ads decision tabs (Carl, 2026-09-24: "track these metrics in the report").
# Last 30 days, every active client with a regular Google account. Rewritten nightly.
GOOGLE_TABS = {
    "Google Campaigns": [
        "Client", "Campaign", "Status", "Spend (30d)", "Clicks", "CPC", "Conversions", "Cost/Conv", "Calls",
        "Search-term spend", "Not-a-keyword spend", "Not-a-keyword %", "Off-intent spend", "Broad %", "Ad groups", "Keywords", "Flags",
    ],
    "Google Keywords": [
        "Client", "Campaign", "Ad group", "Keyword", "Match", "Status", "Spend (30d)", "Impr.", "Clicks", "CTR", "CPC", "Conversions", "Cost/Conv",
    ],
    "Google Search Terms": [
        "Client", "Campaign", "Search term", "Added as keyword?", "Spend (30d)", "Impr.", "Clicks", "Conversions", "Cost/Conv", "Flag",
    ],
    "Funnel": [
        "Week", "Client", "Platform", "Campaign", "Service", "Delivery", "Daily budget", "Spend", "Leads", "CPL",
        "Unique clicks", "Click type", "Cost/Unique click", "Unique CTR", "Impressions", "Reach", "Frequency", "CPM", "CPMr",
        "Hook rate", "Hold rate", "Booked (allocated)", "Booked %", "Cost/Booked",
    ],
    "Funnel (client)": [
        "Week", "Client", "Spend", "Leads", "CPL", "Paid contacts", "Junk", "Qualified", "Qualified %", "Cost/Qualified",
        "Booked", "Booked %", "Cost/Booked", "Confirmed", "Confirmed %", "Showed", "Show %", "No-show %", "Cost/Show",
        "Closed", "Close %", "CAC", "Revenue", "ROAS",
    ],
    "Decisions": [
        "Brief date", "Client", "Campaign", "Platform", "Service", "Verdict", "Gate", "Spend 7d", "Spend 14d",
        "Scheduled 7d", "Scheduled 14d", "CPAs 7d", "CPAs 14d", "Target Ts", "Daily budget", "First leak", "Decision", "Next step", "Confidence",
    ],
    "Landing Pages": [
        "Client", "URL", "Platforms", "Spend (30d)", "Status", "HTTP", "Form?", "Tap-to-call?", "Thank-you page?", "Flags", "Title", "Checked",
    ],
}

HEALTH_HEADER = [
    "Status", "Client", "Spend (7d)", "vs prior wk", "Leads (7d)", "CPL (7d)",
    "CPL target", "Appts (7d)", "Cost/Appt", "Won (7d)", "Revenue (7d)", "What to check",
]

HEALTH_SQL = """
with ads as (
    select client_id,
           sum(spend) filter (where date >= current_date - 6)  as spend_now,
           sum(leads) filter (where date >= current_date - 6)  as leads_now,
           sum(spend) filter (where date <  current_date - 6)  as spend_prev,
           sum(leads) filter (where date <  current_date - 6)  as leads_prev
    from ad_metrics_daily
    where date >= current_date - 13
    group by client_id
),
ghl as (
    select client_id,
           sum(appointments_booked) filter (where date >= current_date - 6) as appts_now,
           sum(appointments_booked) filter (where date <  current_date - 6) as appts_prev,
           sum(jobs_won)            filter (where date >= current_date - 6) as won_now,
           sum(revenue_won)         filter (where date >= current_date - 6) as revenue_now,
           sum(leads_dq)            filter (where date >= current_date - 6) as dq_now
    from ghl_metrics_daily
    where date >= current_date - 13
    group by client_id
)
select c.name, c.cpl_target_green, c.cpl_target_red,
       (c.meta_ad_account_id is not null and c.meta_ad_account_id <> '')
         or (c.google_ads_customer_id is not null and c.google_ads_customer_id <> '') as runs_ads,
       coalesce(a.spend_now, 0) as spend_now, coalesce(a.leads_now, 0) as leads_now,
       coalesce(a.spend_prev, 0) as spend_prev, coalesce(a.leads_prev, 0) as leads_prev,
       coalesce(g.appts_now, 0) as appts_now, coalesce(g.appts_prev, 0) as appts_prev,
       coalesce(g.won_now, 0) as won_now, coalesce(g.revenue_now, 0) as revenue_now,
       coalesce(g.dq_now, 0) as dq_now
from clients c
left join ads a on a.client_id = c.id
left join ghl g on g.client_id = c.id
where c.is_active = true
order by c.name
"""


def _pct(now: float, prev: float) -> str:
    if not prev:
        return ""
    change = (now - prev) / prev
    return f"{'+' if change >= 0 else ''}{round(change * 100)}%"


def _health_row(r: dict) -> tuple[int, list]:
    """Returns (severity_rank, row). Rank 0 = alert, 1 = watch, 2 = good, 3 = idle."""
    spend = float(r["spend_now"])
    leads = float(r["leads_now"])
    spend_prev = float(r["spend_prev"])
    leads_prev = float(r["leads_prev"])
    green, red = float(r["cpl_target_green"]), float(r["cpl_target_red"])
    cpl = spend / leads if leads else None
    cpl_prev = spend_prev / leads_prev if leads_prev else None
    appts = int(r["appts_now"])
    notes: list[str] = []

    if spend == 0:
        if r["runs_ads"] and spend_prev > 0:
            rank, status = 0, "🔴 ALERT"
            notes.append(f"Spend stopped (was ${spend_prev:,.0f} last week) — check delivery/billing")
        else:
            rank, status = 3, "⚪ No spend"
    elif leads == 0:
        rank, status = 0, "🔴 ALERT"
        notes.append(f"${spend:,.0f} spent this week with ZERO leads")
    elif cpl is not None and cpl > red:
        rank, status = 0, "🔴 ALERT"
        notes.append(f"CPL ${cpl:,.0f} is over the ${red:,.0f} red line")
    elif cpl is not None and cpl > green:
        rank, status = 1, "🟡 Watch"
        notes.append(f"CPL ${cpl:,.0f} above the ${green:,.0f} target")
    else:
        rank, status = 2, "🟢 Good"

    if cpl is not None and cpl_prev and cpl > cpl_prev * 1.4:
        notes.append(f"CPL up {_pct(cpl, cpl_prev)} vs last week")
        rank = min(rank, 1)
    if spend_prev and spend < spend_prev * 0.5 and spend > 0:
        notes.append(f"Spend down {_pct(spend, spend_prev)} vs last week")
        rank = min(rank, 1)
    if leads and appts == 0 and int(r["appts_prev"]) > 0:
        notes.append("Leads coming in but no appointments booked this week")
        rank = min(rank, 1)
    dq = int(r.get("dq_now", 0) or 0)
    if leads and dq and dq / (leads + dq) > 0.3:
        notes.append(f"{dq} leads marked junk ({round(dq / (leads + dq) * 100)}% of the week)")
        rank = min(rank, 1)
    if rank == 2 and not notes:
        notes.append(f"On target — keep running (CPL ${cpl:,.0f} vs ${green:,.0f} goal)")

    revenue = float(r["revenue_now"])
    row = [
        status,
        r["name"],
        round(spend, 2),
        _pct(spend, spend_prev),
        leads,
        round(cpl, 2) if cpl is not None else "",
        f"${green:,.0f} / ${red:,.0f}",
        appts,
        round(spend / appts, 2) if appts else "",
        int(r["won_now"]),
        round(revenue, 2),
        "; ".join(notes),
    ]
    return rank, row


def _health_rows() -> list[list]:
    today = date.today().isoformat()
    rows = pg.query(HEALTH_SQL)
    ranked = sorted((_health_row(dict(r)) for r in rows), key=lambda t: t[0])
    return [
        [f"Last 7 days as of {today} — alerts first. Rewritten daily at 7:00 AM PT."],
        HEALTH_HEADER,
        *[row for _, row in ranked],
    ]


EXPORT_SQL = """
with ads as (
    select client_id, date_trunc(%(gran)s, date)::date as period,
           sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(leads) as leads, sum(phone_calls) as phone_calls
    from ad_metrics_daily
    where date >= %(start)s
    group by 1, 2
),
ghl as (
    select client_id, date_trunc(%(gran)s, date)::date as period,
           sum(contacts_created) as ghl_contacts,
           sum(contacts_paid_attributed) as ghl_paid,
           sum(leads_dq) as leads_dq,
           sum(inbound_calls) as inbound_calls,
           sum(appointments_booked) as appointments,
           sum(jobs_won) as jobs_won, sum(revenue_won) as revenue_won
    from ghl_metrics_daily
    where date >= %(start)s
    group by 1, 2
)
select coalesce(a.period, g.period) as period, c.name as client,
       coalesce(a.spend, 0) as spend, coalesce(a.impressions, 0) as impressions,
       coalesce(a.clicks, 0) as clicks, coalesce(a.leads, 0) as leads,
       coalesce(a.phone_calls, 0) as phone_calls,
       coalesce(g.ghl_contacts, 0) as ghl_contacts, coalesce(g.ghl_paid, 0) as ghl_paid,
       coalesce(g.leads_dq, 0) as leads_dq, coalesce(g.inbound_calls, 0) as inbound_calls,
       coalesce(g.appointments, 0) as appointments,
       coalesce(g.jobs_won, 0) as jobs_won, coalesce(g.revenue_won, 0) as revenue_won
from clients c
join (ads a full outer join ghl g using (client_id, period)) on coalesce(a.client_id, g.client_id) = c.id
where c.is_active = true
order by 1 desc, 2
"""


def _access_token() -> str:
    s = get_settings()
    resp = httpx.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": s.google_ads_client_id,
            "client_secret": s.google_ads_client_secret,
            "refresh_token": s.google_sheets_refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _get_setting(key: str) -> str | None:
    rows = pg.query("select value from app_settings where key = %s", (key,))
    return rows[0]["value"] if rows else None


def _set_setting(key: str, value: str) -> None:
    pg.execute(
        """
        insert into app_settings (key, value) values (%s, %s)
        on conflict (key) do update set value = excluded.value
        """,
        (key, value),
    )


def _ensure_tabs(client: httpx.Client, sheet_id: str) -> None:
    r = client.get(f"{SHEETS_API}/{sheet_id}", params={"fields": "sheets.properties.title"})
    r.raise_for_status()
    existing = {s["properties"]["title"] for s in r.json().get("sheets", [])}
    requests = []
    if HEALTH_TAB not in existing:
        requests.append({"addSheet": {"properties": {"title": HEALTH_TAB, "index": 0}}})
    for tab in list(TABS) + list(GOOGLE_TABS):
        if tab not in existing:
            requests.append({"addSheet": {"properties": {"title": tab}}})
    if requests:
        client.post(f"{SHEETS_API}/{sheet_id}:batchUpdate", json={"requests": requests}).raise_for_status()


def _ensure_spreadsheet(client: httpx.Client) -> str:
    sheet_id = _get_setting("sheets_export_id")
    if sheet_id:
        # verify it still exists (someone may have deleted it)
        r = client.get(f"{SHEETS_API}/{sheet_id}", params={"fields": "spreadsheetId"})
        if r.status_code == 200:
            _ensure_tabs(client, sheet_id)
            return sheet_id
    body = {
        "properties": {"title": SPREADSHEET_TITLE},
        "sheets": [{"properties": {"title": HEALTH_TAB}}]
        + [{"properties": {"title": tab}} for tab in TABS],
    }
    r = client.post(SHEETS_API, json=body)
    r.raise_for_status()
    sheet_id = r.json()["spreadsheetId"]
    _set_setting("sheets_export_id", sheet_id)
    for email in SHARE_WITH:
        client.post(
            f"{DRIVE_API}/{sheet_id}/permissions",
            params={"sendNotificationEmail": "false"},
            json={"type": "user", "role": "writer", "emailAddress": email},
        )
    logger.info("Created export spreadsheet %s", sheet_id)
    return sheet_id


def _rows_for(gran: str, days_back: int) -> list[list[Any]]:
    start = date.today() - timedelta(days=days_back)
    rows = pg.query(EXPORT_SQL, {"gran": gran, "start": start})
    out: list[list[Any]] = [HEADER]
    for r in rows:
        spend = float(r["spend"])
        leads = float(r["leads"])
        impressions = int(r["impressions"])
        clicks = int(r["clicks"])
        appts = int(r["appointments"])
        revenue = float(r["revenue_won"])
        out.append([
            r["period"].isoformat(),
            r["client"],
            round(spend, 2),
            impressions,
            clicks,
            round(clicks / impressions, 4) if impressions else "",
            round(spend / clicks, 2) if clicks else "",
            round(spend / impressions * 1000, 2) if impressions else "",
            leads,
            round(spend / leads, 2) if leads else "",
            int(r["phone_calls"]),
            int(r["ghl_contacts"]),
            int(r["ghl_paid"]),
            int(r["leads_dq"]),
            int(r["inbound_calls"]),
            appts,
            round(appts / leads, 4) if leads else "",
            round(spend / appts, 2) if appts else "",
            int(r["jobs_won"]),
            round(revenue, 2),
            round(revenue / spend, 2) if spend else "",
        ])
    return out


def send_slack_health_alerts() -> dict:
    """Post the Health Check alerts/watch items to Slack. No-op without a webhook."""
    s = get_settings()
    if not s.slack_webhook_url:
        return {"skipped": "no SLACK_WEBHOOK_URL configured"}
    rows = pg.query(HEALTH_SQL)
    ranked = sorted((_health_row(dict(r)) for r in rows), key=lambda t: t[0])
    alerts = [row for rank, row in ranked if rank == 0]
    watch = [row for rank, row in ranked if rank == 1]
    if not alerts and not watch:
        text = "🟢 *ZMS Ads health check:* all clients on target this week."
    else:
        lines = [f"*ZMS Ads health check — last 7 days* (<{s.dashboard_url}|dashboard>)"]
        for row in alerts:
            lines.append(f"{row[0]} *{row[1]}* — {row[-1]}")
        for row in watch:
            lines.append(f"{row[0]} {row[1]} — {row[-1]}")
        text = "\n".join(lines)
    resp = httpx.post(s.slack_webhook_url, json={"text": text}, timeout=30)
    resp.raise_for_status()
    return {"alerts": len(alerts), "watch": len(watch)}


# Column indexes (0-based) holding money / percent values in the period tabs and health tab.
G_CAMPAIGNS_SQL = """
select c.name client, c.slug, m.campaign_id, max(m.campaign_name) campaign, max(m.campaign_status) status,
       sum(m.spend) spend, sum(m.clicks) clicks, sum(m.leads) conv, sum(m.phone_calls) calls
from ad_metrics_daily m join clients c on c.id = m.client_id and c.is_active
where m.platform = 'google' and m.date >= current_date - 30
group by c.name, c.slug, m.campaign_id order by c.name, sum(m.spend) desc
"""
G_TERMS_SQL = """
select c.name client, t.campaign_id, t.search_term, max(t.term_status) term_status,
       sum(t.spend) spend, sum(t.impressions) impressions, sum(t.clicks) clicks, sum(t.conversions) conv
from google_search_terms_daily t join clients c on c.id = t.client_id and c.is_active
where t.date >= current_date - 30
group by c.name, t.campaign_id, t.search_term
"""
G_KEYWORDS_SQL = """
select c.name client, k.campaign_id, k.ad_group_id, max(g.ad_group_name) ad_group, max(k.keyword_text) keyword,
       max(k.match_type) match_type, max(k.keyword_status) status,
       sum(k.spend) spend, sum(k.impressions) impressions, sum(k.clicks) clicks, sum(k.conversions) conv
from google_keyword_metrics_daily k join clients c on c.id = k.client_id and c.is_active
left join google_adgroup_metrics_daily g on g.client_id = k.client_id and g.ad_group_id = k.ad_group_id and g.date = k.date
where k.date >= current_date - 30
group by c.name, k.campaign_id, k.ad_group_id, k.criterion_id
having sum(k.impressions) > 0
order by c.name, sum(k.spend) desc
"""
G_ADGROUP_COUNT_SQL = """
select client_id, campaign_id, count(distinct ad_group_id) n from google_adgroup_metrics_daily
where date >= current_date - 30 group by 1, 2
"""
LANDING_SQL = """
select c.name client, l.url, l.platforms, l.spend_30d, l.status, l.http_status, l.has_form, l.has_tel_link,
       l.looks_thank_you, l.client_rendered, l.flags, l.title, l.checked_at
from landing_page_checks l join clients c on c.id = l.client_id and c.is_active
order by case l.status when 'red' then 0 when 'yellow' then 1 else 2 end, l.spend_30d desc
"""


FUNNEL_CAMPAIGN_SQL = """
with vi as (
    select date_trunc('week', date)::date week, client_id, campaign_id, sum(impressions) video_impressions
    from ad_level_metrics_daily where platform = 'meta' and video_3s_plays > 0
      and date >= date_trunc('week', current_date)::date - 56
    group by 1, 2, 3
)
select date_trunc('week', m.date)::date week, c.name client, m.platform, m.campaign_id, max(m.campaign_name) campaign,
       coalesce(max(csm.service), 'Unclassified') service,
       sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads,
       sum(m.reach) reach, sum(m.unique_link_clicks) ulc, sum(m.unique_outbound_clicks) uoc,
       sum(m.video_3s_plays) v3, sum(m.thruplays) thru, max(vi.video_impressions) video_impressions
from ad_metrics_daily m join clients c on c.id = m.client_id and c.is_active
left join campaign_service_map csm on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
left join vi on vi.week = date_trunc('week', m.date)::date and vi.client_id = m.client_id and vi.campaign_id = m.campaign_id
where m.date >= date_trunc('week', current_date)::date - 56
group by 1, 2, 3, 4 having sum(m.spend) > 0 order by 1 desc, 2, spend desc
"""
FUNNEL_APPTS_SQL = """
select date_trunc('week', g.date)::date week, g.client_id, sum(g.appointments_booked) booked
from ghl_metrics_daily g where g.date >= date_trunc('week', current_date)::date - 56 group by 1, 2
"""
FUNNEL_CLIENT_SQL = """
with ads as (
    select date_trunc('week', date)::date week, client_id, sum(spend) spend, sum(leads) leads
    from ad_metrics_daily where date >= date_trunc('week', current_date)::date - 56 group by 1, 2
), ghl as (
    select date_trunc('week', date)::date week, client_id, sum(contacts_paid_attributed) paid, sum(leads_dq) dq,
           sum(appointments_booked) booked, sum(appointments_confirmed) confirmed, sum(appointments_showed) showed,
           sum(appointments_noshow) noshow, sum(jobs_won) won, sum(revenue_won) revenue
    from ghl_metrics_daily where date >= date_trunc('week', current_date)::date - 56 group by 1, 2
)
select a.week, c.name client, a.spend, a.leads, g.paid, g.dq, g.booked, g.confirmed, g.showed, g.noshow, g.won, g.revenue
from ads a join clients c on c.id = a.client_id and c.is_active
left join ghl g on g.week = a.week and g.client_id = a.client_id
where a.spend > 0 order by a.week desc, c.name
"""


def _funnel_rows() -> dict[str, list[list[Any]]]:
    def sd(a, b, nd=2):
        a, b = float(a or 0), float(b or 0)
        return round(a / b, nd) if b else ""

    # campaign-level booked = the client's paid bookings that week spread by lead share
    # (same idea as the dashboard's allocation; exact for one-campaign clients)
    camp = [dict(r) for r in pg.query(FUNNEL_CAMPAIGN_SQL)]
    budgets = {(str(r["client_id"]), r["platform"], r["campaign_id"]): dict(r) for r in pg.query(
        """select b.client_id, b.platform, b.campaign_id, max(b.status) filter (where b.entity_type = 'campaign') status,
                  coalesce(max(b.daily_budget) filter (where b.entity_type = 'campaign'),
                           sum(b.daily_budget) filter (where b.entity_type = 'adset' and b.status in ('ACTIVE','ENABLED'))) daily_budget
           from campaign_budgets b group by 1, 2, 3""")}
    booked = {(r["week"], str(r["client_id"])): float(r["booked"] or 0) for r in pg.query(FUNNEL_APPTS_SQL)}
    ids = {r["name"]: str(r["id"]) for r in pg.query("select id, name from clients")}
    leads_by = {}
    for r in camp:
        k = (r["week"], r["client"])
        leads_by[k] = leads_by.get(k, 0.0) + float(r["leads"] or 0)
    rows: list[list[Any]] = [GOOGLE_TABS["Funnel"]]
    for r in camp:
        spend, imps, clicks, leads = float(r["spend"]), float(r["impressions"]), float(r["clicks"]), float(r["leads"])
        reach, ulc, uoc, v3, thru = (float(r[k] or 0) for k in ("reach", "ulc", "uoc", "v3", "thru"))
        unique = uoc if (uoc > 0 and uoc >= 0.5 * ulc) else ulc
        vimps = float(r.get("video_impressions") or 0) or imps
        share = leads / leads_by[(r["week"], r["client"])] if leads_by.get((r["week"], r["client"])) else 0
        alloc = round(booked.get((r["week"], ids.get(r["client"], "")), 0.0) * share, 1)
        bud = budgets.get((ids.get(r["client"], ""), r["platform"], r["campaign_id"]), {})
        rows.append([r["week"].isoformat(), r["client"], r["platform"], r["campaign"], r["service"],
                     (bud.get("status") or "").lower(), float(bud["daily_budget"]) if bud.get("daily_budget") else "",
                     round(spend, 2), leads, sd(spend, leads),
                     int(unique), "outbound" if (uoc > 0 and uoc >= 0.5 * ulc) else "link" if ulc > 0 else "", sd(spend, unique), sd(unique, imps, 4),
                     int(imps), int(reach), sd(imps, reach), sd(spend * 1000, imps), sd(spend * 1000, reach),
                     sd(v3, vimps, 4) if v3 else "", sd(thru, v3, 4) if v3 else "", alloc, sd(alloc, leads, 4), sd(spend, alloc)])
    crows: list[list[Any]] = [GOOGLE_TABS["Funnel (client)"]]
    for r in pg.query(FUNNEL_CLIENT_SQL):
        spend, leads = float(r["spend"]), float(r["leads"] or 0)
        paid, dq_all = float(r["paid"] or 0), float(r["dq"] or 0)
        base = paid if paid > 0 else leads
        dq = dq_all  # weekly rows have no all-contacts count to scale by; shown as junk moved that week
        qualified = max(base - dq, float(r["booked"] or 0))
        b, conf, sh, ns, won, rev = (float(r[k] or 0) for k in ("booked", "confirmed", "showed", "noshow", "won", "revenue"))
        show_tracked = (sh + ns) > 0  # setters who never mark showed/no-show → leave blank, not 0%
        crows.append([r["week"].isoformat(), r["client"], round(spend, 2), leads, sd(spend, leads), paid, round(dq, 1), round(qualified, 1), sd(qualified, base, 4), sd(spend, qualified),
                      b, sd(b, qualified or base, 4), sd(spend, b), conf, sd(conf, b, 4) if conf else "",
                      sh if show_tracked else "", sd(sh, b, 4) if show_tracked else "", sd(ns, b, 4) if show_tracked else "", sd(spend, sh) if show_tracked else "",
                      won, sd(won, sh or b, 4) if won else "", sd(spend, won) if won else "", round(rev, 2), sd(rev, spend) if rev else ""])
    return {"Funnel": rows, "Funnel (client)": crows}


DECISIONS_SQL = """
select b.brief_date, c.name client, f.value f
from daily_briefs b join clients c on c.id = b.client_id
cross join lateral jsonb_array_elements(b.findings) f
where b.brief_date = (select max(brief_date) from daily_briefs) and f.value->>'kind' = 'sop_verdict'
order by c.name, case f.value->>'verdict' when 'fix' then 0 when 'kill' then 1 when 'kill_or_rebuild' then 2 when 'quality_fail' then 3
                          when 'diagnose' then 4 when 'scale' then 5 when 'micro_scale' then 6 else 7 end
"""


def _decision_rows() -> dict[str, list[list[Any]]]:
    rows: list[list[Any]] = [GOOGLE_TABS["Decisions"]]
    for r in pg.query(DECISIONS_SQL):
        f = r["f"]; ev = f.get("evidence") or {}; d = f.get("decision") or {}
        name = f.get("entity_name") or ""
        # message starts with "name (platform, service): ..." — pull platform/service back out
        import re
        m = re.match(r".*?\((meta|google|lsa), ([^)]*)\)", f.get("message") or "")
        rows.append([r["brief_date"].isoformat(), r["client"], name, m.group(1) if m else "", m.group(2) if m else "",
                     f.get("verdict"), f.get("gate"), ev.get("spend_7"), ev.get("spend_14"), ev.get("scheduled_7"), ev.get("scheduled_14"),
                     ev.get("cpa_s_7") or "", ev.get("cpa_s_14") or "", ev.get("target_ts") or "", ev.get("daily_budget") or "",
                     f.get("layer") or "", d.get("decision"), d.get("next_step"), d.get("confidence")])
    return {"Decisions": rows}


def _google_rows() -> dict[str, list[list[Any]]]:
    """Build the four Google tabs in one pass (top 300 keywords / terms per client)."""
    from app.routers.google_ads import OFF_INTENT  # same intent words as the dashboard

    def off(term: str) -> bool:
        t = f" {term.lower()} "
        return any(w in t for w in OFF_INTENT)

    def sd(a, b, nd=2):
        return round(float(a) / float(b), nd) if b else ""

    terms = [dict(r) for r in pg.query(G_TERMS_SQL)]
    keywords = [dict(r) for r in pg.query(G_KEYWORDS_SQL)]
    campaigns = [dict(r) for r in pg.query(G_CAMPAIGNS_SQL)]
    ag_counts = {(str(r["client_id"]), r["campaign_id"]): r["n"] for r in pg.query(G_ADGROUP_COUNT_SQL)}
    name = {c["campaign_id"]: c["campaign"] for c in campaigns}

    camp_rows: list[list[Any]] = [GOOGLE_TABS["Google Campaigns"]]
    for c in campaigns:
        ct = [t for t in terms if t["campaign_id"] == c["campaign_id"] and t["client"] == c["client"]]
        ck = [k for k in keywords if k["campaign_id"] == c["campaign_id"] and k["client"] == c["client"]]
        spend, clicks, conv = float(c["spend"]), int(c["clicks"]), float(c["conv"])
        tspend = sum(float(t["spend"]) for t in ct)
        unmanaged = sum(float(t["spend"]) for t in ct if t["term_status"] == "NONE")
        off_spend = sum(float(t["spend"]) for t in ct if off(t["search_term"]))
        kspend = sum(float(k["spend"]) for k in ck)
        broad = sum(float(k["spend"]) for k in ck if k["match_type"] == "BROAD")
        flags = []
        if clicks >= 200 and clicks and spend / clicks < 1.5 and conv == 0:
            flags.append("junk traffic (cheap clicks, 0 conv)")
        elif spend >= 150 and conv == 0:
            flags.append("0 conversions")
        if tspend >= 200 and unmanaged / tspend > 0.5:
            flags.append("over half of term spend not on keywords")
        if off_spend >= 50:
            flags.append("off-intent queries")
        if kspend >= 100 and broad / kspend > 0.5:
            flags.append("broad-match heavy")
        camp_rows.append([
            c["client"], c["campaign"], c["status"], round(spend, 2), clicks, sd(spend, clicks), conv, sd(spend, conv),
            float(c["calls"]), round(tspend, 2), round(unmanaged, 2), sd(unmanaged, tspend, 4), round(off_spend, 2),
            sd(broad, kspend, 4), ag_counts.get((None, None), 0) or "", len(ck), "; ".join(flags),
        ])
    # ad-group counts need the client id; cheap second pass by (client name → id) is overkill, use campaign_id only
    agc = {}
    for (cid, camp), n in ag_counts.items():
        agc[camp] = n
    for row in camp_rows[1:]:
        cid_camp = next((c["campaign_id"] for c in campaigns if c["campaign"] == row[1] and c["client"] == row[0]), None)
        row[14] = agc.get(cid_camp, "")

    kw_rows: list[list[Any]] = [GOOGLE_TABS["Google Keywords"]]
    per_client: dict[str, int] = {}
    for k in keywords:
        if per_client.get(k["client"], 0) >= 300:
            continue
        per_client[k["client"]] = per_client.get(k["client"], 0) + 1
        spend, imps, clicks, conv = float(k["spend"]), int(k["impressions"]), int(k["clicks"]), float(k["conv"])
        kw_rows.append([k["client"], name.get(k["campaign_id"], k["campaign_id"]), k["ad_group"], k["keyword"], k["match_type"], k["status"],
                        round(spend, 2), imps, clicks, sd(clicks, imps, 4), sd(spend, clicks), conv, sd(spend, conv)])

    term_rows: list[list[Any]] = [GOOGLE_TABS["Google Search Terms"]]
    per_client = {}
    for t in sorted(terms, key=lambda t: (t["client"], -float(t["spend"]), -int(t["clicks"]))):
        if per_client.get(t["client"], 0) >= 300:
            continue
        per_client[t["client"]] = per_client.get(t["client"], 0) + 1
        spend, clicks, conv = float(t["spend"]), int(t["clicks"]), float(t["conv"])
        flag = ("off-intent" if off(t["search_term"]) else "converting" if conv > 0
                else "not a keyword, no conv" if t["term_status"] == "NONE" and clicks >= 3 else "not a keyword" if t["term_status"] == "NONE" else "")
        term_rows.append([t["client"], name.get(t["campaign_id"], t["campaign_id"]), t["search_term"],
                          {"ADDED": "yes", "EXCLUDED": "negative", "NONE": "no"}.get(t["term_status"], t["term_status"]),
                          round(spend, 2), int(t["impressions"]), clicks, conv, sd(spend, conv), flag])

    lp_rows: list[list[Any]] = [GOOGLE_TABS["Landing Pages"]]
    for r in pg.query(LANDING_SQL):
        yn = lambda v: "" if v is None else ("yes" if v else "no")
        lp_rows.append([r["client"], r["url"], ", ".join(r["platforms"] or []), round(float(r["spend_30d"]), 2), r["status"], r["http_status"],
                        "n/a (app page)" if r["client_rendered"] else yn(r["has_form"]),
                        "n/a (app page)" if r["client_rendered"] else yn(r["has_tel_link"]),
                        "YES" if r["looks_thank_you"] else "no", "; ".join(r["flags"] or []), r["title"] or "",
                        r["checked_at"].strftime("%Y-%m-%d %H:%M") if r["checked_at"] else ""])
    return {"Google Campaigns": camp_rows, "Google Keywords": kw_rows, "Google Search Terms": term_rows, "Landing Pages": lp_rows}


_PERIOD_MONEY_COLS = [HEADER.index(c) for c in ("Spend", "CPC", "CPM", "CPL", "Cost/Appt", "Revenue Won")]
_PERIOD_PCT_COLS = [HEADER.index(c) for c in ("CTR", "Lead→Appt %")]
_HEALTH_MONEY_COLS = [2, 5, 8, 10]


def _format_requests(
    sheet_id_num: int, money_cols: list[int], header_row: int, pct_cols: list[int] = (),
) -> list[dict]:
    """Freeze + bold the header, currency-format money columns, percent-format ratio columns."""
    reqs = [
        {
            "updateSheetProperties": {
                "properties": {"sheetId": sheet_id_num, "gridProperties": {"frozenRowCount": header_row + 1}},
                "fields": "gridProperties.frozenRowCount",
            }
        },
        {
            "repeatCell": {
                "range": {"sheetId": sheet_id_num, "startRowIndex": header_row, "endRowIndex": header_row + 1},
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                "fields": "userEnteredFormat.textFormat.bold",
            }
        },
    ]
    for col in money_cols:
        reqs.append(
            {
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id_num,
                        "startRowIndex": header_row + 1,
                        "startColumnIndex": col,
                        "endColumnIndex": col + 1,
                    },
                    "cell": {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY", "pattern": "$#,##0.00"}}},
                    "fields": "userEnteredFormat.numberFormat",
                }
            }
        )
    for col in pct_cols:
        reqs.append(
            {
                "repeatCell": {
                    "range": {
                        "sheetId": sheet_id_num,
                        "startRowIndex": header_row + 1,
                        "startColumnIndex": col,
                        "endColumnIndex": col + 1,
                    },
                    "cell": {"userEnteredFormat": {"numberFormat": {"type": "PERCENT", "pattern": "0.00%"}}},
                    "fields": "userEnteredFormat.numberFormat",
                }
            }
        )
    reqs.append(
        {
            "autoResizeDimensions": {
                "dimensions": {
                    "sheetId": sheet_id_num, "dimension": "COLUMNS",
                    "startIndex": 0, "endIndex": max(len(HEADER), len(HEALTH_HEADER)),
                }
            }
        }
    )
    return reqs


def _apply_formatting(client: httpx.Client, sheet_id: str) -> None:
    r = client.get(f"{SHEETS_API}/{sheet_id}", params={"fields": "sheets.properties"})
    r.raise_for_status()
    ids = {s["properties"]["title"]: s["properties"]["sheetId"] for s in r.json()["sheets"]}
    reqs: list[dict] = []
    if HEALTH_TAB in ids:
        reqs += _format_requests(ids[HEALTH_TAB], _HEALTH_MONEY_COLS, header_row=1)
    for tab in TABS:
        if tab in ids:
            reqs += _format_requests(ids[tab], _PERIOD_MONEY_COLS, header_row=0, pct_cols=_PERIOD_PCT_COLS)
    for tab, header in GOOGLE_TABS.items():
        if tab in ids:
            money = [i for i, h in enumerate(header) if h.startswith("Spend") or h.startswith("Cost/") or h.startswith("CPAs") or h in ("CPC", "CPL", "CPM", "CPMr", "CAC", "Revenue", "Daily budget", "Target Ts") or h.endswith("spend")]
            pct = [i for i, h in enumerate(header) if h.endswith("%") or h in ("CTR", "Unique CTR", "Hook rate", "Hold rate")]
            reqs += _format_requests(ids[tab], money, header_row=0, pct_cols=pct)
    if reqs:
        client.post(f"{SHEETS_API}/{sheet_id}:batchUpdate", json={"requests": reqs}).raise_for_status()


def run_sheets_export() -> dict:
    """Rewrite all three tabs. Returns row counts per tab."""
    token = _access_token()
    written = {}
    with httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=120) as client:
        sheet_id = _ensure_spreadsheet(client)
        health = _health_rows()
        client.post(f"{SHEETS_API}/{sheet_id}/values/{HEALTH_TAB}!A1:Z:clear", json={}).raise_for_status()
        client.put(
            f"{SHEETS_API}/{sheet_id}/values/{HEALTH_TAB}!A1",
            params={"valueInputOption": "RAW"},
            json={"values": health},
        ).raise_for_status()
        written[HEALTH_TAB] = len(health) - 2
        for tab, (gran, days_back) in TABS.items():
            values = _rows_for(gran, days_back)
            client.post(
                f"{SHEETS_API}/{sheet_id}/values/{tab}!A1:Z:clear", json={}
            ).raise_for_status()
            r = client.put(
                f"{SHEETS_API}/{sheet_id}/values/{tab}!A1",
                params={"valueInputOption": "RAW"},
                json={"values": values},
            )
            r.raise_for_status()
            written[tab] = len(values) - 1
        try:
            for tab, values in {**_decision_rows(), **_google_rows(), **_funnel_rows()}.items():
                client.post(f"{SHEETS_API}/{sheet_id}/values/{tab}!A1:Z:clear", json={}).raise_for_status()
                client.put(f"{SHEETS_API}/{sheet_id}/values/{tab}!A1", params={"valueInputOption": "RAW"},
                           json={"values": values}).raise_for_status()
                written[tab] = len(values) - 1
        except Exception:
            logger.exception("Google tabs export failed (period tabs were written)")
        _apply_formatting(client, sheet_id)
    written["spreadsheet_id"] = sheet_id
    return written

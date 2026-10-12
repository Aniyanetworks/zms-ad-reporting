"""SQL transforms: raw_* dlt landing tables → ad_metrics_daily.

dbt-style staging models (patterned after Fivetran's dbt_ad_reporting grain:
one row per client/platform/campaign/day). Pure SQL upserts — the raw schemas stay
untouched for Phase 2 drill-down.

Settled snapshots: Meta/Google silently restate conversions after the fact. We stamp
leads_t1/t3/t7 with the first value observed at >= 1/3/7 days after the row's date —
i.e. the value "as of" that age — and never overwrite them. This gives an audit trail
against client billing/reporting disputes.
"""
from datetime import date

from app.services import pg

MERGE_META_SQL = """
insert into ad_metrics_daily (
    client_id, platform, campaign_id, campaign_name, campaign_status, date,
    spend, impressions, clicks, leads, phone_calls, account_timezone, currency, raw, synced_at, reach, unique_link_clicks, unique_outbound_clicks, video_3s_plays, thruplays
)
select
    %(client_id)s, 'meta', r.campaign_id, r.campaign_name, r.campaign_status, r.date,
    coalesce(r.spend, 0), coalesce(r.impressions, 0), coalesce(r.clicks, 0),
    coalesce(r.leads, 0), coalesce(r.phone_calls, 0),
    r.account_timezone, coalesce(r.currency, 'USD'), r.raw, now(),
    coalesce(r.reach, 0), coalesce(r.unique_link_clicks, 0), coalesce(r.unique_outbound_clicks, 0), coalesce(r.video_3s_plays, 0), coalesce(r.thruplays, 0)
from raw_meta.campaign_insights_daily r
where r.account_id = %(account_id)s
  and r.date between %(start)s and %(end)s
  and (%(campaign_filter)s::text is null or r.campaign_name ilike %(campaign_filter)s)
on conflict (client_id, platform, campaign_id, date) do update set
    campaign_name = excluded.campaign_name,
    campaign_status = excluded.campaign_status,
    spend = excluded.spend,
    impressions = excluded.impressions,
    clicks = excluded.clicks,
    leads = excluded.leads,
    phone_calls = excluded.phone_calls,
    account_timezone = excluded.account_timezone,
    currency = excluded.currency,
    reach = excluded.reach,
    unique_link_clicks = excluded.unique_link_clicks,
    unique_outbound_clicks = excluded.unique_outbound_clicks,
    video_3s_plays = excluded.video_3s_plays,
    thruplays = excluded.thruplays,
    raw = excluded.raw,
    synced_at = excluded.synced_at
"""

MERGE_META_ADSET_SQL = """
insert into adset_metrics_daily (
    client_id, platform, campaign_id, adset_id, adset_name, date,
    spend, impressions, clicks, leads, phone_calls, currency, raw, synced_at, reach, unique_link_clicks, unique_outbound_clicks, video_3s_plays, thruplays
)
select
    %(client_id)s, 'meta', r.campaign_id, r.adset_id, r.adset_name, r.date,
    coalesce(r.spend, 0), coalesce(r.impressions, 0), coalesce(r.clicks, 0),
    coalesce(r.leads, 0), coalesce(r.phone_calls, 0), coalesce(r.currency, 'USD'), r.raw, now(),
    coalesce(r.reach, 0), coalesce(r.unique_link_clicks, 0), coalesce(r.unique_outbound_clicks, 0), coalesce(r.video_3s_plays, 0), coalesce(r.thruplays, 0)
from raw_meta.adset_insights_daily r
where r.account_id = %(account_id)s
  and r.date between %(start)s and %(end)s
  and (%(campaign_filter)s::text is null or r.campaign_name ilike %(campaign_filter)s)
on conflict (client_id, platform, adset_id, date) do update set
    campaign_id = excluded.campaign_id,
    adset_name = excluded.adset_name,
    spend = excluded.spend,
    impressions = excluded.impressions,
    clicks = excluded.clicks,
    leads = excluded.leads,
    phone_calls = excluded.phone_calls,
    currency = excluded.currency,
    reach = excluded.reach,
    unique_link_clicks = excluded.unique_link_clicks,
    unique_outbound_clicks = excluded.unique_outbound_clicks,
    video_3s_plays = excluded.video_3s_plays,
    thruplays = excluded.thruplays,
    raw = excluded.raw,
    synced_at = excluded.synced_at
"""

MERGE_META_AD_SQL = """
insert into ad_level_metrics_daily (
    client_id, platform, campaign_id, adset_id, ad_id, ad_name, date,
    spend, impressions, clicks, leads, phone_calls, currency, raw, synced_at, reach, unique_link_clicks, unique_outbound_clicks, video_3s_plays, thruplays
)
select
    %(client_id)s, 'meta', r.campaign_id, r.adset_id, r.ad_id, r.ad_name, r.date,
    coalesce(r.spend, 0), coalesce(r.impressions, 0), coalesce(r.clicks, 0),
    coalesce(r.leads, 0), coalesce(r.phone_calls, 0), coalesce(r.currency, 'USD'), r.raw, now(),
    coalesce(r.reach, 0), coalesce(r.unique_link_clicks, 0), coalesce(r.unique_outbound_clicks, 0), coalesce(r.video_3s_plays, 0), coalesce(r.thruplays, 0)
from raw_meta.ad_insights_daily r
where r.account_id = %(account_id)s
  and r.date between %(start)s and %(end)s
  and (%(campaign_filter)s::text is null or r.campaign_name ilike %(campaign_filter)s)
on conflict (client_id, platform, ad_id, date) do update set
    campaign_id = excluded.campaign_id,
    adset_id = excluded.adset_id,
    ad_name = excluded.ad_name,
    spend = excluded.spend,
    impressions = excluded.impressions,
    clicks = excluded.clicks,
    leads = excluded.leads,
    phone_calls = excluded.phone_calls,
    currency = excluded.currency,
    reach = excluded.reach,
    unique_link_clicks = excluded.unique_link_clicks,
    unique_outbound_clicks = excluded.unique_outbound_clicks,
    video_3s_plays = excluded.video_3s_plays,
    thruplays = excluded.thruplays,
    raw = excluded.raw,
    synced_at = excluded.synced_at
"""

MERGE_GOOGLE_SQL = """
insert into ad_metrics_daily (
    client_id, platform, campaign_id, campaign_name, campaign_status, date,
    spend, impressions, clicks, leads, phone_calls, account_timezone, currency, raw, synced_at
)
select
    %(client_id)s,
    coalesce(%(platform_override)s::text,
             case when r.campaign_name like 'LocalServicesCampaign%%' then 'lsa' else 'google' end),
    r.campaign_id, r.campaign_name, r.campaign_status, r.date,
    coalesce(r.spend, 0), coalesce(r.impressions, 0), coalesce(r.clicks, 0),
    coalesce(r.conversions, 0), coalesce(r.phone_calls, 0),
    r.account_timezone, coalesce(r.currency, 'USD'), r.raw, now()
from raw_google.campaign_metrics_daily r
where r.customer_id = %(customer_id)s
  and r.date between %(start)s and %(end)s
on conflict (client_id, platform, campaign_id, date) do update set
    campaign_name = excluded.campaign_name,
    campaign_status = excluded.campaign_status,
    spend = excluded.spend,
    impressions = excluded.impressions,
    clicks = excluded.clicks,
    leads = excluded.leads,
    phone_calls = excluded.phone_calls,
    account_timezone = excluded.account_timezone,
    currency = excluded.currency,
    raw = excluded.raw,
    synced_at = excluded.synced_at
"""

# Stamp-once snapshots. Rows are stamped by the first sync that runs at or after the
# snapshot age, so a missed sync day leaves no permanent hole — the next run stamps it.
SNAPSHOT_SQL = """
update ad_metrics_daily
set leads_t1 = coalesce(leads_t1, case when date <= current_date - 1 then leads end),
    leads_t3 = coalesce(leads_t3, case when date <= current_date - 3 then leads end),
    leads_t7 = coalesce(leads_t7, case when date <= current_date - 7 then leads end)
where client_id = %(client_id)s
  and platform = %(platform)s
  and (
    (leads_t1 is null and date <= current_date - 1) or
    (leads_t3 is null and date <= current_date - 3) or
    (leads_t7 is null and date <= current_date - 7)
  )
"""


def merge_meta(
    client_id: str, account_id: str, start: date, end: date,
    campaign_filter: str | None = None,
) -> int:
    import psycopg2.errors

    params = {"client_id": client_id, "account_id": account_id.removeprefix("act_"),
              "start": start, "end": end, "campaign_filter": campaign_filter}
    rows = pg.execute(MERGE_META_SQL, params)
    # Sub-campaign grains: raw tables are created lazily by dlt, so they may not
    # exist yet for accounts whose first sync returned zero rows.
    for sql in (MERGE_META_ADSET_SQL, MERGE_META_AD_SQL):
        try:
            pg.execute(sql, params)
        except psycopg2.errors.UndefinedTable:
            pass
    pg.execute(SNAPSHOT_SQL, {"client_id": client_id, "platform": "meta"})
    return rows


def merge_google(client_id: str, customer_id: str, start: date, end: date,
                 platform_override: str | None = None) -> int:
    """platform_override='lsa' for a client's dedicated Local Services account; otherwise
    LSA campaigns inside a regular account are split out by name."""
    rows = pg.execute(
        MERGE_GOOGLE_SQL,
        {"client_id": client_id, "customer_id": customer_id.replace("-", ""),
         "start": start, "end": end, "platform_override": platform_override},
    )
    for platform in ("google", "lsa"):
        pg.execute(SNAPSHOT_SQL, {"client_id": client_id, "platform": platform})
    return rows

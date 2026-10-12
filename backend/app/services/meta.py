"""Meta Marketing API sync via dlt.

Uses the vendored dlt facebook_ads verified source's helpers (auth, retry/backoff on
error codes 17/613/8000x, async report jobs) with a custom campaign-level resource:

- The stock `facebook_insights` resource always sends `action_attribution_windows`,
  which Meta deprecated Jan 12, 2026 — the API now mirrors Ads Manager attribution
  settings automatically, so we must NOT pass any attribution-window params.
- We need explicit date-window control (re-pull trailing 28 days daily; 12-month
  backfill cap) rather than dlt incremental state.

Rows land in the `raw_meta` schema; SQL in app.services.transform models them into
`ad_metrics_daily` (grain per Fivetran dbt_ad_reporting: client/platform/campaign/day).
"""
import json
from datetime import date, timedelta
from typing import Any, Iterator

import dlt
import pendulum
from facebook_business.adobjects.adaccount import AdAccount

from app.core.config import get_settings
from facebook_ads.helpers import execute_job, get_ads_account


def _get_account(account_id: str, access_token: str, request_timeout: int) -> AdAccount:
    try:
        return get_ads_account(account_id, access_token, request_timeout, app_api_version=None)
    except ValueError:
        # Partner-shared (client-owned) accounts don't appear in /me/adaccounts —
        # the API session is already initialized by get_ads_account, address directly.
        return AdAccount("act_" + account_id)

# Meta serves at most ~13 months of history for some fields/breakdowns; cap at 12.
MAX_BACKFILL_DAYS = 365
# Meta restates conversions for up to 28 days after the click — every daily sync
# re-pulls the trailing 28 days and upserts (same approach as Airbyte/Stitch).
LOOKBACK_DAYS = 28

INSIGHT_FIELDS = [
    "campaign_id",
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "actions",
    "account_currency",
    "date_start",
    "date_stop",
    # Funnel / ad metrics (Carl's metrics guide, 2026-09-24): reach + frequency, CPM,
    # unique link clicks (on-platform funnels), unique outbound clicks (website
    # funnels), ThruPlays. 3-second plays come from actions[video_view].
    "reach",
    "frequency",
    "cpm",
    "unique_clicks",
    "unique_ctr",
    "unique_inline_link_clicks",
    "unique_inline_link_click_ctr",
    "cost_per_unique_inline_link_click",
    "unique_outbound_clicks",
    "unique_outbound_clicks_ctr",
    "cost_per_unique_outbound_click",
    "outbound_clicks",
    "video_thruplay_watched_actions",
    "video_play_actions",
]

# Extra id/name fields per report level (campaign fields are always requested so
# the meta_campaign_filter ILIKE works at every level).
LEVEL_FIELDS = {
    "campaign": [],
    "adset": ["adset_id", "adset_name"],
    "ad": ["adset_id", "adset_name", "ad_id", "ad_name"],
}

# Ad-level async report jobs over a full year can time out on Meta's side —
# chunk sub-campaign levels into smaller windows.
LEVEL_CHUNK_DAYS = {"campaign": 400, "adset": 120, "ad": 120}

# 'lead' is Meta's aggregate lead action (on-platform forms + pixel leads). When it is
# present we use it alone to avoid double counting; otherwise we sum the split types.
LEAD_AGGREGATE_ACTION = "lead"
LEAD_SPLIT_ACTIONS = ("onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead")
PHONE_ACTION_SUBSTRINGS = ("phone_call", "click_to_call")


def _parse_actions(actions: list[dict[str, Any]] | None) -> tuple[float, float]:
    """Return (leads, phone_calls) from an insights `actions` list."""
    leads = 0.0
    split_leads = 0.0
    phone_calls = 0.0
    has_aggregate = False
    for action in actions or []:
        action_type = action.get("action_type", "")
        try:
            value = float(action.get("value", 0))
        except (TypeError, ValueError):
            value = 0.0
        if action_type == LEAD_AGGREGATE_ACTION:
            leads += value
            has_aggregate = True
        elif action_type in LEAD_SPLIT_ACTIONS:
            split_leads += value
        if any(s in action_type for s in PHONE_ACTION_SUBSTRINGS):
            phone_calls += value
    return (leads if has_aggregate else split_leads), phone_calls


def _first_value(items) -> float:
    """Sum of `value` over an insights action-list field (e.g. unique_outbound_clicks)."""
    total = 0.0
    for it in items or []:
        try:
            total += float(it.get("value", 0))
        except (TypeError, ValueError, AttributeError):
            pass
    return total


def _extra_metrics(row: dict[str, Any]) -> dict[str, Any]:
    """reach / unique link clicks / unique outbound clicks / 3-second plays / ThruPlays."""
    video_3s = 0.0
    for a in row.get("actions") or []:
        if a.get("action_type") == "video_view":
            try:
                video_3s += float(a.get("value", 0))
            except (TypeError, ValueError):
                pass
    return {
        "reach": int(row.get("reach") or 0),
        "unique_link_clicks": int(row.get("unique_inline_link_clicks") or 0),
        "unique_outbound_clicks": int(_first_value(row.get("unique_outbound_clicks"))),
        "video_3s_plays": video_3s,
        "thruplays": _first_value(row.get("video_thruplay_watched_actions")),
    }


_COMMON_COLUMNS = {
    "raw": {"data_type": "json"},
    "reach": {"data_type": "bigint"},
    "unique_link_clicks": {"data_type": "bigint"},
    "unique_outbound_clicks": {"data_type": "bigint"},
    "video_3s_plays": {"data_type": "decimal"},
    "thruplays": {"data_type": "decimal"},
    "date": {"data_type": "date"},
    "spend": {"data_type": "decimal"},
    "impressions": {"data_type": "bigint"},
    "clicks": {"data_type": "bigint"},
    "leads": {"data_type": "decimal"},
    "phone_calls": {"data_type": "decimal"},
}


def _insight_rows(
    account: AdAccount,
    level: str,
    start_date: date,
    end_date: date,
) -> Iterator[dict[str, Any]]:
    """Run async insight report jobs for one level, chunked by date window.

    Deliberately passes NO attribution-window params — the API mirrors the ad
    account's Ads Manager attribution settings (post-2026 behavior).
    """
    fields = INSIGHT_FIELDS + LEVEL_FIELDS[level]
    chunk = timedelta(days=LEVEL_CHUNK_DAYS[level])
    since = start_date
    while since <= end_date:
        until = min(since + chunk - timedelta(days=1), end_date)
        params = {
            "level": level,
            "time_increment": 1,
            "limit": 500,
            "fields": fields,
            "time_range": {"since": since.isoformat(), "until": until.isoformat()},
        }
        job = execute_job(account.get_insights(params=params, is_async=True))
        for item in job.get_result():
            yield dict(item.export_all_data())
        since = until + timedelta(days=1)


@dlt.resource(
    name="campaign_insights_daily",
    primary_key=("account_id", "campaign_id", "date"),
    write_disposition="merge",
    columns=_COMMON_COLUMNS,
)
def meta_campaign_insights(
    account_id: str,
    access_token: str,
    start_date: date,
    end_date: date,
    request_timeout: int = 300,
) -> Iterator[dict[str, Any]]:
    """One row per campaign per day, campaign level."""
    account = _get_account(account_id, access_token, request_timeout)

    # Account-level metadata (timezone + currency) — each account reports in its
    # OWN timezone; daily rows stay in account-local dates (no PT conversion).
    account_meta = account.api_get(fields=["timezone_name", "currency"])
    account_timezone = account_meta.get("timezone_name")
    currency = account_meta.get("currency", "USD")

    # Campaign effective_status isn't in insights rows — fetch the map separately.
    status_map: dict[str, str] = {}
    for campaign in account.get_campaigns(fields=["id", "effective_status"]):
        status_map[campaign["id"]] = campaign.get("effective_status")

    for row in _insight_rows(account, "campaign", start_date, end_date):
        leads, phone_calls = _parse_actions(row.get("actions"))
        yield {
            "account_id": account_id,
            "campaign_id": row["campaign_id"],
            "campaign_name": row.get("campaign_name"),
            "campaign_status": status_map.get(row["campaign_id"]),
            "date": row["date_start"],
            "spend": float(row.get("spend") or 0),
            "impressions": int(row.get("impressions") or 0),
            "clicks": int(row.get("clicks") or 0),
            "leads": leads,
            "phone_calls": phone_calls,
            "account_timezone": account_timezone,
            "currency": currency,
            **_extra_metrics(row),
            "raw": json.loads(json.dumps(row, default=str)),
        }


def _sub_campaign_row(account_id: str, row: dict[str, Any]) -> dict[str, Any]:
    leads, phone_calls = _parse_actions(row.get("actions"))
    return {
        "account_id": account_id,
        "campaign_id": row["campaign_id"],
        "campaign_name": row.get("campaign_name"),
        "adset_id": row["adset_id"],
        "adset_name": row.get("adset_name"),
        "date": row["date_start"],
        "spend": float(row.get("spend") or 0),
        "impressions": int(row.get("impressions") or 0),
        "clicks": int(row.get("clicks") or 0),
        "leads": leads,
        "phone_calls": phone_calls,
        "currency": row.get("account_currency", "USD"),
        **_extra_metrics(row),
        "raw": json.loads(json.dumps(row, default=str)),
    }


@dlt.resource(
    name="adset_insights_daily",
    primary_key=("account_id", "adset_id", "date"),
    write_disposition="merge",
    columns=_COMMON_COLUMNS,
)
def meta_adset_insights(
    account_id: str,
    access_token: str,
    start_date: date,
    end_date: date,
    request_timeout: int = 300,
) -> Iterator[dict[str, Any]]:
    """One row per ad set per day."""
    account = _get_account(account_id, access_token, request_timeout)
    for row in _insight_rows(account, "adset", start_date, end_date):
        yield _sub_campaign_row(account_id, row)


@dlt.resource(
    name="ad_insights_daily",
    primary_key=("account_id", "ad_id", "date"),
    write_disposition="merge",
    columns=_COMMON_COLUMNS,
)
def meta_ad_insights(
    account_id: str,
    access_token: str,
    start_date: date,
    end_date: date,
    request_timeout: int = 300,
) -> Iterator[dict[str, Any]]:
    """One row per ad per day."""
    account = _get_account(account_id, access_token, request_timeout)
    for row in _insight_rows(account, "ad", start_date, end_date):
        yield {**_sub_campaign_row(account_id, row), "ad_id": row["ad_id"], "ad_name": row.get("ad_name")}


def sync_ad_creatives(account_id: str, access_token: str, request_timeout: int = 300) -> int:
    """Upsert preview links, thumbnails AND the creative copy (headline, primary
    text, description, CTA, media ids, full object_story_spec / asset_feed_spec)
    for every ad in the account. The copy is what an AI reviewer needs to judge a
    creative; the dashboard itself only shows the preview link. Failure here must
    not fail the metrics sync — callers treat it as best-effort."""
    from facebook_business.exceptions import FacebookRequestError

    account = _get_account(account_id.removeprefix("act_"), access_token, request_timeout)
    # Small pages: preview_shareable_link is generated server-side per ad and
    # large pages 500 on big accounts (seen on US Pro at limit=100). Accounts with
    # heavy asset_feed_specs (Teppco) fail even at 25 with Graph error code 1
    # "Please reduce the amount of data" — fall back to smaller pages; the upsert is
    # idempotent so restarting from the first page is safe.
    last_exc: Exception | None = None
    for limit in (25, 10, 4):
        try:
            return _sync_creatives_pages(account, account_id, limit)
        except FacebookRequestError as exc:
            if exc.api_error_code() != 1:
                raise
            last_exc = exc
    raise last_exc  # type: ignore[misc]


def _sync_creatives_pages(account, account_id: str, limit: int) -> int:
    import json

    from app.services import pg

    count = 0
    ads = account.get_ads(
        fields=["name", "status", "effective_status", "preview_shareable_link",
                "campaign_id", "adset_id", "created_time",
                "creative{id,thumbnail_url,url_tags,object_story_spec,asset_feed_spec,"
                "title,body,image_url,video_id,call_to_action_type}"],
        params={"limit": limit},
    )
    for ad in ads:
        row = dict(ad.export_all_data())
        creative = row.get("creative") or {}
        link, has_utm = _creative_link_and_utm(creative)
        copy = _creative_copy(creative)
        pg.execute(
            """
            insert into meta_ad_creatives (ad_id, account_id, ad_name, status, effective_status, preview_link, thumbnail_url,
                                           link_url, url_tags, has_adset_utm, creative_id, campaign_id, adset_id,
                                           title, body, description, cta_type, image_url, video_id,
                                           object_story_spec, asset_feed_spec, created_time, updated_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            on conflict (ad_id) do update set
                ad_name = excluded.ad_name,
                status = excluded.status,
                effective_status = excluded.effective_status,
                preview_link = excluded.preview_link,
                thumbnail_url = excluded.thumbnail_url,
                link_url = excluded.link_url,
                url_tags = excluded.url_tags,
                has_adset_utm = excluded.has_adset_utm,
                creative_id = excluded.creative_id,
                campaign_id = excluded.campaign_id,
                adset_id = excluded.adset_id,
                title = excluded.title,
                body = excluded.body,
                description = excluded.description,
                cta_type = excluded.cta_type,
                image_url = excluded.image_url,
                video_id = excluded.video_id,
                object_story_spec = excluded.object_story_spec,
                asset_feed_spec = excluded.asset_feed_spec,
                created_time = excluded.created_time,
                updated_at = now()
            """,
            (
                row["id"],
                account_id.removeprefix("act_"),
                row.get("name"),
                row.get("status"),
                row.get("effective_status"),
                row.get("preview_shareable_link"),
                creative.get("thumbnail_url"),
                link,
                creative.get("url_tags"),
                has_utm,
                creative.get("id"),
                row.get("campaign_id"),
                row.get("adset_id"),
                copy["title"],
                copy["body"],
                copy["description"],
                copy["cta_type"],
                creative.get("image_url"),
                creative.get("video_id"),
                json.dumps(creative.get("object_story_spec")) if creative.get("object_story_spec") else None,
                json.dumps(creative.get("asset_feed_spec")) if creative.get("asset_feed_spec") else None,
                row.get("created_time"),
            ),
        )
        count += 1
    return count


def sync_budgets(client_id: str, account_id: str, access_token: str, request_timeout: int = 120) -> int:
    """Snapshot campaign + ad set daily/lifetime budgets into campaign_budgets.
    Meta stores budgets in minor units (cents). CBO campaigns carry the budget on
    the campaign; ABO campaigns carry it on each ad set (campaign budget = 0)."""
    from app.services import pg

    account = _get_account(account_id.removeprefix("act_"), access_token, request_timeout)
    currency = (account.api_get(fields=["currency"]) or {}).get("currency", "USD")
    rows: list[tuple] = []
    cbo: dict[str, bool] = {}
    for c in account.get_campaigns(fields=["id", "name", "effective_status", "daily_budget", "lifetime_budget"], params={"limit": 200}):
        d = dict(c.export_all_data())
        daily = int(d.get("daily_budget") or 0) / 100 or None
        life = int(d.get("lifetime_budget") or 0) / 100 or None
        cbo[d["id"]] = bool(daily or life)
        rows.append((client_id, "meta", "campaign", d["id"], d["id"], d.get("name"), d.get("effective_status"),
                     daily, life, "campaign" if (daily or life) else "adset", currency))
    for a in account.get_ad_sets(fields=["id", "name", "campaign_id", "effective_status", "daily_budget", "lifetime_budget"], params={"limit": 200}):
        d = dict(a.export_all_data())
        daily = int(d.get("daily_budget") or 0) / 100 or None
        life = int(d.get("lifetime_budget") or 0) / 100 or None
        rows.append((client_id, "meta", "adset", d["id"], d.get("campaign_id"), d.get("name"), d.get("effective_status"),
                     daily, life, "campaign" if cbo.get(d.get("campaign_id")) else "adset", currency))
    if rows:
        import psycopg2.extras
        with pg.get_conn() as conn, conn.cursor() as cur:
            psycopg2.extras.execute_batch(cur, """
                insert into campaign_budgets (client_id, platform, entity_type, entity_id, campaign_id, name, status,
                                              daily_budget, lifetime_budget, budget_source, currency, updated_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                on conflict (client_id, platform, entity_type, entity_id) do update set
                    campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status,
                    daily_budget = excluded.daily_budget, lifetime_budget = excluded.lifetime_budget,
                    budget_source = excluded.budget_source, currency = excluded.currency, updated_at = now()""", rows, page_size=200)
    return len(rows)


def _creative_copy(creative: dict) -> dict:
    """Headline / primary text / description / CTA from wherever Meta put them:
    top-level creative fields, object_story_spec link_data / video_data, or (dynamic
    creative) the first entries of asset_feed_spec. Lists of variants stay in the
    stored asset_feed_spec jsonb."""
    oss = creative.get("object_story_spec") or {}
    ld = oss.get("link_data") or {}
    vd = oss.get("video_data") or {}
    afs = creative.get("asset_feed_spec") or {}

    def first_text(items):
        for it in items or []:
            if isinstance(it, dict) and it.get("text"):
                return it["text"]
        return None

    title = creative.get("title") or ld.get("name") or vd.get("title") or first_text(afs.get("titles"))
    body = creative.get("body") or ld.get("message") or vd.get("message") or first_text(afs.get("bodies"))
    description = ld.get("description") or vd.get("link_description") or first_text(afs.get("descriptions"))
    cta = (creative.get("call_to_action_type")
           or (ld.get("call_to_action") or {}).get("type")
           or (vd.get("call_to_action") or {}).get("type")
           or ((afs.get("call_to_action_types") or [None])[0]))
    return {"title": title, "body": body, "description": description, "cta_type": cta}


def _creative_link_and_utm(creative: dict) -> tuple[str | None, bool | None]:
    """(website link, has utm_medium={{adset.name}}). has_adset_utm is None for
    Instant Form / on-Facebook destinations, where UTMs don't apply — GHL gets
    the ad set name from the form integration instead."""
    from urllib.parse import parse_qs, urlsplit

    oss = creative.get("object_story_spec") or {}
    ld = oss.get("link_data") or {}
    vd = oss.get("video_data") or {}
    link = (ld.get("link")
            or ((vd.get("call_to_action") or {}).get("value") or {}).get("link")
            or ((ld.get("call_to_action") or {}).get("value") or {}).get("link"))
    if not link or "fb.me" in link or "facebook.com" in link or "fb.com" in link or "whatsapp" in link:
        return link, None
    medium = (parse_qs(urlsplit(link).query).get("utm_medium") or [""])[0]
    tags = creative.get("url_tags") or ""
    if not medium and "utm_medium=" in tags:
        medium = tags.split("utm_medium=", 1)[1].split("&", 1)[0]
    return link, "adset.name" in medium


def run_meta_pipeline(client_slug: str, meta_ad_account_id: str, days: int = LOOKBACK_DAYS) -> int:
    """Extract + load campaign insights for one client into raw_meta. Returns row count."""
    settings = get_settings()
    days = min(days, MAX_BACKFILL_DAYS)
    account_id = meta_ad_account_id.removeprefix("act_")
    end = pendulum.today().date()
    start = end - timedelta(days=days)

    pipeline = dlt.pipeline(
        pipeline_name=f"meta_{client_slug}",
        destination=dlt.destinations.postgres(credentials=settings.supabase_db_url),
        dataset_name="raw_meta",
    )
    kwargs = dict(
        account_id=account_id,
        access_token=settings.meta_system_user_token,
        start_date=start,
        end_date=end,
    )
    from app.services.dlt_lock import run_serialized

    run_serialized(pipeline, [
        meta_campaign_insights(**kwargs),
        meta_adset_insights(**kwargs),
        meta_ad_insights(**kwargs),
    ], "raw_meta")
    try:
        sync_ad_creatives(account_id, settings.meta_system_user_token)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("creative metadata sync failed for %s", client_slug)
    return _count_raw_rows(account_id, start, end)


def _count_raw_rows(account_id: str, start: date, end: date) -> int:
    import psycopg2.errors

    from app.services import pg

    try:
        rows = pg.query(
            """
            select count(*) as n from raw_meta.campaign_insights_daily
            where account_id = %s and date >= %s and date <= %s
            """,
            (account_id, start, end),
        )
    except psycopg2.errors.UndefinedTable:
        # zero rows extracted on the very first run — dlt creates the table lazily
        return 0
    return rows[0]["n"]

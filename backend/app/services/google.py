"""Google Ads API sync via dlt.

The dlt google_ads verified source ships only dimension resources (no daily metrics),
so per the build spec we write a custom GAQL resource for the one metric set we need
and keep dlt for loading/merging into the `raw_google` schema.

Auth: OAuth refresh token + developer token under the ZMS MCC — `login_customer_id`
is the MCC ID and each client's `customer_id` is queried individually.
"""
import json
from datetime import date, timedelta
from typing import Any, Iterator

import dlt
import pendulum
from google.ads.googleads.client import GoogleAdsClient

from app.core.config import get_settings

# Google restates conversions for weeks after the click — rolling re-sync of the
# trailing 30 days on every daily run; backfill capped at 12 months.
LOOKBACK_DAYS = 30
MAX_BACKFILL_DAYS = 365

CAMPAIGN_METRICS_GAQL = """
SELECT campaign.id, campaign.name, campaign.status,
       metrics.cost_micros, metrics.impressions, metrics.clicks,
       metrics.conversions, metrics.phone_calls,
       segments.date
FROM campaign
WHERE segments.date BETWEEN '{start}' AND '{end}'
"""

ACCOUNT_META_GAQL = "SELECT customer.time_zone, customer.currency_code FROM customer"


def get_google_ads_client() -> GoogleAdsClient:
    settings = get_settings()
    return GoogleAdsClient.load_from_dict(
        {
            "developer_token": settings.google_ads_developer_token,
            "client_id": settings.google_ads_client_id,
            "client_secret": settings.google_ads_client_secret,
            "refresh_token": settings.google_ads_refresh_token,
            "login_customer_id": settings.google_ads_login_customer_id.replace("-", ""),
            "use_proto_plus": True,
        }
    )


@dlt.resource(
    name="campaign_metrics_daily",
    primary_key=("customer_id", "campaign_id", "date"),
    write_disposition="merge",
    columns={
        "raw": {"data_type": "json"},
        "date": {"data_type": "date"},
        "spend": {"data_type": "decimal"},
        "impressions": {"data_type": "bigint"},
        "clicks": {"data_type": "bigint"},
        "conversions": {"data_type": "decimal"},
        "phone_calls": {"data_type": "decimal"},
    },
)
def google_campaign_metrics(
    customer_id: str,
    start_date: date,
    end_date: date,
) -> Iterator[dict[str, Any]]:
    """One row per campaign per day via GAQL search_stream."""
    client = get_google_ads_client()
    service = client.get_service("GoogleAdsService")

    # Account metadata — each account reports in its OWN timezone/currency.
    account_timezone = None
    currency = "USD"
    for batch in service.search_stream(customer_id=customer_id, query=ACCOUNT_META_GAQL):
        for row in batch.results:
            account_timezone = row.customer.time_zone
            currency = row.customer.currency_code or "USD"

    query = CAMPAIGN_METRICS_GAQL.format(start=start_date.isoformat(), end=end_date.isoformat())
    for batch in service.search_stream(customer_id=customer_id, query=query):
        for row in batch.results:
            raw = {
                "campaign": {
                    "id": str(row.campaign.id),
                    "name": row.campaign.name,
                    "status": row.campaign.status.name,
                },
                "metrics": {
                    "cost_micros": row.metrics.cost_micros,
                    "impressions": row.metrics.impressions,
                    "clicks": row.metrics.clicks,
                    "conversions": row.metrics.conversions,
                    "phone_calls": row.metrics.phone_calls,
                },
                "segments": {"date": row.segments.date},
            }
            yield {
                "customer_id": customer_id,
                "campaign_id": str(row.campaign.id),
                "campaign_name": row.campaign.name,
                "campaign_status": row.campaign.status.name,
                "date": row.segments.date,
                "spend": row.metrics.cost_micros / 1_000_000,  # micros → currency units
                "impressions": row.metrics.impressions,
                "clicks": row.metrics.clicks,
                "conversions": row.metrics.conversions,
                "phone_calls": row.metrics.phone_calls,
                "account_timezone": account_timezone,
                "currency": currency,
                "raw": json.loads(json.dumps(raw, default=str)),
            }


def run_google_pipeline(client_slug: str, customer_id: str, days: int = LOOKBACK_DAYS) -> int:
    """Extract + load campaign metrics for one client into raw_google. Returns row count."""
    settings = get_settings()
    days = min(days, MAX_BACKFILL_DAYS)
    customer_id = customer_id.replace("-", "")  # store digits only
    end = pendulum.today().date()
    start = end - timedelta(days=days)

    pipeline = dlt.pipeline(
        pipeline_name=f"google_{client_slug}",
        destination=dlt.destinations.postgres(credentials=settings.supabase_db_url),
        dataset_name="raw_google",
    )
    from app.services.dlt_lock import run_serialized

    run_serialized(pipeline, google_campaign_metrics(customer_id=customer_id, start_date=start, end_date=end), "raw_google")
    return _count_raw_rows(customer_id, start, end)


def _count_raw_rows(customer_id: str, start: date, end: date) -> int:
    import psycopg2.errors

    from app.services import pg

    try:
        rows = pg.query(
            """
            select count(*) as n from raw_google.campaign_metrics_daily
            where customer_id = %s and date >= %s and date <= %s
            """,
            (customer_id, start, end),
        )
    except psycopg2.errors.UndefinedTable:
        # zero rows extracted on the very first run — dlt creates the table lazily
        return 0
    return rows[0]["n"]


# ---------------------------------------------------------------------------
# Below campaign level — ad groups, ads (RSA copy), keywords, search terms.
# Not used by the dashboard's numbers (those stay on ad_metrics_daily); collected
# so an AI reviewer can read what is actually running and what people searched.
# Each report is independent: one failing GAQL never blocks the others.
# ---------------------------------------------------------------------------

ADGROUP_GAQL = """
SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.type,
       metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.phone_calls,
       segments.date
FROM ad_group
WHERE segments.date BETWEEN '{start}' AND '{end}' AND metrics.impressions > 0
"""

AD_GAQL = """
SELECT campaign.id, ad_group.id, ad_group.name,
       ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad_strength,
       ad_group_ad.ad.final_urls,
       ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
       metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions,
       segments.date
FROM ad_group_ad
WHERE segments.date BETWEEN '{start}' AND '{end}' AND metrics.impressions > 0
"""

KEYWORD_GAQL = """
SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id,
       ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status,
       metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions,
       segments.date
FROM keyword_view
WHERE segments.date BETWEEN '{start}' AND '{end}' AND metrics.impressions > 0
"""

SEARCH_TERM_GAQL = """
SELECT campaign.id, ad_group.id, search_term_view.search_term, search_term_view.status,
       metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions,
       segments.date
FROM search_term_view
WHERE segments.date BETWEEN '{start}' AND '{end}'
"""


def _assets(items) -> list[dict[str, Any]]:
    return [{"text": a.text, "pinned_field": a.pinned_field.name if a.pinned_field else None} for a in items]


def sync_granular(client_id: str, customer_id: str, start: date, end: date) -> dict[str, int]:
    """Pull ad-group / ad / keyword / search-term daily rows for one regular Google
    Ads account and upsert them into the public google_* tables. Returns row counts
    per report; a report that errors is logged and reported as -1."""
    import logging

    import psycopg2.extras

    from app.services import pg

    log = logging.getLogger(__name__)
    customer_id = customer_id.replace("-", "")
    service = get_google_ads_client().get_service("GoogleAdsService")
    fmt = dict(start=start.isoformat(), end=end.isoformat())
    counts: dict[str, int] = {}

    def run(name: str, gaql: str, sql: str, to_row) -> None:
        try:
            rows = []
            for batch in service.search_stream(customer_id=customer_id, query=gaql.format(**fmt)):
                rows.extend(to_row(r) for r in batch.results)
            if rows:
                with pg.get_conn() as conn, conn.cursor() as cur:
                    psycopg2.extras.execute_batch(cur, sql, rows, page_size=500)
            counts[name] = len(rows)
        except Exception:
            log.exception("Google %s sync failed for customer %s", name, customer_id)
            counts[name] = -1

    run(
        "ad_groups", ADGROUP_GAQL,
        """insert into google_adgroup_metrics_daily
               (client_id, customer_id, campaign_id, campaign_name, ad_group_id, ad_group_name, ad_group_status,
                ad_group_type, date, spend, impressions, clicks, conversions, phone_calls, synced_at)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
           on conflict (client_id, ad_group_id, date) do update set
               campaign_id = excluded.campaign_id, campaign_name = excluded.campaign_name,
               ad_group_name = excluded.ad_group_name, ad_group_status = excluded.ad_group_status,
               ad_group_type = excluded.ad_group_type, spend = excluded.spend, impressions = excluded.impressions,
               clicks = excluded.clicks, conversions = excluded.conversions, phone_calls = excluded.phone_calls,
               synced_at = now()""",
        lambda r: (client_id, customer_id, str(r.campaign.id), r.campaign.name, str(r.ad_group.id), r.ad_group.name,
                   r.ad_group.status.name, r.ad_group.type_.name, r.segments.date,
                   r.metrics.cost_micros / 1_000_000, r.metrics.impressions, r.metrics.clicks,
                   r.metrics.conversions, r.metrics.phone_calls),
    )
    run(
        "ads", AD_GAQL,
        """insert into google_ad_metrics_daily
               (client_id, customer_id, campaign_id, ad_group_id, ad_group_name, ad_id, ad_name, ad_type, ad_status,
                ad_strength, final_urls, headlines, descriptions, date, spend, impressions, clicks, conversions, synced_at)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
           on conflict (client_id, ad_id, date) do update set
               campaign_id = excluded.campaign_id, ad_group_id = excluded.ad_group_id, ad_group_name = excluded.ad_group_name,
               ad_name = excluded.ad_name, ad_type = excluded.ad_type, ad_status = excluded.ad_status,
               ad_strength = excluded.ad_strength, final_urls = excluded.final_urls, headlines = excluded.headlines,
               descriptions = excluded.descriptions, spend = excluded.spend, impressions = excluded.impressions,
               clicks = excluded.clicks, conversions = excluded.conversions, synced_at = now()""",
        lambda r: (client_id, customer_id, str(r.campaign.id), str(r.ad_group.id), r.ad_group.name,
                   str(r.ad_group_ad.ad.id), r.ad_group_ad.ad.name or None, r.ad_group_ad.ad.type_.name,
                   r.ad_group_ad.status.name, r.ad_group_ad.ad_strength.name,
                   json.dumps(list(r.ad_group_ad.ad.final_urls)),
                   json.dumps(_assets(r.ad_group_ad.ad.responsive_search_ad.headlines)),
                   json.dumps(_assets(r.ad_group_ad.ad.responsive_search_ad.descriptions)),
                   r.segments.date, r.metrics.cost_micros / 1_000_000, r.metrics.impressions, r.metrics.clicks,
                   r.metrics.conversions),
    )
    run(
        "keywords", KEYWORD_GAQL,
        """insert into google_keyword_metrics_daily
               (client_id, customer_id, campaign_id, ad_group_id, criterion_id, keyword_text, match_type, keyword_status,
                date, spend, impressions, clicks, conversions, synced_at)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
           on conflict (client_id, ad_group_id, criterion_id, date) do update set
               campaign_id = excluded.campaign_id, keyword_text = excluded.keyword_text, match_type = excluded.match_type,
               keyword_status = excluded.keyword_status, spend = excluded.spend, impressions = excluded.impressions,
               clicks = excluded.clicks, conversions = excluded.conversions, synced_at = now()""",
        lambda r: (client_id, customer_id, str(r.campaign.id), str(r.ad_group.id), str(r.ad_group_criterion.criterion_id),
                   r.ad_group_criterion.keyword.text, r.ad_group_criterion.keyword.match_type.name,
                   r.ad_group_criterion.status.name, r.segments.date, r.metrics.cost_micros / 1_000_000,
                   r.metrics.impressions, r.metrics.clicks, r.metrics.conversions),
    )
    run(
        "search_terms", SEARCH_TERM_GAQL,
        """insert into google_search_terms_daily
               (client_id, customer_id, campaign_id, ad_group_id, search_term, term_status,
                date, spend, impressions, clicks, conversions, synced_at)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
           on conflict (client_id, ad_group_id, search_term, date) do update set
               campaign_id = excluded.campaign_id, term_status = excluded.term_status, spend = excluded.spend,
               impressions = excluded.impressions, clicks = excluded.clicks, conversions = excluded.conversions,
               synced_at = now()""",
        lambda r: (client_id, customer_id, str(r.campaign.id), str(r.ad_group.id), r.search_term_view.search_term,
                   r.search_term_view.status.name, r.segments.date, r.metrics.cost_micros / 1_000_000,
                   r.metrics.impressions, r.metrics.clicks, r.metrics.conversions),
    )
    return counts


BUDGET_GAQL = """
SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.period,
       campaign_budget.total_amount_micros
FROM campaign WHERE campaign.status != 'REMOVED'
"""


def sync_budgets(client_id: str, customer_id: str, platform_override: str | None = None) -> int:
    """Snapshot Google campaign budgets (daily or total) into campaign_budgets."""
    import psycopg2.extras

    from app.services import pg

    customer_id = customer_id.replace("-", "")
    service = get_google_ads_client().get_service("GoogleAdsService")
    rows: list[tuple] = []
    for batch in service.search_stream(customer_id=customer_id, query=BUDGET_GAQL):
        for r in batch.results:
            platform = platform_override or ("lsa" if r.campaign.name.startswith("LocalServicesCampaign") else "google")
            period = r.campaign_budget.period.name if r.campaign_budget.period else "DAILY"
            amount = r.campaign_budget.amount_micros / 1_000_000 if r.campaign_budget.amount_micros else None
            total = r.campaign_budget.total_amount_micros / 1_000_000 if r.campaign_budget.total_amount_micros else None
            rows.append((client_id, platform, "campaign", str(r.campaign.id), str(r.campaign.id), r.campaign.name,
                         r.campaign.status.name, amount if period == "DAILY" else None, total or (amount if period != "DAILY" else None),
                         "campaign", "USD"))
    if rows:
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


# LSA (Local Services Ads): the Local Services API is a separate surface; deferred to
# Phase 2 per spec — do not block Phase 1 on it.

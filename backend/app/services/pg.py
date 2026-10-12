"""Sync Postgres helpers for Celery tasks (psycopg2, service role — RLS bypassed)."""
import json
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg2
import psycopg2.extras

from app.core.config import get_settings

psycopg2.extras.register_default_jsonb(loads=json.loads, globally=True)


@contextmanager
def get_conn() -> Iterator[psycopg2.extensions.connection]:
    conn = psycopg2.connect(get_settings().supabase_db_url)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]


def execute(sql: str, params: tuple = ()) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


def get_active_clients(source_column: str) -> list[dict[str, Any]]:
    """Active clients that have the given source id column populated.

    source_column: 'meta_ad_account_id' | 'google_ads_customer_id' | 'ghl_location_id'
    """
    assert source_column in ("meta_ad_account_id", "google_ads_customer_id", "google_lsa_customer_id", "ghl_location_id")
    return query(
        f"""
        select c.id, c.name, c.slug, c.meta_ad_account_id, c.google_ads_customer_id,
               c.google_lsa_customer_id, c.ghl_location_id, c.meta_campaign_filter, s.ghl_token
        from clients c
        left join client_secrets s on s.client_id = c.id
        where c.is_active = true and c.{source_column} is not null and c.{source_column} <> ''
        order by c.slug
        """
    )

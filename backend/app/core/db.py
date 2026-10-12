"""asyncpg connection pool for API reads/writes (service role — RLS bypassed).

Celery tasks run sync and use psycopg2 via app.services.pg instead.
"""
import json
from typing import Any

import asyncpg

from app.core.config import get_settings

_pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    # Transparent jsonb <-> dict encoding
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        settings = get_settings()
        _pool = await asyncpg.create_pool(
            settings.supabase_db_url,
            min_size=1,
            max_size=10,
            init=_init_conn,
            # Supabase transaction-mode pooler can't handle prepared statements
            statement_cache_size=0,
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def fetch(query: str, *args: Any) -> list[asyncpg.Record]:
    pool = await get_pool()
    return await pool.fetch(query, *args)


async def fetchrow(query: str, *args: Any) -> asyncpg.Record | None:
    pool = await get_pool()
    return await pool.fetchrow(query, *args)


async def execute(query: str, *args: Any) -> str:
    pool = await get_pool()
    return await pool.execute(query, *args)

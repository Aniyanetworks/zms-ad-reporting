"""Serialize dlt LOAD steps per raw dataset.

Every client's Meta pipeline loads into the same `raw_meta` dataset, and dlt's merge
writes through a shared `<dataset>_staging` table. With the worker at concurrency 4, two
clients loading at the same moment collided in staging ("duplicate key value violates
unique constraint ad_insights_daily__dlt_id_key") — Dove / Castles / Austin failed the
1:00 AM run on 2026-09-28 and Austin / Bay Area on 2026-09-25, each recovering only at
the 6:00 pass. Extraction and normalization stay parallel; only load() takes the lock.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Iterator

import redis

from app.core.config import get_settings

logger = logging.getLogger(__name__)


@contextmanager
def load_lock(dataset: str, timeout: int = 900, wait: int = 1800) -> Iterator[None]:
    """Hold a Redis lock named after the dataset while dlt loads. Falls through (unlocked)
    if Redis is unreachable — a sync without the lock is better than no sync."""
    try:
        client = redis.Redis.from_url(get_settings().redis_url)
        lock = client.lock(f"dlt-load:{dataset}", timeout=timeout, blocking_timeout=wait)
        acquired = lock.acquire()
    except redis.RedisError:
        logger.warning("dlt load lock unavailable for %s — loading without it", dataset)
        yield
        return
    if not acquired:
        logger.warning("waited %ss for the %s load lock — loading without it", wait, dataset)
        yield
        return
    try:
        yield
    finally:
        try:
            lock.release()
        except redis.RedisError:
            pass


def run_serialized(pipeline, data, dataset: str):
    """pipeline.run() with the load step behind the dataset lock."""
    pipeline.extract(data)
    pipeline.normalize()
    with load_lock(dataset):
        return pipeline.load()

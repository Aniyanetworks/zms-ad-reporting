"""Supabase Storage for uploaded creatives (private bucket, service-role access).

The bucket is created on first use. Files are addressed as
<build_id>/<asset_id>.<ext>; the browser gets short-lived signed URLs.
"""
from __future__ import annotations

import logging

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

BUCKET = "campaign-assets"
IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
VIDEO_TYPES = {"video/mp4": "mp4", "video/quicktime": "mov"}
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_VIDEO_BYTES = 200 * 1024 * 1024


def _base() -> str:
    return get_settings().supabase_url.rstrip("/") + "/storage/v1"


def _headers() -> dict:
    key = get_settings().supabase_service_role_key
    return {"Authorization": f"Bearer {key}", "apikey": key}


async def ensure_bucket(client: httpx.AsyncClient) -> None:
    r = await client.get(f"{_base()}/bucket/{BUCKET}", headers=_headers())
    if r.status_code == 200:
        return
    r = await client.post(
        f"{_base()}/bucket",
        headers=_headers(),
        json={
            "id": BUCKET, "name": BUCKET, "public": False,
            "file_size_limit": MAX_VIDEO_BYTES,
            "allowed_mime_types": [*IMAGE_TYPES, *VIDEO_TYPES],
        },
    )
    if r.status_code not in (200, 201, 409):
        raise RuntimeError(f"storage bucket create failed: {r.status_code} {r.text[:200]}")
    logger.info("created storage bucket %s", BUCKET)


async def upload(path: str, content_type: str, data: bytes) -> None:
    async with httpx.AsyncClient(timeout=120) as client:
        await ensure_bucket(client)
        r = await client.post(
            f"{_base()}/object/{BUCKET}/{path}",
            headers={**_headers(), "Content-Type": content_type, "x-upsert": "true"},
            content=data,
        )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"storage upload failed: {r.status_code} {r.text[:200]}")


async def delete(path: str) -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        await client.delete(f"{_base()}/object/{BUCKET}/{path}", headers=_headers())


async def signed_url(path: str, expires_in: int = 3600) -> str | None:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{_base()}/object/sign/{BUCKET}/{path}", headers=_headers(), json={"expiresIn": expires_in}
        )
    if r.status_code != 200:
        return None
    signed = r.json().get("signedURL") or r.json().get("signedUrl")
    return f"{_base()}{signed}" if signed and signed.startswith("/") else signed


def download_sync(path: str) -> bytes:
    """Used by the executor (Celery, sync)."""
    with httpx.Client(timeout=300) as client:
        r = client.get(f"{_base()}/object/{BUCKET}/{path}", headers=_headers())
        r.raise_for_status()
        return r.content


async def download(path: str) -> bytes:
    async with httpx.AsyncClient(timeout=300) as client:
        r = await client.get(f"{_base()}/object/{BUCKET}/{path}", headers=_headers())
        r.raise_for_status()
        return r.content

"""Per-IP rate limiting (slowapi). Behind Cloudflare the real client IP is
CF-Connecting-IP; fall back to X-Forwarded-For, then the socket peer."""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

from app.core.config import get_settings


def client_key(request: Request) -> str:
    for header in ("cf-connecting-ip", "x-real-ip"):
        v = request.headers.get(header)
        if v:
            return v.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return get_remote_address(request)


_settings = get_settings()
limiter = Limiter(
    key_func=client_key,
    default_limits=[_settings.rate_limit_default],
    storage_uri=_settings.rate_limit_storage_uri or "memory://",
    headers_enabled=False,  # header injection needs a Response param on every route; the 429 handler suffices
)

# Named limits used by routers (kept here so they are easy to audit).
LIMIT_MUTATION = _settings.rate_limit_mutation      # approve/dismiss/clients/sync
LIMIT_PLUGIN = _settings.rate_limit_plugin          # /api/plugin/* writes

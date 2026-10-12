"""Append-only audit log writer (table audit_log, migration 20260917000011).

Call `record()` from any route that changes state. Secrets are redacted before
storage; the row is written with the service role so RLS never blocks it.
Failures to write the audit row are logged, never swallowed silently, and never
turned into a user-facing error — the primary action already happened.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import Request

from app.core.config import get_settings
from app.core.db import execute

logger = logging.getLogger("app.audit")

REDACT_KEYS = {
    "ghl_token", "token", "password", "secret", "authorization", "refresh_token",
    "access_token", "api_key", "apikey", "client_secret", "service_role_key",
}
REDACTED = "[redacted]"


def redact(value: Any) -> Any:
    """Recursively replace secret-looking keys; safe for jsonb storage."""
    if isinstance(value, dict):
        return {k: (REDACTED if str(k).lower() in REDACT_KEYS else redact(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    # Cloudflare Tunnel → cloudflared → Next.js → FastAPI: CF-Connecting-IP is authoritative.
    for header in ("cf-connecting-ip", "x-real-ip"):
        v = request.headers.get(header)
        if v:
            return v.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else None


async def record(
    *,
    action: str,
    actor: dict | None = None,
    actor_type: str = "user",
    entity_type: str | None = None,
    entity_id: str | int | None = None,
    client_id: str | None = None,
    before: Any = None,
    after: Any = None,
    request: Request | None = None,
) -> None:
    settings = get_settings()
    actor_id = (actor or {}).get("id") if actor_type == "user" else None
    actor_email = (actor or {}).get("email") or (actor or {}).get("name")
    request_id = getattr(getattr(request, "state", None), "request_id", None) if request else None
    try:
        await execute(
            """
            insert into audit_log (actor_type, actor_id, actor_email, action, entity_type, entity_id,
                                   client_id, before, after, request_id, ip, user_agent, environment)
            values ($1, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::jsonb, $9::jsonb, $10, $11::inet, $12, $13)
            """,
            actor_type, actor_id, actor_email, action, entity_type,
            str(entity_id) if entity_id is not None else None, client_id,
            json.dumps(redact(before)) if before is not None else None,
            json.dumps(redact(after)) if after is not None else None,
            request_id, client_ip(request),
            (request.headers.get("user-agent")[:500] if request and request.headers.get("user-agent") else None),
            settings.environment,
        )
    except Exception:  # noqa: BLE001 — never fail the primary action because of the audit row
        logger.exception("audit_log write failed action=%s entity=%s/%s", action, entity_type, entity_id)

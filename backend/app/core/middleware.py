"""Request ID + structured access log, Origin check (CSRF defence in depth),
and baseline security headers for the API."""
from __future__ import annotations

import logging
import time
import uuid
from urllib.parse import urlsplit

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.audit import client_ip

access_log = logging.getLogger("app.access")

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assign X-Request-ID, time the request, emit one JSON access-log line."""

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            access_log.exception(
                "request failed", extra={"request_id": request_id, "method": request.method, "path": request.url.path}
            )
            raise
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        response.headers["X-Request-ID"] = request_id
        if request.url.path not in ("/api/health/live",):
            access_log.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "ms": elapsed_ms,
                    "ip": client_ip(request),
                },
            )
        return response


def _host_of(url: str | None) -> str | None:
    if not url:
        return None
    parts = urlsplit(url)
    return (parts.netloc or parts.path).split(":")[0].lower() or None


class OriginCheckMiddleware(BaseHTTPMiddleware):
    """Reject state-changing browser requests whose Origin/Referer is not one of
    ours. Requests without an Origin (server-to-server, curl, the plugin) pass —
    they are bearer-token authenticated and not CSRF-able."""

    def __init__(self, app, allowed_hosts: set[str]) -> None:
        super().__init__(app)
        self.allowed_hosts = {h.lower() for h in allowed_hosts if h}

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.method in UNSAFE_METHODS:
            origin_host = _host_of(request.headers.get("origin")) or _host_of(request.headers.get("referer"))
            if origin_host and origin_host not in self.allowed_hosts:
                return JSONResponse(
                    status_code=403,
                    content={"detail": f"Cross-site request from '{origin_host}' rejected"},
                )
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        return response

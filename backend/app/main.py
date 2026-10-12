"""ZMS Ads Intelligence Dashboard — FastAPI backend."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.responses import JSONResponse

from app.core.config import get_settings
from app.core.db import close_pool
from app.core.logging import configure_logging
from app.core.middleware import OriginCheckMiddleware, RequestContextMiddleware, SecurityHeadersMiddleware
from app.core.ratelimit import limiter
from app.routers import (
    actions,
    audit,
    brief,
    builds,
    campaigns,
    clients,
    export,
    funnel,
    google_ads,
    health,
    integrations,
    me,
    overview,
    plugin,
    service_targets,
    services,
    setters,
    today,
    sync,
)

settings = get_settings()
configure_logging("api", settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await close_pool()


app = FastAPI(
    title="ZMS Ads Intelligence API",
    lifespan=lifespan,
    # OpenAPI docs are internal-only: the public tunnel routes / to Next.js,
    # and the API is reached through the /api rewrite. Keep docs off in prod.
    docs_url=None if settings.environment == "production" else "/docs",
    redoc_url=None,
    openapi_url=None if settings.environment == "production" else "/openapi.json",
)

# --- middleware (outermost first at request time = last added) ---
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def _rate_limited(request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content={"detail": f"Rate limit exceeded: {exc.detail}"})


app.add_middleware(SlowAPIMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(OriginCheckMiddleware, allowed_hosts=settings.allowed_origin_hosts)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(dict.fromkeys([*settings.cors_origins, settings.dashboard_url, *settings.allowed_origins])),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)
app.add_middleware(RequestContextMiddleware)

app.include_router(health.router, prefix="/api")
app.include_router(me.router, prefix="/api")
app.include_router(clients.router, prefix="/api")
app.include_router(overview.router, prefix="/api")
app.include_router(campaigns.router, prefix="/api")
app.include_router(sync.router, prefix="/api")
app.include_router(plugin.router, prefix="/api")
app.include_router(actions.router, prefix="/api")
app.include_router(services.router, prefix="/api")
app.include_router(service_targets.router, prefix="/api")
app.include_router(brief.router, prefix="/api")
app.include_router(integrations.router, prefix="/api")
app.include_router(setters.router, prefix="/api")
app.include_router(audit.router, prefix="/api")
app.include_router(builds.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(google_ads.router, prefix="/api")
app.include_router(funnel.router, prefix="/api")
app.include_router(today.router, prefix="/api")

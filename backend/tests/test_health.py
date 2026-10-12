"""Deep health endpoint semantics with the checks stubbed out."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import health


def _client(monkeypatch, db_ok, redis_ok, sync_ok):
    async def db():
        return {"ok": db_ok}

    async def rds():
        return {"ok": redis_ok}

    async def syncs():
        return {s: {"ok": sync_ok, "last_success": None} for s in health.SYNC_SOURCES}

    monkeypatch.setattr(health, "check_db", db)
    monkeypatch.setattr(health, "check_redis", rds)
    monkeypatch.setattr(health, "check_syncs", syncs)
    app = FastAPI()
    app.include_router(health.router, prefix="/api")
    return TestClient(app)


def test_live_is_static():
    app = FastAPI()
    app.include_router(health.router, prefix="/api")
    assert TestClient(app).get("/api/health/live").json() == {"status": "ok"}


def test_all_good(monkeypatch):
    r = _client(monkeypatch, True, True, True).get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.headers["Cache-Control"] == "no-store"


def test_stale_sync_is_degraded_not_down(monkeypatch):
    r = _client(monkeypatch, True, True, False).get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "degraded"


@pytest.mark.parametrize("db_ok,redis_ok", [(False, True), (True, False)])
def test_critical_failure_is_503(monkeypatch, db_ok, redis_ok):
    r = _client(monkeypatch, db_ok, redis_ok, True).get("/api/health")
    assert r.status_code == 503 and r.json()["status"] == "unhealthy"

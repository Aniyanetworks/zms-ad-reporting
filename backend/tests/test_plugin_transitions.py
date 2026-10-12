"""The plugin's PATCH route must refuse approval and enforce provenance."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.ratelimit import limiter
from app.routers import plugin


@pytest.fixture
def client(monkeypatch):
    rows = {
        1: {"id": 1, "status": "proposed", "client_id": "c1", "approved_by": None},
        2: {"id": 2, "status": "approved", "client_id": "c1", "approved_by": "carl@x.com"},
        3: {"id": 3, "status": "proposed", "client_id": "c1", "approved_by": None},  # never approved
    }
    updates = []

    async def fetchrow(query, *args):
        if query.strip().startswith("select * from recommendations"):
            return rows.get(args[0])
        updates.append((query, args))
        return {**rows[args[0]], "status": args[1] if len(args) > 1 and args[1] in ("executed", "failed") else "dismissed"}

    async def noop(*_a, **_k):
        return None

    monkeypatch.setattr(plugin, "fetchrow", fetchrow)
    monkeypatch.setattr(plugin.audit, "record", noop)
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(plugin.router, prefix="/api")
    c = TestClient(app)
    c.headers["Authorization"] = "Bearer test-plugin-token"  # PLUGIN_API_TOKEN from conftest
    return c, updates


def test_plugin_token_required(client):
    c, _ = client
    r = c.patch("/api/plugin/recommendations/1", json={"status": "dismissed", "actor": "op"},
                headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_plugin_cannot_approve(client):
    c, updates = client
    r = c.patch("/api/plugin/recommendations/1", json={"status": "approved", "actor": "bot"})
    assert r.status_code == 409
    assert "human" in r.json()["detail"].lower()
    assert updates == []


def test_plugin_executes_only_after_human_approval(client):
    c, _ = client
    r = c.patch("/api/plugin/recommendations/2", json={"status": "executed", "actor": "op", "verification": {"x": 1}})
    assert r.status_code == 200 and r.json()["status"] == "executed"


def test_plugin_cannot_execute_unapproved(client):
    c, _ = client
    r = c.patch("/api/plugin/recommendations/3", json={"status": "executed", "actor": "op"})
    assert r.status_code == 409


def test_plugin_may_dismiss_proposed(client):
    c, _ = client
    r = c.patch("/api/plugin/recommendations/1", json={"status": "dismissed", "actor": "op"})
    assert r.status_code == 200 and r.json()["status"] == "dismissed"


def test_unknown_fields_rejected(client):
    c, _ = client
    r = c.patch("/api/plugin/recommendations/2", json={"status": "executed", "actor": "op", "evil": 1})
    assert r.status_code == 422

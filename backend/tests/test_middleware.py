"""Origin check, security headers, request id — on a tiny app, no DB."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.middleware import OriginCheckMiddleware, RequestContextMiddleware, SecurityHeadersMiddleware


def make_app():
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(OriginCheckMiddleware, allowed_hosts={"adbuildout.contractorscalingblueprint.com", "localhost"})
    app.add_middleware(RequestContextMiddleware)

    @app.post("/api/thing")
    async def thing():
        return {"ok": True}

    @app.get("/api/thing")
    async def get_thing():
        return {"ok": True}

    return TestClient(app)


def test_same_origin_post_allowed():
    c = make_app()
    r = c.post("/api/thing", headers={"Origin": "https://adbuildout.contractorscalingblueprint.com"})
    assert r.status_code == 200


def test_cross_site_post_rejected():
    c = make_app()
    r = c.post("/api/thing", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    r = c.post("/api/thing", headers={"Referer": "https://evil.example/page"})
    assert r.status_code == 403


def test_no_origin_bearer_client_allowed():
    c = make_app()
    assert c.post("/api/thing", headers={"Authorization": "Bearer t"}).status_code == 200


def test_get_never_blocked_and_headers_present():
    c = make_app()
    r = c.get("/api/thing", headers={"Origin": "https://evil.example"})
    assert r.status_code == 200
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Cache-Control"] == "no-store"
    assert len(r.headers["X-Request-ID"]) >= 16


def test_request_id_propagated():
    c = make_app()
    r = c.get("/api/thing", headers={"X-Request-ID": "abc-123"})
    assert r.headers["X-Request-ID"] == "abc-123"

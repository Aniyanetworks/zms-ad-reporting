"""Audit writer: redaction and best-effort semantics."""
from datetime import UTC, datetime

import pytest

from app.core import audit


def test_redact_nested_secrets():
    data = {
        "name": "Acme", "ghl_token": "pit-123", "nested": {"Authorization": "Bearer x", "ok": 1},
        "list": [{"refresh_token": "r"}, "plain"], "when": datetime(2026, 1, 1, tzinfo=UTC),
    }
    out = audit.redact(data)
    assert out["ghl_token"] == audit.REDACTED
    assert out["nested"]["Authorization"] == audit.REDACTED
    assert out["nested"]["ok"] == 1
    assert out["list"][0]["refresh_token"] == audit.REDACTED
    assert out["list"][1] == "plain"
    assert out["when"] == "2026-01-01T00:00:00+00:00"


class _Req:
    def __init__(self, headers, host="10.0.0.1"):
        self.headers = headers
        self.client = type("C", (), {"host": host})()
        self.state = type("S", (), {"request_id": "rid-1"})()


def test_client_ip_prefers_cloudflare_header():
    assert audit.client_ip(_Req({"cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1"})) == "203.0.113.9"
    assert audit.client_ip(_Req({"x-forwarded-for": "198.51.100.2, 10.0.0.5"})) == "198.51.100.2"
    assert audit.client_ip(_Req({})) == "10.0.0.1"
    assert audit.client_ip(None) is None


@pytest.mark.asyncio
async def test_record_never_raises_when_db_fails(monkeypatch):
    async def boom(*_a, **_k):
        raise RuntimeError("db down")

    monkeypatch.setattr(audit, "execute", boom)
    await audit.record(action="x.y", actor={"id": "u", "email": "a@b.c"}, after={"password": "p"})


@pytest.mark.asyncio
async def test_record_writes_redacted_row(monkeypatch):
    captured = {}

    async def fake_execute(query, *args):
        captured["query"] = query
        captured["args"] = args

    monkeypatch.setattr(audit, "execute", fake_execute)
    await audit.record(
        action="client.update", actor={"id": "11111111-1111-1111-1111-111111111111", "email": "carl@x.com"},
        entity_type="client", entity_id=7, client_id="c1", before={"ghl_token": "old"}, after={"ghl_token": "new"},
        request=_Req({"cf-connecting-ip": "203.0.113.9", "user-agent": "pytest"}),
    )
    args = captured["args"]
    assert args[0] == "user" and args[3] == "client.update" and args[5] == "7"
    assert '"[redacted]"' in args[7] and '"[redacted]"' in args[8]
    assert args[9] == "rid-1" and args[10] == "203.0.113.9"

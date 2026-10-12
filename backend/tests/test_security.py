"""JWT verification tests — ES256 (JWKS) and HS256 (legacy fallback) paths."""
import os

os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "sb_publishable_test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-hs256-secret-long-enough-32-bytes!")
os.environ.setdefault("SUPABASE_DB_URL", "postgresql://x:x@localhost/x")

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key

from app.core import security


@pytest.fixture
def es256_keypair():
    private_key = generate_private_key(SECP256R1())
    return private_key, private_key.public_key()


class FakeSigningKey:
    def __init__(self, key):
        self.key = key


class FakeJWKSClient:
    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return FakeSigningKey(self._public_key)


def test_es256_token_verified_via_jwks(monkeypatch, es256_keypair):
    private_key, public_key = es256_keypair
    monkeypatch.setattr(security, "_jwks_client", lambda: FakeJWKSClient(public_key))
    token = jwt.encode(
        {"sub": "user-1", "email": "a@b.c", "aud": "authenticated"},
        private_key,
        algorithm="ES256",
        headers={"kid": "test-kid"},
    )
    payload = security._decode_token(token)
    assert payload["sub"] == "user-1"


def test_es256_wrong_key_rejected(monkeypatch, es256_keypair):
    _, public_key = es256_keypair
    other_private = generate_private_key(SECP256R1())
    monkeypatch.setattr(security, "_jwks_client", lambda: FakeJWKSClient(public_key))
    token = jwt.encode(
        {"sub": "user-1", "aud": "authenticated"}, other_private, algorithm="ES256"
    )
    with pytest.raises(jwt.PyJWTError):
        security._decode_token(token)


def test_hs256_fallback_with_secret():
    token = jwt.encode(
        {"sub": "user-2", "aud": "authenticated"},
        "test-hs256-secret-long-enough-32-bytes!",
        algorithm="HS256",
    )
    payload = security._decode_token(token)
    assert payload["sub"] == "user-2"


def test_hs256_wrong_secret_rejected():
    token = jwt.encode({"sub": "user-2", "aud": "authenticated"}, "wrong", algorithm="HS256")
    with pytest.raises(jwt.PyJWTError):
        security._decode_token(token)


def test_wrong_audience_rejected():
    token = jwt.encode(
        {"sub": "user-3", "aud": "anon"},
        "test-hs256-secret-long-enough-32-bytes!",
        algorithm="HS256",
    )
    with pytest.raises(jwt.PyJWTError):
        security._decode_token(token)

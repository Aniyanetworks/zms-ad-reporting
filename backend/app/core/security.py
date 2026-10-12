"""JWT verification — validates Supabase-issued tokens; role comes from profiles.

Supabase projects using the new API-key system sign access tokens asymmetrically
(ES256/RS256); we verify against the project's JWKS endpoint. Legacy HS256 tokens
are supported as a fallback when SUPABASE_JWT_SECRET is set (also used by tests).
"""
from functools import lru_cache
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import policy
from app.core.config import get_settings
from app.core.db import fetchrow

bearer_scheme = HTTPBearer(auto_error=False)


@lru_cache
def _jwks_client() -> jwt.PyJWKClient:
    settings = get_settings()
    return jwt.PyJWKClient(
        f"{settings.supabase_url}/auth/v1/.well-known/jwks.json",
        cache_keys=True,
        lifespan=3600,
    )


def _decode_token(token: str) -> dict:
    settings = get_settings()
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "")
    if alg == "HS256":
        if not settings.supabase_jwt_secret:
            raise jwt.InvalidTokenError("HS256 token but no SUPABASE_JWT_SECRET configured")
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    signing_key = _jwks_client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["ES256", "RS256"],
        audience="authenticated",
    )


async def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> dict:
    """Verify the Supabase JWT and return the decoded claims + profile role."""
    if creds is None:
        if get_settings().public_read:
            # Anonymous read-only viewer: every role check that gates a write still fails.
            return {"id": None, "email": None, "role": policy.ROLE_VIEWER, "full_name": "Public viewer", "anonymous": True}
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")

    try:
        payload = _decode_token(creds.credentials)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {exc}") from exc

    profile = await fetchrow("select role, full_name from profiles where id = $1", payload["sub"])
    role = profile["role"] if profile and policy.is_valid_role(profile["role"]) else policy.ROLE_VIEWER
    return {
        "id": payload["sub"],
        "email": payload.get("email"),
        "role": role,
        "full_name": profile["full_name"] if profile else None,
    }


async def require_admin(user: Annotated[dict, Depends(get_current_user)]) -> dict:
    if user["role"] != policy.ROLE_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return user


def require_role(*roles: str):
    """Dependency factory: `user: Annotated[dict, Depends(require_role("admin", "media_buyer"))]`."""

    async def _dep(user: Annotated[dict, Depends(get_current_user)]) -> dict:
        if user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of roles: {', '.join(roles)}",
            )
        return user

    return _dep


CurrentUser = Annotated[dict, Depends(get_current_user)]
AdminUser = Annotated[dict, Depends(require_admin)]
ApproverUser = Annotated[dict, Depends(require_role(policy.ROLE_ADMIN, policy.ROLE_MEDIA_BUYER))]

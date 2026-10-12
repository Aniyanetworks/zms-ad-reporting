"""Read side of the audit log (admin only). Writes happen via app.core.audit."""
from fastapi import APIRouter, HTTPException, Query

from app.core import policy
from app.core.db import fetch
from app.core.security import CurrentUser

router = APIRouter(tags=["audit"])


def _ser(row) -> dict:
    return {k: (v.isoformat() if hasattr(v, "isoformat") else (str(v) if k == "ip" and v is not None else v))
            for k, v in dict(row).items()}


@router.get("/audit-log")
async def audit_log(
    user: CurrentUser,
    limit: int = Query(default=100, ge=1, le=500),
    client_slug: str | None = Query(default=None, max_length=100, pattern=r"^[a-z0-9-]*$"),
    action: str | None = Query(default=None, max_length=100, pattern=r"^[a-z_.]*$"),
) -> list[dict]:
    if not policy.can_view_audit_log(user["role"]):
        raise HTTPException(status_code=403, detail="Admin role required")
    rows = await fetch(
        """
        select a.*, c.slug as client_slug, c.name as client_name
        from audit_log a left join clients c on c.id = a.client_id
        where ($2::text is null or c.slug = $2)
          and ($3::text is null or a.action = $3)
        order by a.at desc limit $1
        """,
        limit, client_slug or None, action or None,
    )
    return [_ser(r) for r in rows]

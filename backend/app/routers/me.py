"""Who am I — the signed-in user's id, email, role, and the human-control rules
the UI displays. Role comes from profiles (see app.core.security)."""
from fastapi import APIRouter

from app.core import policy
from app.core.security import CurrentUser
from app.services.builder.guards import approver_max_daily_cents

router = APIRouter(tags=["me"])


@router.get("/me")
async def me(user: CurrentUser) -> dict:
    return {
        "id": user["id"],
        "email": user.get("email"),
        "role": user["role"],
        "full_name": user.get("full_name"),
        "permissions": {
            "manage_clients": policy.can_manage_clients(user["role"]),
            "trigger_sync": policy.can_trigger_sync(user["role"]),
            "dismiss": policy.can_dismiss(user["role"]),
            "approve": policy.can_approve(user["role"], "pause", None)[0],
            "approve_large_budget": policy.can_approve(
                user["role"], "budget_change", policy.BUDGET_INCREASE_OWNER_THRESHOLD_PCT + 1
            )[0],
            "view_audit_log": policy.can_view_audit_log(user["role"]),
            "create_build": policy.can_create_build(user["role"]),
            "approve_build_max_daily_cents": approver_max_daily_cents(user["role"]),
        },
        "budget_owner_threshold_pct": policy.BUDGET_INCREASE_OWNER_THRESHOLD_PCT,
        "human_control_rules": list(policy.HUMAN_CONTROL_RULES),
    }

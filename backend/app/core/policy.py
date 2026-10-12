"""Human-control policy — the rules that hosting on the Mac mini does not change.

Single source of truth for who may do what, imported by the routers and by
tests. Keep this file free of I/O so it can be unit-tested and read as a spec.

  * AI (the plugin) can prepare drafts and propose recommendations.
  * AI cannot approve itself: the plugin token can never move a recommendation
    to 'approved'. Only a signed-in person with the right role can.
  * Created campaigns start PAUSED; launch is a separate human step in the ad
    platform UI — the API refuses 'activate'.
  * Budget increases above BUDGET_INCREASE_OWNER_THRESHOLD_PCT need the owner.
  * Every consequential action is written to audit_log (see app.core.audit).
"""
from __future__ import annotations

ROLE_ADMIN = "admin"          # Agency Owner
ROLE_MEDIA_BUYER = "media_buyer"
ROLE_VIEWER = "viewer"
ROLES = (ROLE_ADMIN, ROLE_MEDIA_BUYER, ROLE_VIEWER)

# Budget increases (pct_change) strictly above this need an admin approval.
BUDGET_INCREASE_OWNER_THRESHOLD_PCT = 20.0

# Status transitions the PLUGIN (shared bearer token) may perform. 'approved'
# is deliberately absent: approval is a person's action in the dashboard.
PLUGIN_ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "proposed": frozenset({"dismissed"}),
    "approved": frozenset({"executed", "failed", "dismissed"}),
}

# Actions that must never be executed by software on a person's behalf.
HUMAN_ONLY_ACTIONS = frozenset({"activate"})

HUMAN_CONTROL_RULES = (
    "AI can prepare and modify drafts.",
    "AI can provide recommendations.",
    "AI cannot approve itself.",
    "Campaign creation requires human approval.",
    "Created campaigns must initially be paused.",
    "Campaign launch requires a separate human confirmation.",
    f"Budget increases above {BUDGET_INCREASE_OWNER_THRESHOLD_PCT:.0f}% require the Agency Owner.",
    "Every consequential action is recorded in the audit log.",
)


def is_valid_role(role: str | None) -> bool:
    return role in ROLES


def can_manage_clients(role: str | None) -> bool:
    return role == ROLE_ADMIN


def can_trigger_sync(role: str | None) -> bool:
    return role == ROLE_ADMIN


def can_view_audit_log(role: str | None) -> bool:
    return role == ROLE_ADMIN


def can_create_build(role: str | None) -> bool:
    """Draft campaigns in the Campaign Builder (approval is budget-gated separately)."""
    return role in (ROLE_ADMIN, ROLE_MEDIA_BUYER)


def can_dismiss(role: str | None) -> bool:
    return role in (ROLE_ADMIN, ROLE_MEDIA_BUYER)


def can_approve(role: str | None, action: str, pct_change: float | None) -> tuple[bool, str | None]:
    """Return (allowed, reason_if_denied) for approving one recommendation."""
    if action in HUMAN_ONLY_ACTIONS:
        return False, "Activation is done by a person in the ad platform; it cannot be approved for execution."
    if role == ROLE_ADMIN:
        return True, None
    if role == ROLE_MEDIA_BUYER:
        if action == "budget_change" and pct_change is not None and float(pct_change) > BUDGET_INCREASE_OWNER_THRESHOLD_PCT:
            return False, (
                f"Budget increase of {float(pct_change):.0f}% exceeds {BUDGET_INCREASE_OWNER_THRESHOLD_PCT:.0f}%; "
                "Agency Owner approval required."
            )
        return True, None
    return False, "Your role cannot approve recommendations."


def plugin_can_transition(current: str, new: str) -> bool:
    return new in PLUGIN_ALLOWED_TRANSITIONS.get(current, frozenset())

"""Human-control policy — pure rules, no I/O."""
import pytest

from app.core import policy


@pytest.mark.parametrize("role", ["admin", "media_buyer", "viewer"])
def test_activate_is_never_approvable(role):
    ok, reason = policy.can_approve(role, "activate", None)
    assert not ok and "person" in reason


def test_admin_approves_anything_else():
    for action in ("budget_change", "pause", "refresh_creative", "fix_signal", "investigate"):
        assert policy.can_approve("admin", action, 500)[0]


def test_media_buyer_budget_threshold():
    assert policy.can_approve("media_buyer", "budget_change", 20)[0]
    assert policy.can_approve("media_buyer", "budget_change", -50)[0]
    assert policy.can_approve("media_buyer", "budget_change", None)[0]
    ok, reason = policy.can_approve("media_buyer", "budget_change", 20.5)
    assert not ok and "Owner" in reason
    assert policy.can_approve("media_buyer", "pause", None)[0]


def test_viewer_cannot_approve_or_dismiss():
    assert not policy.can_approve("viewer", "pause", None)[0]
    assert not policy.can_dismiss("viewer")
    assert not policy.can_approve(None, "pause", None)[0]


def test_admin_only_management():
    assert policy.can_manage_clients("admin") and not policy.can_manage_clients("media_buyer")
    assert policy.can_trigger_sync("admin") and not policy.can_trigger_sync("media_buyer")
    assert policy.can_view_audit_log("admin") and not policy.can_view_audit_log("viewer")


def test_plugin_can_never_approve():
    assert not policy.plugin_can_transition("proposed", "approved")
    assert policy.plugin_can_transition("proposed", "dismissed")
    assert policy.plugin_can_transition("approved", "executed")
    assert policy.plugin_can_transition("approved", "failed")
    assert not policy.plugin_can_transition("executed", "approved")
    assert not policy.plugin_can_transition("dismissed", "executed")
    for transitions in policy.PLUGIN_ALLOWED_TRANSITIONS.values():
        assert "approved" not in transitions


def test_rules_text_mentions_every_requirement():
    text = " ".join(policy.HUMAN_CONTROL_RULES).lower()
    for phrase in ("cannot approve itself", "paused", "separate human", "budget", "audit log"):
        assert phrase in text

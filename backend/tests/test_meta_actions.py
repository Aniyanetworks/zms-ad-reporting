"""Unit tests for Meta insights action parsing."""
from app.services.meta import _parse_actions


def test_empty_actions():
    assert _parse_actions(None) == (0.0, 0.0)
    assert _parse_actions([]) == (0.0, 0.0)


def test_aggregate_lead_preferred_over_split():
    # 'lead' already includes onsite + offsite; must not double count
    actions = [
        {"action_type": "lead", "value": "10"},
        {"action_type": "onsite_conversion.lead_grouped", "value": "6"},
        {"action_type": "offsite_conversion.fb_pixel_lead", "value": "4"},
    ]
    leads, calls = _parse_actions(actions)
    assert leads == 10.0
    assert calls == 0.0


def test_split_leads_summed_when_no_aggregate():
    actions = [
        {"action_type": "onsite_conversion.lead_grouped", "value": "6"},
        {"action_type": "offsite_conversion.fb_pixel_lead", "value": "4"},
    ]
    leads, _ = _parse_actions(actions)
    assert leads == 10.0


def test_phone_call_actions():
    actions = [
        {"action_type": "click_to_call_native_call_placed", "value": "3"},
        {"action_type": "onsite_conversion.phone_call_lead", "value": "2"},
        {"action_type": "link_click", "value": "100"},
    ]
    _, calls = _parse_actions(actions)
    assert calls == 5.0


def test_malformed_values_ignored():
    actions = [{"action_type": "lead", "value": "not-a-number"}]
    leads, calls = _parse_actions(actions)
    assert leads == 0.0


def test_unknown_actions_ignored():
    actions = [
        {"action_type": "post_engagement", "value": "50"},
        {"action_type": "landing_page_view", "value": "20"},
    ]
    assert _parse_actions(actions) == (0.0, 0.0)

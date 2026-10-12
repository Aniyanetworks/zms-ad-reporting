from app.services import tracking as t


def test_standard_utm_detection():
    assert t.has_standard_utm(t.STANDARD_URL_TAGS)
    assert t.has_standard_utm("utm_source=facebook&utm_medium={{adset.name}}&x=1")
    assert not t.has_standard_utm(None)
    assert not t.has_standard_utm("utm_source=facebook&utm_medium=paid")
    assert not t.has_standard_utm("utm_source=google&utm_medium={{adset.name}}")


def test_website_link_detection():
    assert t.is_website_link("https://kitchen.uspropaint.com/x")
    assert not t.is_website_link("http://fb.me/")
    assert not t.is_website_link("https://www.facebook.com/page")
    assert not t.is_website_link(None)


def test_event_classification():
    assert t.classify_events({"PageView": 100, "ViewContent": 20}) == "none"
    assert t.classify_events({"Scheduled Appointment": 3, "Paid Lead": 2}) == "custom"
    assert t.classify_events({"Lead": 5, "Scheduled Appointment": 3}) == "standard"
    assert t.classify_events({}) == "none"


def test_executable_actions_are_only_tracking_ones():
    assert set(t.EXECUTABLE_ACTIONS) == {"fix_utm", "create_pixel", "fix_tracking"}


def test_tracking_spec_merge_adds_only_missing():
    cur = [{"action.type": ["onsite_conversion"]}, {"action.type": ["leadgen_quality_conversion"], "fb_pixel": ["111"]}]
    merged, adds = t.merge_tracking_specs(cur, "111", "ON_AD")
    assert [a["action.type"][0] for a in adds] == ["offline_conversion"]
    assert merged[:2] == cur and merged[-1] == {"action.type": ["offline_conversion"], "dataset": ["111"]}


def test_tracking_spec_merge_website_vs_form():
    _, adds = t.merge_tracking_specs([], "999", "WEBSITE")
    assert adds[0] == {"action.type": ["offsite_conversion"], "fb_pixel": ["999"]}
    _, adds = t.merge_tracking_specs([], "999", None)
    assert adds[0]["action.type"] == ["leadgen_quality_conversion"]
    merged, adds2 = t.merge_tracking_specs(merged := t.merge_tracking_specs([], "999", None)[0], "999", None)
    assert adds2 == []  # idempotent


def test_client_pixel_choice():
    assert t._client_pixel({"meta_pixel_id": "5"}, [{"id": "1"}, {"id": "2"}]) == "5"
    assert t._client_pixel({}, [{"id": "1"}]) == "1"
    assert t._client_pixel({}, [{"id": "1"}, {"id": "2"}]) is None
    assert t._client_pixel({}, []) is None


def test_lead_campaign_filter():
    assert t.is_lead_campaign("OUTCOME_LEADS", "18-Sep-26 | Kitchen Remodeling | WEB")
    assert t.is_lead_campaign("CONVERSIONS", "Cabinets")
    assert not t.is_lead_campaign("LINK_CLICKS", "Instagram post: Hoje, nosso roofing…")
    assert not t.is_lead_campaign("OUTCOME_LEADS", "Instagram post: still a boost")
    assert not t.is_lead_campaign("OUTCOME_TRAFFIC", "[07/25/2018] Promoting http://www.uspropainter.com/")
    assert not t.is_lead_campaign("OUTCOME_ENGAGEMENT", "Engagement")


def test_explain_maps_meta_errors_to_actions():
    assert "Manage campaigns" in t.explain(RuntimeError("To create or edit ads ... (code 200/2490591)"))
    assert "Page" in t.explain(RuntimeError("The viewer must have the advertiser permission on the page to create an ad (code 100/1885499)"))
    assert "Ads Manager" in t.explain(RuntimeError("Choose or create an instant form (code 100/3390001)"))
    assert "Ads Manager" in t.explain(RuntimeError("An unexpected error occurred (code 200/1634013)"))
    assert "Events Manager" in t.explain(RuntimeError("(#200) Permissions error (code 200/None)"))


def test_with_retry_backs_off_on_rate_limit(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(t.time, "sleep", lambda s: None)

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise t.GraphCallError("rate limited", code=613)
        return {"ok": True}

    assert t._with_retry(flaky) == {"ok": True} and calls["n"] == 3
    import pytest

    with pytest.raises(t.GraphCallError):
        t._with_retry(lambda: (_ for _ in ()).throw(t.GraphCallError("perm", code=200)))


def test_ads_manager_offsite_spec_counts_as_website_events():
    cur = [{"action.type": ["offsite_conversion"], "fb_pixel": ["26857381320598571"]},
           {"action.type": ["offline_conversion"], "dataset": ["26857381320598571"]}]
    _, adds = t.merge_tracking_specs(cur, "26857381320598571", "ON_AD")
    assert adds == []

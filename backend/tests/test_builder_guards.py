"""Campaign Builder guardrails — pure validation, no network."""
from app.services.builder import guards
from app.services.builder.schema import Plan

ASSET = "11111111-1111-1111-1111-111111111111"


def plan(**over) -> Plan:
    base = {
        "version": 1,
        "campaign": {"name": "21-Sep-26 | Cabinet Painting", "daily_budget_cents": 10000},
        "ad_sets": [{
            "name": "Broad",
            "destination": "instant_form",
            "lead_form_id": "2132115967374985",
            "targeting": {"geo": [{"key": "2427613", "name": "Cape Coral", "type": "city", "country_code": "US", "radius_miles": 25}]},
            "ads": [{"name": "Image 1", "asset_id": ASSET, "primary_text": "Cabinets refinished in 3 days.", "headline": "Free in-home quote", "cta": "GET_QUOTE"}],
        }],
        "url_tags": guards.REQUIRED_URL_TAGS,
    }
    for k, v in over.items():
        base[k] = v
    return Plan.model_validate(base)


def validate(p: Plan, **kw):
    kw.setdefault("asset_ids", {ASSET})
    return guards.validate_plan(p, **kw)


def test_good_plan_ok():
    v = validate(plan(), existing_campaign_names={"20-Sep-26 | Siding"}, existing_adset_names={"Retargeting 30d"})
    assert v.ok and not [p for p in v.problems if p.level == "error"]


def test_url_tags_must_be_exact():
    p = plan(url_tags="utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.id}}")
    v = validate(p)
    assert not v.ok and any(x.code == "url_tags" for x in v.problems)


def test_campaign_collision_and_adset_collision():
    v = validate(plan(), existing_campaign_names={"21-sep-26 | cabinet painting"}, existing_adset_names={"broad"})
    codes = {x.code for x in v.problems}
    assert {"collision_campaign", "collision_adset"} <= codes and not v.ok


def test_budget_caps():
    v = validate(plan(campaign={"name": "21-Sep-26 | X", "daily_budget_cents": 600_000_00}))
    assert any(x.code == "budget_hard_cap" for x in v.problems)
    v = validate(plan(campaign={"name": "21-Sep-26 | X", "daily_budget_cents": 60_000}), max_daily_cents_for_approver=50_000)
    assert any(x.code == "budget_role_cap" for x in v.problems) and not v.ok
    v = validate(plan(campaign={"name": "21-Sep-26 | X", "daily_budget_cents": 60_000}), max_daily_cents_for_approver=None)
    assert v.ok


def test_shared_account_filter_token_required():
    v = validate(plan(), campaign_filter="%hurley%")
    assert any(x.code == "campaign_filter" for x in v.problems)
    v = validate(plan(campaign={"name": "21-Sep-26 | Hurley Decks", "daily_budget_cents": 5000}), campaign_filter="%hurley%")
    assert v.ok


def test_asset_must_be_uploaded_and_form_required():
    v = validate(plan(), asset_ids=set())
    assert any(x.code == "asset_missing" for x in v.problems)
    p = plan()
    p.ad_sets[0].lead_form_id = None
    assert any(x.code == "lead_form_missing" for x in validate(p).problems)


def test_website_destination_rules():
    p = plan()
    p.ad_sets[0].destination = "website"
    p.ad_sets[0].landing_page_url = "http://example.com/?utm_source=x"
    codes = {x.code for x in validate(p).problems}
    assert {"landing_page", "landing_page_utm"} <= codes
    p.ad_sets[0].landing_page_url = "https://example.com/cabinets"
    assert validate(p).ok


def test_name_charset_and_sop_warnings():
    p = plan(campaign={"name": "Kitchen & Bath", "daily_budget_cents": 5000})
    v = validate(p)
    assert any(x.code == "name_charset" for x in v.problems)
    p = plan(campaign={"name": "Cabinets Q4", "daily_budget_cents": 5000})
    v = validate(p)
    assert v.ok and any(x.code == "name_sop" and x.level == "warning" for x in v.problems)


def test_schema_rejects_enabled_or_unknown_fields():
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Plan.model_validate({**plan().model_dump(), "status": "ACTIVE"})
    with pytest.raises(ValidationError):
        Plan.model_validate({**plan().model_dump(), "campaign": {**plan().campaign.model_dump(), "objective": "OUTCOME_SALES"}})


def test_approver_caps():
    assert guards.approver_max_daily_cents("admin") is None
    assert guards.approver_max_daily_cents("media_buyer") == 50_000
    assert guards.approver_max_daily_cents("viewer") == 0


def test_targeting_spec_maps_geo_types():
    from app.services.builder.meta_graph import targeting_spec

    spec = targeting_spec({"geo": [
        {"key": "2427613", "type": "city", "radius_miles": 25}, {"key": "3847", "type": "region"},
        {"key": "33914", "type": "zip"}, {"key": "US", "type": "country"}], "age_min": 30, "age_max": 60, "genders": []})
    g = spec["geo_locations"]
    assert g["cities"] == [{"key": "2427613", "radius": 25, "distance_unit": "mile"}]
    assert g["regions"] == [{"key": "3847"}] and g["zips"] == [{"key": "33914"}] and g["countries"] == ["US"]
    assert spec["age_min"] == 30 and spec["targeting_automation"] == {"advantage_audience": 1} and "genders" not in spec

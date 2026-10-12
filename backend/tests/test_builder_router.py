"""Router-level rules that need no database: role gate, status locks."""
from app.core import policy
from app.services.builder import chat


def test_roles_for_builder():
    assert policy.can_create_build("admin") and policy.can_create_build("media_buyer")
    assert not policy.can_create_build("viewer") and not policy.can_create_build(None)


def test_tools_expose_no_write_capability():
    names = {t["name"] for t in chat.TOOLS}
    assert names == {"search_geo", "search_interests", "check_landing_page", "propose_plan"}
    assert "PAUSED" in chat.SYSTEM_PROMPT and "never create" in chat.SYSTEM_PROMPT


def test_propose_plan_schema_is_the_plan_model():
    schema = next(t for t in chat.TOOLS if t["name"] == "propose_plan")["input_schema"]
    assert "campaign" in schema["properties"]["plan"]["properties"]

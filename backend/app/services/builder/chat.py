"""One chat turn of the Campaign Builder: Claude drafts, tools do the checking.

The model can search locations/interests, check a landing page, and PROPOSE a
plan. It cannot create anything — `propose_plan` only stores a validated draft;
creation happens in executor.py after a person approves in the dashboard.

Conversation storage: every API turn is persisted as its raw content blocks
(thinking, text, tool_use, tool_result) in campaign_build_messages so the next
turn replays the exact history (required for thinking-block continuity and for
prompt caching of the prefix).
"""
from __future__ import annotations

import base64
import io
import json
import logging
from datetime import date
from typing import Any, AsyncIterator

import anthropic
import httpx

from app.core.config import get_settings
from app.core.db import fetch, fetchrow

from . import guards, meta_graph
from .schema import Plan

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 8

SYSTEM_PROMPT = """You are the Campaign Builder for Zeal Media Solutions, a paid-ads agency for home-services contractors (roofing, painting, decks, remodeling, plumbing, flooring, exteriors). You help the media buyer draft a Meta (Facebook/Instagram) lead-generation campaign for ONE client, then hand the draft to the dashboard where a person approves it. Everything is created PAUSED by code after approval; you never create, enable, or change anything yourself, and you never say that something has been created.

How to work
- The brief, the ad account facts, the uploaded creatives and the current plan are in the context block. Read them first; do not ask for things that are already there.
- Ask only the questions you truly need (usually: what is the offer, where do you run, what daily budget, Instant Form or landing page). Bundle questions. If the brief already answers them, go straight to a plan.
- Propose early: call `propose_plan` as soon as you can write a reasonable first draft, then refine with the buyer. The tool validates the plan and returns problems; fix every error it reports and call it again.
- Use `search_geo` to turn place names into Meta location keys (cities can carry a 10–50 mile radius; ZIPs and counties for tight service areas). Never invent keys.
- Use `check_landing_page` before proposing a website destination.
- Write real ad copy for contractors: concrete offer, local proof, clear next step. One ad per uploaded creative unless the buyer asks otherwise; match the copy to what the creative shows (you can see the images).

Zeal structure and naming SOP (hard rules — the validator enforces them)
- Objective OUTCOME_LEADS, campaign budget (CBO) daily, bid strategy LOWEST_COST_WITHOUT_CAP, Advantage+ placements, Advantage audience on. Age 25–65 unless told otherwise.
- Campaign name: "D-Mon-YY | Service" using the launch date (e.g. "21-Sep-26 | Cabinet Painting"). Shared ad accounts: the name must contain the client's filter token.
- Ad set names are the attribution key: short audience labels, unique in the account ("Broad", "Homeowners 35+", "Retargeting 30d"). Never reuse an existing ad set name.
- Ad names: "<Format> <n>" → "Image 1", "Video 2".
- Letters, numbers, spaces, hyphens and pipes only in names. No emoji, no & # % quotes.
- Destination: Instant Form by default (use a lead_form_id seen in the account, or one the buyer gives you). Website destination needs an https landing page and a pixel on the account.
- url_tags is always exactly: utm_source=facebook&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.id}}
- Special ad category HOUSING only if the copy touches housing/financing/"homeowners in <area>" qualification language.
- Daily budget in the account currency, in cents. Over $500/day needs the Agency Owner; over $5,000/day is refused.

Style: short, direct, no marketing fluff toward the buyer. When you propose a plan, summarise it in a few lines (name, budget, ad sets, ads) and say what you would still like to confirm. Never claim approval, creation, or launch — the buyer does that in the dashboard and Ads Manager.
"""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "search_geo",
        "description": "Search Meta location targeting keys for a place (city, region/state, ZIP, county, neighborhood). Returns key, name, type, region, country_code. Use the returned objects verbatim in plan targeting.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Place name or ZIP, e.g. 'Cape Coral, FL' or '33914'"},
                "types": {"type": "array", "items": {"type": "string", "enum": ["city", "region", "zip", "neighborhood", "county", "geo_market"]}},
            },
            "required": ["query"],
        },
    },
    {
        "name": "search_interests",
        "description": "Search Meta interest targeting (rarely needed; Zeal defaults to broad + Advantage audience).",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "check_landing_page",
        "description": "Fetch a landing page URL and report status code, final URL, title and whether it is https. Use before proposing a website destination.",
        "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
    },
    {
        "name": "propose_plan",
        "description": "Validate and store a campaign plan draft (does NOT create anything). Returns {ok, problems[]}; fix every error and call again. Only the latest ok plan can be approved by a person in the dashboard.",
        "input_schema": {"type": "object", "properties": {"plan": Plan.model_json_schema()}, "required": ["plan"]},
    },
]


# ---------------------------------------------------------------- persistence

async def load_history(build_id: str) -> list[dict]:
    rows = await fetch(
        "select role, content from campaign_build_messages where build_id = $1::uuid order by id", build_id
    )
    msgs: list[dict] = []
    for r in rows:
        role = "assistant" if r["role"] == "assistant" else "user"
        content = r["content"]
        if isinstance(content, list):
            content = [{k: v for k, v in b.items() if k != "seen_assets"} for b in content]
        if msgs and msgs[-1]["role"] == role and isinstance(content, list) and isinstance(msgs[-1]["content"], list):
            msgs[-1]["content"] = msgs[-1]["content"] + content
        else:
            msgs.append({"role": role, "content": content})
    return msgs


async def save_message(build_id: str, role: str, content: Any, *, text: str | None = None, tool_name: str | None = None,
                       tool_status: str | None = None, plan_version: int | None = None, usage: dict | None = None) -> int:
    row = await fetchrow(
        """
        insert into campaign_build_messages (build_id, role, content, text, tool_name, tool_status, plan_version, usage)
        values ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb) returning id
        """,
        build_id, role, json.dumps(content), text, tool_name, tool_status, plan_version,
        json.dumps(usage) if usage else None,
    )
    return row["id"]


# ---------------------------------------------------------------- context

def _downscale(data: bytes, content_type: str, max_px: int = 1024) -> tuple[bytes, str]:
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(data))
        im.thumbnail((max_px, max_px))
        out = io.BytesIO()
        im.convert("RGB").save(out, format="JPEG", quality=82)
        return out.getvalue(), "image/jpeg"
    except Exception:  # noqa: BLE001 — fall back to the original bytes
        return data, content_type


async def context_block(build: dict, client: dict, assets: list[dict]) -> str:
    ctx = build.get("account_context") or {}
    plan = build.get("plan")
    lines = [
        f"Today: {date.today().isoformat()}",
        f"Client: {client['name']} (slug {client['slug']}), trade {client.get('trade')}, default service {client.get('default_service')}, booking system {client.get('booking_system')}, timezone {client.get('timezone')}",
        f"Targets: CPL green < {client.get('cpl_target_green')}, red > {client.get('cpl_target_red')}; target CPL {client.get('target_cpl')}, target CPBA {client.get('target_cpba')}, avg job value {client.get('avg_job_value')}",
        f"Ad account: {ctx.get('ad_account_id')} ({ctx.get('account_name')}), currency {ctx.get('currency')}, timezone {ctx.get('timezone')}",
        f"Facebook Page id: {ctx.get('page_id')}; Instagram id: {ctx.get('instagram_user_id')}",
        "Instant Forms seen in this account's ads (id: times used): " + (", ".join(f"{f['id']}: {f['seen_in_ads']}" for f in ctx.get("lead_forms", [])) or "none"),
        f"Pixels: {', '.join(ctx.get('pixel_ids', [])) or 'none'}",
        f"Campaign name filter (shared account): {client.get('meta_campaign_filter') or 'none'}",
        "Existing campaign names (do not reuse): " + "; ".join(ctx.get("existing_campaign_names", [])[:120]),
        "Existing ad set names (do not reuse): " + "; ".join(sorted(set(ctx.get("existing_adset_names", [])))[:150]),
        "Recent campaigns: " + json.dumps(ctx.get("recent_campaigns", [])[:8]),
        "Brief from the buyer: " + json.dumps(build.get("brief") or {}),
        "Uploaded creatives (use asset_id in the plan): " + json.dumps([
            {"asset_id": str(a["id"]), "kind": a["kind"], "filename": a["filename"], "width": a.get("width"), "height": a.get("height")}
            for a in assets
        ]),
        f"Current plan (version {build.get('plan_version', 0)}): " + (json.dumps(plan) if plan else "none yet"),
        "Current validation: " + json.dumps(build.get("validation") or {}),
        f"Build status: {build.get('status')}",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------- tools

async def _tool_search_geo(inp: dict) -> Any:
    return await meta_graph.search_geo(inp["query"], inp.get("types"))


async def _tool_search_interests(inp: dict) -> Any:
    return await meta_graph.search_interests(inp["query"])


async def _tool_check_landing_page(inp: dict) -> Any:
    url = inp["url"]
    async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers={"User-Agent": "ZMS-CampaignBuilder/1.0"}) as c:
        try:
            r = await c.get(url)
        except httpx.HTTPError as e:
            return {"ok": False, "error": type(e).__name__}
    text = r.text[:20000]
    title = None
    lo = text.lower()
    if "<title>" in lo:
        s = lo.index("<title>") + 7
        e = lo.find("</title>", s)
        title = text[s:e].strip() if e > s else None
    return {"ok": r.status_code < 400, "status": r.status_code, "final_url": str(r.url),
            "https": str(r.url).startswith("https://"), "title": title}


async def _tool_propose_plan(build: dict, client: dict, assets: list[dict], inp: dict) -> tuple[dict, dict | None]:
    """Returns (tool_result, plan_event_or_None)."""
    try:
        plan = Plan.model_validate(inp["plan"])
    except Exception as e:  # noqa: BLE001 — pydantic errors are for the model to fix
        return {"ok": False, "problems": [{"level": "error", "code": "schema", "message": str(e)[:3000]}]}, None
    ctx = build.get("account_context") or {}
    v = guards.validate_plan(
        plan,
        asset_ids={str(a["id"]) for a in assets},
        existing_campaign_names=set(ctx.get("existing_campaign_names", [])),
        existing_adset_names=set(ctx.get("existing_adset_names", [])),
        campaign_filter=client.get("meta_campaign_filter"),
        known_lead_forms={f["id"] for f in ctx.get("lead_forms", [])},
    )
    if build["status"] in ("approved", "creating", "created"):
        return {"ok": False, "problems": [{"level": "error", "code": "locked", "message": f"Build is {build['status']}; the plan can no longer change"}]}, None
    if not v.ok:
        return v.model_dump(), None
    version = int(build.get("plan_version") or 0) + 1
    plan.version = version
    row = await fetchrow(
        """
        update campaign_builds set plan = $2::jsonb, plan_version = $3, validation = $4::jsonb,
               status = case when status in ('draft','planned','failed') then 'planned' else status end,
               title = coalesce(title, $5)
        where id = $1::uuid returning plan, plan_version, validation, status
        """,
        build["id"], plan.model_dump_json(), version, v.model_dump_json(), plan.campaign.name,
    )
    build.update({"plan": row["plan"], "plan_version": row["plan_version"], "validation": row["validation"], "status": row["status"]})
    return {**v.model_dump(), "stored_version": version}, {"plan": row["plan"], "plan_version": version, "validation": row["validation"]}


# ---------------------------------------------------------------- the turn

def _client() -> anthropic.AsyncAnthropic:
    """Anthropic SDK client. With LLM_BASE_URL set, the same SDK talks to any
    Anthropic-Messages-compatible provider (Meta Model API for Muse Spark, etc.)
    in "compat mode": no thinking/effort/caching/fallback extras are sent."""
    s = get_settings()
    key = (s.llm_api_key or s.anthropic_api_key) if s.llm_compat_mode else s.anthropic_api_key
    if not key:
        raise RuntimeError("No model API key configured (ANTHROPIC_API_KEY, or LLM_API_KEY with LLM_BASE_URL)")
    kwargs: dict[str, Any] = {"api_key": key, "max_retries": 2, "timeout": 300}
    if s.llm_compat_mode:
        kwargs["base_url"] = s.llm_base_url.rstrip("/")
    return anthropic.AsyncAnthropic(**kwargs)


def _model_name() -> str:
    s = get_settings()
    return (s.llm_model or s.anthropic_model) if s.llm_compat_mode else s.anthropic_model


def _stream(api: anthropic.AsyncAnthropic, *, system: list[dict], history: list[dict]):
    """Open the streaming request for the configured provider."""
    s = get_settings()
    if not s.llm_compat_mode:
        return api.beta.messages.stream(
            model=s.anthropic_model,
            max_tokens=16000,
            system=system,
            tools=TOOLS,
            messages=history,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": s.builder_effort},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    plain_system = [{k: v for k, v in b.items() if k != "cache_control"} for b in system]
    extra = {"reasoning_effort": s.llm_reasoning_effort} if s.llm_reasoning_effort else None
    return api.messages.stream(
        model=_model_name(),
        max_tokens=16000,
        system=plain_system,
        tools=TOOLS,
        messages=history,
        **({"extra_body": extra} if extra else {}),
    )


async def run_turn(build: dict, client_row: dict, assets: list[dict], user_text: str, user: dict) -> AsyncIterator[tuple[str, dict]]:
    """Async generator of (event, data) pairs for the SSE endpoint."""
    build_id = str(build["id"])

    # --- user message (+ any images the model has not seen yet)
    seen = {
        r["a"] for r in await fetch(
            "select jsonb_array_elements_text(coalesce(content->0->'seen_assets','[]'::jsonb)) as a from campaign_build_messages where build_id = $1::uuid and role = 'user'",
            build_id,
        )
    }
    content: list[dict] = []
    new_assets: list[str] = []
    for a in assets:
        if a["kind"] != "image" or str(a["id"]) in seen:
            continue
        try:
            from . import storage

            raw = await storage.download(a["storage_path"])
            data, ctype = _downscale(raw, a["content_type"])
            content.append({"type": "image", "source": {"type": "base64", "media_type": ctype, "data": base64.b64encode(data).decode()}})
            content.append({"type": "text", "text": f"(creative asset_id={a['id']} — {a['filename']})"})
            new_assets.append(str(a["id"]))
        except Exception:  # noqa: BLE001
            logger.exception("could not attach asset %s", a["id"])
    content.append({"type": "text", "text": user_text})
    if new_assets:
        # Marker block: stored so later turns know these images were already shown;
        # load_history strips `seen_assets` before the blocks go to the API.
        content.insert(0, {"type": "text", "text": f"[{len(new_assets)} new creative(s) attached]", "seen_assets": new_assets})
    await save_message(build_id, "user", content, text=user_text)

    history = await load_history(build_id)
    system = [
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "CONTEXT (refreshed every turn):\n" + await context_block(build, client_row, assets)
                                 + f"\nSigned-in user: {user.get('email')} (role {user.get('role')})"},
    ]
    try:
        api = _client()
    except RuntimeError as e:
        yield "error", {"message": str(e)}
        return

    rounds = 0
    final_text_parts: list[str] = []
    while rounds < MAX_TOOL_ROUNDS:
        rounds += 1
        try:
            async with _stream(api, system=system, history=history) as stream:
                async for event in stream:
                    if event.type == "content_block_delta":
                        if event.delta.type == "text_delta":
                            final_text_parts.append(event.delta.text)
                            yield "token", {"text": event.delta.text}
                        elif event.delta.type == "thinking_delta" and event.delta.thinking:
                            yield "thinking", {"text": event.delta.thinking}
                response = await stream.get_final_message()
        except anthropic.RateLimitError:
            yield "error", {"message": "The model is rate-limited right now; try again in a minute."}
            return
        except anthropic.APIStatusError as e:
            yield "error", {"message": f"Model API error {e.status_code}: {e.message}"}
            return
        except anthropic.APIConnectionError:
            yield "error", {"message": "Could not reach the model API."}
            return

        content_blocks = [b.model_dump(exclude_none=True) for b in response.content]
        usage = response.usage.model_dump(exclude_none=True) if response.usage else None
        text = "".join(b.text for b in response.content if b.type == "text") or None
        await save_message(build_id, "assistant", content_blocks, text=text, usage=usage)
        history.append({"role": "assistant", "content": content_blocks})

        if getattr(response, "stop_reason", None) == "refusal":
            yield "error", {"message": "The model declined this request."}
            break
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses or response.stop_reason == "max_tokens":
            break

        results: list[dict] = []
        for tu in tool_uses:
            inp = tu.input if isinstance(tu.input, dict) else {}
            yield "tool", {"name": tu.name, "status": "start"}
            plan_event = None
            try:
                if tu.name == "search_geo":
                    out = await _tool_search_geo(inp)
                elif tu.name == "search_interests":
                    out = await _tool_search_interests(inp)
                elif tu.name == "check_landing_page":
                    out = await _tool_check_landing_page(inp)
                elif tu.name == "propose_plan":
                    out, plan_event = await _tool_propose_plan(build, client_row, assets, inp)
                else:
                    out = {"error": f"unknown tool {tu.name}"}
                ok = not (isinstance(out, dict) and out.get("ok") is False)
                status = "ok" if ok else "error"
            except Exception as e:  # noqa: BLE001
                logger.exception("tool %s failed", tu.name)
                out, status = {"error": f"{type(e).__name__}: {e}"}, "error"
            block = {"type": "tool_result", "tool_use_id": tu.id, "content": json.dumps(out, default=str)[:60000], "is_error": status == "error"}
            results.append(block)
            detail = None
            if tu.name == "propose_plan":
                detail = f"plan v{out.get('stored_version')}" if status == "ok" else f"{len(out.get('problems', []))} problem(s)"
            yield "tool", {"name": tu.name, "status": status, "detail": detail}
            await save_message(build_id, "tool", [block], tool_name=tu.name, tool_status=status,
                               plan_version=(plan_event or {}).get("plan_version"))
            if plan_event:
                yield "plan", plan_event
        history.append({"role": "user", "content": results})
        # refresh the dynamic context after tools (plan may have changed)
        system[1] = {"type": "text", "text": "CONTEXT (refreshed every turn):\n" + await context_block(build, client_row, assets)
                                              + f"\nSigned-in user: {user.get('email')} (role {user.get('role')})"}

    yield "message", {"text": "".join(final_text_parts)}

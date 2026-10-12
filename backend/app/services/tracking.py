"""Tracking rollout — website events, offline (CAPI) events and standard URL tags
for every Meta client, as approval-gated recommendations.

propose_tracking_fixes()  reads each account live and writes `proposed` recs:
  fix_utm        per ad set with ACTIVE website ads lacking the Zeal UTM macro set
  create_pixel   per ad account with no pixel/dataset
  fix_signal     per client whose pixel is silent / browser-only (GHL → CAPI setup),
                 or sends only custom event names (standardise to Lead/Schedule/Purchase)
execute_recommendation()  performs fix_utm / create_pixel after a person approved:
  fix_utm: for each ad, create a creative on the SAME page post (keeps likes/comments)
           with url_tags, point the ad at it, read back. Meta re-reviews the ads and
           the ad set restarts its learning phase — stated as the risk on the rec.
  create_pixel: POST act_<id>/adspixels, read back.
Nothing here enables, pauses, or deletes anything.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

import httpx

from app.core.config import get_settings
from app.services import pg

logger = logging.getLogger(__name__)

STANDARD_URL_TAGS = "utm_source=facebook&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.id}}"
STANDARD_EVENTS = {"Lead", "Schedule", "Purchase", "CompleteRegistration", "Contact", "SubmitApplication"}
GRAPH = "https://graph.facebook.com/v21.0"
EXECUTABLE_ACTIONS = ("fix_utm", "create_pixel", "fix_tracking")

GHL_CAPI_STEPS = (
    "GHL sub-account → Automation → Workflows → create 'Meta CAPI: Lead' (trigger: Contact Created, filter source = paid/Facebook) "
    "→ action 'Facebook Conversion API' → event name Lead, action_source system_generated, send email + phone (hashed by GHL), fbc/fbp if present, event_id = contact id.\n"
    "Second workflow 'Meta CAPI: Schedule' (trigger: Opportunity stage changed → Scheduled Appointment OR Confirmed Appointment) → event Schedule.\n"
    "Third workflow 'Meta CAPI: Purchase' (trigger: Opportunity status → Won) → event Purchase with value = opportunity monetary value, currency USD.\n"
    "Select the pixel/dataset named on this recommendation. Then in Meta Events Manager → the dataset → Settings, confirm the events appear under 'Server'."
)


# ---------------------------------------------------------------- graph helpers (sync)

def _tok() -> str:
    tok = get_settings().meta_system_user_token
    if not tok:
        raise RuntimeError("META_SYSTEM_USER_TOKEN not configured")
    return tok


RATE_LIMIT_CODES = {4, 17, 32, 613, 80000, 80003, 80004}


class GraphCallError(RuntimeError):
    def __init__(self, message: str, code: int | None = None, subcode: int | None = None):
        super().__init__(message)
        self.code, self.subcode = code, subcode


def _check(r: httpx.Response) -> dict:
    body = r.json()
    if r.status_code >= 400 or "error" in body:
        err = body.get("error") or {}
        raise GraphCallError(
            f"{err.get('error_user_msg') or err.get('message') or r.status_code} (code {err.get('code')}/{err.get('error_subcode')})",
            err.get("code"), err.get("error_subcode"),
        )
    return body


def _with_retry(fn, attempts: int = 4):
    """Meta's per-account limits (code 613: 1 call / 30 s on some edges) hit bulk work; back off and retry."""
    delay = 31
    for i in range(attempts):
        try:
            return fn()
        except GraphCallError as e:
            if e.code in RATE_LIMIT_CODES and i < attempts - 1:
                time.sleep(delay)
                delay = min(delay * 2, 180)
                continue
            raise
    raise RuntimeError("unreachable")


def explain(err: Exception) -> str:
    """Turn Meta's error into the action a person must take."""
    m = str(err)
    if "2490591" in m or "Advertise permission" in m:
        return ("Our system user has no task assignment on this ad account. In Zeal's Business Manager → Ad accounts → this account → "
                "assign the system user 'Manage campaigns' (the client may need to grant Zeal that partner permission first).")
    if "1885499" in m or "advertiser permission on the page" in m:
        return ("Our system user cannot create ads for this Facebook Page. In Zeal's Business Manager → Pages, assign the system user "
                "'Advertise' on the client's Page (the Page must be shared to Zeal with that task).")
    if "(#200)" in m or "Permissions error" in m:
        return ("Meta refused the write: pixel creation needs admin rights on the business that owns the account. Create the dataset in "
                "Events Manager (client's BM, or Zeal's BM and share it to the account), then set it in Settings → client → Meta Pixel ID.")
    if "3390001" in m or "1634013" in m:
        return ("Meta's API refuses tracking edits on Instant Form ads that were built in Ads Manager (it re-validates the form and errors). "
                "Set the toggles there instead: Ads Manager → select the ads → Edit → Tracking → turn on Website events (pick the pixel) and "
                "Offline events (pick the dataset) → Publish. Ads created through the Campaign Builder get the toggles at creation.")
    if "613" in m or "rate limit" in m.lower():
        return "Meta rate limit on this account; retry in a few minutes."
    return m


def _get(client: httpx.Client, path: str, **params) -> dict:
    params["access_token"] = _tok()
    return _with_retry(lambda: _check(client.get(f"{GRAPH}/{path}", params=params)))


def _get_all(client: httpx.Client, path: str, pages: int = 5, **params) -> list[dict]:
    out: list[dict] = []
    body = _get(client, path, **params)
    out += body.get("data", [])
    n = 1
    while body.get("paging", {}).get("next") and n < pages:
        r = client.get(body["paging"]["next"])
        body = r.json()
        out += body.get("data", [])
        n += 1
    return out


def _post(client: httpx.Client, path: str, params: dict) -> dict:
    data = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}
    data["access_token"] = _tok()
    return _with_retry(lambda: _check(client.post(f"{GRAPH}/{path}", data=data)))


def has_standard_utm(url_tags: str | None) -> bool:
    """True when url_tags carries the ad-set macro the dashboard's attribution reads."""
    tags = (url_tags or "").replace(" ", "").lower()
    return "utm_medium={{adset.name}}" in tags and "utm_source=facebook" in tags


def is_website_link(link: str | None) -> bool:
    return bool(link) and not str(link).lower().startswith(("http://fb.me", "https://fb.me", "https://www.facebook.com", "https://facebook.com"))


LEAD_OBJECTIVES = {"OUTCOME_LEADS", "LEAD_GENERATION", "CONVERSIONS", "OUTCOME_SALES", "OUTCOME_TRAFFIC"}
BOOST_PREFIXES = ("instagram post:", "post:", "promoting ", "[")  # Ads Manager boosts / legacy page promotions


def is_lead_campaign(objective: str | None, name: str | None) -> bool:
    """Only campaigns built to generate leads or conversions get tracking items.
    Boosted posts ("Instagram post: …") and legacy "[date] Promoting …" page
    promotions are skipped: they are not lead campaigns and would swamp the queue."""
    if (name or "").strip().lower().startswith(BOOST_PREFIXES):
        return False
    return (objective or "").upper() in LEAD_OBJECTIVES


def classify_events(events: dict[str, int]) -> str:
    """'standard' if any Meta standard conversion event arrived, 'custom' if only
    custom names (e.g. 'Scheduled Appointment'), 'none' otherwise."""
    conv = {k: v for k, v in events.items() if k not in ("PageView", "ViewContent")}
    if not conv:
        return "none"
    return "standard" if any(k in STANDARD_EVENTS for k in conv) else "custom"


def desired_tracking_specs(pixel_id: str, destination_type: str | None) -> list[dict]:
    """The ad-level 'Website events' and 'Offline events' toggles as tracking_specs.
    Instant Form / on-Facebook ads bind the pixel through leadgen_quality_conversion
    (what Ads Manager writes); website ads through offsite_conversion. Offline events
    bind the dataset (same id as the pixel since datasets absorbed offline event sets)."""
    web_type = "offsite_conversion" if (destination_type or "").upper() == "WEBSITE" else "leadgen_quality_conversion"
    return [
        {"action.type": [web_type], "fb_pixel": [str(pixel_id)]},
        {"action.type": ["offline_conversion"], "dataset": [str(pixel_id)]},
    ]


WEB_EVENT_TYPES = {"offsite_conversion", "leadgen_quality_conversion"}


def _spec_present(specs: list[dict], want: dict) -> bool:
    """Ads Manager writes Website events as offsite_conversion even on Instant Form
    ads; the API default is leadgen_quality_conversion. Either binds the pixel."""
    want_types = set(want["action.type"])
    for sp in specs or []:
        have = set(sp.get("action.type", []))
        if have != want_types and not (want_types <= WEB_EVENT_TYPES and have <= WEB_EVENT_TYPES and have):
            continue
        for key in ("fb_pixel", "dataset"):
            if key in want and str(want[key][0]) in [str(x) for x in sp.get(key, [])]:
                return True
    return False


def merge_tracking_specs(current: list[dict] | None, pixel_id: str, destination_type: str | None) -> tuple[list[dict], list[dict]]:
    """Return (merged_specs, additions). Existing specs are kept verbatim — Meta
    overwrites the whole list on update, so we must send everything back."""
    current = list(current or [])
    additions = [w for w in desired_tracking_specs(pixel_id, destination_type) if not _spec_present(current, w)]
    return current + additions, additions


# ---------------------------------------------------------------- proposal

def _open_rec_exists(client_id: str, action: str, entity_id: str | None) -> bool:
    rows = pg.query(
        "select 1 from recommendations where client_id = %s and action = %s and coalesce(entity_id,'') = coalesce(%s,'') and status in ('proposed','approved') limit 1",
        (client_id, action, entity_id),
    )
    return bool(rows)


def _insert_rec(client_id: str, **r) -> int | None:
    if _open_rec_exists(client_id, r["action"], r.get("entity_id")):
        return None
    rows = pg.query(
        """
        insert into recommendations (client_id, entity_type, entity_id, entity_name, action, current_value, proposed_value,
                                     reason, evidence, risk, rollback_value, status)
        values (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,'proposed') returning id
        """,
        (client_id, r["entity_type"], r.get("entity_id"), r.get("entity_name"), r["action"], r.get("current_value"),
         r.get("proposed_value"), r["reason"], json.dumps(r.get("evidence") or {}, default=str), r.get("risk"), r.get("rollback_value")),
    )
    return rows[0]["id"]


def propose_utm_fixes(client: dict, http: httpx.Client) -> int:
    acct = f"act_{client['meta_ad_account_id'].replace('act_', '')}"
    flt = json.dumps([{"field": "effective_status", "operator": "IN", "value": ["ACTIVE"]}])
    ads = _get_all(
        http, f"{acct}/ads", limit=100, filtering=flt,
        fields="id,name,adset_id,adset{name},campaign{name,objective},creative{id,name,url_tags,effective_object_story_id,object_story_spec{link_data{link},video_data{call_to_action}},asset_feed_spec{link_urls}}",
    )
    by_adset: dict[str, dict] = {}
    for a in ads:
        camp = a.get("campaign") or {}
        if not is_lead_campaign(camp.get("objective"), camp.get("name")):
            continue
        c = a.get("creative") or {}
        oss = c.get("object_story_spec") or {}
        link = (oss.get("link_data") or {}).get("link") or (((oss.get("video_data") or {}).get("call_to_action") or {}).get("value") or {}).get("link")
        if not link and (c.get("asset_feed_spec") or {}).get("link_urls"):
            link = (c["asset_feed_spec"]["link_urls"][0] or {}).get("website_url")
        if not is_website_link(link) or has_standard_utm(c.get("url_tags")):
            continue
        g = by_adset.setdefault(a["adset_id"], {"adset_name": (a.get("adset") or {}).get("name"), "campaign_name": (a.get("campaign") or {}).get("name"), "ads": []})
        g["ads"].append({"ad_id": a["id"], "ad_name": a["name"], "creative_id": c.get("id"), "url_tags": c.get("url_tags"),
                         "effective_object_story_id": c.get("effective_object_story_id"), "link": link})
    n = 0
    for adset_id, g in by_adset.items():
        rid = _insert_rec(
            client["id"], entity_type="adset", entity_id=adset_id, entity_name=g["adset_name"], action="fix_utm",
            current_value="no url_tags", proposed_value=STANDARD_URL_TAGS,
            reason=(f"{len(g['ads'])} active website ad(s) in '{g['campaign_name']} › {g['adset_name']}' send traffic without the Zeal UTM set, so their "
                    "GoHighLevel leads and bookings cannot be attributed to the ad set. Execute swaps each ad to a creative on the same post with the standard tags."),
            evidence={"kind": "utm", "account": acct, "campaign_name": g["campaign_name"], "ads": g["ads"], "url_tags": STANDARD_URL_TAGS},
            risk="Each ad is re-reviewed by Meta (minutes to hours) and the ad set restarts its learning phase. Likes/comments are kept (same post).",
            rollback_value=json.dumps({a["ad_id"]: a["creative_id"] for a in g["ads"]}),
        )
        n += 1 if rid else 0
    return n


def _client_pixel(client: dict, pixels: list[dict]) -> str | None:
    """The pixel to bind: the Settings choice, else the only pixel, else None (ambiguous)."""
    preferred = (client.get("meta_pixel_id") or "").strip()
    if preferred:
        return preferred
    return pixels[0]["id"] if len(pixels) == 1 else None


def propose_tracking_toggles(client: dict, http: httpx.Client) -> int:
    """One fix_tracking recommendation per campaign whose active ads lack the
    Website events / Offline events bindings to the client's pixel."""
    acct = f"act_{client['meta_ad_account_id'].replace('act_', '')}"
    pixels = _get_all(http, f"{acct}/adspixels", fields="id,name")
    pixel = _client_pixel(client, pixels)
    if not pixel:
        if pixels:  # several pixels and no Settings choice → ask, don't guess
            _insert_rec(client["id"], entity_type="account", entity_id=f"{acct}:pixel_choice", entity_name=client["name"], action="investigate",
                        reason="The ad account has several pixels (" + ", ".join(f"{p['name']} {p['id']}" for p in pixels[:4]) + "). Set the live one in Settings → client → Meta Pixel ID, then re-run Propose tracking fixes.",
                        evidence={"kind": "pixel_choice", "pixels": pixels}, risk="None")
        return 0
    flt = json.dumps([{"field": "effective_status", "operator": "IN", "value": ["ACTIVE"]}])
    ads = _get_all(http, f"{acct}/ads", limit=100, filtering=flt,
                   fields="id,name,campaign_id,campaign{name,objective},adset{destination_type},tracking_specs")
    campaigns: dict[str, dict] = {}
    flat: list[dict] = []
    for a in ads:
        camp = a.get("campaign") or {}
        if not is_lead_campaign(camp.get("objective"), camp.get("name")):
            continue
        dest = (a.get("adset") or {}).get("destination_type")
        _, additions = merge_tracking_specs(a.get("tracking_specs"), pixel, dest)
        if not additions:
            continue
        missing = [x["action.type"][0] for x in additions]
        entry = {"ad_id": a["id"], "ad_name": a["name"], "campaign_id": a["campaign_id"], "campaign_name": camp.get("name"),
                 "destination_type": dest, "missing": missing}
        flat.append(entry)
        g = campaigns.setdefault(a["campaign_id"], {"campaign_name": camp.get("name"), "objective": camp.get("objective"), "ads": 0})
        g["ads"] += 1
    if not flat:
        return 0
    toggles = sorted({m for e in flat for m in e["missing"]})
    human = sorted({("Offline events" if t == "offline_conversion" else "Website events") for t in toggles})
    camp_list = "; ".join(f"{g['campaign_name']} ({g['ads']})" for g in list(campaigns.values())[:12]) + (" …" if len(campaigns) > 12 else "")
    rid = _insert_rec(
        client["id"], entity_type="account", entity_id=f"{acct}:tracking", entity_name=client["name"], action="fix_tracking",
        current_value="off", proposed_value=f"on (pixel {pixel})",
        reason=(f"{len(flat)} active ad(s) across {len(campaigns)} lead campaign(s) have {' + '.join(human)} switched off, so conversions and "
                f"offline outcomes are not tied back to the ads. Execute turns the toggles on for every listed ad, bound to pixel/dataset {pixel}. "
                f"Campaigns: {camp_list}. Boosted posts and legacy page promotions are deliberately excluded."),
        evidence={"kind": "tracking_toggles", "account": acct, "pixel_id": pixel, "campaigns": campaigns, "ads": flat},
        risk="Minor edit: no creative change, no re-review, no learning reset. Existing tracking specs are kept.",
    )
    return 1 if rid else 0


def propose_signal_fixes(client: dict, http: httpx.Client) -> int:
    acct = f"act_{client['meta_ad_account_id'].replace('act_', '')}"
    pixels = _get_all(http, f"{acct}/adspixels", fields="id,name,last_fired_time")
    preferred = (client.get("meta_pixel_id") or "").strip()
    other_pixels: list[dict] = []
    if preferred and any(p["id"] == preferred for p in pixels):
        other_pixels = [p for p in pixels if p["id"] != preferred]
        pixels = [p for p in pixels if p["id"] == preferred]
    n = 0
    if not pixels:
        if _insert_rec(client["id"], entity_type="account", entity_id=acct, entity_name=client["name"], action="create_pixel",
                       proposed_value=f"{client['name']} Pixel",
                       reason="The ad account has no pixel/dataset, so Meta receives no website or offline conversion signal. Execute creates one; then connect it in GHL (see the fix_signal recommendation).",
                       evidence={"kind": "pixel_missing", "account": acct}, risk="None — creates an empty dataset; nothing fires until it is installed/connected."):
            n += 1
        if _insert_rec(client["id"], entity_type="account", entity_id=f"{acct}:capi", entity_name=client["name"], action="fix_signal",
                       reason="Set up the GHL → Meta Conversions API workflows (Lead / Schedule / Purchase) against the new pixel so bookings and won jobs reach Meta as offline events.",
                       evidence={"kind": "capi_setup", "account": acct, "steps": GHL_CAPI_STEPS, "standard_events": ["Lead", "Schedule", "Purchase"]},
                       risk="None — tracking only. Manual step in GHL (workflows cannot be created via API)."):
            n += 1
        return n
    now = int(time.time())
    events: dict[str, int] = {}
    server = browser = 0
    for p in pixels:
        try:
            st = _get(http, f"{p['id']}/stats", aggregation="event", start_time=now - 14 * 86400, end_time=now)
            for b in st.get("data", []):
                for d in b.get("data", []):
                    events[d.get("value")] = events.get(d.get("value"), 0) + int(d.get("count") or 0)
            ss = _get(http, f"{p['id']}/stats", aggregation="event_source", start_time=now - 14 * 86400, end_time=now)
            for b in ss.get("data", []):
                for d in b.get("data", []):
                    if d.get("value") == "SERVER":
                        server += int(d.get("count") or 0)
                    elif d.get("value") == "BROWSER":
                        browser += int(d.get("count") or 0)
        except RuntimeError:
            continue
    kind = classify_events(events)
    names = ", ".join(f"{p['name']} ({p['id']})" for p in pixels[:3])
    if other_pixels:
        names += " — ignore the other pixel(s) on this account: " + ", ".join(f"{p['name']} ({p['id']})" for p in other_pixels[:3])
    if server == 0:
        reason = (f"Pixel {names}: no server (Conversions API) events in 14 days" + (f", {browser} browser events only" if browser else ", no events at all")
                  + ". Bookings and won jobs never reach Meta. Set up the GHL → CAPI workflows for Lead / Schedule / Purchase.")
        if _insert_rec(client["id"], entity_type="account", entity_id=f"{acct}:capi", entity_name=client["name"], action="fix_signal", reason=reason,
                       evidence={"kind": "capi_setup", "account": acct, "pixels": pixels, "pixel_id": pixels[0]["id"], "other_pixels": other_pixels,
                                 "events_14d": events, "server": server, "browser": browser,
                                 "steps": GHL_CAPI_STEPS, "standard_events": ["Lead", "Schedule", "Purchase"]},
                       risk="None — tracking only. Manual step in GHL."):
            n += 1
    elif kind == "custom":
        custom = sorted(k for k in events if k not in ("PageView", "ViewContent"))
        reason = (f"CAPI is live ({server} server events, 14d) but only custom event names arrive: {', '.join(custom[:6])}. "
                  "Meta can only optimise campaigns on events selected as the conversion event; rename/duplicate the GHL workflow events to the standard "
                  "Lead / Schedule / Purchase (keep the custom ones if reports depend on them).")
        if _insert_rec(client["id"], entity_type="account", entity_id=f"{acct}:events", entity_name=client["name"], action="fix_signal", reason=reason,
                       evidence={"kind": "standardise_events", "account": acct, "pixel_id": pixels[0]["id"], "events_14d": events, "steps": GHL_CAPI_STEPS},
                       risk="None — tracking only."):
            n += 1
    return n


def propose_tracking_fixes() -> dict[str, Any]:
    clients = pg.query("select id, slug, name, meta_ad_account_id, meta_pixel_id from clients where is_active and coalesce(meta_ad_account_id,'') <> '' order by slug")
    out = {"clients": 0, "utm_recs": 0, "tracking_recs": 0, "signal_recs": 0, "errors": []}
    with httpx.Client(timeout=90) as http:
        for c in clients:
            out["clients"] += 1
            try:
                out["utm_recs"] += propose_utm_fixes(c, http)
            except Exception as e:  # noqa: BLE001
                out["errors"].append(f"{c['slug']} utm: {e}")
            try:
                out["tracking_recs"] += propose_tracking_toggles(c, http)
            except Exception as e:  # noqa: BLE001
                out["errors"].append(f"{c['slug']} tracking: {e}")
            try:
                out["signal_recs"] += propose_signal_fixes(c, http)
            except Exception as e:  # noqa: BLE001
                out["errors"].append(f"{c['slug']} signal: {e}")
    return out


# ---------------------------------------------------------------- execution

def _finish(rec_id: int, status: str, actor: str, verification: dict) -> None:
    pg.execute(
        "update recommendations set status = %s, executed_by = %s, executed_at = now(), verification = %s::jsonb where id = %s",
        (status, actor, json.dumps(verification, default=str), rec_id),
    )


def execute_recommendation(rec_id: int, actor: str) -> dict:
    rows = pg.query("select r.*, c.slug from recommendations r join clients c on c.id = r.client_id where r.id = %s", (rec_id,))
    if not rows:
        return {"error": "not found"}
    rec = rows[0]
    if rec["status"] != "approved" or not rec.get("approved_by"):
        return {"error": f"status is {rec['status']} or not approved by a person"}
    if rec["action"] not in EXECUTABLE_ACTIONS:
        return {"error": f"{rec['action']} is not executable by the dashboard"}
    ev = rec.get("evidence") or {}
    acct = ev.get("account")
    log: list[dict] = []
    ok = True
    with httpx.Client(timeout=120) as http:
        try:
            if rec["action"] == "create_pixel":
                body = _post(http, f"{acct}/adspixels", {"name": rec.get("proposed_value") or f"{rec.get('entity_name')} Pixel"})
                pid = body["id"]
                back = _get(http, pid, fields="id,name,creation_time")
                log.append({"step": "create_pixel", "ok": True, "pixel": back})
                # surface the id on the companion CAPI rec so the GHL steps name the right dataset
                pg.execute("update recommendations set evidence = coalesce(evidence,'{}'::jsonb) || %s::jsonb where client_id = %s and action = 'fix_signal' and status in ('proposed','approved')",
                           (json.dumps({"pixel_id": pid}), rec["client_id"]))
            elif rec["action"] == "fix_tracking":
                pixel = ev["pixel_id"]
                for ad in ev.get("ads", []):
                    try:
                        cur = _get(http, ad["ad_id"], fields="id,name,tracking_specs,adset{destination_type}")
                        dest = (cur.get("adset") or {}).get("destination_type") or ad.get("destination_type")
                        merged, additions = merge_tracking_specs(cur.get("tracking_specs"), pixel, dest)
                        if not additions:
                            log.append({"step": "ad", "ad_id": ad["ad_id"], "ad_name": ad["ad_name"], "ok": True, "note": "already on"})
                            continue
                        rejected: list[str] = []
                        try:
                            _post(http, ad["ad_id"], {"tracking_specs": merged})
                        except GraphCallError as e:
                            if e.subcode != 1634013:
                                raise
                            # Meta's generic "unexpected error": find out which toggle it objects to by
                            # applying them one at a time, keeping whatever it accepts.
                            base = list(cur.get("tracking_specs") or [])
                            for spec in additions:
                                try:
                                    _post(http, ad["ad_id"], {"tracking_specs": base + [spec]})
                                    base = base + [spec]
                                except GraphCallError as e2:
                                    rejected.append(f"{spec['action.type'][0]}: {e2}")
                        back = _get(http, ad["ad_id"], fields="id,tracking_specs,effective_status")
                        _, still_missing = merge_tracking_specs(back.get("tracking_specs"), pixel, dest)
                        good = not still_missing
                        ok &= good
                        entry = {"step": "ad", "ad_id": ad["ad_id"], "ad_name": ad["ad_name"], "campaign": ad.get("campaign_name"), "ok": good,
                                 "added": [x["action.type"][0] for x in additions if x not in [m for m in still_missing]],
                                 "effective_status": back.get("effective_status")}
                        if rejected:
                            entry["error"] = "Meta rejected: " + "; ".join(rejected)[:300]
                            entry["fix"] = explain(GraphCallError(rejected[0], subcode=1634013))
                        log.append(entry)
                    except Exception as e:  # noqa: BLE001 — one ad must not abort the batch
                        ok = False
                        log.append({"step": "ad", "ad_id": ad["ad_id"], "ad_name": ad["ad_name"], "campaign": ad.get("campaign_name"),
                                    "ok": False, "error": str(e)[:300], "fix": explain(e)})
            else:  # fix_utm
                for ad in ev.get("ads", []):
                    story = ad.get("effective_object_story_id")
                    if not story:
                        log.append({"step": "ad", "ad_id": ad["ad_id"], "ok": False, "error": "no page post id on this ad; recreate it via the Campaign Builder"})
                        ok = False
                        continue
                    try:
                        cr = _post(http, f"{acct}/adcreatives", {"name": f"{ad['ad_name']} | UTM {datetime.now(UTC):%d-%b-%y}",
                                                                 "object_story_id": story, "url_tags": STANDARD_URL_TAGS})
                        back = _get(http, cr["id"], fields="id,url_tags,object_story_id")
                        if not has_standard_utm(back.get("url_tags")):
                            raise RuntimeError(f"new creative {cr['id']} did not keep url_tags")
                        _post(http, ad["ad_id"], {"creative": {"creative_id": cr["id"]}})
                        adb = _get(http, ad["ad_id"], fields="id,name,status,effective_status,creative{id,url_tags}")
                        swapped = (adb.get("creative") or {}).get("id") == cr["id"]
                        ok &= swapped
                        log.append({"step": "ad", "ad_id": ad["ad_id"], "ad_name": ad["ad_name"], "ok": swapped, "old_creative": ad.get("creative_id"),
                                    "new_creative": cr["id"], "url_tags": (adb.get("creative") or {}).get("url_tags"), "effective_status": adb.get("effective_status")})
                    except Exception as e:  # noqa: BLE001 — one ad must not abort the batch
                        ok = False
                        log.append({"step": "ad", "ad_id": ad["ad_id"], "ad_name": ad["ad_name"], "ok": False, "error": str(e)[:300], "fix": explain(e)})
        except Exception as e:  # noqa: BLE001
            ok = False
            log.append({"step": "error", "ok": False, "error": str(e)[:500], "fix": explain(e)})
    verification = {
        "executed_at": datetime.now(UTC).isoformat(timespec="seconds"), "ok": ok, "log": log,
        "done": sum(1 for x in log if x.get("ok") and x.get("step") == "ad"),
        "failed": sum(1 for x in log if not x.get("ok")),
        "needs": sorted({x["fix"] for x in log if not x.get("ok") and x.get("fix")}),
    }
    _finish(rec_id, "executed" if ok else "failed", actor, verification)
    pg.execute(
        "insert into audit_log (actor_type, actor_email, action, entity_type, entity_id, client_id, after, environment) values ('user', %s, %s, 'recommendation', %s, %s, %s::jsonb, 'production')",
        (actor, f"recommendation.{rec['action']}." + ("executed" if ok else "failed"), str(rec_id), rec["client_id"], json.dumps(verification, default=str)),
    )
    return verification

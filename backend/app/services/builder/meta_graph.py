"""Meta Marketing API for the builder — plain Graph HTTP (httpx) so every request
and response is inspectable and logged. Reads use the async client (API request
path); the executor (Celery, sync) uses the sync twin.

Only create operations exist here, and every created object carries
status=PAUSED. There is no update/enable/delete method on purpose.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

API_VERSION = "v21.0"
BASE = f"https://graph.facebook.com/{API_VERSION}"
STATUS = "PAUSED"


class GraphError(RuntimeError):
    def __init__(self, message: str, code: int | None = None, subcode: int | None = None, payload: dict | None = None):
        super().__init__(message)
        self.code, self.subcode, self.payload = code, subcode, payload or {}

    @property
    def is_rate_limit(self) -> bool:
        return self.code in (4, 17, 32, 613) or (self.code == 80004)


def _token() -> str:
    tok = get_settings().meta_system_user_token
    if not tok:
        raise RuntimeError("META_SYSTEM_USER_TOKEN is not configured")
    return tok


def _raise_for(r: httpx.Response) -> dict:
    try:
        body = r.json()
    except ValueError:
        body = {"raw": r.text[:500]}
    if r.status_code >= 400 or "error" in body:
        err = body.get("error", {})
        raise GraphError(
            err.get("error_user_msg") or err.get("message") or f"HTTP {r.status_code}",
            code=err.get("code"), subcode=err.get("error_subcode"), payload=body,
        )
    return body


def act(account_id: str) -> str:
    aid = str(account_id)
    return aid if aid.startswith("act_") else f"act_{aid}"


# ---------------------------------------------------------------- async reads

async def _get(client: httpx.AsyncClient, path: str, **params) -> dict:
    params["access_token"] = _token()
    r = await client.get(f"{BASE}/{path}", params=params)
    return _raise_for(r)


async def _get_all(client: httpx.AsyncClient, path: str, limit_pages: int = 6, **params) -> list[dict]:
    out: list[dict] = []
    body = await _get(client, path, **params)
    out += body.get("data", [])
    pages = 1
    while body.get("paging", {}).get("next") and pages < limit_pages:
        r = await client.get(body["paging"]["next"])
        body = _raise_for(r)
        out += body.get("data", [])
        pages += 1
    return out


async def account_context(account_id: str, preferred_pixel: str | None = None) -> dict[str, Any]:
    """Everything the model and the validator need about the ad account:
    currency/timezone, the Page (+IG) used by existing ads, Instant Forms seen in
    ads, pixels, and every campaign / ad set name (any status, last 2 years)."""
    a = act(account_id)
    async with httpx.AsyncClient(timeout=60) as client:
        acct = await _get(client, a, fields="account_id,name,currency,timezone_name,account_status")
        campaigns = await _get_all(
            client, f"{a}/campaigns", fields="id,name,status,objective,daily_budget,created_time", limit=200,
            date_preset="maximum",
        )
        adsets = await _get_all(client, f"{a}/adsets", fields="id,name,campaign_id,status", limit=500)
        ads = await _get_all(
            client, f"{a}/ads", limit=100, limit_pages=3,
            fields="id,name,status,created_time,creative{object_story_spec{page_id,instagram_user_id,link_data{call_to_action}}}",
        )
        try:
            pixels = await _get_all(client, f"{a}/adspixels", fields="id,name", limit=10)
        except GraphError:
            pixels = []
    pages: dict[str, dict] = {}
    forms: dict[str, int] = {}
    for ad in ads:
        oss = ((ad.get("creative") or {}).get("object_story_spec")) or {}
        pid = oss.get("page_id")
        if pid:
            entry = pages.setdefault(pid, {"page_id": pid, "instagram_user_id": oss.get("instagram_user_id"), "ads": 0})
            entry["ads"] += 1
            if oss.get("instagram_user_id") and not entry.get("instagram_user_id"):
                entry["instagram_user_id"] = oss["instagram_user_id"]
        cta = ((oss.get("link_data") or {}).get("call_to_action") or {}).get("value") or {}
        fid = cta.get("lead_gen_form_id")
        if fid:
            forms[fid] = forms.get(fid, 0) + 1
    primary = max(pages.values(), key=lambda p: p["ads"]) if pages else {}
    pixel_ids = [p["id"] for p in pixels]
    if preferred_pixel and preferred_pixel in pixel_ids:
        pixel_ids = [preferred_pixel, *[p for p in pixel_ids if p != preferred_pixel]]
    elif preferred_pixel:
        pixel_ids = [preferred_pixel, *pixel_ids]  # trust the setting even if the list call missed it
    return {
        "ad_account_id": acct.get("account_id"),
        "account_name": acct.get("name"),
        "currency": acct.get("currency"),
        "timezone": acct.get("timezone_name"),
        "account_status": acct.get("account_status"),
        "page_id": primary.get("page_id"),
        "instagram_user_id": primary.get("instagram_user_id"),
        "pages_seen": list(pages.values()),
        "lead_forms": [{"id": k, "seen_in_ads": v} for k, v in sorted(forms.items(), key=lambda kv: -kv[1])],
        "pixel_ids": pixel_ids,
        "preferred_pixel_id": preferred_pixel,
        "existing_campaign_names": [c["name"] for c in campaigns],
        "existing_adset_names": [s["name"] for s in adsets],
        "recent_campaigns": [
            {"id": c["id"], "name": c["name"], "status": c.get("status"), "objective": c.get("objective"),
             "daily_budget": c.get("daily_budget")}
            for c in sorted(campaigns, key=lambda c: c.get("created_time", ""), reverse=True)[:15]
        ],
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


async def search_geo(q: str, types: list[str] | None = None, country: str = "US") -> list[dict]:
    async with httpx.AsyncClient(timeout=30) as client:
        body = await _get(
            client, "search", type="adgeolocation", q=q, limit=10,
            location_types=json.dumps(types or ["city", "region", "zip", "neighborhood", "county"]),
            country_code=country,
        )
    return [
        {"key": r["key"], "name": r["name"], "type": r["type"], "region": r.get("region"),
         "country_code": r.get("country_code", country), "radius_miles": None}
        for r in body.get("data", [])
    ]


async def search_interests(q: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=30) as client:
        body = await _get(client, "search", type="adinterest", q=q, limit=10)
    return [{"id": r["id"], "name": r["name"], "audience_size": r.get("audience_size_lower_bound")} for r in body.get("data", [])]


# ---------------------------------------------------------------- sync writes (executor)

class GraphWriter:
    """Sync client used by the Celery executor. Every create sets status=PAUSED.
    `log` records each call (without the token) for the build's step log."""

    def __init__(self, account_id: str, log: list[dict] | None = None):
        self.account = act(account_id)
        self.log = log if log is not None else []
        self.client = httpx.Client(timeout=120)

    def close(self) -> None:
        self.client.close()

    def _post(self, path: str, params: dict, files: dict | None = None, retries: int = 3) -> dict:
        data = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items() if v is not None}
        data["access_token"] = _token()
        for attempt in range(retries):
            r = self.client.post(f"{BASE}/{path}", data=data, files=files)
            try:
                body = _raise_for(r)
                self.log.append({"step": path, "ok": True, "request": {k: v for k, v in data.items() if k != "access_token"}, "response": body})
                return body
            except GraphError as e:
                self.log.append({"step": path, "ok": False, "request": {k: v for k, v in data.items() if k != "access_token"}, "error": str(e), "code": e.code, "subcode": e.subcode})
                if e.is_rate_limit and attempt < retries - 1:
                    time.sleep(30 * (attempt + 1))
                    continue
                raise
        raise RuntimeError("unreachable")

    def get(self, path: str, **params) -> dict:
        params["access_token"] = _token()
        return _raise_for(self.client.get(f"{BASE}/{path}", params=params))

    # -- uploads
    def upload_image(self, filename: str, data: bytes, content_type: str) -> str:
        body = self._post(f"{self.account}/adimages", {}, files={"filename": (filename, data, content_type)})
        images = body.get("images", {})
        first = next(iter(images.values()), {})
        h = first.get("hash")
        if not h:
            raise GraphError("image upload returned no hash", payload=body)
        return h

    def upload_video(self, filename: str, data: bytes, content_type: str, title: str) -> str:
        # Non-resumable upload is fine for the creative sizes we accept (≤200 MB).
        body = self._post(f"{self.account}/advideos", {"title": title, "name": filename}, files={"source": (filename, data, content_type)})
        vid = body.get("id")
        if not vid:
            raise GraphError("video upload returned no id", payload=body)
        return vid

    def video_ready(self, video_id: str) -> bool:
        body = self.get(video_id, fields="status")
        return (body.get("status") or {}).get("video_status") == "ready"

    def video_thumbnail(self, video_id: str) -> str | None:
        body = self.get(f"{video_id}/thumbnails", fields="uri,is_preferred")
        thumbs = body.get("data", [])
        pref = next((t for t in thumbs if t.get("is_preferred")), thumbs[0] if thumbs else None)
        return pref.get("uri") if pref else None

    # -- creates (all PAUSED)
    def create_campaign(self, name: str, daily_budget_cents: int, bid_strategy: str, special_ad_categories: list[str], start_date: str | None) -> str:
        params = {
            "name": name, "objective": "OUTCOME_LEADS", "status": STATUS,
            "daily_budget": int(daily_budget_cents), "bid_strategy": bid_strategy,
            "special_ad_categories": special_ad_categories or [],
            "is_adset_budget_sharing_enabled": False,
        }
        if start_date:
            params["start_time"] = f"{start_date}T00:00:00"
        return self._post(f"{self.account}/campaigns", params)["id"]

    def create_adset(self, campaign_id: str, name: str, destination: str, page_id: str, lead_form_id: str | None,
                     pixel_id: str | None, targeting: dict) -> str:
        params: dict[str, Any] = {
            "name": name, "campaign_id": campaign_id, "status": STATUS,
            "billing_event": "IMPRESSIONS", "targeting": targeting,
        }
        if destination == "instant_form":
            params.update({"optimization_goal": "LEAD_GENERATION", "destination_type": "ON_AD",
                           "promoted_object": {"page_id": page_id}})
        else:
            params.update({"optimization_goal": "OFFSITE_CONVERSIONS", "destination_type": "WEBSITE",
                           "promoted_object": {"pixel_id": pixel_id, "custom_event_type": "LEAD"}})
        return self._post(f"{self.account}/adsets", params)["id"]

    def create_creative(self, name: str, page_id: str, instagram_user_id: str | None, asset: dict, ad: dict,
                        destination: str, lead_form_id: str | None, landing_page_url: str | None, url_tags: str) -> str:
        cta: dict[str, Any] = {"type": ad["cta"], "value": {}}
        if destination == "instant_form":
            cta["value"] = {"lead_gen_form_id": lead_form_id}
            link = "https://fb.me/"
        else:
            cta["value"] = {"link": landing_page_url}
            link = landing_page_url
        if asset["kind"] == "image":
            story = {"link_data": {
                "image_hash": asset["meta_image_hash"], "link": link, "message": ad["primary_text"],
                "name": ad["headline"], "description": ad.get("description") or "", "call_to_action": cta,
            }}
        else:
            story = {"video_data": {
                "video_id": asset["meta_video_id"], "image_url": asset.get("thumbnail_url"),
                "message": ad["primary_text"], "title": ad["headline"],
                "link_description": ad.get("description") or "", "call_to_action": cta,
            }}
        spec = {"page_id": page_id, **story}
        if instagram_user_id:
            spec["instagram_user_id"] = instagram_user_id
        params: dict[str, Any] = {
            "name": name, "object_story_spec": spec,
            # Keep Meta's Advantage+ creative enhancements off — brand control.
            "degrees_of_freedom_spec": {"creative_features_spec": {"standard_enhancements": {"enroll_status": "OPT_OUT"}}},
        }
        if destination == "website":
            params["url_tags"] = url_tags
        return self._post(f"{self.account}/adcreatives", params)["id"]

    def create_ad(self, adset_id: str, name: str, creative_id: str) -> str:
        return self._post(f"{self.account}/ads", {
            "name": name, "adset_id": adset_id, "status": STATUS, "creative": {"creative_id": creative_id},
        })["id"]

    # -- read back
    def read_campaign(self, cid: str) -> dict:
        return self.get(cid, fields="id,name,status,effective_status,objective,daily_budget,bid_strategy,special_ad_categories")

    def read_adset(self, sid: str) -> dict:
        return self.get(sid, fields="id,name,status,effective_status,campaign_id,optimization_goal,destination_type,promoted_object,targeting")

    def read_ad(self, aid: str) -> dict:
        return self.get(aid, fields="id,name,status,effective_status,adset_id,creative{id,url_tags}")


def targeting_spec(targeting: dict) -> dict:
    """Plan targeting -> Meta targeting object. Advantage+ placements = no
    publisher_platforms restriction; Advantage audience on."""
    geo: dict[str, list] = {}
    for g in targeting["geo"]:
        t = g["type"]
        if t == "city":
            item = {"key": g["key"]}
            if g.get("radius_miles"):
                item.update({"radius": int(g["radius_miles"]), "distance_unit": "mile"})
            geo.setdefault("cities", []).append(item)
        elif t == "region":
            geo.setdefault("regions", []).append({"key": g["key"]})
        elif t == "zip":
            geo.setdefault("zips", []).append({"key": g["key"]})
        elif t == "country":
            geo.setdefault("countries", []).append(g["key"])
        elif t == "neighborhood":
            geo.setdefault("neighborhoods", []).append({"key": g["key"]})
        elif t == "geo_market":
            geo.setdefault("geo_markets", []).append({"key": g["key"]})
        elif t == "county":
            geo.setdefault("regions", []).append({"key": g["key"]})  # counties map to region keys in the search API
    geo["location_types"] = ["home", "recent"]
    spec: dict[str, Any] = {
        "geo_locations": geo,
        "age_min": int(targeting.get("age_min", 25)),
        "age_max": int(targeting.get("age_max", 65)),
        "targeting_automation": {"advantage_audience": 1},
    }
    if targeting.get("genders"):
        spec["genders"] = targeting["genders"]
    return spec

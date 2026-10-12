"""Execute an APPROVED build: upload creatives, create campaign → ad sets →
creatives → ads, all PAUSED, read every object back, record the result.

Runs in Celery (sync). Idempotency: a build is executed at most once; on any
failure the objects already created are left in place (PAUSED) and listed in
created_objects so nothing is silently deleted — a person decides in Ads Manager.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime

from app.services import pg

from . import storage
from .meta_graph import GraphError, GraphWriter, targeting_spec

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _set(build_id: str, **cols) -> None:
    sets = ", ".join(f"{k} = %s" for k in cols)
    pg.execute(f"update campaign_builds set {sets} where id = %s", (*[json.dumps(v) if isinstance(v, (dict, list)) else v for v in cols.values()], build_id))


def _audit(build: dict, action: str, after: dict, actor_email: str | None) -> None:
    pg.execute(
        """
        insert into audit_log (actor_type, actor_id, actor_email, action, entity_type, entity_id, client_id, after, environment)
        values ('user', %s, %s, %s, 'campaign_build', %s, %s, %s::jsonb, %s)
        """,
        (build.get("approved_by_id"), actor_email, action, str(build["id"]), build["client_id"],
         json.dumps(after, default=str), "production"),
    )


def execute_build(build_id: str) -> dict:
    rows = pg.query(
        """
        select b.*, c.meta_ad_account_id, c.slug, c.name as client_name
        from campaign_builds b join clients c on c.id = b.client_id where b.id = %s
        """,
        (build_id,),
    )
    if not rows:
        raise RuntimeError(f"build {build_id} not found")
    build = rows[0]
    if build["status"] != "approved":
        return {"skipped": f"status is {build['status']}"}
    if not build.get("approved_by_id"):
        _set(build_id, status="failed", error="Refused: no approver recorded")
        return {"error": "no approver"}
    plan = build["plan"]
    ctx = build.get("account_context") or {}
    page_id = ctx.get("page_id")
    if not page_id:
        _set(build_id, status="failed", error="No Facebook Page id could be derived for this ad account")
        return {"error": "no page"}

    _set(build_id, status="creating", error=None)
    log: list[dict] = [{"at": _now(), "step": "start", "ok": True, "detail": f"plan v{build['plan_version']}"}]
    created: dict = {"campaign": None, "ad_sets": [], "ads": [], "creatives": [], "uploads": [], "log": log, "verified": False}
    writer = GraphWriter(build["meta_ad_account_id"], log=[])
    assets = {str(a["id"]): a for a in pg.query("select * from campaign_build_assets where build_id = %s", (build_id,))}

    def step(name: str, fn):
        try:
            out = fn()
            log.append({"at": _now(), "step": name, "ok": True, "detail": out if isinstance(out, str) else json.dumps(out, default=str)[:500]})
            return out
        except GraphError as e:
            log.append({"at": _now(), "step": name, "ok": False, "detail": f"{e} (code {e.code}/{e.subcode})", "response": e.payload})
            raise
        except Exception as e:  # noqa: BLE001
            log.append({"at": _now(), "step": name, "ok": False, "detail": f"{type(e).__name__}: {e}"})
            raise

    try:
        # 1. uploads (only assets referenced by the plan)
        needed = {ad["asset_id"] for s in plan["ad_sets"] for ad in s["ads"]}
        for aid in needed:
            a = assets.get(aid)
            if a is None:
                raise RuntimeError(f"asset {aid} missing")
            if a["kind"] == "image" and not a.get("meta_image_hash"):
                data = storage.download_sync(a["storage_path"])
                h = step(f"upload image {a['filename']}", lambda a=a, data=data: writer.upload_image(a["filename"], data, a["content_type"]))
                pg.execute("update campaign_build_assets set meta_image_hash = %s where id = %s", (h, aid))
                a["meta_image_hash"] = h
                created["uploads"].append({"asset_id": aid, "hash": h})
            elif a["kind"] == "video" and not a.get("meta_video_id"):
                data = storage.download_sync(a["storage_path"])
                vid = step(f"upload video {a['filename']}", lambda a=a, data=data: writer.upload_video(a["filename"], data, a["content_type"], plan["campaign"]["name"]))
                pg.execute("update campaign_build_assets set meta_video_id = %s where id = %s", (vid, aid))
                a["meta_video_id"] = vid
                created["uploads"].append({"asset_id": aid, "video_id": vid})
        # videos must finish processing before a creative can reference them
        for a in assets.values():
            if a["kind"] == "video" and a.get("meta_video_id") and a["id"] and str(a["id"]) in needed:
                for _ in range(40):
                    if writer.video_ready(a["meta_video_id"]):
                        break
                    time.sleep(15)
                a["thumbnail_url"] = writer.video_thumbnail(a["meta_video_id"])
        _set(build_id, created_objects=created)

        # 2. campaign (PAUSED)
        c = plan["campaign"]
        cid = step("create campaign", lambda: writer.create_campaign(c["name"], c["daily_budget_cents"], c["bid_strategy"], c.get("special_ad_categories") or [], c.get("start_date")))
        created["campaign"] = {"id": cid, "name": c["name"], "status": "PAUSED"}
        _set(build_id, created_objects=created)

        # 3. ad sets → creatives → ads
        for s in plan["ad_sets"]:
            pixel = (ctx.get("pixel_ids") or [None])[0]
            sid = step(f"create ad set {s['name']}", lambda s=s, pixel=pixel: writer.create_adset(
                cid, s["name"], s["destination"], page_id, s.get("lead_form_id"), pixel, targeting_spec(s["targeting"])))
            created["ad_sets"].append({"id": sid, "name": s["name"], "status": "PAUSED"})
            _set(build_id, created_objects=created)
            for ad in s["ads"]:
                a = assets[ad["asset_id"]]
                cr_name = f"{c['name']} | {s['name']} | {ad['name']}"
                crid = step(f"create creative {ad['name']}", lambda a=a, ad=ad, s=s, cr_name=cr_name: writer.create_creative(
                    cr_name, page_id, ctx.get("instagram_user_id"), a, ad, s["destination"], s.get("lead_form_id"),
                    s.get("landing_page_url"), plan["url_tags"]))
                created["creatives"].append({"id": crid, "name": cr_name})
                adid = step(f"create ad {ad['name']}", lambda sid=sid, ad=ad, crid=crid: writer.create_ad(sid, ad["name"], crid))
                created["ads"].append({"id": adid, "name": ad["name"], "status": "PAUSED", "adset_id": sid})
                _set(build_id, created_objects=created)

        # 4. read back — every object must be PAUSED
        problems = []
        rc = writer.read_campaign(cid)
        if rc.get("status") != "PAUSED":
            problems.append(f"campaign status {rc.get('status')}")
        created["campaign"]["read_back"] = rc
        for s_ in created["ad_sets"]:
            r = writer.read_adset(s_["id"])
            s_["read_back"] = {k: r.get(k) for k in ("status", "effective_status", "optimization_goal", "destination_type")}
            if r.get("status") != "PAUSED":
                problems.append(f"ad set {s_['name']} status {r.get('status')}")
        for a_ in created["ads"]:
            r = writer.read_ad(a_["id"])
            a_["read_back"] = {k: r.get(k) for k in ("status", "effective_status")}
            a_["url_tags"] = (r.get("creative") or {}).get("url_tags")
            if r.get("status") != "PAUSED":
                problems.append(f"ad {a_['name']} status {r.get('status')}")
        created["verified"] = not problems
        acct = build["meta_ad_account_id"].replace("act_", "")
        created["ads_manager_url"] = f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act={acct}&selected_campaign_ids={cid}"
        created["graph_log"] = writer.log[-50:]
        log.append({"at": _now(), "step": "verify", "ok": not problems, "detail": "all PAUSED" if not problems else "; ".join(problems)})
        _set(build_id, status="created", created_objects=created, error=None if not problems else "Read-back mismatch: " + "; ".join(problems))
        _audit(build, "campaign_build.created", {"campaign_id": cid, "ad_sets": len(created["ad_sets"]), "ads": len(created["ads"]), "verified": not problems}, build.get("approved_by_email"))
        # Mirror the plugin flow: one 'activate' recommendation per created campaign so the
        # Actions queue shows what is waiting for a human in Ads Manager.
        pg.execute(
            """
            insert into recommendations (client_id, entity_type, entity_id, entity_name, action, reason, evidence, risk, status)
            values (%s, 'campaign', %s, %s, 'activate', %s, %s::jsonb, 'Created PAUSED by the Campaign Builder; a person enables it in Ads Manager', 'proposed')
            """,
            (build["client_id"], cid, c["name"], f"Campaign built from build {build_id} (plan v{build['plan_version']}), approved by {build.get('approved_by_email')}",
             json.dumps({"build_id": str(build_id), "ad_sets": created["ad_sets"], "ads": [{k: v for k, v in a_.items() if k != 'read_back'} for a_ in created["ads"]]}, default=str)),
        )
        return {"ok": True, "campaign_id": cid}
    except Exception as e:  # noqa: BLE001
        logger.exception("build %s failed", build_id)
        created["graph_log"] = writer.log[-50:]
        _set(build_id, status="failed", created_objects=created, error=f"{type(e).__name__}: {e}"[:2000])
        _audit(build, "campaign_build.failed", {"error": str(e)[:500], "created_so_far": {k: created[k] for k in ("campaign", "ad_sets", "ads")}}, build.get("approved_by_email"))
        return {"ok": False, "error": str(e)}
    finally:
        writer.close()

"""Landing-page checks: fetch every URL that paid ads point at (Google final URLs,
Meta website ads) once a night and record what a visitor actually gets.

Catches the silent failures a metrics sync can't: a 404/500, a domain that now
serves a thank-you page (uspropaint.com, 2026-09-23), a redirect to the wrong
site, a page with no form or phone link. Stores one row per client × URL in
`landing_page_checks`; never writes anywhere else."""
from __future__ import annotations

import logging
import re
import time
from html import unescape

import httpx

from app.services import pg

logger = logging.getLogger(__name__)

MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
SKIP_HOSTS = ("fb.me", "facebook.com", "fb.com", "instagram.com", "wa.me", "whatsapp", "m.me")

URLS_SQL = """
with g as (
    select client_id, url, 'google' platform, sum(spend) spend
    from google_ad_metrics_daily, jsonb_array_elements_text(coalesce(final_urls, '[]'::jsonb)) url
    where date >= current_date - 30 group by 1, 2
),
m as (
    select m.client_id, cr.link_url url, 'meta' platform, sum(m.spend) spend
    from meta_ad_creatives cr
    join ad_level_metrics_daily m on m.ad_id = cr.ad_id and m.date >= current_date - 30
    where cr.link_url is not null group by 1, 2
),
u as (select * from g union all select * from m)
select u.client_id, u.url, array_agg(distinct u.platform) platforms, sum(u.spend) spend
from u join clients c on c.id = u.client_id and c.is_active
group by 1, 2 order by sum(u.spend) desc
"""

THANK_YOU_RE = re.compile(r"thank\s*you|request\s+received|is\s+booked|we'?ll\s+be\s+in\s+touch|confirmation", re.I)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.S | re.I)


def _text(fragment: str) -> str:
    return unescape(re.sub(r"<[^>]+>", " ", fragment)).strip()


def inspect(url: str, timeout: float = 20.0) -> dict:
    """Fetch one URL as a phone and describe it. Never raises."""
    out: dict = {"http_status": None, "final_url": None, "title": None, "bytes": None, "load_ms": None,
                 "has_form": None, "has_tel_link": None, "looks_thank_you": False, "client_rendered": False,
                 "flags": [], "error": None}
    t0 = time.time()
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout, headers={"User-Agent": MOBILE_UA}) as c:
            r = c.get(url)
    except Exception as exc:  # DNS, TLS, timeout …
        out["error"] = f"{type(exc).__name__}: {exc}"[:300]
        out["flags"].append("unreachable")
        return out
    out["load_ms"] = int((time.time() - t0) * 1000)
    out["http_status"] = r.status_code
    out["final_url"] = str(r.url)
    body = r.text or ""
    out["bytes"] = len(body)
    m = TITLE_RE.search(body)
    out["title"] = _text(m.group(1))[:200] if m else None
    if r.status_code >= 400:
        out["flags"].append(f"http {r.status_code}")
        return out
    lowered = body.lower()
    # Client-rendered shells (GHL funnels, Next/React apps) ship a few KB of HTML and
    # an iframe or script bundle; form/phone detection is meaningless there.
    out["client_rendered"] = len(body) < 8000 and ("<iframe" in lowered or "<script" in lowered) and "<form" not in lowered
    if not out["client_rendered"]:
        out["has_form"] = ("<form" in lowered) or ("full name" in lowered and "phone" in lowered)
        out["has_tel_link"] = 'href="tel:' in lowered or "href='tel:" in lowered
        if not out["has_form"]:
            out["flags"].append("no form found")
        if not out["has_tel_link"]:
            out["flags"].append("no tap-to-call link")
    h1s = " ".join(_text(h) for h in H1_RE.findall(body)[:3])
    head = f"{out['title'] or ''} {h1s}"
    if THANK_YOU_RE.search(head) or ("request received" in lowered and "thank you" in lowered and "<form" not in lowered):
        out["looks_thank_you"] = True
        out["flags"].append("reads like a thank-you / confirmation page")
    if out["load_ms"] and out["load_ms"] > 6000:
        out["flags"].append(f"slow ({out['load_ms'] / 1000:.1f}s)")
    if r.url.host and url.split("/")[2].replace("www.", "") != r.url.host.replace("www.", ""):
        out["flags"].append(f"redirects to {r.url.host}")
    return out


def _status(res: dict) -> str:
    if res["error"] or (res["http_status"] or 0) >= 400 or res["looks_thank_you"]:
        return "red"
    if res["flags"]:
        return "yellow"
    return "green"


def run_checks() -> dict:
    """Check every spending landing URL for every active client. Returns counts."""
    rows = pg.query(URLS_SQL)
    counts = {"checked": 0, "red": 0, "yellow": 0, "skipped": 0}
    seen: set[str] = set()
    cache: dict[str, dict] = {}
    for r in rows:
        url = (r["url"] or "").strip()
        if not url.startswith("http") or any(h in url for h in SKIP_HOSTS):
            counts["skipped"] += 1
            continue
        key = f"{r['client_id']}|{url}"
        if key in seen:
            continue
        seen.add(key)
        res = cache.get(url) or inspect(url)
        cache[url] = res
        status = _status(res)
        pg.execute(
            """insert into landing_page_checks
                   (client_id, url, platforms, spend_30d, http_status, final_url, title, bytes, load_ms, has_form,
                    has_tel_link, looks_thank_you, client_rendered, flags, status, error, checked_at)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
               on conflict (client_id, url) do update set
                   platforms = excluded.platforms, spend_30d = excluded.spend_30d, http_status = excluded.http_status,
                   final_url = excluded.final_url, title = excluded.title, bytes = excluded.bytes, load_ms = excluded.load_ms,
                   has_form = excluded.has_form, has_tel_link = excluded.has_tel_link,
                   looks_thank_you = excluded.looks_thank_you, client_rendered = excluded.client_rendered,
                   flags = excluded.flags, status = excluded.status, error = excluded.error, checked_at = now()""",
            (str(r["client_id"]), url, list(r["platforms"]), float(r["spend"] or 0), res["http_status"], res["final_url"],
             res["title"], res["bytes"], res["load_ms"], res["has_form"], res["has_tel_link"], res["looks_thank_you"],
             res["client_rendered"], res["flags"], status, res["error"]),
        )
        counts["checked"] += 1
        counts[status] = counts.get(status, 0) + 1
    # forget URLs that stopped receiving spend
    pg.execute("delete from landing_page_checks where checked_at < now() - interval '3 days'")
    return counts

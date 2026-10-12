"""Rules the model cannot override. Every plan passes through `validate_plan`
before it is stored, and again (with live account checks) before approval.

Mirrors plugins/meta-ads/CLAUDE.md and the Meta campaign-builder skill:
PAUSED only, Zeal UTM macro set, SOP name charset, unique names per account,
budget ceiling, Instant Form or website destination fully specified, every ad
tied to an uploaded asset, ad names by format+n.
"""
from __future__ import annotations

import re
from datetime import UTC, date, datetime
from urllib.parse import parse_qsl, urlsplit

from .schema import CTA_TYPES, Plan, Problem, Validation

REQUIRED_URL_TAGS = "utm_source=facebook&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.id}}"
REQUIRED_UTM = dict(parse_qsl(REQUIRED_URL_TAGS))

NAME_RE = re.compile(r"^[A-Za-z0-9 |\-]+$")
CAMPAIGN_NAME_RE = re.compile(r"^\d{1,2}-[A-Z][a-z]{2}-\d{2} \| .+")  # D-Mon-YY | Service
AD_NAME_RE = re.compile(r"^(Image|Video|Carousel) \d+$")

HARD_MAX_DAILY_CENTS = 5_000_00   # $5,000/day — nothing above this, ever
DEFAULT_MEDIA_BUYER_MAX_DAILY_CENTS = 500_00
STATUS = "PAUSED"


def _p(level: str, code: str, message: str, path: str | None = None) -> Problem:
    return Problem(level=level, code=code, message=message, path=path)


def check_url_tags(url_tags: str) -> list[Problem]:
    pairs = dict(parse_qsl((url_tags or "").lstrip("?&"), keep_blank_values=True))
    bad = [f"{k}={pairs.get(k, '<missing>')}" for k, v in REQUIRED_UTM.items() if pairs.get(k) != v]
    if bad:
        return [_p("error", "url_tags", f"url_tags must be exactly the Zeal macro set; wrong/missing: {', '.join(bad)}", "url_tags")]
    return []


def check_name(name: str, what: str, path: str) -> list[Problem]:
    out: list[Problem] = []
    if not name or not name.strip():
        out.append(_p("error", "name_empty", f"{what} name is empty", path))
        return out
    if not NAME_RE.match(name):
        out.append(_p("error", "name_charset", f"{what} name '{name}' has characters outside letters, numbers, spaces, hyphens, pipes", path))
    return out


def validate_plan(
    plan: Plan,
    *,
    asset_ids: set[str],
    existing_campaign_names: set[str] | None = None,
    existing_adset_names: set[str] | None = None,
    campaign_filter: str | None = None,
    known_lead_forms: set[str] | None = None,
    max_daily_cents_for_approver: int | None = None,
) -> Validation:
    problems: list[Problem] = []
    c = plan.campaign

    # --- campaign
    problems += check_name(c.name, "Campaign", "campaign.name")
    if not CAMPAIGN_NAME_RE.match(c.name):
        problems.append(_p("warning", "name_sop", "Campaign name should follow 'D-Mon-YY | Service' (e.g. '21-Sep-26 | Cabinet Painting')", "campaign.name"))
    if campaign_filter:
        token = campaign_filter.strip("%").lower()
        if token and token not in c.name.lower():
            problems.append(_p("error", "campaign_filter", f"Shared ad account: campaign name must contain '{token}' or the dashboard will not attribute it", "campaign.name"))
    if existing_campaign_names is not None and c.name.lower() in {n.lower() for n in existing_campaign_names}:
        problems.append(_p("error", "collision_campaign", f"A campaign named '{c.name}' already exists in this ad account", "campaign.name"))
    if c.daily_budget_cents > HARD_MAX_DAILY_CENTS:
        problems.append(_p("error", "budget_hard_cap", f"Daily budget {c.daily_budget_cents/100:.2f} exceeds the hard cap {HARD_MAX_DAILY_CENTS/100:.0f}/day", "campaign.daily_budget_cents"))
    if max_daily_cents_for_approver is not None and c.daily_budget_cents > max_daily_cents_for_approver:
        problems.append(_p("error", "budget_role_cap", f"Daily budget {c.daily_budget_cents/100:.2f} needs Agency Owner approval (your limit {max_daily_cents_for_approver/100:.0f}/day)", "campaign.daily_budget_cents"))
    if c.start_date:
        try:
            if date.fromisoformat(c.start_date) < date.today():
                problems.append(_p("warning", "start_date_past", "start_date is in the past; Meta will start immediately once enabled", "campaign.start_date"))
        except ValueError:
            problems.append(_p("error", "start_date", "start_date must be YYYY-MM-DD", "campaign.start_date"))

    # --- url tags
    problems += check_url_tags(plan.url_tags)

    # --- ad sets
    seen_adsets: set[str] = set()
    seen_ads: set[str] = set()
    existing_adsets_lc = {n.lower() for n in (existing_adset_names or set())}
    for i, s in enumerate(plan.ad_sets):
        path = f"ad_sets[{i}]"
        problems += check_name(s.name, "Ad set", f"{path}.name")
        if s.name.lower() in seen_adsets:
            problems.append(_p("error", "duplicate_adset", f"Ad set name '{s.name}' used twice in this plan", f"{path}.name"))
        seen_adsets.add(s.name.lower())
        if s.name.lower() in existing_adsets_lc:
            problems.append(_p("error", "collision_adset", f"An ad set named '{s.name}' already exists in this ad account (attribution key must be unique)", f"{path}.name"))
        if s.destination == "instant_form":
            if not s.lead_form_id:
                problems.append(_p("error", "lead_form_missing", "Instant Form destination needs lead_form_id", f"{path}.lead_form_id"))
            elif known_lead_forms is not None and known_lead_forms and s.lead_form_id not in known_lead_forms:
                problems.append(_p("warning", "lead_form_unknown", f"Lead form {s.lead_form_id} was not seen in this account's ads; confirm it belongs to the Page", f"{path}.lead_form_id"))
        else:
            u = s.landing_page_url or ""
            parts = urlsplit(u)
            if parts.scheme != "https" or not parts.netloc:
                problems.append(_p("error", "landing_page", "Website destination needs an https landing_page_url", f"{path}.landing_page_url"))
            if "utm_" in u.lower():
                problems.append(_p("error", "landing_page_utm", "Do not put UTMs in the landing page URL; url_tags carries them", f"{path}.landing_page_url"))
        if not s.targeting.geo:
            problems.append(_p("error", "geo_missing", "Ad set has no geo targeting", f"{path}.targeting.geo"))
        if s.targeting.age_min > s.targeting.age_max:
            problems.append(_p("error", "age_range", "age_min is greater than age_max", f"{path}.targeting"))
        for j, a in enumerate(s.ads):
            ap = f"{path}.ads[{j}]"
            problems += check_name(a.name, "Ad", f"{ap}.name")
            if not AD_NAME_RE.match(a.name):
                problems.append(_p("warning", "ad_name_sop", "Ad names follow '<Format> <n>' (Image 1, Video 2)", f"{ap}.name"))
            key = (s.name.lower(), a.name.lower())
            if key in seen_ads:
                problems.append(_p("error", "duplicate_ad", f"Ad name '{a.name}' used twice in ad set '{s.name}'", f"{ap}.name"))
            seen_ads.add(key)
            if a.asset_id not in asset_ids:
                problems.append(_p("error", "asset_missing", f"Ad '{a.name}' references asset {a.asset_id} which is not uploaded to this build", f"{ap}.asset_id"))
            if a.cta not in CTA_TYPES:
                problems.append(_p("error", "cta", f"cta must be one of {', '.join(CTA_TYPES)}", f"{ap}.cta"))
            if len(a.headline) > 40:
                problems.append(_p("warning", "headline_long", "Headlines over 40 characters get truncated in most placements", f"{ap}.headline"))
            if len(a.primary_text) > 125:
                problems.append(_p("warning", "primary_text_long", "Primary text over 125 characters is cut with 'See more' in feed", f"{ap}.primary_text"))

    ok = not any(p.level == "error" for p in problems)
    return Validation(ok=ok, problems=problems, checked_at=datetime.now(UTC).isoformat(timespec="seconds"))


def approver_max_daily_cents(role: str) -> int | None:
    """None = unlimited (admin). media_buyer capped; viewer cannot approve (0)."""
    if role == "admin":
        return None
    if role == "media_buyer":
        return DEFAULT_MEDIA_BUYER_MAX_DAILY_CENTS
    return 0

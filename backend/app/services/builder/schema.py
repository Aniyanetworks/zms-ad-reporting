"""Pydantic models for the builder's brief and plan. The plan is the ONLY thing the
model can propose; everything the executor sends to Meta is derived from it by code."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CTA_TYPES = (
    "LEARN_MORE", "GET_QUOTE", "SIGN_UP", "CONTACT_US", "BOOK_NOW", "GET_OFFER",
    "APPLY_NOW", "REQUEST_TIME", "SUBSCRIBE", "DOWNLOAD",
)
GEO_TYPES = ("city", "region", "zip", "country", "neighborhood", "geo_market", "county")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=5000)


class GeoTarget(Strict):
    key: str = Field(max_length=40)
    name: str = Field(max_length=200)
    type: str = Field(max_length=30)
    region: str | None = Field(default=None, max_length=100)
    country_code: str = Field(default="US", max_length=2)
    radius_miles: int | None = Field(default=None, ge=10, le=50)  # Meta: 10-50 mi for city radius


class Brief(Strict):
    service: str | None = Field(default=None, max_length=120)
    offer: str | None = Field(default=None, max_length=500)
    destination: Literal["instant_form", "website"] | None = None
    lead_form_id: str | None = Field(default=None, max_length=40, pattern=r"^\d*$")
    landing_page_url: str | None = Field(default=None, max_length=1000)
    daily_budget_cents: int | None = Field(default=None, ge=100, le=100_000_00)
    geo: list[GeoTarget] = Field(default_factory=list, max_length=50)
    age_min: int | None = Field(default=None, ge=18, le=65)
    age_max: int | None = Field(default=None, ge=18, le=65)
    launch_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    notes: str | None = Field(default=None, max_length=4000)
    audiences: list[str] = Field(default_factory=list, max_length=10)


class Targeting(Strict):
    geo: list[GeoTarget] = Field(min_length=1, max_length=50)
    age_min: int = Field(default=25, ge=18, le=65)
    age_max: int = Field(default=65, ge=18, le=65)
    genders: list[int] = Field(default_factory=list, max_length=2)  # [] = all, [1] men, [2] women


class PlanAd(Strict):
    name: str = Field(max_length=100)
    asset_id: str = Field(max_length=40)          # campaign_build_assets.id
    primary_text: str = Field(min_length=1, max_length=2000)
    headline: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=255)
    cta: str = Field(default="LEARN_MORE", max_length=30)


class PlanAdSet(Strict):
    name: str = Field(max_length=100)
    destination: Literal["instant_form", "website"] = "instant_form"
    lead_form_id: str | None = Field(default=None, max_length=40, pattern=r"^\d*$")
    landing_page_url: str | None = Field(default=None, max_length=1000)
    targeting: Targeting
    placements: Literal["advantage_plus"] = "advantage_plus"
    ads: list[PlanAd] = Field(min_length=1, max_length=10)


class PlanCampaign(Strict):
    name: str = Field(max_length=200)
    objective: Literal["OUTCOME_LEADS"] = "OUTCOME_LEADS"
    daily_budget_cents: int = Field(ge=100)
    bid_strategy: Literal["LOWEST_COST_WITHOUT_CAP"] = "LOWEST_COST_WITHOUT_CAP"
    special_ad_categories: list[Literal["HOUSING", "CREDIT", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES"]] = Field(
        default_factory=list
    )
    start_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class Plan(Strict):
    version: int = 1
    campaign: PlanCampaign
    ad_sets: list[PlanAdSet] = Field(min_length=1, max_length=10)
    url_tags: str = Field(max_length=500)
    notes: str | None = Field(default=None, max_length=4000)


class Problem(Strict):
    level: Literal["error", "warning"]
    code: str
    message: str
    path: str | None = None


class Validation(Strict):
    ok: bool
    problems: list[Problem]
    checked_at: str

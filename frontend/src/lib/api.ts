"use client";

import { createClient } from "@/lib/supabase/client";

/** The current Supabase access token, or null when signed out. Shared by
 * apiFetch, the SSE reader and the XHR uploader so every /api call carries
 * the same Authorization header. */
export async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/** Non-2xx response. `message` keeps the historical "<status>: <detail>" shape;
 * `detail` is the parsed JSON `detail` (string or object, e.g. a Validation on 422). */
export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(`${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Fetch from the FastAPI backend (proxied at /api) with the Supabase JWT attached. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();

  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    let detail: unknown = body;
    try {
      detail = JSON.parse(body).detail ?? body;
    } catch {}
    throw new ApiError(res.status, detail);
  }
  // 204 / empty bodies (e.g. DELETE) resolve to undefined instead of a JSON parse error.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- Types mirrored from the FastAPI responses ----------

/** admin = Agency Owner (everything); media_buyer = approve/dismiss within policy; viewer = read-only. */
export type Role = "admin" | "media_buyer" | "viewer";

/** Server-computed capabilities (mirrors backend policy; the server is authoritative). */
export interface MePermissions {
  /** admin + media_buyer may create builds and edit briefs/plans. */
  create_build: boolean;
  /** Max campaign daily budget (cents) this user may approve; null = unlimited (admin), 0 = none (viewer). */
  approve_build_max_daily_cents: number | null;
  [key: string]: boolean | number | null | undefined;
}

export interface Me {
  id: string | null;
  email: string | null;
  role: Role;
  full_name: string | null;
  permissions: MePermissions;
}

export interface Client {
  id: string;
  name: string;
  slug: string;
  meta_ad_account_id: string | null;
  meta_pixel_id?: string | null;
  google_ads_customer_id: string | null;
  google_lsa_customer_id: string | null;
  ghl_location_id: string | null;
  has_ghl_token: boolean;
  /** Unit economics → max profitable CPBA = job × close × margin × ad share. */
  avg_job_value: number | null;
  close_rate: number | null;
  gross_margin_pct: number | null;
  max_ad_cost_share: number | null;
  /** What Zeal earns per appointment the setters book for this client — drives the setter leaderboard goal. */
  setter_fee_per_appt: number | null;
  default_service: string | null;
  trade: string | null;
  booking_system: string;
  cpl_target_green: number;
  cpl_target_red: number;
  is_active: boolean;
  created_at: string;
}

export interface OverviewClient {
  id: string;
  name: string;
  slug: string;
  cpl_target_green: number;
  cpl_target_red: number;
  meta_spend: number;
  meta_leads: number;
  meta_cpl: number | null;
  google_spend: number;
  google_leads: number;
  google_cpl: number | null;
  lsa_spend: number;
  lsa_leads: number;
  lsa_cpl: number | null;
  total_spend: number;
  total_leads: number;
  blended_cpl: number | null;
  ghl_contacts_created: number;
  ghl_contacts_paid: number;
  ghl_inbound_calls: number;
  ghl_appointments: number;
  cost_per_appointment: number | null;
  lead_to_appt_rate: number | null;
  /** Most we may pay per booked appointment for this client to stay profitable; null until avg_job_value is set. */
  cpba_max: number | null;
  cpba_color: "green" | "yellow" | "red" | null;
  spark: number[];
  spark_meta: number[];
  spark_google: number[];
  spark_lsa: number[];
  /** Lead-weighted CPL thresholds from the client's service mix (service_targets); null → use cpl_target_*. */
  meta_target_green: number | null;
  meta_target_red: number | null;
  google_target_green: number | null;
  google_target_red: number | null;
  lsa_target_green: number | null;
  lsa_target_red: number | null;
  blended_target_green: number | null;
  blended_target_red: number | null;
}

export interface OverviewResponse {
  start: string;
  end: string;
  totals: {
    total_spend: number;
    total_leads: number;
    total_appointments: number;
    blended_cpl: number | null;
    cost_per_appointment: number | null;
  };
  clients: OverviewClient[];
}

export interface Campaign {
  platform: "meta" | "google" | "lsa";
  campaign_id: string;
  campaign_name: string | null;
  campaign_status: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  phone_calls: number;
  ctr: number | null;
  cpl: number | null;
  currency: string;
  /** GHL bookings for this campaign — tagged bookings plus a lead-share slice of untagged ones. */
  appointments: number;
  cost_per_appt: number | null;
  /** Service the campaign sells (from its name) and the portfolio-wide CPL for that service in range. */
  service: string | null;
  service_cpl: number | null;
  service_clients: number;
  /** CPL thresholds used for this campaign's score and where they came from. */
  target_cpl_green: number;
  target_cpl_red: number;
  target_source: "service" | "portfolio" | "client";
  /** ≤ target_cpl_green → green, ≤ target_cpl_red → yellow, else red; null under 3 leads. */
  score: "green" | "yellow" | "red" | null;
}

export interface ServiceTarget {
  service: string;
  platform: "all" | "meta" | "google" | "lsa";
  cpl_green: number | null;
  cpl_red: number | null;
  cpba_green: number | null;
  cpba_red: number | null;
  source: "seed" | "manual";
  updated_at: string;
  updated_by: string | null;
}

export interface ServiceTargetRow {
  service: string;
  platform: "meta" | "google" | "lsa" | "all";
  clients: number;
  spend: number;
  leads: number;
  appointments: number;
  cpl: number | null;
  cpba: number | null;
  target: ServiceTarget | null;
  fallback: ServiceTarget | null;
}

export interface AdsetRow {
  adset_id: string;
  adset_name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  phone_calls: number;
  ctr: number | null;
  cpl: number | null;
  currency: string;
  ghl_appointments: number;
  cost_per_appt: number | null;
}

export interface AdRow {
  ad_id: string;
  ad_name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  phone_calls: number;
  ctr: number | null;
  cpl: number | null;
  currency: string;
  preview_link: string | null;
  thumbnail_url: string | null;
}

export interface TopAd extends AdRow {
  platform: "meta" | "google" | "lsa";
  campaign_id: string;
}

export type CreativeGrade = "winner" | "ok" | "underperforming" | "learning";
export type CreativeTrend = "improving" | "stable" | "fatiguing" | null;

export interface Creative extends AdRow {
  platform: "meta" | "google" | "lsa";
  campaign_name: string | null;
  last_active: string | null;
  grade: CreativeGrade;
  trend: CreativeTrend;
}

export interface PeriodRow {
  period: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  phone_calls: number;
  ghl_contacts: number;
  ghl_paid: number;
  ghl_calls: number;
  appointments: number;
  jobs_won: number;
  revenue_won: number;
  ctr: number | null;
  cpl: number | null;
  cost_per_appt: number | null;
  roas: number | null;
}

export interface PeriodsResponse {
  client: { id: string; name: string; slug: string; cpl_target_green: number; cpl_target_red: number };
  granularity: "daily" | "weekly" | "monthly";
  periods: PeriodRow[];
}

export interface TrendPoint {
  date: string;
  meta_spend: number;
  google_spend: number;
  meta_leads: number;
  google_leads: number;
  spend: number;
  leads: number;
}

export interface ClientDetailResponse {
  client: {
    id: string;
    name: string;
    slug: string;
    cpl_target_green: number;
    cpl_target_red: number;
  };
  campaigns: Campaign[];
  trend: TrendPoint[];
  ghl: {
    contacts_created: number;
    contacts_paid_attributed: number;
    inbound_calls: number;
    appointments_booked: number;
  } | null;
}

export type RecStatus = "proposed" | "approved" | "executed" | "dismissed" | "failed";

export interface Recommendation {
  id: number;
  client_id: string;
  triage_run_id: number | null;
  created_at: string;
  entity_type: "campaign" | "adset" | "ad" | "account";
  entity_id: string | null;
  entity_name: string | null;
  action: "budget_change" | "pause" | "activate" | "refresh_creative" | "fix_signal" | "investigate" | "fix_utm" | "create_pixel" | "fix_tracking";
  current_value: string | null;
  proposed_value: string | null;
  pct_change: number | null;
  reason: string;
  evidence: Record<string, unknown> | null;
  risk: string | null;
  rollback_value: string | null;
  status: RecStatus;
  approved_by: string | null;
  executed_by: string | null;
  executed_at: string | null;
  verification: Record<string, unknown> | null;
  window_start: string | null;
  window_end: string | null;
  run_score: "green" | "yellow" | "red" | null;
}

export interface Scorecard {
  client_id: string;
  slug: string;
  name: string;
  trade: string | null;
  booking_system: string;
  target_cpl: number | null;
  target_cpba: number | null;
  avg_job_value: number | null;
  run_at: string | null;
  window_start: string | null;
  window_end: string | null;
  spend: number | null;
  leads: number | null;
  appointments_ghl: number | null;
  appointments_meta_reported: number | null;
  divergence_ratio: number | null;
  cpl: number | null;
  cpba: number | null;
  lead_to_appt_rate: number | null;
  score: "green" | "yellow" | "red" | null;
  cpl_p25: number | null;
  cpl_median: number | null;
  cpl_p75: number | null;
  cpl_bench_source: "internal" | "industry" | null;
  cpba_p25: number | null;
  cpba_median: number | null;
  cpba_p75: number | null;
  cpba_bench_source: "internal" | "industry" | null;
  open_recs?: number;
  cpba_vs_median?: number | null;
  cpl_vs_median?: number | null;
  cpba_max?: number | null;
  cpba_color?: "green" | "yellow" | "red" | null;
  /** "triage" when numbers come from the latest weekly triage run, "live_30d" when computed from the last 30 days. */
  metrics_source?: "triage" | "live_30d";
}

export interface ServiceClientRow {
  slug: string;
  name: string;
  campaigns: number;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  appointments: number;
  ctr: number | null;
  cpc: number | null;
  cpl: number | null;
  cpba: number | null;
  lead_to_appt_rate: number | null;
}

export interface ServiceRow {
  service: string;
  /** Services are reported per platform — Meta and Google are never blended into one CPL. */
  platform: "meta" | "google" | "lsa";
  clients: number;
  campaigns: number;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  appointments: number;
  ctr: number | null;
  cpc: number | null;
  cpl: number | null;
  cpba: number | null;
  lead_to_appt_rate: number | null;
  rows: ServiceClientRow[];
}

export interface ServicesResponse {
  start: string;
  end: string;
  totals: {
    platforms: {
      platform: "meta" | "google" | "lsa";
      services: number;
      spend: number;
      leads: number;
      appointments: number;
      cpl: number | null;
      cpba: number | null;
    }[];
    services: number;
    spend: number;
    leads: number;
    appointments: number;
    /** Bookings with no ad-set tag; allocated to services by lead share. */
    appointments_unattributed: number;
    cpl: number | null;
    cpba: number | null;
    lead_to_appt_rate: number | null;
  };
  services: ServiceRow[];
}

export interface SyncRun {
  id: number;
  source: "meta" | "google" | "ghl";
  client_id: string | null;
  client_name: string | null;
  client_slug: string | null;
  status: string;
  rows_upserted: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface SyncStatusResponse {
  last_per_source: {
    source: string;
    status: string;
    started_at: string | null;
    finished_at: string | null;
  }[];
  latest_runs: SyncRun[];
}

export interface LeaderboardSetter {
  rank: number;
  name: string;
  /** false = former setter shown only because they have data in this month */
  active: boolean;
  booked: number;
  shows: number;
  no_shows: number;
  pending: number;
  cancelled: number;
  show_up_rate: number | null;
  new_leads: number;
  appts_set: number;
  booking_ratio: number | null;
  /** Σ of the sheet's Commission column for the month */
  earned: number;
  /** Money made for Zeal: Σ client fee per appointment over booked, non-cancelled appointments */
  revenue: number;
  revenue_confirmed: number;
  rows_using_default: number;
}

export interface LeaderboardTeam {
  booked: number;
  shows: number;
  no_shows: number;
  pending: number;
  cancelled: number;
  earned: number;
  revenue: number;
  revenue_confirmed: number;
  new_leads: number;
  appts_set: number;
  show_up_rate: number | null;
  booking_ratio: number | null;
  /** 0 = no goal set yet */
  goal: number;
  goal_progress: number | null;
  /** fraction of the month elapsed (1 for past months) — the pace marker */
  month_elapsed: number;
}

export interface LeaderboardResponse {
  month: string; // YYYY-MM
  is_current: boolean;
  months: string[]; // months with any activity, newest first (includes current)
  /** false before Sept 2026 — the commission tracker has no rows, so booked/show-up are unknown */
  booked_available: boolean;
  last_updated: string | null;
  sync_status: "success" | "partial" | "error" | "running" | null;
  /** rows_using_default = booked appointments whose client has no Zeal fee set (they count at `default`, 0 until set) */
  fee: { default: number; rows_using_default: number; rows_total: number };
  team: LeaderboardTeam;
  setters: LeaderboardSetter[];
}

export interface BriefFinding {
  severity: "red" | "yellow" | "info";
  kind: string;
  message: string;
  entity_type: "account" | "campaign" | "adset" | "ad";
  entity_id: string | null;
  entity_name: string | null;
  action: Recommendation["action"] | null;
  proposed_value: string | null;
  pct_change: number | null;
  risk: string | null;
  evidence: Record<string, unknown>;
  /** "proposed" = a new recommendation was written; "already open" = one existed. */
  recommendation: "proposed" | "already open" | null;
  /** Kill/Scale SOP verdict fields — present when kind === "sop_verdict". */
  verdict?: "fix" | "kill" | "kill_or_rebuild" | "quality_fail" | "diagnose" | "scale" | "micro_scale" | "hold" | "no_verdict";
  gate?: string;
  layer?: string | null;
  decision?: { decision: string; evidence: string; confidence: "high" | "medium" | "low"; expected_impact: string; next_step: string };
}

export interface BriefPlatform {
  platform: "meta" | "google" | "lsa";
  spend_a: number;
  leads_a: number;
  spend_b: number;
  leads_b: number;
  cpl_a: number | null;
  cpl_b: number | null;
  expected_green: number;
  expected_red: number;
  spend_delta_pct: number | null;
  leads_delta_pct: number | null;
}

export interface BriefTotals {
  spend_a: number;
  spend_b: number;
  leads_a: number;
  leads_b: number;
  cpl_a: number | null;
  cpl_b: number | null;
  expected_green: number;
  expected_red: number;
  appts_a: number;
  appts_b: number;
  appts_all_a: number;
  cpba_a: number | null;
  expected_cpba_green: number | null;
  expected_cpba_red: number | null;
  cpba_max: number | null;
}

export interface ClientBrief {
  id: number;
  client_id: string;
  slug: string;
  name: string;
  booking_system: string;
  brief_date: string;
  window_start: string;
  window_end: string;
  score: "green" | "yellow" | "red" | null;
  summary_md: string;
  platforms: { platforms: BriefPlatform[]; totals: BriefTotals; campaigns: unknown[] };
  findings: BriefFinding[];
  triage_run_id: number | null;
}

export interface BriefResponse {
  date: string | null;
  clients: ClientBrief[];
}

// ---------- Campaign Builder ----------

export type BuildStatus =
  | "draft"
  | "planned"
  | "approved"
  | "creating"
  | "created"
  | "failed"
  | "cancelled";

export type BuildPlatform = "meta" | "google";
export type BuildDestination = "instant_form" | "website";

export interface GeoTarget {
  key: string;
  name: string;
  type: "city" | "region" | "zip" | "country" | "neighborhood";
  region?: string;
  country_code: string;
  radius_miles?: number;
}

/** What the media buyer tells the builder; every field optional and merged server-side by PATCH. */
export interface Brief {
  service?: string;
  offer?: string;
  destination?: BuildDestination;
  lead_form_id?: string;
  landing_page_url?: string;
  daily_budget_cents?: number;
  geo?: GeoTarget[];
  age_min?: number;
  age_max?: number;
  /** YYYY-MM-DD */
  launch_date?: string;
  notes?: string;
  audiences?: string[];
}

export interface LeadFormRef {
  id: string;
  name?: string;
  seen_in_ads: number;
}

export interface AccountContext {
  ad_account_id: string;
  currency: string;
  timezone: string;
  page_id: string;
  page_name?: string;
  instagram_user_id?: string;
  lead_forms: LeadFormRef[];
  pixel_ids: string[];
  existing_campaign_names: string[];
}

export interface Asset {
  id: string;
  kind: "image" | "video";
  filename: string;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  /** Signed URL, valid ~1 h. */
  url: string;
  meta_image_hash: string | null;
  meta_video_id: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string | null;
  tool_name?: string;
  tool_status?: "ok" | "error";
  plan_version?: number;
  created_at: string;
}

export interface PlanAd {
  name: string;
  asset_id: string;
  primary_text: string;
  headline: string;
  description?: string;
  cta: string;
}

export interface PlanAdSet {
  name: string;
  destination: BuildDestination;
  lead_form_id?: string;
  landing_page_url?: string;
  targeting: {
    geo: GeoTarget[];
    age_min: number;
    age_max: number;
    genders: number[];
  };
  placements: "advantage_plus";
  ads: PlanAd[];
}

export interface Plan {
  version: number;
  campaign: {
    name: string;
    objective: "OUTCOME_LEADS";
    daily_budget_cents: number;
    bid_strategy: string;
    special_ad_categories: string[];
    start_date?: string;
  };
  ad_sets: PlanAdSet[];
  url_tags: string;
  notes?: string;
}

export interface ValidationProblem {
  level: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface Validation {
  ok: boolean;
  problems: ValidationProblem[];
  checked_at: string;
}

export interface CreatedObjects {
  campaign: { id: string; name: string; status: string };
  ad_sets: { id: string; name: string; status: string }[];
  ads: { id: string; name: string; status: string; adset_id: string }[];
  creatives: { id: string; name: string }[];
  uploads: { asset_id: string; hash?: string; video_id?: string }[];
  ads_manager_url: string;
  verified: boolean;
  log: { at: string; step: string; ok: boolean; detail?: string }[];
}

export interface Build {
  id: string;
  client_id: string;
  client_slug: string;
  client_name: string;
  platform: BuildPlatform;
  title: string | null;
  status: BuildStatus;
  brief: Brief;
  plan: Plan | null;
  plan_version: number;
  validation: Validation | null;
  account_context: AccountContext | null;
  created_objects: CreatedObjects | null;
  error: string | null;
  created_by_email: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  assets: Asset[];
}

/** 202 from POST /api/builds/{id}/approve — creation runs in the background. */
export interface ApproveResponse {
  task_id: string;
  build: Build;
}

export type HealthStatus = "green" | "yellow" | "red" | "grey";

export interface IntegrationCheckDef {
  key: string;
  label: string;
  group: "ads" | "ghl";
}

export interface IntegrationClient {
  client_id: string;
  slug: string;
  name: string;
  booking_system: string;
  overall: HealthStatus;
  checks: Record<string, { status: HealthStatus; detail: string | null }>;
}

export interface IntegrationsResponse {
  checked_at: string | null;
  checks: IntegrationCheckDef[];
  clients: IntegrationClient[];
}

// ---------- Google Ads decision report (/api/clients/{slug}/google-ads) ----------

export interface GoogleAdsFlag {
  level: "red" | "yellow" | "info";
  text: string;
}

export interface GoogleAdGroupRow {
  campaign_id: string;
  ad_group_id: string;
  ad_group_name: string | null;
  status: string | null;
  type: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  phone_calls: number;
  ctr: number | null;
  cpc: number | null;
  cost_per_conv: number | null;
}

export interface GoogleAdRow {
  campaign_id: string;
  ad_group_id: string;
  ad_group_name: string | null;
  ad_id: string;
  ad_type: string | null;
  status: string | null;
  ad_strength: string | null;
  final_urls: string[] | null;
  headlines: { text: string; pinned_field: string | null }[] | null;
  descriptions: { text: string; pinned_field: string | null }[] | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cost_per_conv: number | null;
}

export interface GoogleKeywordRow {
  campaign_id: string;
  ad_group_id: string;
  criterion_id: string;
  keyword_text: string | null;
  match_type: string | null;
  status: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cost_per_conv: number | null;
}

export interface GoogleSearchTermRow {
  campaign_id: string;
  search_term: string;
  /** ADDED = already a keyword, EXCLUDED = already a negative, NONE = neither. */
  term_status: "ADDED" | "EXCLUDED" | "NONE" | string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number | null;
  cost_per_conv: number | null;
  flag: "converting" | "off-intent" | "unmanaged, no conv" | "not a keyword" | null;
}

export interface LandingPageCheck {
  url: string;
  platforms: string[];
  spend_30d: number;
  http_status: number | null;
  final_url: string | null;
  title: string | null;
  has_form: boolean | null;
  has_tel_link: boolean | null;
  looks_thank_you: boolean;
  client_rendered: boolean;
  flags: string[];
  status: "green" | "yellow" | "red";
  error: string | null;
  checked_at: string | null;
}

export interface GoogleAdsCampaign {
  campaign_id: string;
  campaign_name: string | null;
  campaign_status: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  phone_calls: number;
  ctr: number | null;
  cpc: number | null;
  cost_per_conv: number | null;
  spend_7d: number;
  conv_7d: number;
  daily_budget: number | null;
  lifetime_budget: number | null;
  ad_groups: GoogleAdGroupRow[];
  ads: GoogleAdRow[];
  keywords: GoogleKeywordRow[];
  keyword_count: number;
  match_mix: { EXACT: number; PHRASE: number; BROAD: number };
  search_terms: GoogleSearchTermRow[];
  converting_terms: GoogleSearchTermRow[];
  term_stats: { terms: number; spend: number; unmanaged_spend: number; off_intent_spend: number; zero_conv_spend: number; converting_spend: number };
  landing_pages: LandingPageCheck[];
  flags: GoogleAdsFlag[];
}

export interface GoogleAdsReport {
  client: { name: string; slug: string; customer_id: string | null; cpl_target_green: number; cpl_target_red: number };
  range: { start: string; end: string };
  totals: {
    spend: number; clicks: number; conversions: number; phone_calls: number;
    term_spend: number; unmanaged_spend: number; off_intent_spend: number;
    match_mix: { EXACT: number; PHRASE: number; BROAD: number };
    red_flags: number; yellow_flags: number;
  };
  campaigns: GoogleAdsCampaign[];
  landing_pages: LandingPageCheck[];
}

// ---------- Funnel report (/api/clients/{slug}/funnel) ----------

export interface FunnelSignal {
  level: "red" | "yellow" | "green";
  metric: string;
  text: string;
}

export interface FunnelAdMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  phone_calls: number;
  cpl: number | null;
  unique_clicks: number;
  unique_click_kind: "outbound" | "link" | null;
  cost_per_unique_click: number | null;
  unique_ctr: number | null;
  ctr: number | null;
  cpc: number | null;
  reach: number;
  frequency: number | null;
  cpm: number | null;
  cpmr: number | null;
  video_3s_plays: number;
  thruplays: number;
  /** impressions of ad-days that had 3-second plays — the hook-rate denominator */
  video_impressions: number;
  hook_rate: number | null;
  hold_rate: number | null;
  signals: FunnelSignal[];
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  pct_of_prev: number | null;
  cost_per: number | null;
  /** false when the client's GHL never records this stage (e.g. setters don't mark showed / no-show). */
  tracked: boolean;
  estimate?: boolean;
}

export interface FunnelOffline {
  contacts: number;
  contacts_paid: number;
  junk: number;
  inbound_calls: number;
  booked_all: number;
  noshow: number;
  noshow_rate: number | null;
  junk_all: number;
  tracked: { confirmed: boolean; showed: boolean; won: boolean };
  stages: FunnelStage[];
  cac: number | null;
  revenue: number;
  roas: number | null;
  expected_revenue: number | null;
  bottleneck: string | null;
}

export interface FunnelBudget {
  /** effective status from the platform (ACTIVE / PAUSED / ENABLED …) */
  delivery: string | null;
  daily_budget: number | null;
  lifetime_budget: number | null;
  /** 'campaign' = CBO / Google campaign budget, 'adset' = ABO */
  budget_source: "campaign" | "adset" | null;
}

export interface FunnelCampaignRow extends FunnelAdMetrics, FunnelBudget {
  platform: "meta" | "google" | "lsa";
  campaign_id: string;
  campaign_name: string | null;
  campaign_status: string | null;
  service: string | null;
  adset_id?: undefined;
  adset_name?: undefined;
  booked: number;
  booked_rate: number | null;
  cost_per_booked: number | null;
}

export interface FunnelAdsetRow extends FunnelAdMetrics, FunnelBudget {
  platform?: undefined;
  campaign_id: string;
  campaign_name?: undefined;
  service?: undefined;
  adset_id: string;
  adset_name: string | null;
  ghl_contacts: number;
  booked: number;
  booked_rate: number | null;
  cost_per_booked: number | null;
}

export interface FunnelReport {
  client: { name: string; slug: string; booking_system: string | null; cpl_target_green: number; cpl_target_red: number };
  range: { start: string; end: string };
  benchmarks: { ctr_red: number; ctr_yellow: number; cpc_yellow: number; hook_good: number; hook_great: number; hold_good: number; hold_great: number; frequency_watch: number };
  totals: FunnelAdMetrics & { funnel: FunnelOffline; daily_budget: number | null; delivery: null };
  platforms: Record<string, FunnelAdMetrics>;
  campaigns: FunnelCampaignRow[];
  adsets: FunnelAdsetRow[];
}

// ---------- Today board / plays / creative health (/api/today, /api/clients/{slug}/plays, /creative-health) ----------

export type PlaySeverity = "red" | "yellow" | "green" | "info";
export type ClientStatus = "red" | "yellow" | "green" | "grey";

export interface PlayIssue {
  play: string;
  icon: string;
  label: string;
  sev: PlaySeverity;
  campaign: string | null;
  text: string;
  next: string | null;
  /** ad or ad-set name when the play is about one ad / ad set inside the campaign */
  where?: string | null;
  where_type?: "ad" | "adset" | "campaign" | null;
  /** creative advice — never changes the client's status */
  advice?: boolean;
}

export interface TodayCard {
  slug: string;
  name: string;
  status: ClientStatus;
  url: string;
  tracks_bookings: boolean;
  target_cpba: number | null;
  leads: { y: number; d7: number; d30: number; delta7: number | null };
  booked: { y: number; d7: number; d30: number; delta7: number | null } | null;
  spend: { y: number; d7: number; d30: number };
  cpl7: number | null;
  cpba7: number | null;
  issues: PlayIssue[];
  spend30: number;
}

export interface TodayResponse {
  date: string;
  brief_date: string | null;
  counts: Record<ClientStatus, number>;
  totals: { spend: { y: number; d7: number; d30: number }; leads: { y: number; d7: number; d30: number }; booked: { y: number; d7: number; d30: number } };
  top_actions: (PlayIssue & { client: string; slug: string })[];
  wins: (PlayIssue & { client: string; slug: string })[];
  clients: TodayCard[];
  legend: string;
}

export interface ClientPlaysResponse {
  date: string;
  brief_date: string | null;
  legend: string;
  card: TodayCard | null;
}

export interface CreativeAdRow {
  ad_id: string;
  ad_name: string | null;
  campaign: string | null;
  adset: string | null;
  format: "video" | "image";
  destination: "instant form" | "website";
  plays: string[];
  spend: number;
  imps: number;
  leads: number;
  unique_clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpl: number | null;
  hook: number | null;
  hold: number | null;
  form_through: number | null;
  lpv_ratio: number | null;
  page_cvr: number | null;
  freq: number | null;
  freq_prev: number | null;
  cpmr: number | null;
  cpmr_prev: number | null;
  cpl_prev: number | null;
}

export interface CreativeHealthResponse {
  end: string;
  window_days: number;
  ft_median: number | null;
  ads: CreativeAdRow[];
  signals: { play: string; label: string; severity: PlaySeverity; entity_type: string; entity_name: string; campaign: string | null; text: string; next_step: string }[];
  benchmarks: { hook_low: number; hook_border: number; hold_low: number; hold_high: number; ctr_low: number; cpc_warn: number; lpv_low: number; ft_low: number };
}

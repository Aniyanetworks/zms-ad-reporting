# AI analysis data (creatives, ad sets, ads, Google granular)

Carl, 2026-09-23: *"collect metrics for creatives and ad sets and everything — maybe
not for the report, but so I can give it to AI to analyze."*

## What is collected nightly

| Level | Meta | Google (regular accounts) | Where |
|---|---|---|---|
| Campaign | spend, impressions, clicks, CTR, all `actions` (raw) | spend, impressions, clicks, conversions, phone calls | `ad_metrics_daily` (dashboard numbers) |
| Ad set / ad group | same, per ad set | spend, impressions, clicks, conversions, phone calls, status, type | `adset_metrics_daily`, `google_adgroup_metrics_daily` |
| Ad | same, per ad | RSA **headlines + descriptions**, final URLs, ad strength, status | `ad_level_metrics_daily`, `google_ad_metrics_daily` |
| Creative copy | headline (`title`), primary text (`body`), `description`, CTA, image/video ids, preview link, thumbnail, link URL + UTM check, full `object_story_spec` / `asset_feed_spec` (dynamic-creative variants) | — | `meta_ad_creatives` |
| Keywords | — | text, match type, status, daily metrics | `google_keyword_metrics_daily` |
| Search terms | — | what people typed, whether it is already a keyword/negative (`term_status`) | `google_search_terms_daily` |
| Bookings | GHL paid-attributed + all appointments, won jobs/revenue, per ad set | | `ghl_metrics_daily`, `ghl_adset_daily` |

Local Services (LSA) accounts have no ad groups/keywords; only campaign level exists for them.
Not collected: Meta targeting/audiences, placement and demographic breakdowns (pulled ad hoc
for the placement review), Meta video-view/thruplay metrics, Google quality score.

## Getting it to an AI

* **Client page → "AI data (JSON)"** (next to the date picker) downloads one file for the
  selected range: client economics + service targets, campaigns (with daily series), Meta
  ad sets and ads with creative copy, Google ad groups / ads / keywords / search terms,
  GHL daily bookings, latest Daily Brief and open recommendations. Drop it into Claude/ChatGPT
  with the question you want answered.
* API: `GET /api/clients/{slug}/ai-bundle?start=YYYY-MM-DD&end=YYYY-MM-DD[&daily=false][&download=true]`
  and `GET /api/export/ai-bundle?start&end` for every active client (daily series off by default).
  Same Supabase JWT as the dashboard.
* Claude Code plugin: the `plugin_reader` role can SELECT the new `google_*` tables directly.

## Pipeline

* `meta.sync_ad_creatives` (runs inside every Meta sync) now requests
  `creative{title,body,object_story_spec,asset_feed_spec,image_url,video_id,call_to_action_type}`.
* `google.sync_granular` runs after `merge_google` in `sync_google_client` for non-LSA accounts;
  each of the four GAQL reports is independent (one failing never blocks the others or the
  campaign sync). Rows with zero impressions are skipped; search terms are unfiltered.
* Migration `20260923000020_ai_analysis_data.sql`.

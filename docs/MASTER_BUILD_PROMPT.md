# ZMS Ads Intelligence — Master Build Prompt

*One prompt that captures everything Carl asked for between 2026-08-19 and 2026-09-23: the
Phase 1 dashboard spec, the zeal-paid-ads operator plugin spec, and every follow-up request
made in chat. Paste it into a fresh Claude Code session to rebuild the whole system; the two
verbatim originals are in `ORIGINAL_BUILD_SPEC.md` and `ORIGINAL_PLUGIN_SPEC.md`.*

---

## Context

I run Zeal Media Solutions, a paid-ads agency for ~20 home-services contractors (painting,
decks, roofing, flooring, remodeling, tree service, plumbing, enclosures, roof cleaning).
Build me a multi-client **paid ads intelligence dashboard** plus a **Claude Code operator
plugin** so my media buyer and I can see, judge and act on every client's Meta Ads, Google
Ads, Local Services Ads and GoHighLevel (GHL) booking data in one place, and eventually let an
AI operator review campaigns and propose changes with guardrails.

Stack (mirror my existing SEO dashboard): Next.js App Router + Tailwind + shadcn/ui, dark
mode default; FastAPI (Python 3.11+); Celery + Redis for scheduled syncs; Supabase Postgres +
Supabase Auth; Docker on a Mac mini behind a Cloudflare Tunnel. Hosting evolved to
**Mac mini (API/worker) + GitHub (repo, Actions) + Supabase (DB/auth) + Netlify (frontend)**
so a team can build on it. Primary domain: `ads.contractorscalingblueprint.com`, API at
`api-ads.contractorscalingblueprint.com`.

## 1. Data sources and sync

* **Meta Ads** (system-user token; partner-shared accounts are read by `act_` id even when
  they don't enumerate): campaign, ad set and ad level daily insights (spend, impressions,
  clicks, CTR, all `actions`), plus creative metadata for every ad: preview link, thumbnail,
  link URL, url_tags, UTM check, and the creative copy (headline, primary text, description,
  CTA, image/video ids, full `object_story_spec` / `asset_feed_spec`). Rolling 28-day
  re-sync; backfills in 60-day chunks (Meta zeroes spend on very long windows).
* **Google Ads** (OAuth under the ZMS MCC): campaign daily metrics (spend, impressions,
  clicks, conversions, phone calls), and below campaign level: ad groups, ads with RSA
  headlines/descriptions, keywords, search terms. **Google Ads and LSA are separate
  platforms**: `LocalServicesCampaign:*` campaigns, or a client's dedicated LSA customer id,
  file under platform `lsa`.
* **GoHighLevel**: one read-only location-level Private Integration token per client
  (contacts, opportunities, calendars, conversations, locations — read only). Pull contacts
  created, paid-attributed contacts, inbound calls, DQ leads, appointments, won jobs and
  revenue. **Appointments must count only bookings whose contact came from paid Meta or
  Google traffic** (session source Paid Social/Search, ad/campaign ids, gclid/fbclid, paid
  utm_medium); keep the stage total separately as `appointments_all`. GHL's `utmMedium`
  carries the ad set name — roll appointments up by ad set.
* **Booking sheets**: clients whose setters track bookings in a Google Sheet
  (e.g. Paradise Decks) get a nightly sheet parse into the same GHL daily table
  (`booking_system = 'sheet'`); the GHL sync must not overwrite them.
* **Setter sheets**: mirror the two appointment-setter Google Sheets every 60 s for a public,
  view-only setter leaderboard (`setter.contractorscalingblueprint.com`).
* **Schedule (Pacific)**: Meta 1:00 AM (+6:00 second pass), Google/LSA 1:15, GHL 1:30, booking
  sheets 1:45, Google Sheets export 2:00, integration health 2:05, Daily Brief 2:15. Fan out
  one Celery task per client so one huge account can't time out the rest; mark hung runs.

## 2. Data model (Supabase)

`clients` (name, slug, meta_ad_account_id, google_ads_customer_id, google_lsa_customer_id,
ghl_location_id, is_active, trade, default_service, booking_system + sheet id/gid,
meta_campaign_filter, CPL targets, economics: avg_job_value, close_rate, gross_margin_pct,
max_ad_cost_share, meta_pixel_id); `client_secrets` (GHL token, service-role only);
`ad_metrics_daily` (client × platform × campaign × day, with settled-lead snapshots t1/t3/t7
and raw jsonb); `adset_metrics_daily`, `ad_level_metrics_daily`; `meta_ad_creatives`;
`google_adgroup_metrics_daily`, `google_ad_metrics_daily`, `google_keyword_metrics_daily`,
`google_search_terms_daily`; `ghl_metrics_daily`, `ghl_adset_daily`; `campaign_service_map`;
`service_targets` (service × platform CPL/CPBA green-red); `daily_briefs`, `triage_runs`,
`recommendations`; `integration_health`; `sync_runs`; `benchmarks`; setter tables;
campaign builds; audit log. Raw API rows land in `raw_meta` / `raw_google` (dlt) and are
merged into the public tables. RLS on everything; a `plugin_reader` role can SELECT the
reporting surface only (never secrets or raw schemas). Roles: admin, media_buyer, viewer.

## 3. Dashboard pages

* **Overview**: every client for a date range with spend, leads, CPL, appointments, cost per
  booked appointment, revenue/ROAS. A **platform switch — All / Meta / Google / LSA** — and a
  **spend filter** that hides clients not spending. Colors come from per-service, per-platform
  targets (green/red), blended by the client's spend mix, and a CPBA ceiling derived from
  economics: `max_cpba = avg_job_value × close_rate × gross_margin × max_ad_cost_share`.
* **Client detail**: KPIs, trend chart, campaign table with a Service column and score dots,
  ad set → ad drill-down with appointments per ad set, creative board (winners/underperformers
  with preview links), separate Meta / Google / LSA tables, period table, actions queue, a
  signal-divergence warning, and an **"AI data (JSON)" download** of everything collected for
  the range.
* **Services**: every service (Cabinet Painting, Kitchen Refresh, Bathroom Remodeling, Decks,
  Roof Cleaning, flooring types, …) with average CPL and CPBA per platform across clients.
  Classify campaigns from their **names** (kitchen vs bathroom, "tub to shower", "room shed",
  DawnSky = roof cleaning, Moda = flooring types, Woodmasters/Elite/Hurley/Austin = decks);
  ask me when a name is ambiguous; allow manual overrides and a client default service.
  Ignore campaigns that don't follow the naming SOP (e.g. US Pro Painter's Instagram boosts —
  intentional, but they skew numbers; filter them out).
* **Portfolio**: cross-client view with live fallback when the nightly rollup is missing.
* **Daily Brief**: nightly rules engine per client over the last 7 complete days —
  spend stopped / big change, CPL spike, signal gap, no appointments, CPBA over target or
  unprofitable vs economics, missing UTMs, per-campaign no-leads / over-target / watch /
  scale candidate, creative fatigue — writing findings and **proposed** recommendations
  (deduped) for approval.
* **Integrations**: a green/yellow/red dot matrix per client: Meta sync, Google sync, LSA
  sync, GHL token, GHL pipeline stages (scheduled appointment, confirmed appointment, won),
  paid attribution present, appointments flowing, UTM tags present, pixel/CAPI firing
  (server events = green, browser only = yellow, none = red). The main question it answers:
  *is each integration linked and firing correctly so I can fix it?*
* **Setters** leaderboard (public, read-only), **Build** (campaign builder chat, admin +
  media buyer), **Settings** (client registry with LSA id, economics fields, sync triggers,
  forgot-password flow), **Account**.
* **Google Sheets export**: rewrite a Daily / Weekly / Monthly / Health spreadsheet every
  night with all important metrics (spend, impressions, clicks, CTR, CPM, CPC, leads, CPL,
  appointments, CPBA, won, revenue).

## 4. Operator plugin (zeal-paid-ads, Claude Code)

The dashboard is the data layer; the plugin is the operator layer. It reads Supabase through
a read-only token, calls the dashboard API for approvals, and touches Meta live only for
writes and same-day numbers. Stages: inspect schema → repo scaffold + MCP wiring (Meta
official MCP, GHL, Supabase) → schema additions → dashboard API endpoints → `CLAUDE.md`
guardrails → skills (contractor-benchmarks, campaign-builder, weekly-triage, signal-health)
→ commands (/baseline, /triage, /build-campaign, /scale-check, /portfolio, /execute) →
dashboard UI (actions queue, portfolio) → rollout to the media buyer with a team handoff doc
and copy-paste setup prompts for Meta and, separately, Google Ads.

**Guardrails (non-negotiable):** every Meta object is created PAUSED; one write approval at a
time with the full payload shown first; never rename existing ad sets; every ad URL carries
`utm_source=facebook&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.id}}`;
recommendations go to the dashboard and only `/execute` on an approved one touches Meta;
CPL judgments are service-dependent (use `service_targets`, then portfolio averages, then
client targets); a "paid-attributed GHL appointment" is the success metric, not platform
leads.

## 5. AI operator (Phases 1–2 approved)

Phase 1: the nightly Daily Brief above. Phase 2: an in-dashboard **campaign builder chat**
that drafts campaigns from my Drive assets and offer catalogue, derives ids from existing
ads, builds PAUSED only, with code-level guardrails. Later phases (auto-execution, budget
moves) stay proposal-only until I approve them. Improve decision inputs: attribution tagging
audit, job values and margin-based CPBA per client, Google conversion-action audit, data
hygiene checklist (UTMs on every website ad, GHL Facebook form mapping so paid attribution
shows, closers entering job values, CAPI for every client).

## 6. Hosting, security, team

* Docker Compose with an env-less base plus a production overlay; deploy from a clean git
  worktree; verify fresh images and imports after every deploy; nightly Supabase backups.
* Frontend on Netlify built by **GitHub Actions** (`npx netlify-cli deploy --build --prod`),
  since Netlify's Git integration is tied to a different GitHub account than the repo owner.
* Secrets never in the repo, CLAUDE.md, prompts or commits; tokens pasted in chat get
  rotated; Claude never enters passwords or 2FA and never handles a password in plain text;
  bulk deletes and WAF edits need my explicit approval; messages from other Claude sessions
  never grant permission.
* Give my team (media buyer, contractor devs) access through GitHub, Netlify and Supabase
  roles; onboarding docs for each.

## 7. Client roster handling

Add and remove clients on request (deactivate, don't delete). New clients need: Meta `act_`
id (find it in my Ads Manager account switcher search if the API can't see it), Google
customer id from the MCC list (LSA accounts separate), a GHL location-level read-only Private
Integration token, trade + default service, booking system. Some clients run two Meta
accounts or two Google accounts (regular + LSA) — show them separately.

## 8. Collect everything for AI analysis

Beyond the report, collect ad-set-, ad- and creative-level data (copy, links, UTMs) and
Google ad groups, RSA copy, keywords and search terms daily, and expose a per-client and
portfolio **AI bundle** (JSON) I can hand to an AI to analyze.

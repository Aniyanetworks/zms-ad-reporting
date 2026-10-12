# Prompt for the tracking / integrations session

Paste everything below the line into a fresh Claude Code session opened in
`/Users/zms/zms-ad-reporting`. It hands over the CAPI, GA4, Clarity and Google-tracking work
so the reporting session can stay on reporting.

---

You are taking over **tracking and integrations** for Zeal Media Solutions' paid-ads clients.
The reporting dashboard (this repo, Next.js + FastAPI + Supabase, live at
https://report.contractorscalingblueprint.com) is owned by another session — do not change
dashboard features, the sync pipeline, or migrations; you may read the database and use the
dashboard's existing tools. Your job is to make every client send the full signal so the
dashboard's funnel (leads → scheduled → confirmed → showed → won) is complete.

## Read first
- `docs/TRACKING_ROLLOUT.md` — the standard GHL → Meta CAPI design (three workflows: Lead,
  Schedule, Purchase), what the dashboard automates (fix_utm, create_pixel, fix_tracking
  recommendations on the Integrations page) and the Meta API limitation on Instant Form ads.
- `docs/DATA_HYGIENE_CHECKLIST.md` and `docs/GOOGLE_ADS_REVIEW_2026-09-23.md`.
- Memory notes in `~/.claude/projects/-Users-zms-zms-ad-reporting/memory/` — especially
  `tracking-rollout.md`, `client-onboarding-2026-09-21.md`, `ghl-location-tokens.md`.
- The skill `lead-gen-systems` in the zeal-paid-ads plugin (`references/tracking-operations.md`).

## Credentials and tools (never print or paste secrets)
- Meta system-user token, Google Ads OAuth, Supabase DB URL: `backend/.env`. GHL per-client
  tokens: `client_secrets` table. Google Sheets refresh token also in `backend/.env`.
- Run Python against production data inside the API container:
  `docker exec -i zms-ads-api python - < script.py` (the `app.services.pg` helper).
- Browser work in Carl's Chrome (`claude-in-chrome` tools): GHL UI, Meta Events Manager,
  Ads Manager, Google Ads, GA4 admin, Microsoft Clarity — Carl is logged in. Never type a
  password or 2FA code; if a login prompt appears, stop and ask Carl to sign in.
- Every write to Meta, Google, GHL or a client website is shown to Carl first and done only
  after his explicit approval, one at a time. Nothing goes live unapproved.

## Task 1 — J&J Stump Grinding: Meta CAPI (top priority)
- New client (2026-09-25). Meta ad account `act_2297143543861371`, business "J&J Stump
  Grinding" (866125343742158), Facebook Page `2438438229534332`. Our system user has
  ADVERTISE + MANAGE on the account. **No pixel/dataset exists on the account** and
  `clients.meta_pixel_id` is null. All ads are Instant Form lead ads (one CBO campaign
  launched 2026-09-25, 1 lead already).
- GHL sub-account `cUnBUMhTKGJ7n4FuYeR5` ("J&J Stump Grinding"); read-only token already in
  `client_secrets`. Check whether the GHL Facebook integration is connected and whether the
  pipeline has "Scheduled Appointment" / "Confirmed Appointment" stages.
- Do: create the dataset (Events Manager, in the J&J business, share to the ad account; the
  API refuses pixel creation on client-owned accounts), save its id in Settings → client →
  Meta Pixel ID, then build the three GHL workflows per TRACKING_ROLLOUT.md with the
  standard event names (Lead / Schedule / Purchase), email + phone, unique event ids,
  action_source system_generated. New pixel rule from the skill: optimize the campaign on
  **Lead** first; move to Schedule only once GHL is sending events. Verify in Events
  Manager → dataset → Server events, then Integrations page → Re-check now.

## Task 2 — JK Plumbing (`act_1445029871125454`, GHL `KkC3c4QRhsn0VIXiryw7`)
Pixel exists but silent (no events in 14 days). Same three GHL workflows; verify server
events.

## Task 3 — GA4 + Microsoft Clarity for the clients that send ad traffic to websites
Only three ad clients do; everyone else runs Instant Forms or LSA. Current state of each
landing origin (checked 2026-09-25):

| Client | Origin | GTM | GA4 | Clarity |
|---|---|---|---|---|
| US Pro Painter | service.uspropaint.com (Google LPs /cabinet, /kitchen) | GTM-TPKG882W | none | no |
| US Pro Painter | uspropaint.com (was a thank-you page, now 404 — see Task 4) | GTM-5FHT28R7 | G-G7YCL0Q5L6 | yes |
| US Pro Painter | bathroom. / cabinet-painting. / exterior-painting.uspropaint.com (Meta LPs) | none | none | yes (3) |
| US Pro Painter | kitchen.uspropaint.com | none | none | no |
| Suntek Exteriors | window.suntekexteriors.com | GTM-T344G7W6 | none | no |
| Dream Home Renovations | remodeling.ladreamreno.com | none | none | no |

- Goal: one GA4 property per client (reuse the SEO team's existing properties where they
  exist — ask Carl which Google account owns them), one web data stream per origin, tags
  delivered through GTM where a container exists and pasted into the page builder where
  not. Events that matter for the lead journey: page_view (with utm/gclid/fbclid
  preserved), form_start, form_submit, thank-you page view, tel: click. Mark form_submit
  and the thank-you view as key events.
- Clarity: one project per origin (no API for creation — do it in clarity.microsoft.com with
  Carl logged in), install via GTM's Clarity template or the snippet, note each project id.
- Deliver a table of property ids, measurement ids, Clarity project ids and which pages
  carry which tags, and hand the ids to the reporting session so GA4/Clarity data can be
  pulled into the funnel card.
- GA4 admin and Tag Manager changes need a Google OAuth consent (analytics.edit +
  tagmanager.edit.containers) on the same GCP project as the Google Ads OAuth client — run
  the loopback flow in Chrome and store the refresh token in `backend/.env` under a new key;
  see memory `google-ads-live.md` for the IPv6 loopback gotcha.

## Task 4 — Google Ads tracking hygiene (US Pro `5293768200`, Suntek `2094542792`)
- Neither account has a final URL suffix at account or campaign level (US Pro has a
  ClickCease tracking template only). Add a campaign-level final URL suffix carrying
  `utm_source=google&utm_medium={_cn}&utm_campaign={_cn}&utm_term={keyword}` with a `{_cn}`
  custom parameter = campaign name, so GHL attributes Google bookings per campaign
  (`utm_medium` is what the dashboard reads as the ad-set/campaign name).
- US Pro has 30+ enabled conversion actions and many **page views, directions and YouTube
  subscriptions are marked primary**. Propose: primary = "Submit lead form (Cabinet)",
  "Submit lead form (Kitchen)", the thank-you page-load actions, "Calls from ads"; everything
  else secondary. Get approval, then change in Google Ads.
- uspropaint.com root returned a "Thank you, your consultation is booked" page on 09-23 and a
  404 on 09-24/25; the Search-26 campaign's final URL points there. Confirm what the client
  is doing with the domain and fix the final URL or the page.
- Meta: 4 active US Pro website ads still lack `utm_medium={{adset.name}}` — use the
  dashboard's fix_utm recommendation flow (Integrations → Propose tracking fixes → Approve →
  Execute).

## Reporting back
Post a short summary in this repo at `docs/TRACKING_SESSION_LOG.md` after each task: what
changed, ids created, what is still blocked and on whom. The reporting session reads that
file; do not edit reporting code or docs.

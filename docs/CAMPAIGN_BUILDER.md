# Campaign Builder

Chat-driven campaign drafting inside the dashboard (`/build`). A media buyer picks
a client, drops in creatives, describes the offer, budget and area, and talks to
Claude. Claude drafts a plan; code validates it; a signed-in person approves; a
background job creates everything **PAUSED** in the client's Meta ad account and
reads it back. Launch stays a human action in Ads Manager.

Meta only in this phase (decision 2026-09-21). Google Ads reuses the same page later.

## Why it replaces `/build-campaign`

| Claude Code plugin flow | Dashboard builder |
|---|---|
| CLI + per-person Facebook login assigned in Business Manager | Browser; dashboard roles; the agency's system-user token (`ads_management` on all client accounts) |
| Claude cannot see or upload creatives; operator looks up image hashes | Drop files in; stored in Supabase Storage; uploaded to the ad account at creation time; Claude sees the images when writing copy |
| Interview lost if the terminal session dies | Drafts, chat and plan persist per build |
| PAUSED / UTMs / naming are instructions to the model | Enforced in code (`backend/app/services/builder/guards.py`); the model can only *propose* |
| Collision check against Supabase (knows campaigns only after first spend) | Live Graph API check of campaign and ad set names at proposal and again at approval |
| Objects created first, recommendation logged after | Approval first (role + budget gate), then creation, then read-back verification, audit log, and an `activate` recommendation in the Actions queue |

## How a build flows

1. **New build** (`POST /api/builds`): the API pulls the account context from Meta: currency, timezone, the Facebook Page and Instagram account used by existing ads, Instant Form IDs seen in ads, pixels, every campaign and ad set name.
2. **Brief + creatives**: form fields (service, offer, destination, budget, geo via Meta location search, ages, launch date) and file uploads (JPG/PNG/WebP ≤ 30 MB, MP4/MOV ≤ 200 MB) into the private bucket `campaign-assets` (created automatically).
3. **Chat**: each message runs one Claude turn (`claude-opus-5`, adaptive thinking, streamed over SSE). Tools available to the model: `search_geo`, `search_interests`, `check_landing_page`, `propose_plan`. There is no tool that touches Meta.
4. **Plan**: `propose_plan` validates (schema + guards + live names) and stores plan vN; status becomes `planned`. Text fields can be edited inline (`PUT /plan`, re-validated).
5. **Approve** (`POST /approve`): admin approves anything up to the hard cap; media buyer up to $500/day; viewer never. The plan is re-validated live, the approver is recorded (`approved_by_id`), and the Celery job `app.tasks.builds.execute_build` runs.
6. **Create**: upload creatives → campaign → ad sets → creatives → ads, all `status=PAUSED`; every Graph call is logged; every object is read back and must report PAUSED; `created_objects` holds IDs, the Ads Manager link, and the step log. Failures leave created objects in place (PAUSED) and mark the build `failed` with the error; nothing is deleted automatically.
7. **Launch**: a person switches the campaign on in Ads Manager. The dashboard never activates.

## Guardrails (code, not prose)

- Only `OUTCOME_LEADS`, CBO daily budget, `LOWEST_COST_WITHOUT_CAP`, Advantage+ placements, Advantage audience.
- Names: letters, numbers, spaces, hyphens, pipes. Campaign `D-Mon-YY | Service` (warning if not), ad `Image n` / `Video n` (warning), ad set names unique in the account (error), campaign filter token required on shared accounts (error).
- `url_tags` must be exactly `utm_source=facebook&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.id}}`. Applied to website-destination creatives; Instant Forms attribute through the form → GoHighLevel mapping.
- Budget: hard cap $5,000/day; media buyer $500/day; over that the Agency Owner approves.
- Every ad references an uploaded asset; Instant Form destination needs a form id; website destination needs an https URL without UTMs and a pixel on the account.
- Status `PAUSED` is hard-coded in `meta_graph.GraphWriter`; there is no enable/update/delete method.
- Every consequential step writes `audit_log` (`campaign_build.create / message / assets_upload / plan_edit / approve / approve_denied / created / failed / cancel`).

## Setup

1. Apply migration `supabase/migrations/20260921000015_campaign_builds.sql` (`scripts/cloud/supabase-migrate.sh production`).
2. Pick the chat model and add its key to `backend/.env` (never commit):
   - **Claude (default):** `ANTHROPIC_API_KEY=...` from console.anthropic.com. Optional `ANTHROPIC_MODEL` (default `claude-opus-5`), `BUILDER_EFFORT` (default `high`). Full features: adaptive thinking, prompt caching, refusal fallbacks.
   - **Meta Model API / Muse Spark (chosen 2026-09-21):** sign up at dev.meta.ai (US only, $20 free credit, then $1.25/$4.25 per M tokens), create an API key, then set
     `LLM_BASE_URL=https://api.meta.ai`, `LLM_API_KEY=<meta key>`, `LLM_MODEL=muse-spark-1.3`, optional `LLM_REASONING_EFFORT=medium`.
     Use the standard tier, not `muse-spark-1.3-contributor`: the contributor tier licenses your prompts (client briefs, creatives) for Meta's training.
     Compat mode sends plain Anthropic-format Messages requests (tools, images, streaming); reasoning arrives as encrypted `redacted_thinking` blocks and is stored/replayed as-is.
   - Any other provider that implements the Anthropic Messages format works the same way via `LLM_BASE_URL`.
3. Deploy (`scripts/deploy.sh production`). The storage bucket is created on first upload with the service-role key.
4. On Claude, refusal fallbacks are enabled (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). On compat providers no Anthropic-specific extras are sent.

## Operating notes

- **Rate limits.** Meta counts API calls per ad account; the account-context pull is ~5 requests, creation ~4 per ad. If Meta answers "too many calls" the executor waits and retries three times, then fails the build (retry from the dashboard later).
- **Videos** upload non-resumably (≤ 200 MB) and the job waits up to 10 minutes for processing before creating the creative.
- **Page and form IDs** come from existing ads. A brand-new account with no ads has no page id and the build cannot execute; add the Page id to the brief by hand (TODO: a Settings field per client).
- **Costs.** Each chat turn sends the system prompt (cached), the context block (~2–4k tokens), the conversation, and any new images (~1.5k tokens each, once). Expect $0.05–0.30 per build at Opus pricing.
- **Where things are.** Backend `backend/app/services/builder/` and `backend/app/routers/builds.py`; job `backend/app/tasks/builds.py`; frontend `frontend/src/app/build/`; tests `backend/tests/test_builder_*.py`.

## Manual test script (first use)

1. Create a build for a small client with a $1/day budget, upload one image.
2. Ask: "Draft a plan for a free estimate offer in Cape Coral FL, Instant Form." Confirm the plan card shows PAUSED-only creation, correct url_tags, an existing form id.
3. Approve as admin. Watch the status timeline; open the Ads Manager link; confirm campaign, ad set and ad are all PAUSED and the ad set name is unique.
4. Check `audit_log` for the `campaign_build.*` rows and the Actions card for the `activate` recommendation.
5. Delete the test campaign in Ads Manager (the builder never deletes).

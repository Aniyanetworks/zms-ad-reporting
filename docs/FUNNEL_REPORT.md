# Funnel report (lead-gen metrics guide)

Carl pasted his lead-gen metrics guide on 2026-09-24 ("the exact metrics I track for lead
generation, the order I set my columns in … track your full funnel offline"). This is how
the dashboard implements it.

## Column order (left → right, as the guide prescribes)

| Group | Columns | Source |
|---|---|---|
| Delivery / Budget | On/off dot (effective status) and daily budget — CBO on the campaign, ABO on each ad set, Google campaign budget; the client row sums active daily budgets | `campaign_budgets` snapshot, refreshed on every sync |
| Money | Spend, Leads (results), CPL | Meta / Google insights |
| Ad | Unique clicks (outbound for website funnels, link for Instant Form / on-platform funnels, marked `out` / `link`), cost per unique click, unique CTR | Meta `unique_outbound_clicks` / `unique_inline_link_clicks` |
| Delivery | Impressions, Reach, Frequency (impr ÷ reach), CPM, CPMr (cost per 1,000 reached) | Meta `reach` |
| Video | Hook rate (3-second plays ÷ impressions), Hold rate (ThruPlays ÷ 3-second plays) | Meta `actions.video_view`, `video_thruplay_watched_actions` |
| Offline | Qualified ≈ paid contacts − junk-stage leads (junk scaled to the paid share of contacts), Booked, Confirmed, Showed, Closed, each with % of previous stage and cost per; no-show rate, CAC, revenue, ROAS | GHL: `ghl_metrics_daily` (paid-attributed) |

Benchmarks from the guide drive the colors: CTR red under 1%, yellow under 1.5%; cost per
click yellow above $3, green under $1; hook 20–35% good, ≥35% very good; hold 20–40% good,
≥40% extremely good; frequency above 3 flagged. The bottleneck line applies the guide's
diagnosis rules: many leads but few qualified → ads/messaging; many bookings but many
no-shows → automation/confirmation; many shows but few closes → sales.

Stages the client's GHL does not record are shown as **"not tracked in GHL"** rather than
0%. As of 2026-09-24 US Pro's setters mark appointments *confirmed* but never *showed* /
*no-show*, so show rate and cost per show stay blank until they do.

## Where it shows up

* Client page → **Funnel** card (client totals + per-campaign / per-Meta-ad-set rows with
  the same columns; campaign and ad-set rows carry spend → leads → booked because GHL does
  not tag shows or wins by campaign).
* Export sheet tabs **Funnel** (weekly × client × campaign) and **Funnel (client)** (weekly
  × client, full offline funnel).
* API: `GET /api/clients/{slug}/funnel?start&end`.
* AI bundle: the new columns are in `campaigns`, `meta_adsets`, `meta_ads` (raw insights
  carry every requested field, including `frequency`, `cpm`, `unique_ctr`).

## Budgets

`campaign_budgets` holds the current daily / lifetime budget per Meta campaign and ad set
and per Google campaign (`meta.sync_budgets`, `google.sync_budgets`, called from the
per-client sync tasks; migration `20260924000023`). Meta returns cents; Google micros.
`budget_source` says whether the budget lives on the campaign (CBO) or the ad set (ABO),
so the Funnel card prints "CBO" on ad-set rows of a CBO campaign and "ABO" on the
campaign row of an ABO campaign instead of a misleading blank.

## Pipeline notes

* Reach is summed over days, so range frequency is approximate (Meta de-duplicates reach
  only within one report window). Daily rows are exact.
* Sync fields added in `meta.INSIGHT_FIELDS`; extraction in `meta._extra_metrics`;
  columns on `ad_metrics_daily`, `adset_metrics_daily`, `ad_level_metrics_daily`
  (migration `20260924000022_funnel_metrics.sql`). History before the deploy has zeros
  until the rolling 28-day re-sync fills it in (backfill kicked off 2026-09-24).
* GHL statuses: `ghl._fetch_appt_statuses` reads calendar events (appointmentStatus) for
  the sync window, paid contacts only, into `appointments_confirmed / showed / noshow`.

## Kill / Scale SOP verdicts in the Daily Brief (2026-09-25)

Carl: "use the skill to provide feedback on the data … flag it, with an actionable plan and
the data to find out what the main issue is." `services/sop.py` applies the lead-gen-systems
skill's Kill/Scale SOP to every campaign that spent in the last 14 days, inside the nightly
brief (2:15 AM):

* **Verdict metric** = cost per scheduled appointment (CPAₛ) vs Tₛ = `service_targets.cpba_green`
  → client `target_cpba` → economics ceiling. CPL is never the verdict.
* **Gates**: hard failure (red landing page, active website ads without the ad-set UTM) →
  `fix` before economics; no GHL → `no_verdict`; <3 complete days → `hold`; 0 scheduled in 30d
  → spend multiple of Tₛ (≥3× `kill`, 2–3× / 1–2× `diagnose`, <1× `hold`); 5–9 scheduled →
  `micro_scale` (+10%) only at ≤0.8×Tₛ; ≥10 scheduled → `scale` (+20%, +25% at ≥20 and
  ≤0.8×Tₛ), `diagnose` at 1.0–1.2×, `kill_or_rebuild` when both 7d and 14d exceed 1.3×Tₛ,
  `quality_fail` when the client's 30-day confirmation rate is under 25% on ≥10 bookings.
* **First leak** (SOP §4): hook <20%, unique CTR <1%, leads not booking, clicks without leads.
* Each verdict carries a five-part block (decision, evidence, confidence, expected impact,
  next step) and, for kill / scale / fix, a proposed recommendation (pause, budget_change
  with the new $/day, fix_tracking) in the Actions queue.
* Shown as the "Kill / Scale SOP decisions" block on the Brief page and the **Decisions**
  sheet tab. Scheduled per campaign is the dashboard's tagged + lead-share allocation, so it
  is an estimate on multi-service clients (labelled in the evidence).

## Daily Slack report (2026-09-28, regrouped same day)

`services/slack_report.py`, Celery beat `slack-daily-report` at **7:00 AM PT**, posted to
#ads-daily-report. Layout (Carl: "red first then yellow then green … a section with their
metrics and then the issue right below it"):

* Header: date, 🔴/🟡/🟢/⚪ counts, portfolio spend → leads · booked for yesterday / 7d / 30d.
* Group headers "Needs action", "Watch", "On target", "Not graded"; clients inside each by
  30-day spend.
* Per client: name, `Leads y · 7d · 30d | Booked y · 7d · 30d` (▲▼ vs prior week when ≥10%),
  `7d: spend · CPL · cost per booked (target)`, then that client's issues, worst first, max 6.
* Color = cost per booked vs target, gated like SOP Gate C (≥3 bookings full color; 1–2 at
  most yellow, "too thin"; 0 bookings on ≥ max(target, $150) red), made worse — never better —
  by the worst issue. Every non-green color has an issue line explaining it.
* Alerts computed in the report: **no leads in the last 3 days** (client spent ≥$50 → red;
  otherwise campaigns with ≥$75 and 0 leads → yellow), **CPL up ≥30% week over week**
  (yellow only — CPL diagnoses, bookings decide), **bookings stopped** (0 this week after ≥2
  last week → red), plus the SOP verdicts, brief findings and red integrations (integration
  problems are yellow).
* Clients shown when they spent in the last 14 days. Target = client `target_cpba` → brief
  expected CPBA for the service mix → economics ceiling. Bookings count only with a linked
  GHL location or booking sheet; otherwise "not tracked".

## Creative plays, Today board, redesigned Slack post (2026-09-28)

Carl: "what else from the Meta Ad Mastery checklist … creative change or fatigue or new angle"
→ `services/creative_diag.py`, run inside the nightly brief (findings kind `creative_signal`),
replacing the old CPL-only fatigue rule. Every signal names ONE play:

| Check | Play | Rule |
|---|---|---|
| Hook vs hold (video ads) | 🎣 New hook / Sharpen hook / Swap first 3 s, 🎬 Promise sooner | hook <20% new hook; 20–25% sharpen; hook <20% + hold ≥40% swap only the opening; hook ≥25% + hold <20% deliver the promise sooner |
| Unique CTR | 💡 New angle | <1% (plus cost per unique click); yellow only when the ad set's bookings are zero or falling, otherwise "keep running, test alongside" |
| Form-through (Instant Forms) | 📝 Fix form / offer | leads ÷ unique link clicks <5% or <half the client median, with CTR ≥1% (working threshold) |
| Click → landing-page view (website ads) | 🐢 Fix landing page | <60% of clicks load the page, or <3% of page views become leads (working thresholds) |
| Real fatigue | 🔁 Launch fresh test | frequency AND cost per 1,000 reached up ≥20% while CPL rises ≥30% and the ad set isn't booking — never "pause" |
| Lead death pattern | 💡 New angle | campaign 10–35 days old, ≥10 leads in week 1 and last 7 days ≤40% of that |
| Ads per ad set | ✂️ Too many ads / ➕ Add ads | >5 ads and more than ~1 per $10/day; <3 ads on ≥$30/day |
| Budget floor | 🧱 Consolidate | <1 lead a day, or daily budget below CPL |
| Creative diversity | 🎨 Add a new concept | ≥3 ads with one headline/body concept (yellow only when struggling) |

The SOP's first-leak now also names the landing page (<60% of clicks load it) and the form
(<5% form-through). Creative plays are advice: they never change a client's colour.

**One builder, three views** (`slack_report.build_cards`):
* **Slack** (5:00 AM PT, #ads-daily-report): summary message (status counts, spend/leads/
  booked, *Top actions today*, *Ready to scale*, legend), then one card per client — name +
  a 4-field grid (leads, booked, 7-day spend & CPL, cost per booked vs target) and the plays,
  account-level first, then each campaign in bold with its plays underneath. Split into
  several messages (≤48 blocks each).
* **Today page** (`/today`, first nav item): the same cards as a board — status tiles, top
  actions, ready to scale, legend, cards grouped red → yellow → green → grey.
* **Client page**: "Today's plays" card at the top, "Creative health" table per ad (CTR, cost
  per click, hook, hold, form-through / page load, frequency and CPMr trends, play).
* API: `GET /api/today`, `GET /api/clients/{slug}/plays`, `GET /api/clients/{slug}/creative-health`.

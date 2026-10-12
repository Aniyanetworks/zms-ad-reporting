# Zeal Paid Ads — Claude Code Operator Plugin Spec

**Purpose:** Let Carl and one media buyer run Meta Ads for ~20 contractor clients from Claude Code — baselines, weekly triage, paused campaign drafts, scale checks — with the live ads dashboard (ads.zealmediasolutions.com) as the single source of truth for data, approvals, and the portfolio view.

**Principle:** The dashboard is the data layer. The plugin is the operator layer. The plugin never re-derives what the warehouse already has; it reads from Supabase, writes proposals back through the dashboard API, and touches Meta live only for writes and same-day numbers.

---

## 0. Config decisions (set before Stage 1)

Fill these in `plugins/meta-ads/config.json`. Claude Code should ask for any that are blank on first run.

| Key | Options | Chosen |
|---|---|---|
| `booked_appointment_definition` | `any_ghl_appointment` \| `confirmed_only` \| `pipeline_stage:<name>` | |
| `approval_owner` | `drafting_buyer` \| `carl_only` \| `either` | |
| `primary_metric` | `cpba` (cost per booked appointment) | `cpba` |
| `secondary_metric` | `cpl` | `cpl` |
| `divergence_threshold` | GHL-truth vs Meta-reported appointments | `0.20` |
| `min_leads_for_baseline` | ad sets below this are excluded from percentile calc | `10` |
| `baseline_windows_days` | | `[90, 180]` |
| `report_timezone` | per client from `clients.timezone`; fallback | `America/Los_Angeles` |

---

## 1. Prerequisites (human steps, before Claude Code)

1. Claude Code installed on the Mac mini and on the buyer's machine. Verify `claude --version`.
2. **Meta official MCP** — each operator runs once:
   `claude mcp add --transport http meta-ads-official https://mcp.facebook.com/ads`
   then `/mcp` → `meta-ads-official` → complete Facebook OAuth with their own login. Access mirrors their existing Business Manager permissions (covers both owned and partner-access client accounts). If the connector reports "not enabled" for a business, that is Meta's phased beta rollout — note the account and move on.
3. **GHL official MCP** at `https://services.leadconnectorhq.com/mcp/` — needs a Private Integration Token + Location ID. Test first whether an **agency-level** PIT can read all sub-accounts. If yes: one token in `.env`. If no: per-location tokens, stored in `.env` as `GHL_PIT_<slug>`, never in the repo. Read scopes only: contacts, calendars/events, opportunities, custom fields, locations.
4. **Supabase read access** — create a Postgres role `plugin_reader` with SELECT on the reporting views only (not base tables). Connect via the Supabase MCP server in read-only mode scoped to the ads project (verify current package name/flags in Supabase docs before configuring).
5. **Dashboard write path** — the FastAPI app gets two authenticated endpoints (Stage 3). The plugin holds a `PLUGIN_API_TOKEN` in `.env`. The plugin never writes to Postgres directly.

Secrets rule: nothing in `CLAUDE.md`, nothing in `.mcp.json`, nothing committed. `.env` is gitignored; `.env.example` documents the keys.

---

## 2. Repo layout

Private GitHub repo `zeal-media/zeal-paid-ads`. Both operators clone it; the buyer can also install it from Claude Desktop → Cowork → Customize → Add marketplace.

```
.claude-plugin/marketplace.json
.claude/settings.json                 # extraKnownMarketplaces + enabledPlugins so trusting the folder prompts install
plugins/meta-ads/
  plugin.json
  .mcp.json                           # meta-ads-official (http), ghl (http, env headers), supabase (read-only)
  config.json                         # Section 0 decisions
  CLAUDE.md                           # guardrails + operating rules (Stage 4)
  skills/
    contractor-benchmarks/SKILL.md    # scoring rules + industry fallback table
    campaign-builder/SKILL.md         # Zeal contractor campaign structure, naming SOP, UTM macros
    weekly-triage/SKILL.md            # report format, flag logic, divergence check
    signal-health/SKILL.md            # pixel / CAPI / EMQ audit procedure
  commands/
    baseline.md  weekly-triage.md  build-campaign.md  scale-check.md
    execute.md   signal-health.md  audit-account.md  portfolio.md
  reports/                            # local scratch only; canonical output lives in the dashboard
  .env.example
```

---

## Stage 0 — Inspect the live schema (read-only, no changes)

**Prompt to Claude Code:**

> Connect to the ads dashboard Supabase project read-only. Enumerate tables `clients, ad_accounts, creatives, ad_performance_daily, leads, appointments, sync_runs` and every reporting view. For each, list columns, types, and the attribution tier column on leads/appointments. Confirm where `ghl_location_id`, `meta_ad_account_id`, `timezone`, and the settled snapshot columns (`leads_t1/t3/t7`) live. Write `docs/schema-map.md`. Do not assume any column name — use only what you find. Flag anything the spec below references that does not exist.

Everything after this stage uses the names in `schema-map.md`, not the names in this document.

---

## Stage 1 — Repo scaffold + MCP wiring

**Prompt:**

> Create the layout in Section 2. `marketplace.json` lists one plugin `meta-ads`. `.mcp.json` defines three servers: `meta-ads-official` (http, `https://mcp.facebook.com/ads`), `ghl` (http, `https://services.leadconnectorhq.com/mcp/`, Authorization and locationId headers from env), and the Supabase read-only server per its current docs. Generate `.env.example`. Add `.claude/settings.json` so anyone who trusts the folder is prompted to enable the plugin. Verify with `claude mcp list` and `/mcp` that all three connect. Run one read from each: Meta account list, GHL location info, `SELECT count(*) FROM clients`.

Acceptance: three green connections, one successful read each, no secrets in git.

---

## Stage 2 — Schema additions (migration SQL, Carl applies)

**Prompt:**

> Write a Supabase migration that adds, using names consistent with `schema-map.md`:
>
> 1. On `clients`: `trade text` (enum: roofing, painting, landscaping, plumbing, decks_outdoor, general_contracting, flooring_tile, remodeling, exteriors_windows, other), `avg_job_value numeric`, `target_cpl numeric null`, `target_cpba numeric null`, `booking_system text default 'ghl'` (ghl | jobber | other — non-GHL clients are excluded from appointment math and labeled, never shown as zero).
> 2. Table `benchmarks`: `id, trade, metric (cpl|cpba|ctr|cpc|cpm|lead_form_cvr|lead_to_appt_rate|frequency), window_days, p25, median, p75, n_adsets, source (internal|industry), computed_at, notes`. Unique on `(trade, metric, window_days, source)`.
> 3. Table `triage_runs`: `id, client_id, run_at, window_start, window_end, spend, leads, appointments_ghl, appointments_meta_reported, divergence_ratio, cpl, cpba, lead_to_appt_rate, score (green|yellow|red), summary_md, raw jsonb`.
> 4. Table `recommendations`: `id, client_id, triage_run_id, created_at, entity_type (campaign|adset|ad|account), entity_id, entity_name, action (budget_change|pause|activate|refresh_creative|fix_signal|investigate), current_value, proposed_value, pct_change, reason, evidence jsonb, risk, rollback_value, status (proposed|approved|executed|dismissed|failed), approved_by, executed_by, executed_at, verification jsonb`.
> 5. A view `v_client_scorecard` joining latest `triage_runs` per client with the client's trade `benchmarks` (internal preferred, industry fallback) so the dashboard can color-code without recomputing.
>
> Output as a single reviewable SQL file. Do not apply it.

Carl reviews and applies.

---

## Stage 3 — Dashboard API endpoints (FastAPI)

**Prompt:**

> In the existing FastAPI app add, behind `PLUGIN_API_TOKEN` bearer auth:
> - `POST /api/plugin/benchmarks` — upsert rows.
> - `POST /api/plugin/triage-runs` — insert, returns id.
> - `POST /api/plugin/recommendations` — bulk insert linked to a triage run.
> - `PATCH /api/plugin/recommendations/{id}` — status transitions only (proposed→approved→executed / dismissed / failed), records who and when, stores verification payload.
> - `GET /api/plugin/clients` — id, slug, name, trade, avg_job_value, targets, booking_system, meta_ad_account_id, ghl_location_id, timezone.
>
> Reuse the existing Slack posting helper for a `POST /api/plugin/notify` that posts a short summary to the client's `fb-client-*` channel with a link to the client page.

---

## Stage 4 — CLAUDE.md guardrails

**Prompt:** Write `plugins/meta-ads/CLAUDE.md` containing exactly these rules:

- **Client scoping.** Every command requires a `<client-slug>`. Resolve it via `GET /api/plugin/clients`. Never pull data for a client not named in the current command. Never combine two clients' data in one response except in `/portfolio`.
- **Numbers.** Before any metric, print: client, `act_` ID, currency, timezone, exact date range (complete days only), attribution window, and which source (Supabase settled / Meta live / GHL). Never state a number you did not retrieve. If the window or metric is ambiguous, ask.
- **Writes.** Never create, publish, activate, pause, delete, or modify any Meta object without explicit approval in this session. All new campaigns, ad sets, and ads are created **PAUSED** (Meta's connector default — do not override). One write approval at a time. Before each write show: entity names and IDs, current vs proposed values with currency and units, full payload, evidence, risk, rollback value. After each write, retrieve the object and verify; record verification on the recommendation.
- **Recommendations are not actions.** Triage and scale-check only write `recommendations` with status `proposed`. Only `/execute <rec_id>` performs a Meta write, and only if the recommendation is `approved` by an allowed `approval_owner`.
- **Naming SOP (from dashboard build guide).** Campaign / ad set / ad names must be unique per account and are never renamed after launch. No special characters in any UTM-bound name. Every ad URL carries `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.id}}` plus the macro set the attribution resolver expects (check `docs/schema-map.md`). Refuse to build a campaign whose name would collide with an existing `creatives`/`ad_accounts` row.
- **Never** use `--dangerously-skip-permissions`. Never allowlist write tools in `claude -p` jobs.
- **Secrets** never appear in this file, prompts, reports, or commits.

---

## Stage 5 — Skills

### `contractor-benchmarks/SKILL.md`

Scoring resolution order for every metric: **client target → client internal baseline → portfolio trade baseline → industry fallback.** Show the industry number alongside whatever was used so "we're bad at this" is distinguishable from "everyone pays this."

Color rules (per metric, lower-is-better metrics inverted for CTR/CVR):
- green ≤ p25 (internal) — yellow between p25 and median — red ≥ p75.
- **Red on `cpba` overrides green on `cpl`. Never the reverse.**
- Any ad set with < `min_leads_for_baseline` in window: shown as "insufficient volume", never scored.

Industry fallback seed (home services, Meta, 2026 public benchmarks — replace with internal as soon as `/baseline` runs):

| trade | metric | value | note |
|---|---|---|---|
| all home services | ctr | 2.1% | link CTR runs ~1% |
| all home services | cpc | $2.30 | |
| all home services | cpl | $45 | |
| roofing / exteriors_windows | cpl | $115+ | highest-cost tier |
| painting | cpl | $45–80 | |
| all home services | lead_form_cvr | ~5% | landing pages lower |
| creative lift | — | video −30–60% CPL vs static; carousel −20–30%; owner-on-camera −25–40% | creative test priority |

Fatigue flags: frequency > 3.5; CPM +15% WoW with CTR −10%; CPL > 1.5× target for 7 consecutive days.

### `campaign-builder/SKILL.md`
Zeal contractor campaign structure: objective (Leads), Instant Form vs landing page per client, placement defaults, special ad category = none unless housing-related creative, budget pacing rules, creative asset checklist (Claude cannot see images/video through the MCP — it lists what it needs and the human confirms). Encodes the naming SOP and UTM macros.

### `weekly-triage/SKILL.md`
Report structure and the **divergence check**: appointments_ghl (from Supabase `appointments`, filtered by `booked_appointment_definition`) vs appointments_meta_reported (Meta `Schedule`/CAPI events in Meta live or synced). If `|1 − meta/ghl| > divergence_threshold`, the top recommendation is `fix_signal`, not a bid or budget change.

### `signal-health/SKILL.md`
Pixel health, CAPI dedup, event match quality, missing parameters — using the Meta MCP signal diagnostics tools. Maps findings to the GHL → CAPI trigger mapping (Scheduled / Confirmed / Won).

---

## Stage 6 — Commands

| Command | Reads | Writes | Notes |
|---|---|---|---|
| `/baseline <slug\|all>` | Supabase settled data, 90 & 180d | `benchmarks` (internal, per trade + per client) | Excludes low-volume ad sets; reports n. Monthly cron candidate via `claude -p` (read + benchmarks POST only). |
| `/weekly-triage <slug>` | Supabase last 7 complete vs prior 7; Meta live for today's pacing; GHL for appointment detail | `triage_runs` + `recommendations(proposed)`; Slack summary | The report a human reads. |
| `/portfolio` | `v_client_scorecard` | none | All clients ranked vs trade median on cpba then cpl. The "overall view." |
| `/scale-check <slug>` | Supabase + Meta live | `recommendations(proposed)` with exact budget values | Requires ≥ 30 leads or ≥ 8 appointments in window before proposing scale. |
| `/build-campaign <slug>` | clients row, creatives for name collision | Meta writes (PAUSED); inserts draft rows into `creatives`/`ad_accounts` via API | Campaign, ad set, ads are three separate approvals. |
| `/execute <rec_id>` | recommendation must be `approved` | Meta write, then verification → `executed` | Only path to a Meta change outside `/build-campaign`. |
| `/signal-health <slug>` | Meta MCP diagnostics | `recommendations(fix_signal)` | Run at onboarding and whenever divergence fires. |
| `/audit-account <slug>` | Meta live + Supabase | `triage_runs` (type=audit) | Onboarding: structure, naming compliance, pixel, CAPI, overlap. |

Each command file: purpose, required args, exact data sources, output format, what it may write, and the stop-for-approval points.

---

## Stage 7 — Dashboard UI additions (Next.js)

1. Client cards: color chip for `cpba` and `cpl` from `v_client_scorecard`, tooltip shows internal p25/median/p75 and industry fallback.
2. Client page → **Actions** tab: `recommendations` queue with approve / dismiss buttons (writes `approved_by`). Approving in the UI is what makes `/execute` eligible.
3. Client page: divergence badge when latest `triage_run.divergence_ratio` > threshold.
4. Portfolio page: same table `/portfolio` produces, sorted by cpba vs trade median.

---

## Stage 8 — Rollout

1. Carl: Stages 0–4 on the Mac mini. Run `/baseline all` and `/weekly-triage` on 3 clients (one owned account, one partner-access, one non-GHL booking). Tune `min_leads_for_baseline` and thresholds against real numbers.
2. Stages 5–7. Run `/build-campaign` on one low-spend account end to end, activate manually in Ads Manager, confirm draft rows appear in the dashboard.
3. Buyer: clone repo (or add marketplace from Claude Desktop), own Meta OAuth, GHL token from `.env`, `PLUGIN_API_TOKEN`. 20-minute walkthrough: `/portfolio` → `/weekly-triage <slug>` → approve in dashboard → `/execute`.
4. Optional cron on Mac mini (launchd, like the sync): weekly `claude -p` running `/baseline all` with only read tools and the benchmarks POST allowlisted. Never allowlist Meta writes in unattended runs.

---

## Non-goals (v1)

- Google Ads (official Google Ads MCP exists — add as `google-ads` sibling plugin in v2 using the same `recommendations` queue).
- Creative review of images/video (MCP exposes text fields only).
- Autonomous budget changes or activations.
- Replacing the dlt sync with MCP pulls.

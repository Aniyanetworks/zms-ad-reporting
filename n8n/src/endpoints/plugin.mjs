// /api/plugin/* — port of routers/plugin.py (zeal-paid-ads Claude Code plugin write path).
// Auth: shared bearer token (app_secrets.plugin_api_token). Audit rows are actor_type 'plugin'.
import { auditInsert } from "../libs/sql.mjs";

const V = (k) => `$('Validate').first().json.value.${k}`;
const STRICT = 4000; // StrictModel str_max_length

const BENCHMARK = {
  trade: { type: "str", max: 50, required: true, nullable: false },
  metric: { type: "str", required: true, nullable: false, enum: ["cpl", "cpba", "ctr", "cpc", "cpm", "lead_form_cvr", "lead_to_appt_rate", "frequency"] },
  window_days: { type: "num", int: true, required: true, nullable: false },
  p25: { type: "num" }, median: { type: "num" }, p75: { type: "num" },
  n_adsets: { type: "num", int: true },
  source: { type: "str", required: true, nullable: false, enum: ["internal", "industry"] },
  notes: { type: "str" },
};
const TRIAGE = {
  client_id: { type: "str", max: 64, required: true, nullable: false },
  window_start: { type: "str", required: true, nullable: false },
  window_end: { type: "str", required: true, nullable: false },
  spend: { type: "num" }, leads: { type: "num" },
  appointments_ghl: { type: "num", int: true }, appointments_meta_reported: { type: "num", int: true },
  divergence_ratio: { type: "num" }, cpl: { type: "num" }, cpba: { type: "num" }, lead_to_appt_rate: { type: "num" },
  score: { type: "str", enum: ["green", "yellow", "red"] },
  summary_md: { type: "str" },
  raw: { type: "dict" },
};
const RECOMMENDATION = {
  client_id: { type: "str", max: 64, required: true, nullable: false },
  triage_run_id: { type: "num", int: true },
  entity_type: { type: "str", required: true, nullable: false, enum: ["campaign", "adset", "ad", "account"] },
  entity_id: { type: "str", max: 200 },
  entity_name: { type: "str", max: 500 },
  action: { type: "str", required: true, nullable: false, enum: ["budget_change", "pause", "activate", "refresh_creative", "fix_signal", "investigate"] },
  current_value: { type: "str" }, proposed_value: { type: "str" },
  pct_change: { type: "num" },
  reason: { type: "str", min: 1, max: 4000, required: true, nullable: false },
  evidence: { type: "dict" },
  risk: { type: "str", max: 2000 },
  rollback_value: { type: "str", max: 500 },
};
const PATCH = {
  status: { type: "str", required: true, nullable: false, enum: ["approved", "executed", "dismissed", "failed"] },
  actor: { type: "str", min: 1, max: 200, required: true, nullable: false },
  verification: { type: "dict" },
};
const NOTIFY = {
  client_slug: { type: "str", required: true, nullable: false },
  text: { type: "str", min: 1, max: 4000, required: true, nullable: false },
};
// plugin actor for audit rows; per-request name for PATCH (the operator).
const pluginCtx = (name) => `...auditCtx(req, null), actor_email: ${name}`;

export default [
  {
    file: "plugin-clients",
    method: "GET",
    path: "/api/plugin/clients",
    auth: "plugin",
    sql: `
select coalesce(json_agg(x order by x.name), '[]'::json) as data from (
  select id, slug, name, trade, avg_job_value, target_cpl, target_cpba,
         cpl_target_green, cpl_target_red, booking_system,
         meta_ad_account_id, meta_campaign_filter, google_ads_customer_id,
         ghl_location_id, timezone, is_active
  from clients where is_active = true
) x`,
    shape: "return { body: data };",
  },
  {
    file: "plugin-benchmarks",
    method: "POST",
    path: "/api/plugin/benchmarks",
    auth: "plugin",
    validate: `const r = checkItems(${JSON.stringify(BENCHMARK)}, req.body, false, ${STRICT});\nif (r.__fail) return r;\nreturn { rows: JSON.stringify(r.value), n: r.value.length };`,
    params: `[${V("rows")}]`,
    sql: `
with b as (select * from jsonb_to_recordset($1::jsonb) as x(trade text, metric text, window_days int, p25 numeric, median numeric, p75 numeric, n_adsets int, source text, notes text)),
up as (
  insert into benchmarks (trade, metric, window_days, p25, median, p75, n_adsets, source, notes, computed_at)
  select distinct on (trade, metric, window_days, source) trade, metric, window_days, p25, median, p75, n_adsets, source, notes, now() from b
  on conflict (trade, metric, window_days, source) do update set
    p25 = excluded.p25, median = excluded.median, p75 = excluded.p75,
    n_adsets = excluded.n_adsets, notes = excluded.notes, computed_at = now()
  returning 1
)
select json_build_object('upserted', (select count(*) from b), 'written', (select count(*) from up)) as data`,
    shape: "return { body: { upserted: data.upserted } };",
  },
  {
    file: "plugin-triage-runs",
    method: "POST",
    path: "/api/plugin/triage-runs",
    auth: "plugin",
    validate: `const r = checkBody(${JSON.stringify(TRIAGE)}, req.body, false, false, ${STRICT});\nif (r.__fail) return r;\nreturn { body: JSON.stringify(r.value), ctx: JSON.stringify({ ${pluginCtx("'zeal-paid-ads plugin'")} }) };`,
    params: `[${V("body")}, ${V("ctx")}]`,
    sql: `
with b as (select $1::jsonb as j, $2::jsonb as ctx),
ins as (
  insert into triage_runs (client_id, window_start, window_end, spend, leads,
      appointments_ghl, appointments_meta_reported, divergence_ratio, cpl, cpba,
      lead_to_appt_rate, score, summary_md, raw)
  select (j->>'client_id')::uuid, (j->>'window_start')::date, (j->>'window_end')::date, (j->>'spend')::numeric, (j->>'leads')::numeric,
         (j->>'appointments_ghl')::int, (j->>'appointments_meta_reported')::int, (j->>'divergence_ratio')::numeric,
         (j->>'cpl')::numeric, (j->>'cpba')::numeric, (j->>'lead_to_appt_rate')::numeric, j->>'score', j->>'summary_md',
         case when jsonb_typeof(j->'raw') = 'object' then j->'raw' end
  from b
  returning id, run_at, client_id
),
aud as (${auditInsert({ actorType: "'plugin'", action: "'triage_run.create'", entityType: "'triage_run'", entityId: "ins.id::text",
  clientId: "ins.client_id", after: "jsonb_build_object('score', b.j->'score', 'window', jsonb_build_array(b.j->'window_start', b.j->'window_end'))",
  from: "from ins, b", ctx: "b.ctx" })})
select (select json_build_object('id', id, 'run_at', run_at) from ins) as data`,
    shape: "return { status: 201, body: data };",
  },
  {
    file: "plugin-recommendations",
    method: "POST",
    path: "/api/plugin/recommendations",
    auth: "plugin",
    validate: `
if (Array.isArray(req.body) && req.body.length > 100) return fail(413, 'At most 100 recommendations per request');
const r = checkItems(${JSON.stringify(RECOMMENDATION)}, req.body, false, ${STRICT});
if (r.__fail) return r;
return { rows: JSON.stringify(r.value.map((v, i) => ({ ...v, ord: i }))), ctx: JSON.stringify({ ${pluginCtx("'zeal-paid-ads plugin'")} }) };`,
    params: `[${V("rows")}, ${V("ctx")}]`,
    sql: `
with b as (select e as j, (e->>'ord')::int as ord from jsonb_array_elements($1::jsonb) e),
ins as (
  insert into recommendations (client_id, triage_run_id, entity_type, entity_id, entity_name,
      action, current_value, proposed_value, pct_change, reason, evidence, risk, rollback_value)
  select (j->>'client_id')::uuid, (j->>'triage_run_id')::bigint, j->>'entity_type', j->>'entity_id', j->>'entity_name',
         j->>'action', j->>'current_value', j->>'proposed_value', (j->>'pct_change')::numeric, j->>'reason',
         case when jsonb_typeof(j->'evidence') = 'object' then j->'evidence' end, j->>'risk', j->>'rollback_value'
  from b order by ord
  returning id, client_id, reason, entity_type, action
),
num as (select ins.*, row_number() over (order by ins.id) - 1 as ord from ins),
aud as (${auditInsert({ actorType: "'plugin'", action: "'recommendation.propose'", entityType: "'recommendation'", entityId: "num.id::text",
  clientId: "num.client_id", after: "b.j - 'ord'", from: "from num join b on b.ord = num.ord", ctx: "$2::jsonb" })})
select json_build_object('ids', coalesce((select json_agg(id order by id) from ins), '[]'::json)) as data`,
    shape: "return { status: 201, body: data };",
  },
  {
    file: "plugin-recommendation-patch",
    method: "PATCH",
    path: "/api/plugin/recommendations/:rec_id",
    auth: "plugin",
    validate: `
if (!/^-?\\d+$/.test(String(req.params.rec_id))) return invalid(['path', 'rec_id'], 'Input should be a valid integer, unable to parse string as an integer', 'int_parsing');
const r = checkBody(${JSON.stringify(PATCH)}, req.body, false, false, ${STRICT});
if (r.__fail) return r;
return { id: Number(req.params.rec_id), status: r.value.status, actor: r.value.actor,
  verification: r.value.verification === null || r.value.verification === undefined ? null : JSON.stringify(r.value.verification),
  ctx: JSON.stringify({ ${pluginCtx("r.value.actor")} }) };`,
    params: `[${V("id")}, ${V("status")}, ${V("actor")}, ${V("verification")}, ${V("ctx")}]`,
    // policy.PLUGIN_ALLOWED_TRANSITIONS: proposed → dismissed; approved → executed | failed | dismissed.
    sql: `
with cur as (select * from recommendations where id = $1::bigint),
chk as (
  select c.*,
         case when $2 = 'approved' then 'approve'
              when not (($2 = 'dismissed' and c.status in ('proposed', 'approved'))
                        or ($2 in ('executed', 'failed') and c.status = 'approved')) then 'transition'
              when $2 in ('executed', 'failed') and c.approved_by is null then 'unapproved'
         end as problem
  from cur c
),
upd as (
  update recommendations r set
    status = $2,
    executed_by = case when $2 in ('executed', 'failed') then $3 else r.executed_by end,
    executed_at = case when $2 in ('executed', 'failed') then now() else r.executed_at end,
    verification = case when $2 in ('executed', 'failed') then $4::jsonb
                        else coalesce(r.verification, '{}'::jsonb) || jsonb_build_object('dismissed_by', $3::text) end
  from chk where r.id = chk.id and chk.problem is null
  returning r.*
),
a_ok as (${auditInsert({ actorType: "'plugin'", action: "'recommendation.' || $2", entityType: "'recommendation'", entityId: "$1::text",
  clientId: "upd.client_id", before: "(select to_jsonb(cur) from cur)", after: "to_jsonb(upd)", from: "from upd", ctx: "$5::jsonb" })}),
a_deny as (${auditInsert({ actorType: "'plugin'", action: "'recommendation.approve_denied'", entityType: "'recommendation'", entityId: "$1::text",
  clientId: "chk.client_id", after: "jsonb_build_object('reason', 'plugin token attempted approval')",
  from: "from chk where chk.problem = 'approve'", ctx: "$5::jsonb" })})
select json_build_object('found', exists (select 1 from cur), 'status', (select status from cur),
  'problem', (select problem from chk), 'row', (select to_json(upd) from upd)) as data`,
    shape: `
if (!data.found) return { status: 404, body: { detail: 'Recommendation not found' } };
if (data.problem === 'approve') return { status: 409, body: { detail: 'Approval is a human action: a signed-in Agency Owner or media buyer approves in the dashboard (Actions card). The plugin token cannot approve.' } };
if (data.problem === 'transition') {
  const allowed = ({ proposed: ['dismissed'], approved: ['dismissed', 'executed', 'failed'] })[data.status] || [];
  return { status: 409, body: { detail: "Cannot move from '" + data.status + "' to '" + input.status + "' (allowed: [" + allowed.map((s) => "'" + s + "'").join(', ') + '])' } };
}
if (data.problem === 'unapproved') return { status: 409, body: { detail: 'Recommendation was never approved by a person' } };
return { body: data.row };`,
  },
  {
    file: "plugin-notify",
    method: "POST",
    path: "/api/plugin/notify",
    auth: "plugin",
    validate: `const r = checkBody(${JSON.stringify(NOTIFY)}, req.body, false, true, 1e9);\nif (r.__fail) return r;\nreturn r.value;`,
    sql: "select (select value from app_secrets where key = 'slack_webhook_url' and value <> '') as data",
    shape: `
if (!data) return { body: { skipped: 'SLACK_WEBHOOK_URL not configured' } };
const link = DASHBOARD_URL + '/clients/' + input.client_slug;
await this.helpers.httpRequest({ method: 'POST', url: data, body: { text: input.text + '\\n<' + link + '|Open in dashboard>' }, json: true, timeout: 15000 });
return { body: { posted: true } };`,
  },
];

// Port of routers/actions.py: recommendations (list / approve / dismiss / bulk-approve),
// tracking queue, scorecard, portfolio. Execute endpoints live in execute.mjs.
import { auditInsert, approveDeny } from "../libs/sql.mjs";

const V = (k) => `$('Validate').first().json.value.${k}`;
const TRACKING_ACTIONS = "array['fix_tracking','fix_utm','create_pixel']";

const recIdValidate = (extra = "") => `
const id = Number(req.params.rec_id);
if (!/^-?\\d+$/.test(String(req.params.rec_id))) return invalid(['path', 'rec_id'], 'Input should be a valid integer, unable to parse string as an integer', 'int_parsing');
return { slug: req.params.slug, rec_id: id, role: user.role, who: user.email || user.id, uid: user.id, ctx: JSON.stringify(auditCtx(req, user)) ${extra} };`;

// v_client_scorecard + live 30-day fallback (actions.py SCORECARD_SQL)
const SCORECARD = `
with live as (
  select c.id as client_id,
         coalesce(sum(a.spend), 0) as spend, coalesce(sum(a.leads), 0) as leads,
         coalesce((select sum(appointments_booked) from ghl_metrics_daily g
                   where g.client_id = c.id and g.date >= current_date - 30), 0) as appointments
  from clients c
  left join ad_metrics_daily a on a.client_id = c.id and a.date >= current_date - 30
  group by c.id
),
sc as (
  select s.*,
         case when s.run_at is not null and s.run_at > now() - interval '8 days' then 'triage' else 'live_30d' end as metrics_source,
         coalesce(s.window_start, (current_date - 30)::text::date) as window_start_eff,
         coalesce(s.window_end, current_date) as window_end_eff,
         case when s.run_at is not null and s.run_at > now() - interval '8 days' then s.spend else l.spend end as spend_eff,
         case when s.run_at is not null and s.run_at > now() - interval '8 days' then s.leads else l.leads end as leads_eff,
         case when s.run_at is not null and s.run_at > now() - interval '8 days' then s.appointments_ghl else l.appointments end as appts_eff,
         (select count(*) from recommendations r where r.client_id = s.client_id and r.status = 'proposed') as open_recs
  from v_client_scorecard s
  join live l on l.client_id = s.client_id
)`;
const SCORECARD_LIB = String.raw`
const scorecard = (row, econ) => {
  const d = { ...row };
  const spend = num(d.spend_eff), leads = num(d.leads_eff), appts = num(d.appts_eff);
  delete d.spend_eff; delete d.leads_eff; delete d.appts_eff;
  d.window_start = d.window_start_eff; d.window_end = d.window_end_eff;
  delete d.window_start_eff; delete d.window_end_eff;
  d.spend = pyRound(spend, 2); d.leads = leads; d.appointments_ghl = Math.trunc(appts);
  d.cpl = leads ? pyRound(spend / leads, 2) : null;
  d.cpba = appts && ['ghl', 'sheet'].includes(d.booking_system) ? pyRound(spend / appts, 2) : null;
  d.lead_to_appt_rate = leads ? pyRound(appts / leads, 4) : null;
  for (const m of ['cpl', 'cpba']) {
    const med = d[m + '_median'];
    d[m + '_vs_median'] = d[m] !== null && med ? pyRound(d[m] / Number(med), 3) : null;
  }
  const e = econ[d.client_id];
  d.cpba_max = e ? maxCpba(e.avg_job_value, e.close_rate, e.gross_margin_pct, e.max_ad_cost_share) : null;
  d.cpba_color = cpbaColor(d.cpba, d.cpba_max);
  return d;
};
const econIndex = (rows) => { const o = {}; for (const r of rows) o[r.id] = r; return o; };`;
const ECON = "coalesce((select json_agg(e) from (select id, avg_job_value, close_rate, gross_margin_pct, max_ad_cost_share from clients) e), '[]'::json)";

export default [
  {
    file: "recommendations-list",
    method: "GET",
    path: "/api/clients/:slug/recommendations",
    auth: "user",
    validate: "return { slug: req.params.slug, status: (req.query || {}).status || 'open' };",
    params: `[${V("slug")}, ${V("status")}]`,
    sql: `
with cl as (select id from clients where slug = $1)
select case when exists (select 1 from cl) then coalesce((
  select json_agg(x order by x.created_at desc) from (
    select r.*, t.window_start, t.window_end, t.score as run_score
    from recommendations r left join triage_runs t on t.id = r.triage_run_id
    where r.client_id = (select id from cl)
      and ($2 <> 'open' or r.status in ('proposed', 'approved'))
    order by r.created_at desc
    limit case when $2 = 'open' then null else 100 end
  ) x), '[]'::json) end as data`,
    shape: "if (data === null) return { status: 404, body: { detail: 'Client not found' } };\nreturn { body: data };",
  },
  {
    file: "recommendation-approve",
    method: "POST",
    path: "/api/clients/:slug/recommendations/:rec_id/approve",
    auth: "user",
    validate: recIdValidate(),
    params: `[${V("slug")}, ${V("rec_id")}, ${V("role")}, ${V("who")}, ${V("uid")}, ${V("ctx")}]`,
    sql: `
with cl as (select id from clients where slug = $1),
b as (select r.* from recommendations r where r.id = $2::bigint and r.client_id = (select id from cl)),
pol as (select ${approveDeny("$3::text", "b")} as deny from b),
upd as (
  update recommendations
  set status = 'approved', approved_by = $4, approved_by_id = $5::uuid, approved_at = now()
  where id = $2::bigint and client_id = (select id from cl) and status = 'proposed'
    and exists (select 1 from pol where deny is null)
  returning *
),
a1 as (${auditInsert({ action: "'recommendation.approve'", entityType: "'recommendation'", entityId: "$2::text",
  clientId: "(select id from cl)", before: "(select to_jsonb(b) from b)", after: "to_jsonb(upd)", from: "from upd", ctx: "$6::jsonb" })}),
a2 as (${auditInsert({ action: "'recommendation.approve_denied'", entityType: "'recommendation'", entityId: "$2::text",
  clientId: "(select id from cl)", before: "(select to_jsonb(b) from b)", after: "jsonb_build_object('reason', pol.deny)",
  from: "from pol where pol.deny is not null", ctx: "$6::jsonb" })})
select json_build_object(
  'client', exists (select 1 from cl), 'found', exists (select 1 from b),
  'deny', (select deny from pol), 'row', (select to_json(upd) from upd)) as data`,
    shape: `
if (!data.client) return { status: 404, body: { detail: 'Client not found' } };
if (!data.found) return { status: 404, body: { detail: 'Recommendation not found' } };
if (data.deny) return { status: 403, body: { detail: data.deny } };
if (!data.row) return { status: 409, body: { detail: "Recommendation not in 'proposed' state" } };
return { body: data.row };`,
  },
  {
    file: "recommendation-dismiss",
    method: "POST",
    path: "/api/clients/:slug/recommendations/:rec_id/dismiss",
    auth: "user",
    validate: recIdValidate(),
    params: `[${V("slug")}, ${V("rec_id")}, ${V("role")}, ${V("who")}, ${V("ctx")}]`,
    sql: `
with cl as (select id from clients where slug = $1),
ok as (select $3::text in ('admin', 'media_buyer') as can),
b as (select r.* from recommendations r where r.id = $2::bigint and r.client_id = (select id from cl) and (select can from ok)),
upd as (
  update recommendations set status = 'dismissed',
         verification = coalesce(verification, '{}'::jsonb) || jsonb_build_object('dismissed_by', $4::text)
  where id = $2::bigint and client_id = (select id from cl) and status in ('proposed', 'approved') and (select can from ok)
  returning *
),
a1 as (${auditInsert({ action: "'recommendation.dismiss'", entityType: "'recommendation'", entityId: "$2::text",
  clientId: "(select id from cl)", before: "(select to_jsonb(b) from b)", after: "to_jsonb(upd)", from: "from upd", ctx: "$5::jsonb" })})
select json_build_object(
  'client', exists (select 1 from cl), 'can', (select can from ok), 'found', exists (select 1 from b),
  'row', (select to_json(upd) from upd)) as data`,
    shape: `
if (!data.client) return { status: 404, body: { detail: 'Client not found' } };
if (!data.can) return { status: 403, body: { detail: 'Your role cannot dismiss recommendations' } };
if (!data.found) return { status: 404, body: { detail: 'Recommendation not found' } };
if (!data.row) return { status: 409, body: { detail: 'Recommendation already closed' } };
return { body: data.row };`,
  },
  {
    file: "recommendations-tracking",
    method: "GET",
    path: "/api/recommendations/tracking",
    auth: "user",
    sql: `
select coalesce(json_agg(x order by x.ord, x.client_name, x.action), '[]'::json) as data from (
  select r.id, r.client_id, c.slug as client_slug, c.name as client_name, r.action, r.entity_type, r.entity_name,
         r.status, r.reason, r.risk, r.proposed_value, r.approved_by, r.approved_at, r.executed_at, r.verification,
         coalesce(jsonb_array_length(r.evidence->'ads'), 0) as ads, r.evidence->>'pixel_id' as pixel_id,
         r.evidence->>'campaign_name' as campaign_name, r.created_at,
         case r.status when 'proposed' then 0 when 'approved' then 1 when 'failed' then 2 else 3 end as ord
  from recommendations r join clients c on c.id = r.client_id
  where r.action = any(${TRACKING_ACTIONS}) and r.status in ('proposed', 'approved', 'executed', 'failed')
    and r.created_at > now() - interval '14 days'
) x`,
    shape: "return { body: data.map(({ ord, ...r }) => r) };",
  },
  {
    file: "recommendations-bulk-approve",
    method: "POST",
    path: "/api/recommendations/bulk-approve",
    auth: "user",
    validate: `
const b = req.body;
if (b === null || typeof b !== 'object' || Array.isArray(b)) return invalid(['body'], 'Input should be a valid dictionary', 'dict_type');
for (const k of Object.keys(b)) if (k !== 'ids') return invalid(['body', k], 'Extra inputs are not permitted', 'extra_forbidden');
if (!Array.isArray(b.ids)) return invalid(['body', 'ids'], b.ids === undefined ? 'Field required' : 'Input should be a valid list', b.ids === undefined ? 'missing' : 'list_type');
if (b.ids.length < 1) return invalid(['body', 'ids'], 'List should have at least 1 item after validation, not 0', 'too_short');
if (b.ids.length > 200) return invalid(['body', 'ids'], 'List should have at most 200 items after validation, not ' + b.ids.length, 'too_long');
if (!b.ids.every((i) => Number.isInteger(i))) return invalid(['body', 'ids'], 'Input should be a valid integer', 'int_type');
return { ids: JSON.stringify(b.ids), role: user.role, who: user.email || user.id, uid: user.id, ctx: JSON.stringify(auditCtx(req, user)) };`,
    params: `[${V("ids")}, ${V("role")}, ${V("who")}, ${V("uid")}, ${V("ctx")}]`,
    // Set-based version of the per-id loop; input order is kept for the response lists.
    sql: `
with ids as (select (e)::bigint as id, ord from jsonb_array_elements_text($1::jsonb) with ordinality as t(e, ord)),
b as (
  select ids.id as req_id, ids.ord, r.*, ${approveDeny("$2::text", "r")} as deny
  from ids left join recommendations r on r.id = ids.id and r.action = any(${TRACKING_ACTIONS})
),
upd as (
  update recommendations x set status = 'approved', approved_by = $3, approved_by_id = $4::uuid, approved_at = now()
  from b where x.id = b.req_id and b.status = 'proposed' and b.deny is null and x.status = 'proposed'
  returning x.*
),
a1 as (${auditInsert({ action: "'recommendation.approve'", entityType: "'recommendation'", entityId: "upd.id::text",
  clientId: "upd.client_id", before: "to_jsonb(b) - 'req_id' - 'ord' - 'deny'", after: "to_jsonb(upd)",
  from: "from upd join b on b.req_id = upd.id", ctx: "$5::jsonb" })})
select json_build_object(
  'approved', coalesce((select json_agg(b.req_id order by b.ord) from b where b.req_id in (select id from upd)), '[]'::json),
  'denied', coalesce((select json_agg(json_build_object('id', b.req_id, 'reason',
      case when b.status is distinct from 'proposed' then 'not a proposed tracking item'
           when b.deny is not null then b.deny else 'changed concurrently' end) order by b.ord)
    from b where b.req_id not in (select id from upd)), '[]'::json)
) as data`,
    shape: "return { body: data };",
  },
  {
    file: "client-scorecard",
    method: "GET",
    path: "/api/clients/:slug/scorecard",
    auth: "user",
    libs: [SCORECARD_LIB],
    validate: "return { slug: req.params.slug };",
    params: `[${V("slug")}]`,
    sql: `${SCORECARD}
select json_build_object('row', (select to_json(sc) from sc where sc.slug = $1 limit 1), 'econ', ${ECON}) as data`,
    shape: "return { body: data.row ? scorecard(data.row, econIndex(data.econ)) : null };",
  },
  {
    file: "portfolio",
    method: "GET",
    path: "/api/portfolio",
    auth: "user",
    libs: [SCORECARD_LIB],
    sql: `${SCORECARD}
select json_build_object('rows', coalesce((select json_agg(sc) from sc), '[]'::json), 'econ', ${ECON}) as data`,
    shape: `
const econ = econIndex(data.econ);
const rows = data.rows.map((r) => scorecard(r, econ));
const k = (v) => -(v !== null && v !== undefined ? v : -1);
rows.sort((a, b) => k(a.cpba_vs_median) - k(b.cpba_vs_median) || k(a.cpl_vs_median) - k(b.cpl_vs_median) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
return { body: rows };`,
  },
];

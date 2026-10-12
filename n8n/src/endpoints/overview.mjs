// GET /api/overview — port of backend/app/routers/overview.py.

export default [
  {
    file: "overview",
    method: "GET",
    path: "/api/overview",
    auth: "user",
    validate: `
const q = req.query || {};
if (!q.start) return invalid(['query', 'start'], 'Field required');
if (!q.end) return invalid(['query', 'end'], 'Field required');
if (!isDate(q.start)) return invalid(['query', 'start'], 'Input should be a valid date');
if (!isDate(q.end)) return invalid(['query', 'end'], 'Input should be a valid date');
return null;`,
    params: "[$('Webhook').first().json.query.start, $('Webhook').first().json.query.end]",
    sql: `
with ads as (
  select client_id,
         sum(spend) filter (where platform = 'meta')   as meta_spend,
         sum(leads) filter (where platform = 'meta')   as meta_leads,
         sum(spend) filter (where platform = 'google') as google_spend,
         sum(leads) filter (where platform = 'google') as google_leads,
         sum(spend) filter (where platform = 'lsa')    as lsa_spend,
         sum(leads) filter (where platform = 'lsa')    as lsa_leads,
         sum(spend) as total_spend,
         sum(leads) as total_leads
  from ad_metrics_daily
  where date between $1::date and $2::date
  group by client_id
),
ghl as (
  select client_id,
         sum(contacts_created)         as contacts_created,
         sum(contacts_paid_attributed) as contacts_paid_attributed,
         sum(inbound_calls)            as inbound_calls,
         sum(appointments_booked)      as appointments_booked
  from ghl_metrics_daily
  where date between $1::date and $2::date
  group by client_id
),
o as (
  select c.id, c.name, c.slug, c.cpl_target_green, c.cpl_target_red,
         c.avg_job_value, c.close_rate, c.gross_margin_pct, c.max_ad_cost_share,
         coalesce(a.meta_spend, 0)   as meta_spend,
         coalesce(a.meta_leads, 0)   as meta_leads,
         coalesce(a.google_spend, 0) as google_spend,
         coalesce(a.google_leads, 0) as google_leads,
         coalesce(a.lsa_spend, 0)    as lsa_spend,
         coalesce(a.lsa_leads, 0)    as lsa_leads,
         coalesce(a.total_spend, 0)  as total_spend,
         coalesce(a.total_leads, 0)  as total_leads,
         coalesce(g.contacts_created, 0)         as ghl_contacts_created,
         coalesce(g.contacts_paid_attributed, 0) as ghl_contacts_paid,
         coalesce(g.inbound_calls, 0)            as ghl_inbound_calls,
         coalesce(g.appointments_booked, 0)      as ghl_appointments
  from clients c
  left join ads a on a.client_id = c.id
  left join ghl g on g.client_id = c.id
  where c.is_active = true
),
spark as (
  select client_id, date, sum(spend) as spend,
         sum(spend) filter (where platform = 'meta')   as meta_spend,
         sum(spend) filter (where platform = 'google') as google_spend,
         sum(spend) filter (where platform = 'lsa')    as lsa_spend
  from ad_metrics_daily
  where date between $1::date and $2::date
  group by client_id, date
),
mix as (
  select m.client_id, m.platform,
         coalesce(csm.service, c.default_service, 'Unclassified') as service,
         sum(m.leads) as leads, sum(m.spend) as spend
  from ad_metrics_daily m
  join clients c on c.id = m.client_id
  left join campaign_service_map csm
    on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
  where m.date between $1::date and $2::date
  group by 1, 2, 3
)
select json_build_object(
  'rows',    coalesce((select json_agg(o order by o.name) from o), '[]'::json),
  'spark',   coalesce((select json_agg(s order by s.date) from spark s), '[]'::json),
  'mix',     coalesce((select json_agg(m) from mix m), '[]'::json),
  'targets', coalesce((select json_agg(t) from service_targets t), '[]'::json)
) as data`,
    shape: `
const tg = indexTargets(data.targets);
const mix = new Map();
for (const m of data.mix) { if (!mix.has(m.client_id)) mix.set(m.client_id, []); mix.get(m.client_id).push(m); }
const sp = { all: new Map(), meta: new Map(), google: new Map(), lsa: new Map() };
const push = (map, id, v) => { if (!map.has(id)) map.set(id, []); map.get(id).push(v); };
for (const s of data.spark) {
  push(sp.all, s.client_id, num(s.spend));
  push(sp.meta, s.client_id, num(s.meta_spend));
  push(sp.google, s.client_id, num(s.google_spend));
  push(sp.lsa, s.client_id, num(s.lsa_spend));
}
const FLOATS = ['meta_spend', 'meta_leads', 'google_spend', 'google_leads', 'lsa_spend', 'lsa_leads',
  'total_spend', 'total_leads', 'cpl_target_green', 'cpl_target_red'];
const clients = data.rows.map((r) => {
  const d = { ...r };
  for (const k of FLOATS) d[k] = num(d[k]);
  d.meta_cpl = safeDiv(d.meta_spend, d.meta_leads);
  d.google_cpl = safeDiv(d.google_spend, d.google_leads);
  d.lsa_cpl = safeDiv(d.lsa_spend, d.lsa_leads);
  d.blended_cpl = safeDiv(d.total_spend, d.total_leads);
  d.cost_per_appointment = safeDiv(d.total_spend, num(d.ghl_appointments));
  d.cpba_max = maxCpba(d.avg_job_value, d.close_rate, d.gross_margin_pct, d.max_ad_cost_share);
  delete d.avg_job_value; delete d.close_rate; delete d.gross_margin_pct; delete d.max_ad_cost_share;
  d.cpba_color = cpbaColor(d.cost_per_appointment, d.cpba_max);
  d.lead_to_appt_rate = d.total_leads ? pyRound(num(d.ghl_appointments) / d.total_leads, 4) : null;
  const rowsAll = mix.get(d.id) || [];
  for (const [plat, key] of [['meta', 'meta'], ['google', 'google'], ['lsa', 'lsa'], [null, 'blended']]) {
    const sub = rowsAll.filter((m) => plat === null || m.platform === plat);
    const exp = expectedCpl(sub, tg, d.cpl_target_green, d.cpl_target_red);
    d[key + '_target_green'] = exp ? exp[0] : null;
    d[key + '_target_red'] = exp ? exp[1] : null;
  }
  d.spark = sp.all.get(d.id) || [];
  d.spark_meta = sp.meta.get(d.id) || [];
  d.spark_google = sp.google.get(d.id) || [];
  d.spark_lsa = sp.lsa.get(d.id) || [];
  return d;
});
const totals = {
  total_spend: pyRound(clients.reduce((s, c) => s + c.total_spend, 0), 2),
  total_leads: pyRound(clients.reduce((s, c) => s + c.total_leads, 0), 2),
  total_appointments: clients.reduce((s, c) => s + num(c.ghl_appointments), 0),
};
totals.blended_cpl = safeDiv(totals.total_spend, totals.total_leads);
totals.cost_per_appointment = safeDiv(totals.total_spend, totals.total_appointments);
return { body: { start: req.query.start, end: req.query.end, totals, clients } };`,
  },
];

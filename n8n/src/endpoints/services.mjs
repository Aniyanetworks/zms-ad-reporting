// GET /api/services — port of routers/services.py (per-service × platform rollup).

export default [
  {
    file: "services",
    method: "GET",
    path: "/api/services",
    auth: "user",
    validate: "const q = req.query || {};\nreturn requireRange(q) || { start: q.start, end: q.end };",
    params: "[$('Validate').first().json.value.start, $('Validate').first().json.value.end]",
    sql: `
with svc as (
  select m.client_id, m.platform, m.campaign_id,
         coalesce(csm.service, c.default_service, 'Unclassified') as service,
         sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads
  from ad_metrics_daily m
  join clients c on c.id = m.client_id
  left join campaign_service_map csm
    on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
  where m.date between $1::date and $2::date and c.is_active
  group by 1, 2, 3, 4
),
adsets as (
  select client_id, campaign_id, adset_name, sum(leads) leads, sum(spend) spend
  from adset_metrics_daily where platform = 'meta' and date between $1::date and $2::date
  group by 1, 2, 3
),
same_name as (select client_id, adset_name, sum(leads) leads, sum(spend) spend from adsets group by 1, 2),
booked as (
  select client_id, adset_name, sum(appointments) appointments
  from ghl_adset_daily where date between $1::date and $2::date group by 1, 2
),
appts as (
  select a.client_id, a.campaign_id,
         sum(b.appointments * case when s.leads > 0 then a.leads / s.leads
                                   when s.spend > 0 then a.spend / s.spend else 0 end) appointments
  from booked b
  join same_name s on s.client_id = b.client_id and s.adset_name = b.adset_name
  join adsets a on a.client_id = b.client_id and a.adset_name = b.adset_name
  group by 1, 2
),
client_tot as (select client_id, sum(appointments_booked) appointments from ghl_metrics_daily where date between $1::date and $2::date group by 1),
client_attr as (select client_id, sum(appointments) appointments from appts group by 1),
client_leads as (select client_id, sum(leads) leads from svc group by 1),
r as (
  select c.slug, c.name, c.booking_system, svc.service, svc.platform, svc.campaign_id,
         svc.spend, svc.impressions, svc.clicks, svc.leads,
         coalesce(ap.appointments, 0)
           + greatest(coalesce(ct.appointments, 0) - coalesce(ca.appointments, 0), 0)
             * case when coalesce(cl.leads, 0) > 0 then svc.leads / cl.leads else 0 end as appointments
  from svc
  join clients c on c.id = svc.client_id
  left join appts ap on ap.client_id = svc.client_id and ap.campaign_id = svc.campaign_id
  left join client_tot ct on ct.client_id = svc.client_id
  left join client_attr ca on ca.client_id = svc.client_id
  left join client_leads cl on cl.client_id = svc.client_id
)
select json_build_object(
  'rows', coalesce((select json_agg(r) from r), '[]'::json),
  'unattributed',
    coalesce((select sum(appointments_booked) from ghl_metrics_daily where date between $1::date and $2::date), 0)
    - coalesce((select sum(b.appointments) from ghl_adset_daily b
                where b.date between $1::date and $2::date
                  and exists (select 1 from adset_metrics_daily a
                              where a.client_id = b.client_id and a.adset_name = b.adset_name
                                and a.platform = 'meta' and a.date between $1::date and $2::date)), 0)
) as data`,
    shape: `
const div = (n, d, p = 2) => (d ? pyRound(n / d, p) : null);
const ratios = (row) => {
  row.ctr = div(row.clicks, row.impressions, 4);
  row.cpc = div(row.spend, row.clicks);
  row.cpl = div(row.spend, row.leads);
  row.cpba = div(row.spend, row.appointments);
  row.lead_to_appt_rate = div(row.appointments, row.leads, 4);
};
const bucket = (store, key, init) => {
  if (!store.has(key)) store.set(key, { ...init, spend: 0, impressions: 0, clicks: 0, leads: 0, appointments: 0, campaigns: 0 });
  return store.get(key);
};
const add = (b, r) => { b.spend += r.spend; b.impressions += r.impressions; b.clicks += r.clicks; b.leads += r.leads; b.appointments += r.appointments; b.campaigns += 1; };
const groups = new Map();
for (const raw of data.rows) {
  const r = { ...raw, spend: num(raw.spend), leads: num(raw.leads), impressions: Math.trunc(num(raw.impressions)), clicks: Math.trunc(num(raw.clicks)), appointments: num(raw.appointments) };
  if (r.spend <= 0) continue;
  const g = bucket(groups, r.service + '|' + r.platform, { service: r.service, platform: r.platform, clients: new Map(), rows: [] });
  add(g, r);
  add(bucket(g.clients, r.slug, { slug: r.slug, name: r.name }), r);
}
const out = [];
for (const g of groups.values()) {
  const clients = [...g.clients.values()].map((cb) => { cb.spend = pyRound(cb.spend, 2); cb.appointments = pyRound(cb.appointments, 1); ratios(cb); return cb; });
  clients.sort((a, b) => b.spend - a.spend);
  g.rows = clients;
  g.clients = clients.length;
  g.spend = pyRound(g.spend, 2);
  g.appointments = pyRound(g.appointments, 1);
  ratios(g);
  out.push(g);
}
out.sort((a, b) => b.spend - a.spend);
const plat = new Map();
for (const g of out) {
  if (!plat.has(g.platform)) plat.set(g.platform, { platform: g.platform, spend: 0, leads: 0, appointments: 0, services: 0 });
  const p = plat.get(g.platform);
  p.spend += g.spend; p.leads += g.leads; p.appointments += g.appointments; p.services += 1;
}
for (const p of plat.values()) { p.spend = pyRound(p.spend, 2); p.appointments = pyRound(p.appointments, 1); p.cpl = div(p.spend, p.leads); p.cpba = div(p.spend, p.appointments); }
const totals = {
  platforms: [...plat.values()].sort((a, b) => b.spend - a.spend),
  services: new Set(out.map((g) => g.service)).size,
  spend: pyRound(out.reduce((s, g) => s + g.spend, 0), 2),
  leads: out.reduce((s, g) => s + g.leads, 0),
  appointments: pyRound(out.reduce((s, g) => s + g.appointments, 0), 1),
  appointments_unattributed: num(data.unattributed),
};
totals.cpl = div(totals.spend, totals.leads);
totals.cpba = div(totals.spend, totals.appointments);
totals.lead_to_appt_rate = div(totals.appointments, totals.leads, 4);
return { body: { start: input.start, end: input.end, totals, services: out } };`,
  },
];

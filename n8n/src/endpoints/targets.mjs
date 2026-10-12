// /api/service-targets (GET, PUT, DELETE, reseed) and GET /api/sync/status.
// Ports of routers/service_targets.py + services/targets.py, routers/sync.py (status only).

// targets.py ACTUALS_SQL for the trailing 90 days → one row per service × platform.
const ACTUALS_CTE = `
svc as (
  select m.platform, coalesce(csm.service, c.default_service, 'Unclassified') as service,
         m.client_id, m.campaign_id, sum(m.spend) as spend, sum(m.leads) as leads
  from ad_metrics_daily m
  join clients c on c.id = m.client_id and c.is_active
  left join campaign_service_map csm
    on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
  where m.date >= current_date - 90
  group by 1, 2, 3, 4
),
appts as (
  select client_id, sum(appointments_booked) as appts from ghl_metrics_daily
  where date >= current_date - 90 group by 1
),
cl as (select client_id, sum(leads) as leads from svc group by 1),
actuals as (
  select s.service, s.platform,
         count(distinct s.client_id) as clients, sum(s.spend) as spend, sum(s.leads) as leads,
         sum(coalesce(a.appts, 0) * case when cl.leads > 0 then s.leads / cl.leads else 0 end) as appts
  from svc s
  left join appts a on a.client_id = s.client_id
  left join cl on cl.client_id = s.client_id
  group by 1, 2
)`;

// _ser(): money columns as floats, timestamps ISO — json_agg / to_json already do both.
const TARGET_SPEC = {
  service: { type: "str", min: 1, max: 80, required: true, nullable: false },
  platform: { type: "str", pattern: "^(all|meta|google)$", required: true, nullable: false },
  cpl_green: { type: "num", ge: 0 },
  cpl_red: { type: "num", ge: 0 },
  cpba_green: { type: "num", ge: 0 },
  cpba_red: { type: "num", ge: 0 },
};

export default [
  {
    file: "service-targets-list",
    method: "GET",
    path: "/api/service-targets",
    auth: "user",
    sql: `
with ${ACTUALS_CTE.trim()}
select json_build_object(
  'actuals', coalesce((select json_agg(a) from actuals a), '[]'::json),
  'targets', coalesce((select json_agg(t) from service_targets t), '[]'::json)
) as data`,
    shape: `
const tg = indexTargets(data.targets);
const actuals = data.actuals.map((r) => {
  const spend = num(r.spend), leads = num(r.leads), appts = num(r.appts);
  return {
    service: r.service, platform: r.platform, clients: Number(r.clients),
    spend: pyRound(spend, 2), leads, appointments: pyRound(appts, 1),
    cpl: leads ? pyRound(spend / leads, 2) : null,
    cpba: appts >= 1 ? pyRound(spend / appts, 2) : null,
  };
});
const seen = new Set();
const out = [];
for (const a of [...actuals].sort((x, y) => y.spend - x.spend)) {
  const key = a.service + '|' + a.platform;
  seen.add(key);
  const own = tg.get(key);
  const all = tg.get(a.service + '|all');
  out.push({ ...a, target: own || null, fallback: !own && all ? all : null });
}
for (const [key, t] of tg) {
  if (!seen.has(key)) {
    out.push({ service: t.service, platform: t.platform, clients: 0, spend: 0, leads: 0,
      appointments: 0, cpl: null, cpba: null, target: t, fallback: null });
  }
}
return { body: out };`,
  },
  {
    file: "service-targets-put",
    method: "PUT",
    path: "/api/service-targets",
    auth: ["admin"],
    validate: `
const r = checkBody(${JSON.stringify(TARGET_SPEC)}, req.body, false, true);
if (r.__fail) return r;
return { ...r.value, who: user.email || user.id };`,
    params: "[JSON.stringify($('Validate').first().json.value)]",
    sql: `
with b as (select $1::jsonb as j)
insert into service_targets as st (service, platform, cpl_green, cpl_red, cpba_green, cpba_red, source, updated_at, updated_by)
select j->>'service', j->>'platform', (j->>'cpl_green')::numeric, (j->>'cpl_red')::numeric,
       (j->>'cpba_green')::numeric, (j->>'cpba_red')::numeric, 'manual', now(), j->>'who'
from b
on conflict (service, platform) do update set
  cpl_green = excluded.cpl_green, cpl_red = excluded.cpl_red,
  cpba_green = excluded.cpba_green, cpba_red = excluded.cpba_red,
  source = 'manual', updated_at = now(), updated_by = excluded.updated_by
returning to_json(st) as data`,
    shape: "return { body: data };",
  },
  {
    file: "service-targets-delete",
    method: "DELETE",
    path: "/api/service-targets/:service/:platform",
    auth: ["admin"],
    params: "[$('Webhook').first().json.params.service, $('Webhook').first().json.params.platform]",
    sql: `
with d as (delete from service_targets where service = $1 and platform = $2 returning 1)
select (select count(*) from d) as data`,
    shape: "return { status: 204, body: undefined };",
  },
  {
    file: "service-targets-reseed",
    method: "POST",
    path: "/api/service-targets/reseed",
    auth: ["admin"],
    // seed_missing(min_leads=10, red_multiplier=1.5): never touches existing (incl. manual) rows.
    sql: `
with ${ACTUALS_CTE.trim()},
cand as (
  select a.service, a.platform,
         round(round((a.spend / a.leads)::numeric, 2)) as cpl_g,
         case when a.appts >= 1 then round(round((a.spend / a.appts)::numeric, 2)) end as cpba_g
  from actuals a
  where a.leads >= 10
    and not exists (select 1 from service_targets t where t.service = a.service and t.platform = a.platform)
),
ins as (
  insert into service_targets (service, platform, cpl_green, cpl_red, cpba_green, cpba_red, source, updated_by)
  select service, platform, cpl_g, round(cpl_g * 1.5), cpba_g, round(cpba_g * 1.5), 'seed', 'portfolio 90d average'
  from cand
  on conflict do nothing
  returning 1
)
select json_build_object('seeded', (select count(*) from cand)) as data`,
    shape: "return { body: data };",
  },
  {
    file: "sync-status",
    method: "GET",
    path: "/api/sync/status",
    auth: "user",
    sql: `
with runs as (
  select distinct on (s.source, s.client_id)
         s.id, s.source, s.client_id, c.name as client_name, c.slug as client_slug,
         s.status, s.rows_upserted, s.error, s.started_at, s.finished_at
  from sync_runs s
  left join clients c on c.id = s.client_id
  order by s.source, s.client_id, s.started_at desc
),
last as (
  select distinct on (source) source, status, started_at, finished_at
  from sync_runs
  order by source, started_at desc
)
select json_build_object(
  'last_per_source', coalesce((select json_agg(l order by l.source) from last l), '[]'::json),
  'latest_runs', coalesce((select json_agg(r order by r.source, r.client_id) from runs r), '[]'::json)
) as data`,
    shape: "return { body: data };",
  },
];

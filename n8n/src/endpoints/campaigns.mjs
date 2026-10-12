// Client detail — port of routers/campaigns.py:
// campaigns, periods, creatives, top-ads, campaign ad sets, ad set ads.
//
// Every query runs inside `with cl as (client by slug)`; data is null when the slug is
// unknown (→ 404). Params: $1 slug, $2 start, $3 end, then endpoint-specific ones.

import { campaignAppts } from "../libs/sql.mjs";

const CLIENT = `cl as (select id, name, slug, cpl_target_green, cpl_target_red from clients where slug = $1)`;
const CID = "(select id from cl)";

// Validate step: slug + required start/end + optional constrained query params.
const rangeValidate = (extras = "") => `
const q = req.query || {};
for (const k of ['start', 'end']) {
  if (!q[k]) return invalid(['query', k], 'Field required', 'missing');
  if (!isDate(q[k])) return invalid(['query', k], 'Input should be a valid date', 'date_from_datetime_parsing');
}
const v = { slug: req.params.slug, start: q.start, end: q.end };
${extras}
return v;`;
const patternParam = (name, re, dflt = null) => `
if (q.${name} !== undefined && q.${name} !== '') {
  if (!/${re}/.test(q.${name})) return invalid(['query', '${name}'], "String should match pattern '${re}'", 'string_pattern_mismatch');
  v.${name} = q.${name};
} else v.${name} = ${JSON.stringify(dflt)};`;
const V = (k) => `$('Validate').first().json.value.${k}`;

const FINISH_ROW = String.raw`
// campaigns.py _finish_row
const finishRow = (r) => {
  const d = { ...r };
  for (const k of ['spend', 'leads', 'phone_calls']) d[k] = num(d[k]);
  d.impressions = Math.trunc(num(d.impressions));
  d.clicks = Math.trunc(num(d.clicks));
  d.ctr = d.impressions ? pyRound(d.clicks / d.impressions, 4) : null;
  d.cpl = safeDiv(d.spend, d.leads);
  return d;
};`;

const wrap = (body) => `
with ${CLIENT}
select case when exists (select 1 from cl) then json_build_object(
  'client', (select to_json(cl) from cl),
${body}
) end as data`;

export default [
  {
    file: "client-campaigns",
    method: "GET",
    path: "/api/clients/:slug/campaigns",
    auth: "user",
    libs: [FINISH_ROW],
    validate: rangeValidate(patternParam("platform", "^(meta|google)$")),
    params: `[${V("slug")}, ${V("start")}, ${V("end")}, ${V("platform")}]`,
    sql: wrap(`
  'campaigns', coalesce((
    select json_agg(x order by x.spend desc) from (
      select platform, campaign_id, max(campaign_name) as campaign_name, max(campaign_status) as campaign_status,
             sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks, sum(leads) as leads,
             sum(phone_calls) as phone_calls, max(currency) as currency
      from ad_metrics_daily
      where client_id = ${CID} and date between $2::date and $3::date and ($4::text is null or platform = $4)
      group by platform, campaign_id
    ) x), '[]'::json),
  'appts', coalesce((select json_agg(z) from (${campaignAppts(CID, "$2::date", "$3::date")}
    ) z), '[]'::json),
  'services', coalesce((
    select json_agg(z) from (
      with tagged as (
        select m.client_id, m.platform, m.campaign_id,
               coalesce(csm.service, c.default_service, 'Unclassified') service,
               sum(m.spend) spend, sum(m.leads) leads
        from ad_metrics_daily m
        join clients c on c.id = m.client_id and c.is_active
        left join campaign_service_map csm
          on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
        where m.date between $2::date and $3::date
        group by 1, 2, 3, 4
      ),
      portfolio as (
        select service, sum(spend) spend, sum(leads) leads, count(distinct client_id) clients
        from tagged where spend > 0 group by 1
      )
      select t.platform, t.campaign_id, t.service, p.clients as service_clients,
             case when p.leads > 0 then p.spend / p.leads end as service_cpl
      from tagged t left join portfolio p on p.service = t.service
      where t.client_id = ${CID}
    ) z), '[]'::json),
  'targets', coalesce((select json_agg(t) from service_targets t), '[]'::json),
  'trend', coalesce((
    select json_agg(x order by x.date) from (
      select date,
             sum(spend) filter (where platform = 'meta')   as meta_spend,
             sum(spend) filter (where platform = 'google') as google_spend,
             sum(leads) filter (where platform = 'meta')   as meta_leads,
             sum(leads) filter (where platform = 'google') as google_leads,
             sum(spend) as spend, sum(leads) as leads
      from ad_metrics_daily
      where client_id = ${CID} and date between $2::date and $3::date
      group by date
    ) x), '[]'::json),
  'ghl', (
    select json_build_object(
      'contacts_created', coalesce(sum(contacts_created), 0),
      'contacts_paid_attributed', coalesce(sum(contacts_paid_attributed), 0),
      'inbound_calls', coalesce(sum(inbound_calls), 0),
      'appointments_booked', coalesce(sum(appointments_booked), 0))
    from ghl_metrics_daily where client_id = ${CID} and date between $2::date and $3::date)`),
    shape: `
if (!data) return { status: 404, body: { detail: 'Client not found' } };
const tg = indexTargets(data.targets);
const appts = {};
for (const a of data.appts) appts[a.platform + '|' + a.campaign_id] = num(a.appointments);
const svc = {};
for (const s of data.services) svc[s.platform + '|' + s.campaign_id] = s;
const green = num(data.client.cpl_target_green), red = num(data.client.cpl_target_red);
const campaigns = data.campaigns.map((r) => {
  const c = finishRow(r);
  const key = c.platform + '|' + c.campaign_id;
  c.appointments = pyRound(appts[key] ?? 0, 1);
  c.cost_per_appt = safeDiv(c.spend, c.appointments);
  const s = svc[key];
  c.service = s ? s.service : null;
  c.service_cpl = s && s.service_cpl !== null && s.service_cpl !== undefined ? pyRound(s.service_cpl, 2) : null;
  c.service_clients = s ? Math.trunc(num(s.service_clients)) : 0;
  // _thresholds: service target → ±15% of the portfolio service CPL → client targets
  const t = resolveTarget(tg, c.service, c.platform);
  let g, rd, src;
  if (t && t.cpl_green !== null && t.cpl_green !== undefined) {
    g = Number(t.cpl_green); rd = t.cpl_red !== null && t.cpl_red !== undefined ? Number(t.cpl_red) : g * 1.5; src = 'service';
  } else if (c.service_cpl) { g = c.service_cpl * 0.85; rd = c.service_cpl * 1.15; src = 'portfolio'; }
  else { g = green; rd = red; src = 'client'; }
  c.target_cpl_green = pyRound(g, 2); c.target_cpl_red = pyRound(rd, 2); c.target_source = src;
  c.score = c.cpl === null || c.leads < 3 ? null : c.cpl <= g ? 'green' : c.cpl <= rd ? 'yellow' : 'red';
  return c;
});
const trend = data.trend.map((r) => ({ date: r.date, meta_spend: num(r.meta_spend), google_spend: num(r.google_spend),
  meta_leads: num(r.meta_leads), google_leads: num(r.google_leads), spend: num(r.spend), leads: num(r.leads) }));
return { body: { client: data.client, campaigns, trend, ghl: data.ghl } };`,
  },
  {
    file: "client-periods",
    method: "GET",
    path: "/api/clients/:slug/periods",
    auth: "user",
    validate: rangeValidate(patternParam("granularity", "^(daily|weekly|monthly)$", "weekly") + patternParam("platform", "^(meta|google)$")),
    params: `[${V("slug")}, ${V("start")}, ${V("end")}, ({ daily: 'day', weekly: 'week', monthly: 'month' })[${V("granularity")}], ${V("platform")}]`,
    sql: wrap(`
  'periods', coalesce((
    select json_agg(x order by x.period desc) from (
      with ads as (
        select date_trunc($4::text, date)::date as period,
               sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
               sum(leads) as leads, sum(phone_calls) as phone_calls
        from ad_metrics_daily
        where client_id = ${CID} and date between $2::date and $3::date and ($5::text is null or platform = $5)
        group by 1
      ),
      ghl as (
        select date_trunc($4::text, date)::date as period,
               sum(contacts_created) as ghl_contacts, sum(contacts_paid_attributed) as ghl_paid,
               sum(inbound_calls) as ghl_calls, sum(appointments_booked) as appointments,
               sum(jobs_won) as jobs_won, sum(revenue_won) as revenue_won
        from ghl_metrics_daily
        where client_id = ${CID} and date between $2::date and $3::date
        group by 1
      )
      select coalesce(a.period, g.period) as period,
             coalesce(a.spend, 0) as spend, coalesce(a.impressions, 0) as impressions,
             coalesce(a.clicks, 0) as clicks, coalesce(a.leads, 0) as leads,
             coalesce(a.phone_calls, 0) as phone_calls,
             coalesce(g.ghl_contacts, 0) as ghl_contacts, coalesce(g.ghl_paid, 0) as ghl_paid,
             coalesce(g.ghl_calls, 0) as ghl_calls, coalesce(g.appointments, 0) as appointments,
             coalesce(g.jobs_won, 0) as jobs_won, coalesce(g.revenue_won, 0) as revenue_won
      from ads a full outer join ghl g using (period)
    ) x), '[]'::json)`),
    shape: `
if (!data) return { status: 404, body: { detail: 'Client not found' } };
const periods = data.periods.map((r) => {
  const d = { ...r };
  for (const k of ['spend', 'leads', 'phone_calls', 'revenue_won']) d[k] = num(d[k]);
  for (const k of ['impressions', 'clicks', 'ghl_contacts', 'ghl_paid', 'ghl_calls', 'appointments', 'jobs_won']) d[k] = Math.trunc(num(d[k]));
  d.ctr = d.impressions ? pyRound(d.clicks / d.impressions, 4) : null;
  d.cpl = safeDiv(d.spend, d.leads);
  d.cost_per_appt = safeDiv(d.spend, d.appointments);
  d.roas = safeDiv(d.revenue_won, d.spend);
  return d;
});
return { body: { client: data.client, granularity: input.granularity, periods } };`,
  },
  {
    file: "client-creatives",
    method: "GET",
    path: "/api/clients/:slug/creatives",
    auth: "user",
    libs: [FINISH_ROW],
    validate: rangeValidate(),
    params: `[${V("slug")}, ${V("start")}, ${V("end")}]`,
    sql: wrap(`
  'ads', coalesce((
    select json_agg(x order by x.leads desc, x.spend desc) from (
      select m.ad_id, m.platform,
             max(m.ad_name) as ad_name, max(cn.campaign_name) as campaign_name,
             sum(m.spend) as spend, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
             sum(m.leads) as leads, sum(m.phone_calls) as phone_calls, max(m.currency) as currency,
             sum(m.spend) filter (where m.date <  mid.d) as spend_a,
             sum(m.leads) filter (where m.date <  mid.d) as leads_a,
             sum(m.spend) filter (where m.date >= mid.d) as spend_b,
             sum(m.leads) filter (where m.date >= mid.d) as leads_b,
             max(m.date) as last_active,
             max(c.preview_link) as preview_link, max(c.thumbnail_url) as thumbnail_url
      from ad_level_metrics_daily m
      cross join (select $2::date + (($3::date - $2::date) / 2) as d) mid
      left join meta_ad_creatives c on c.ad_id = m.ad_id
      left join lateral (
        select a.campaign_name from ad_metrics_daily a
        where a.client_id = m.client_id and a.platform = m.platform and a.campaign_id = m.campaign_id
        order by a.date desc limit 1
      ) cn on true
      where m.client_id = ${CID} and m.date between $2::date and $3::date
      group by m.ad_id, m.platform
    ) x), '[]'::json)`),
    shape: `
if (!data) return { status: 404, body: { detail: 'Client not found' } };
const green = num(data.client.cpl_target_green), red = num(data.client.cpl_target_red);
const grade = (spend, leads) => {
  if (leads > 0) { const cpl = spend / leads; return cpl <= green ? 'winner' : cpl <= red ? 'ok' : 'underperforming'; }
  return spend >= red ? 'underperforming' : 'learning';
};
const trendOf = (sa, la, sb, lb) => {
  sa = num(sa); sb = num(sb); la = num(la); lb = num(lb);
  if (sa < red || sb < red) return null;
  const a = la ? sa / la : null, b = lb ? sb / lb : null;
  if (a === null && b === null) return null;
  if (b === null) return 'fatiguing';
  if (a === null) return 'improving';
  if (b > a * 1.5) return 'fatiguing';
  if (b < a * 0.67) return 'improving';
  return 'stable';
};
const out = data.ads.map((r) => {
  const d = finishRow(r);
  d.last_active = d.last_active || null;
  d.grade = grade(d.spend, d.leads);
  d.trend = trendOf(r.spend_a, r.leads_a, r.spend_b, r.leads_b);
  for (const k of ['spend_a', 'leads_a', 'spend_b', 'leads_b']) delete d[k];
  return d;
});
return { body: out };`,
  },
  {
    file: "client-top-ads",
    method: "GET",
    path: "/api/clients/:slug/top-ads",
    auth: "user",
    libs: [FINISH_ROW],
    validate: rangeValidate(`
if (q.limit !== undefined && q.limit !== '') {
  const n = Number(q.limit);
  if (!Number.isInteger(n)) return invalid(['query', 'limit'], 'Input should be a valid integer, unable to parse string as an integer', 'int_parsing');
  if (n < 1) return invalid(['query', 'limit'], 'Input should be greater than or equal to 1', 'greater_than_equal');
  if (n > 25) return invalid(['query', 'limit'], 'Input should be less than or equal to 25', 'less_than_equal');
  v.limit = n;
} else v.limit = 6;`),
    params: `[${V("slug")}, ${V("start")}, ${V("end")}, ${V("limit")}]`,
    sql: wrap(`
  'ads', coalesce((
    select json_agg(x) from (
      select m.ad_id, m.platform, max(m.ad_name) as ad_name, max(m.campaign_id) as campaign_id,
             sum(m.spend) as spend, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
             sum(m.leads) as leads, sum(m.phone_calls) as phone_calls, max(m.currency) as currency,
             max(c.preview_link) as preview_link, max(c.thumbnail_url) as thumbnail_url
      from ad_level_metrics_daily m
      left join meta_ad_creatives c on c.ad_id = m.ad_id
      where m.client_id = ${CID} and m.date between $2::date and $3::date
      group by m.ad_id, m.platform
      having sum(m.leads) > 0
      order by sum(m.leads) desc, sum(m.spend) asc
      limit $4::int
    ) x), '[]'::json)`),
    shape: "if (!data) return { status: 404, body: { detail: 'Client not found' } };\nreturn { body: data.ads.map(finishRow) };",
  },
  {
    file: "client-campaign-adsets",
    method: "GET",
    path: "/api/clients/:slug/campaigns/:campaign_id/adsets",
    auth: "user",
    libs: [FINISH_ROW],
    validate: rangeValidate(patternParam("platform", "^(meta|google)$", "meta") + "\nv.campaign_id = req.params.campaign_id;"),
    params: `[${V("slug")}, ${V("start")}, ${V("end")}, ${V("platform")}, ${V("campaign_id")}]`,
    sql: wrap(`
  'adsets', coalesce((
    select json_agg(x order by x.spend desc) from (
      select m.adset_id, max(m.adset_name) as adset_name,
             sum(m.spend) as spend, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
             sum(m.leads) as leads, sum(m.phone_calls) as phone_calls, max(m.currency) as currency,
             coalesce(max(g.appointments), 0) as ghl_appointments
      from adset_metrics_daily m
      left join lateral (
        select sum(appointments) as appointments from ghl_adset_daily gh
        where gh.client_id = m.client_id and gh.adset_name = m.adset_name and gh.date between $2::date and $3::date
      ) g on true
      where m.client_id = ${CID} and m.platform = $4 and m.campaign_id = $5 and m.date between $2::date and $3::date
      group by m.adset_id
    ) x), '[]'::json)`),
    shape: `
if (!data) return { status: 404, body: { detail: 'Client not found' } };
return { body: data.adsets.map((r) => {
  const d = finishRow(r);
  d.ghl_appointments = Math.trunc(num(d.ghl_appointments));
  d.cost_per_appt = safeDiv(d.spend, d.ghl_appointments);
  return d;
}) };`,
  },
  {
    file: "client-adset-ads",
    method: "GET",
    path: "/api/clients/:slug/adsets/:adset_id/ads",
    auth: "user",
    libs: [FINISH_ROW],
    validate: rangeValidate(patternParam("platform", "^(meta|google)$", "meta") + "\nv.adset_id = req.params.adset_id;"),
    params: `[${V("slug")}, ${V("start")}, ${V("end")}, ${V("platform")}, ${V("adset_id")}]`,
    sql: wrap(`
  'ads', coalesce((
    select json_agg(x order by x.spend desc) from (
      select m.ad_id, max(m.ad_name) as ad_name,
             sum(m.spend) as spend, sum(m.impressions) as impressions, sum(m.clicks) as clicks,
             sum(m.leads) as leads, sum(m.phone_calls) as phone_calls, max(m.currency) as currency,
             max(c.preview_link) as preview_link, max(c.thumbnail_url) as thumbnail_url
      from ad_level_metrics_daily m
      left join meta_ad_creatives c on c.ad_id = m.ad_id
      where m.client_id = ${CID} and m.platform = $4 and m.adset_id = $5 and m.date between $2::date and $3::date
      group by m.ad_id
    ) x), '[]'::json)`),
    shape: "if (!data) return { status: 404, body: { detail: 'Client not found' } };\nreturn { body: data.ads.map(finishRow) };",
  },
];

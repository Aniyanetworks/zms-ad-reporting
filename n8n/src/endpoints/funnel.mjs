// GET /api/clients/{slug}/funnel — port of routers/funnel.py.
import { campaignAppts } from "../libs/sql.mjs";

const CID = "(select id from cl)";
const RANGE = "$2::date and $3::date";

export default [
  {
    file: "client-funnel",
    method: "GET",
    path: "/api/clients/:slug/funnel",
    auth: "user",
    validate: "const q = req.query || {};\nreturn requireRange(q) || { slug: req.params.slug, start: q.start, end: q.end };",
    params: "[$('Validate').first().json.value.slug, $('Validate').first().json.value.start, $('Validate').first().json.value.end]",
    sql: `
with cl as (select id, name, slug, booking_system, cpl_target_green, cpl_target_red, avg_job_value from clients where slug = $1)
select case when exists (select 1 from cl) then json_build_object(
  'client', (select to_json(cl) from cl),
  'platforms', coalesce((
    select json_agg(x) from (
      select platform,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(leads) leads, sum(phone_calls) phone_calls,
             sum(reach) reach, sum(unique_link_clicks) unique_link_clicks, sum(unique_outbound_clicks) unique_outbound_clicks,
             sum(video_3s_plays) video_3s_plays, sum(thruplays) thruplays
      from ad_metrics_daily where client_id = ${CID} and date between ${RANGE}
      group by platform
    ) x), '[]'::json),
  'campaigns', coalesce((
    select json_agg(x order by x.spend desc) from (
      select m.platform, m.campaign_id, max(m.campaign_name) campaign_name, max(m.campaign_status) campaign_status,
             coalesce(max(csm.service), 'Unclassified') service,
             sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads, sum(m.phone_calls) phone_calls,
             sum(m.reach) reach, sum(m.unique_link_clicks) unique_link_clicks, sum(m.unique_outbound_clicks) unique_outbound_clicks,
             sum(m.video_3s_plays) video_3s_plays, sum(m.thruplays) thruplays
      from ad_metrics_daily m
      left join campaign_service_map csm on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
      where m.client_id = ${CID} and m.date between ${RANGE}
      group by m.platform, m.campaign_id
    ) x), '[]'::json),
  'adsets', coalesce((
    select json_agg(x order by x.spend desc) from (
      select m.campaign_id, m.adset_id, max(m.adset_name) adset_name,
             sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads, sum(m.phone_calls) phone_calls,
             sum(m.reach) reach, sum(m.unique_link_clicks) unique_link_clicks, sum(m.unique_outbound_clicks) unique_outbound_clicks,
             sum(m.video_3s_plays) video_3s_plays, sum(m.thruplays) thruplays,
             coalesce(max(g.contacts_paid), 0) ghl_contacts, coalesce(max(g.appointments), 0) ghl_appointments
      from adset_metrics_daily m
      left join lateral (
        select sum(contacts_paid) contacts_paid, sum(appointments) appointments from ghl_adset_daily gh
        where gh.client_id = m.client_id and gh.adset_name = m.adset_name and gh.date between ${RANGE}
      ) g on true
      where m.client_id = ${CID} and m.platform = 'meta' and m.date between ${RANGE}
      group by m.campaign_id, m.adset_id
    ) x), '[]'::json),
  'video', coalesce((
    select json_agg(x) from (
      select campaign_id, adset_id, sum(impressions) video_impressions
      from ad_level_metrics_daily
      where client_id = ${CID} and platform = 'meta' and date between ${RANGE} and video_3s_plays > 0
      group by campaign_id, adset_id
    ) x), '[]'::json),
  'budgets', coalesce((
    select json_agg(b) from (
      select platform, entity_type, entity_id, campaign_id, status, daily_budget, lifetime_budget, budget_source
      from campaign_budgets where client_id = ${CID}
    ) b), '[]'::json),
  'ghl', (
    select to_json(g) from (
      select sum(contacts_created) contacts, sum(contacts_paid_attributed) contacts_paid, sum(leads_dq) leads_dq,
             sum(inbound_calls) inbound_calls, sum(appointments_booked) booked, sum(appointments_all) booked_all,
             sum(appointments_confirmed) confirmed, sum(appointments_showed) showed, sum(appointments_noshow) noshow,
             sum(jobs_won) won, sum(revenue_won) revenue
      from ghl_metrics_daily where client_id = ${CID} and date between ${RANGE}
    ) g),
  'appts', coalesce((select json_agg(z) from (${campaignAppts(CID, "$2::date", "$3::date")}
  ) z), '[]'::json)
) end as data`,
    shape: String.raw`
if (!data) return { status: 404, body: { detail: 'Client not found' } };
const CTR_RED = 0.01, CTR_YELLOW = 0.015, CPC_YELLOW = 3.0, HOOK_GOOD = 0.20, HOOK_GREAT = 0.35,
  HOLD_GOOD = 0.20, HOLD_GREAT = 0.40, FREQUENCY_WATCH = 3.0;
const _f = num;
const div = (a, b, nd = 2) => (b ? pyRound(a / b, nd) : null);
const rhe = (x) => { const f = Math.floor(x); const d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
const pct = (x, nd) => (nd ? (x * 100).toFixed(nd) : String(rhe(x * 100))) + '%';

const signals = (m) => {
  const s = [];
  const ctr = m.unique_ctr !== null ? m.unique_ctr : m.ctr;
  if (m.impressions >= 1000 && ctr !== null) {
    if (ctr < CTR_RED) s.push({ level: 'red', metric: 'ctr', text: 'CTR ' + pct(ctr, 2) + " — under 1%, the ad isn't compelling enough" });
    else if (ctr < CTR_YELLOW) s.push({ level: 'yellow', metric: 'ctr', text: 'CTR ' + pct(ctr, 2) + ' — aim for ≥1.5%' });
  }
  const cpc = m.cost_per_unique_click || m.cpc;
  if (cpc !== null && m.clicks >= 30 && cpc > CPC_YELLOW) {
    const label = m.cost_per_unique_click ? 'unique click' : 'click';
    s.push({ level: 'yellow', metric: 'cpc', text: '$' + cpc.toFixed(2) + ' per ' + label + ' — above the $3 comfort range' });
  }
  if (m.frequency !== null && m.reach >= 1000 && m.frequency > FREQUENCY_WATCH) {
    s.push({ level: 'yellow', metric: 'frequency', text: 'Frequency ' + m.frequency.toFixed(1) + ' — same people seeing it repeatedly; watch CPMr and refresh creative' });
  }
  if (m.hook_rate !== null && m.video_impressions >= 1000 && m.video_3s_plays > 0) {
    if (m.hook_rate < HOOK_GOOD) s.push({ level: 'yellow', metric: 'hook', text: 'Hook rate ' + pct(m.hook_rate) + " — under 20%, first 3 seconds aren't grabbing" });
    else if (m.hook_rate >= HOOK_GREAT) s.push({ level: 'green', metric: 'hook', text: 'Hook rate ' + pct(m.hook_rate) + ' — very good' });
  }
  if (m.hold_rate !== null && m.video_3s_plays >= 200) {
    if (m.hold_rate < HOLD_GOOD) s.push({ level: 'yellow', metric: 'hold', text: 'Hold rate ' + pct(m.hold_rate) + " — attention doesn't stick past the hook" });
    else if (m.hold_rate >= HOLD_GREAT) s.push({ level: 'green', metric: 'hold', text: 'Hold rate ' + pct(m.hold_rate) + ' — extremely good' });
  }
  return s;
};

const adMetrics = (d) => {
  const spend = _f(d.spend), imps = _f(d.impressions), clicks = _f(d.clicks);
  const reach = _f(d.reach), ulc = _f(d.unique_link_clicks), uoc = _f(d.unique_outbound_clicks);
  const v3 = _f(d.video_3s_plays), thru = _f(d.thruplays);
  const leads = _f(d.leads), calls = _f(d.phone_calls);
  const outbound = uoc > 0 && uoc >= 0.5 * ulc;
  const unique = outbound ? uoc : ulc;
  const vimps = _f(d.video_impressions) || imps;
  const hasVideo = v3 > 0;
  const out = {
    spend: pyRound(spend, 2), impressions: Math.trunc(imps), clicks: Math.trunc(clicks), leads, phone_calls: calls,
    cpl: div(spend, leads),
    unique_clicks: Math.trunc(unique), unique_click_kind: outbound ? 'outbound' : ulc > 0 ? 'link' : null,
    cost_per_unique_click: unique ? div(spend, unique) : null, unique_ctr: unique ? div(unique, imps, 4) : null,
    ctr: div(clicks, imps, 4), cpc: div(spend, clicks),
    reach: Math.trunc(reach), frequency: div(imps, reach, 2),
    cpm: div(spend * 1000, imps), cpmr: div(spend * 1000, reach),
    video_3s_plays: v3, thruplays: thru,
    video_impressions: hasVideo ? Math.trunc(vimps) : 0,
    hook_rate: hasVideo ? div(v3, vimps, 4) : null, hold_rate: hasVideo ? div(thru, v3, 4) : null,
  };
  out.signals = signals(out);
  return out;
};

const bottleneck = (leads, qualified, booked, showed, won, noshow) => {
  if (leads >= 20 && qualified / leads < 0.4) return 'Lots of leads but few qualified — ads are attracting the wrong people (ads & messaging problem).';
  if (booked >= 10 && noshow / booked > 0.35) return 'Lots of bookings but many no-shows — automation, follow-up or confirmation-page problem.';
  if (showed >= 8 && won / showed < 0.15) return 'Plenty of shows but few closes — pre-call education or sales problem; train the closers.';
  if (qualified >= 20 && booked / qualified < 0.2) return "Qualified leads aren't getting booked — setter speed-to-lead and follow-up problem.";
  return null;
};

const funnel = (spend, leads, g, avgJobValue) => {
  const contacts = _f(g.contacts), contactsPaid = _f(g.contacts_paid);
  const dqAll = _f(g.leads_dq);
  const dq = contacts > 0 && contactsPaid > 0 ? dqAll * (contactsPaid / contacts) : dqAll;
  const booked = _f(g.booked), confirmed = _f(g.confirmed), showed = _f(g.showed), noshow = _f(g.noshow);
  const won = _f(g.won), revenue = _f(g.revenue);
  const base = contactsPaid > 0 ? contactsPaid : leads;
  const qualified = base ? Math.max(base - dq, booked) : booked;
  const confirmedTracked = confirmed > 0 || booked === 0;
  const showedTracked = showed + noshow > 0 || booked === 0;
  const wonTracked = won > 0 || booked === 0;
  const stages = [
    { key: 'leads', label: 'Leads', count: leads, pct_of_prev: null, cost_per: div(spend, leads), tracked: true },
    { key: 'qualified', label: 'Qualified', count: pyRound(qualified, 1), pct_of_prev: div(qualified, base, 4), cost_per: div(spend, qualified), tracked: contactsPaid > 0, estimate: true },
    { key: 'booked', label: 'Booked', count: booked, pct_of_prev: div(booked, qualified || base, 4), cost_per: div(spend, booked), tracked: true },
    { key: 'confirmed', label: 'Confirmed', count: confirmed, pct_of_prev: confirmedTracked ? div(confirmed, booked, 4) : null, cost_per: confirmedTracked ? div(spend, confirmed) : null, tracked: confirmedTracked },
    { key: 'showed', label: 'Showed', count: showed, pct_of_prev: showedTracked ? div(showed, booked, 4) : null, cost_per: showedTracked ? div(spend, showed) : null, tracked: showedTracked },
    { key: 'won', label: 'Closed', count: won, pct_of_prev: wonTracked ? div(won, showed || booked, 4) : null, cost_per: wonTracked ? div(spend, won) : null, tracked: wonTracked },
  ];
  return {
    contacts, contacts_paid: contactsPaid, junk: pyRound(dq, 1), junk_all: dqAll, inbound_calls: _f(g.inbound_calls),
    booked_all: _f(g.booked_all), noshow, noshow_rate: showedTracked ? div(noshow, booked, 4) : null,
    tracked: { confirmed: confirmedTracked, showed: showedTracked, won: wonTracked },
    stages,
    cac: wonTracked ? div(spend, won) : null, revenue, roas: revenue ? div(revenue, spend, 2) : null,
    expected_revenue: avgJobValue && won && !revenue ? pyRound(won * _f(avgJobValue), 2) : null,
    bottleneck: bottleneck(leads, qualified, booked, showed, won, noshow),
  };
};

const client = data.client;
const platforms = {};
for (const r of data.platforms) platforms[r.platform] = r;
const KEYS = ['spend', 'impressions', 'clicks', 'leads', 'phone_calls', 'reach', 'unique_link_clicks', 'unique_outbound_clicks', 'video_3s_plays', 'thruplays'];
const total = {};
for (const k of KEYS) total[k] = Object.values(platforms).reduce((s, p) => s + _f(p[k]), 0);
const budgets = {};
for (const b of data.budgets) budgets[b.platform + '|' + b.entity_type + '|' + b.entity_id] = b;
const budgetOf = (platform, et, id) => {
  const b = budgets[platform + '|' + et + '|' + id];
  if (!b) return { delivery: null, daily_budget: null, lifetime_budget: null, budget_source: null };
  return { delivery: b.status, daily_budget: _f(b.daily_budget) || null, lifetime_budget: _f(b.lifetime_budget) || null, budget_source: b.budget_source };
};
const g = data.ghl || {};
const vc = {}, va = {};
for (const r of data.video) { vc[r.campaign_id] = (vc[r.campaign_id] || 0) + _f(r.video_impressions); va[r.adset_id] = (va[r.adset_id] || 0) + _f(r.video_impressions); }
total.video_impressions = Object.values(vc).reduce((s, v) => s + v, 0);
const clientRow = adMetrics(total);
let activeDaily = 0;
for (const b of data.budgets) {
  if (!['ACTIVE', 'ENABLED'].includes(String(b.status || '').toUpperCase())) continue;
  if (b.entity_type === 'campaign' && b.budget_source === 'campaign' && b.daily_budget) activeDaily += _f(b.daily_budget);
  else if (b.entity_type === 'adset' && b.budget_source === 'adset' && b.daily_budget) activeDaily += _f(b.daily_budget);
}
clientRow.daily_budget = pyRound(activeDaily, 2) || null;
clientRow.delivery = null;
clientRow.funnel = funnel(total.spend, total.leads, g, client.avg_job_value);

const appts = {};
for (const r of data.appts) appts[r.platform + '|' + r.campaign_id] = _f(r.appointments);
const campaigns = data.campaigns.map((d) => {
  const m = adMetrics({ ...d, video_impressions: vc[d.campaign_id] || 0 });
  Object.assign(m, { platform: d.platform, campaign_id: d.campaign_id, campaign_name: d.campaign_name, campaign_status: d.campaign_status, service: d.service });
  Object.assign(m, budgetOf(d.platform, 'campaign', d.campaign_id));
  m.booked = pyRound(appts[d.platform + '|' + d.campaign_id] || 0, 1);
  m.booked_rate = div(m.booked, m.leads, 4);
  m.cost_per_booked = div(m.spend, m.booked);
  return m;
});
const adsets = data.adsets.map((d) => {
  const m = adMetrics({ ...d, video_impressions: va[d.adset_id] || 0 });
  Object.assign(m, { campaign_id: d.campaign_id, adset_id: d.adset_id, adset_name: d.adset_name,
    ghl_contacts: Math.trunc(_f(d.ghl_contacts)), booked: Math.trunc(_f(d.ghl_appointments)) });
  Object.assign(m, budgetOf('meta', 'adset', d.adset_id));
  m.booked_rate = div(m.booked, m.leads, 4);
  m.cost_per_booked = div(m.spend, m.booked);
  return m;
});
const plat = {};
for (const [k, v] of Object.entries(platforms)) plat[k] = adMetrics(v);
return { body: {
  client: { name: client.name, slug: client.slug, booking_system: client.booking_system,
    cpl_target_green: _f(client.cpl_target_green), cpl_target_red: _f(client.cpl_target_red) },
  range: { start: input.start, end: input.end },
  benchmarks: { ctr_red: CTR_RED, ctr_yellow: CTR_YELLOW, cpc_yellow: CPC_YELLOW, hook_good: HOOK_GOOD,
    hook_great: HOOK_GREAT, hold_good: HOLD_GOOD, hold_great: HOLD_GREAT, frequency_watch: FREQUENCY_WATCH },
  totals: clientRow, platforms: plat, campaigns, adsets,
} };`,
  },
];

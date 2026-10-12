// GET /api/audit-log (routers/audit.py) and the AI analysis bundles (routers/export.py).

// export.py build_bundle() for every client whose slug is in $1::text[]; $2 start, $3 end,
// $4 include_daily. Ordered by slug. Client rows come back as JSON; JS attaches dailies.
const BUNDLE_SQL = `
select coalesce(json_agg(b order by b.slug), '[]'::json) as data from (
  select c.slug, json_build_object(
    'client', to_json(c),
    'campaigns', coalesce((select json_agg(x order by x.spend desc) from (
      select m.platform, m.campaign_id, max(m.campaign_name) campaign_name, max(m.campaign_status) campaign_status,
             max(coalesce(csm.service, cc.default_service)) service,
             sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks,
             sum(m.leads) leads, sum(m.phone_calls) phone_calls, max(m.currency) currency,
             min(m.date) first_date, max(m.date) last_date
      from ad_metrics_daily m
      join clients cc on cc.id = m.client_id
      left join campaign_service_map csm on csm.client_id = m.client_id and csm.platform = m.platform and csm.campaign_id = m.campaign_id
      where m.client_id = c.id and m.date between $2::date and $3::date
      group by m.platform, m.campaign_id) x), '[]'::json),
    'campaign_daily', case when $4::boolean then coalesce((select json_agg(x order by x.platform, x.campaign_id, x.date) from (
      select platform, campaign_id, date, spend, impressions, clicks, leads, phone_calls
      from ad_metrics_daily where client_id = c.id and date between $2::date and $3::date) x), '[]'::json) end,
    'adsets', coalesce((select json_agg(x order by x.spend desc) from (
      select campaign_id, adset_id, max(adset_name) adset_name,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(leads) leads,
             min(date) first_date, max(date) last_date
      from adset_metrics_daily where client_id = c.id and platform = 'meta' and date between $2::date and $3::date
      group by campaign_id, adset_id) x), '[]'::json),
    'adset_daily', case when $4::boolean then coalesce((select json_agg(x order by x.adset_id, x.date) from (
      select adset_id, date, spend, impressions, clicks, leads
      from adset_metrics_daily where client_id = c.id and platform = 'meta' and date between $2::date and $3::date) x), '[]'::json) end,
    'ads', coalesce((select json_agg(x order by x.spend desc) from (
      select m.campaign_id, m.adset_id, m.ad_id, max(m.ad_name) ad_name,
             sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) leads,
             min(m.date) first_date, max(m.date) last_date,
             max(cr.status) status, max(cr.effective_status) effective_status, max(cr.created_time) created_time,
             max(cr.title) title, max(cr.body) body, max(cr.description) description, max(cr.cta_type) cta_type,
             max(cr.link_url) link_url, max(cr.url_tags) url_tags, bool_or(cr.has_adset_utm) has_adset_utm,
             max(cr.preview_link) preview_link, max(cr.thumbnail_url) thumbnail_url,
             max(cr.image_url) image_url, max(cr.video_id) video_id,
             (array_agg(cr.asset_feed_spec) filter (where cr.asset_feed_spec is not null))[1] asset_feed_spec
      from ad_level_metrics_daily m
      left join meta_ad_creatives cr on cr.ad_id = m.ad_id
      where m.client_id = c.id and m.platform = 'meta' and m.date between $2::date and $3::date
      group by m.campaign_id, m.adset_id, m.ad_id) x), '[]'::json),
    'ad_daily', case when $4::boolean then coalesce((select json_agg(x order by x.ad_id, x.date) from (
      select ad_id, date, spend, impressions, clicks, leads
      from ad_level_metrics_daily where client_id = c.id and platform = 'meta' and date between $2::date and $3::date) x), '[]'::json) end,
    'g_ad_groups', coalesce((select json_agg(x order by x.spend desc) from (
      select campaign_id, max(campaign_name) campaign_name, ad_group_id, max(ad_group_name) ad_group_name,
             max(ad_group_status) status, max(ad_group_type) type,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions, sum(phone_calls) phone_calls
      from google_adgroup_metrics_daily where client_id = c.id and date between $2::date and $3::date
      group by campaign_id, ad_group_id) x), '[]'::json),
    'g_ads', coalesce((select json_agg(x order by x.spend desc) from (
      select campaign_id, ad_group_id, max(ad_group_name) ad_group_name, ad_id, max(ad_name) ad_name, max(ad_type) ad_type,
             max(ad_status) status, max(ad_strength) ad_strength,
             (array_agg(final_urls order by date desc))[1] final_urls,
             (array_agg(headlines order by date desc))[1] headlines,
             (array_agg(descriptions order by date desc))[1] descriptions,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
      from google_ad_metrics_daily where client_id = c.id and date between $2::date and $3::date
      group by campaign_id, ad_group_id, ad_id) x), '[]'::json),
    'g_keywords', coalesce((select json_agg(x order by x.spend desc) from (
      select campaign_id, ad_group_id, criterion_id, max(keyword_text) keyword_text, max(match_type) match_type,
             max(keyword_status) status,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
      from google_keyword_metrics_daily where client_id = c.id and date between $2::date and $3::date
      group by campaign_id, ad_group_id, criterion_id) x), '[]'::json),
    'g_search_terms', coalesce((select json_agg(x) from (
      select campaign_id, ad_group_id, search_term, max(term_status) term_status,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
      from google_search_terms_daily where client_id = c.id and date between $2::date and $3::date
      group by campaign_id, ad_group_id, search_term order by sum(spend) desc, sum(impressions) desc
      limit 2000) x), '[]'::json),
    'ghl_daily', coalesce((select json_agg(x order by x.date) from (
      select date, contacts_created, contacts_paid_attributed, inbound_calls, leads_dq,
             appointments_booked as appointments_paid, appointments_all, jobs_won, revenue_won
      from ghl_metrics_daily where client_id = c.id and date between $2::date and $3::date) x), '[]'::json),
    'ghl_by_adset', coalesce((select json_agg(x order by x.appointments desc) from (
      select adset_name, sum(contacts_paid) contacts_paid, sum(appointments) appointments
      from ghl_adset_daily where client_id = c.id and date between $2::date and $3::date
      group by adset_name) x), '[]'::json),
    'latest_brief', (select to_json(x) from (
      select brief_date, window_start, window_end, score, summary_md, platforms, findings
      from daily_briefs where client_id = c.id order by brief_date desc limit 1) x),
    'recommendations', coalesce((select json_agg(x order by x.created_at desc) from (
      select created_at, entity_type, entity_id, entity_name, action, current_value, proposed_value, pct_change,
             reason, evidence, risk, status
      from recommendations where client_id = c.id and created_at >= $2::date::timestamp
      order by created_at desc limit 200) x), '[]'::json)
  ) as bundle
  from (
    select id, name, slug, trade, default_service, booking_system, timezone,
           meta_ad_account_id, google_ads_customer_id, google_lsa_customer_id,
           cpl_target_green, cpl_target_red, target_cpl, target_cpba,
           avg_job_value, close_rate, gross_margin_pct, max_ad_cost_share
    from clients where slug = any($1::text[])
  ) c
) b`;

const TARGETS = "coalesce((select json_agg(t order by t.service, t.platform) from (select service, platform, cpl_green, cpl_red, cpba_green, cpba_red, source from service_targets) t), '[]'::json)";

const BUNDLE_LIB = String.raw`
const deriveRow = (d) => {
  const spend = num(d.spend), imps = Math.trunc(num(d.impressions)), clicks = Math.trunc(num(d.clicks));
  const leads = num(d.leads !== null && d.leads !== undefined ? d.leads : d.conversions);
  d.ctr = imps ? pyRound(clicks / imps, 4) : null;
  d.cpm = imps ? pyRound(spend / imps * 1000, 2) : null;
  d.cpc = clicks ? pyRound(spend / clicks, 2) : null;
  d.cpl = leads ? pyRound(spend / leads, 2) : null;
  return d;
};
const attachDaily = (rows, daily, keys) => {
  const by = new Map();
  for (const r of daily || []) {
    const k = keys.map((x) => r[x]).join('\u0000');
    const rest = {};
    for (const [kk, v] of Object.entries(r)) if (!keys.includes(kk)) rest[kk] = v;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(rest);
  }
  for (const r of rows) r.daily = by.get(keys.map((x) => r[x]).join('\u0000')) || [];
};
const NOTES = {
  leads: 'platform-reported leads (Meta lead forms / website leads, Google conversions)',
  appointments_paid: 'GHL bookings whose contact came from paid Meta/Google traffic (the number the dashboard uses)',
  appointments_all: "every booking in the GHL 'scheduled' stage regardless of source",
  'meta_ads.asset_feed_spec': 'dynamic-creative variants (all headlines/bodies/descriptions) when present',
  'google.search_terms': 'capped at the top 2,000 terms by spend for the range',
};
const buildBundle = (b, targets, start, end, includeDaily) => {
  const campaigns = b.campaigns.map(deriveRow), adsets = b.adsets.map(deriveRow), ads = b.ads.map(deriveRow);
  if (includeDaily) {
    attachDaily(campaigns, b.campaign_daily, ['platform', 'campaign_id']);
    attachDaily(adsets, b.adset_daily, ['adset_id']);
    attachDaily(ads, b.ad_daily, ['ad_id']);
  }
  return {
    generated_at: new Date().toISOString().replace(/Z$/, '') + 'Z',
    range: { start, end }, notes: NOTES, client: b.client, service_targets: targets,
    campaigns, meta_adsets: adsets, meta_ads: ads,
    google: { ad_groups: b.g_ad_groups.map(deriveRow), ads: b.g_ads.map(deriveRow), keywords: b.g_keywords.map(deriveRow), search_terms: b.g_search_terms.map(deriveRow) },
    ghl_daily: b.ghl_daily, ghl_by_adset: b.ghl_by_adset, latest_brief: b.latest_brief, recommendations: b.recommendations,
  };
};
const boolParam = (v, dflt) => {
  if (v === undefined || v === '') return dflt;
  const s = String(v).toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(s)) return false;
  return undefined;
};
const rangeDefaults = (q) => {
  for (const k of ['start', 'end']) if (q[k] !== undefined && q[k] !== '' && !isDate(q[k])) return invalid(['query', k], 'Input should be a valid date', 'date_from_datetime_parsing');
  const end = q.end || yesterdayLA();
  const start = q.start || addDays(end, -29);
  return { start, end, days: Math.round((Date.parse(end) - Date.parse(start)) / 86400000) };
};`;

const V = (k) => `$('Validate').first().json.value.${k}`;

export default [
  {
    file: "audit-log",
    method: "GET",
    path: "/api/audit-log",
    auth: "user",
    validate: `
if (user.role !== 'admin') return fail(403, 'Admin role required');
const q = req.query || {};
let limit = 100;
if (q.limit !== undefined && q.limit !== '') {
  limit = Number(q.limit);
  if (!Number.isInteger(limit)) return invalid(['query', 'limit'], 'Input should be a valid integer, unable to parse string as an integer', 'int_parsing');
  if (limit < 1 || limit > 500) return invalid(['query', 'limit'], limit < 1 ? 'Input should be greater than or equal to 1' : 'Input should be less than or equal to 500', limit < 1 ? 'greater_than_equal' : 'less_than_equal');
}
const cs = q.client_slug, act = q.action;
if (cs && (cs.length > 100 || !/^[a-z0-9-]*$/.test(cs))) return invalid(['query', 'client_slug'], "String should match pattern '^[a-z0-9-]*$'", 'string_pattern_mismatch');
if (act && (act.length > 100 || !/^[a-z_.]*$/.test(act))) return invalid(['query', 'action'], "String should match pattern '^[a-z_.]*$'", 'string_pattern_mismatch');
return { limit, client_slug: cs || null, action: act || null };`,
    params: `[${V("limit")}, ${V("client_slug")}, ${V("action")}]`,
    sql: `
select coalesce(json_agg(x order by x.at desc), '[]'::json) as data from (
  select a.*, host(a.ip) as ip_text, c.slug as client_slug, c.name as client_name
  from audit_log a left join clients c on c.id = a.client_id
  where ($2::text is null or c.slug = $2) and ($3::text is null or a.action = $3)
  order by a.at desc limit $1::int
) x`,
    shape: "return { body: data.map(({ ip_text, ...r }) => ({ ...r, ip: r.ip === null || r.ip === undefined ? null : ip_text })) };",
  },
  {
    file: "client-ai-bundle",
    method: "GET",
    path: "/api/clients/:slug/ai-bundle",
    auth: "user",
    headers: ["Content-Disposition"],
    libs: [BUNDLE_LIB],
    validate: `
const q = req.query || {};
const r = rangeDefaults(q);
if (r.__fail) return r;
const daily = boolParam(q.daily, true), download = boolParam(q.download, false);
if (daily === undefined) return invalid(['query', 'daily'], 'Input should be a valid boolean, unable to interpret input', 'bool_parsing');
if (download === undefined) return invalid(['query', 'download'], 'Input should be a valid boolean, unable to interpret input', 'bool_parsing');
if (r.days > 400) return fail(400, 'range too large (max 400 days)');
return { slugs: [req.params.slug], start: r.start, end: r.end, daily, download };`,
    params: `[${V("slugs")}, ${V("start")}, ${V("end")}, ${V("daily")}]`,
    sql: `select json_build_object('bundles', (${BUNDLE_SQL.trim().replace(/\s+as data$/, "")}), 'targets', ${TARGETS}) as data`,
    shape: `
if (!data.bundles.length) return { status: 404, body: { detail: 'Client not found' } };
const b = buildBundle(data.bundles[0].bundle, data.targets, input.start, input.end, input.daily);
const headers = input.download ? { 'Content-Disposition': 'attachment; filename="' + req.params.slug + '-ads-data-' + input.start + '_' + input.end + '.json"' } : {};
return { body: b, headers };`,
  },
  {
    file: "portfolio-ai-bundle",
    method: "GET",
    path: "/api/export/ai-bundle",
    auth: "user",
    headers: ["Content-Disposition"],
    libs: [BUNDLE_LIB],
    validate: `
const q = req.query || {};
const r = rangeDefaults(q);
if (r.__fail) return r;
const daily = boolParam(q.daily, false), download = boolParam(q.download, false);
if (daily === undefined) return invalid(['query', 'daily'], 'Input should be a valid boolean, unable to interpret input', 'bool_parsing');
if (download === undefined) return invalid(['query', 'download'], 'Input should be a valid boolean, unable to interpret input', 'bool_parsing');
if (r.days > 120) return fail(400, 'range too large for the portfolio bundle (max 120 days)');
return { start: r.start, end: r.end, daily, download };`,
    params: `[${V("start")}, ${V("end")}, ${V("daily")}]`,
    sql: `select json_build_object('bundles', (${BUNDLE_SQL.trim().replace(/\s+as data$/, "")
      .replace("$1::text[]", "(select array_agg(slug) from clients where is_active)")
      .replace(/\$2::date/g, "$1::date").replace(/\$3::date/g, "$2::date").replace(/\$4::boolean/g, "$3::boolean")}), 'targets', ${TARGETS}) as data`,
    shape: `
const clients = data.bundles.map((x) => buildBundle(x.bundle, data.targets, input.start, input.end, input.daily));
const headers = input.download ? { 'Content-Disposition': 'attachment; filename="zms-portfolio-ads-data-' + input.start + '_' + input.end + '.json"' } : {};
return { body: { generated_at: new Date().toISOString(), range: { start: input.start, end: input.end }, clients }, headers };`,
  },
];

// GET /api/clients/{slug}/google-ads — port of routers/google_ads.py.

const CID = "(select id from cl)";
const RANGE = "$2::date and $3::date";

export default [
  {
    file: "client-google-ads",
    method: "GET",
    path: "/api/clients/:slug/google-ads",
    auth: "user",
    validate: `
const q = req.query || {};
const bad = requireRange(q);
if (bad) return bad;
let limit = 25;
if (q.limit !== undefined && q.limit !== '') {
  limit = Number(q.limit);
  if (!Number.isInteger(limit)) return invalid(['query', 'limit'], 'Input should be a valid integer, unable to parse string as an integer', 'int_parsing');
  if (limit < 5) return invalid(['query', 'limit'], 'Input should be greater than or equal to 5', 'greater_than_equal');
  if (limit > 200) return invalid(['query', 'limit'], 'Input should be less than or equal to 200', 'less_than_equal');
}
return { slug: req.params.slug, start: q.start, end: q.end, limit };`,
    params: "[$('Validate').first().json.value.slug, $('Validate').first().json.value.start, $('Validate').first().json.value.end]",
    sql: `
with cl as (select id, name, slug, google_ads_customer_id, cpl_target_green, cpl_target_red from clients where slug = $1)
select case when exists (select 1 from cl) then json_build_object(
  'client', (select to_json(cl) from cl),
  'campaigns', coalesce((
    select json_agg(x order by x.spend desc) from (
      select m.campaign_id, max(m.campaign_name) campaign_name, max(m.campaign_status) campaign_status,
             sum(m.spend) spend, sum(m.impressions) impressions, sum(m.clicks) clicks, sum(m.leads) conversions,
             sum(m.phone_calls) phone_calls, min(m.date) first_date, max(m.date) last_date,
             sum(m.spend) filter (where m.date > $3::date - 7) spend_7d,
             sum(m.leads) filter (where m.date > $3::date - 7) conv_7d
      from ad_metrics_daily m
      where m.client_id = ${CID} and m.platform = 'google' and m.date between ${RANGE}
      group by m.campaign_id
    ) x), '[]'::json),
  'adgroups', coalesce((
    select json_agg(x order by x.spend desc) from (
      select campaign_id, ad_group_id, max(ad_group_name) ad_group_name, max(ad_group_status) status, max(ad_group_type) type,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions, sum(phone_calls) phone_calls
      from google_adgroup_metrics_daily where client_id = ${CID} and date between ${RANGE}
      group by campaign_id, ad_group_id
    ) x), '[]'::json),
  'ads', coalesce((
    select json_agg(x order by x.spend desc) from (
      select campaign_id, ad_group_id, max(ad_group_name) ad_group_name, ad_id, max(ad_type) ad_type, max(ad_status) status,
             max(ad_strength) ad_strength,
             (array_agg(final_urls order by date desc))[1] final_urls,
             (array_agg(headlines order by date desc))[1] headlines,
             (array_agg(descriptions order by date desc))[1] descriptions,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
      from google_ad_metrics_daily where client_id = ${CID} and date between ${RANGE}
      group by campaign_id, ad_group_id, ad_id
    ) x), '[]'::json),
  'keywords', coalesce((
    select json_agg(x order by x.spend desc) from (
      select campaign_id, ad_group_id, criterion_id, max(keyword_text) keyword_text, max(match_type) match_type,
             max(keyword_status) status, sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
      from google_keyword_metrics_daily where client_id = ${CID} and date between ${RANGE}
      group by campaign_id, ad_group_id, criterion_id
    ) x), '[]'::json),
  'terms', coalesce((
    select json_agg(x order by x.spend desc, x.clicks desc) from (
      select campaign_id, search_term, max(term_status) term_status,
             sum(spend) spend, sum(impressions) impressions, sum(clicks) clicks, sum(conversions) conversions
      from google_search_terms_daily where client_id = ${CID} and date between ${RANGE}
      group by campaign_id, search_term
    ) x), '[]'::json),
  'landing', coalesce((
    select json_agg(x order by x.spend_30d desc) from (
      select url, platforms, spend_30d, http_status, final_url, title, has_form, has_tel_link, looks_thank_you,
             client_rendered, flags, status, error, checked_at
      from landing_page_checks where client_id = ${CID}
    ) x), '[]'::json),
  'budgets', coalesce((
    select json_agg(b) from (
      select campaign_id, status, daily_budget, lifetime_budget from campaign_budgets
      where client_id = ${CID} and platform = 'google' and entity_type = 'campaign'
    ) b), '[]'::json)
) end as data`,
    shape: String.raw`
if (!data) return { status: 404, body: { detail: 'Client not found' } };
const OFF_INTENT = ['how to', 'diy', 'ideas', 'pictures', 'jobs', 'salary', 'near me free', 'cheap', 'free ',
  'repair', 'fix', 'windshield', 'car ', 'auto ', 'paint for', 'spray paint', 'home depot', 'lowes', 'ikea',
  'wikipedia', 'reddit', 'youtube', 'software', 'template', 'course'];
const _f = num;
const grp = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const rhe = (x) => { const f = Math.floor(x); const d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
const pct0 = (x) => rhe(x * 100) + '%';
const derive = (d) => {
  const spend = _f(d.spend), clicks = Math.trunc(_f(d.clicks)), imps = Math.trunc(_f(d.impressions)), conv = _f(d.conversions);
  Object.assign(d, { spend, clicks, impressions: imps, conversions: conv });
  d.ctr = imps ? pyRound(clicks / imps, 4) : null;
  d.cpc = clicks ? pyRound(spend / clicks, 2) : null;
  d.cost_per_conv = conv ? pyRound(spend / conv, 2) : null;
  return d;
};
const termFlag = (t) => {
  const text = ' ' + t.search_term.toLowerCase() + ' ';
  if (OFF_INTENT.some((w) => text.includes(w))) return 'off-intent';
  if (t.conversions > 0) return 'converting';
  if (t.term_status === 'NONE' && t.clicks >= 3 && t.conversions === 0) return 'unmanaged, no conv';
  if (t.term_status === 'NONE') return 'not a keyword';
  return null;
};
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const green = _f(data.client.cpl_target_green), red = _f(data.client.cpl_target_red);
const campaignFlags = (c, adgroups, ads, keywords, terms, landing) => {
  const flags = [];
  const spend = c.spend, clicks = c.clicks, conv = c.conversions;
  if (clicks >= 200 && c.cpc !== null && c.cpc < 1.5 && conv === 0) {
    flags.push({ level: 'red', text: clicks + ' clicks at $' + c.cpc.toFixed(2) + ' CPC and 0 conversions — junk traffic (broad match, search partners or display expansion). Pause or rebuild.' });
  } else if (spend >= Math.max(150, 2 * green) && conv === 0) {
    flags.push({ level: 'red', text: '$' + grp(spend, 0) + ' spent, 0 conversions.' });
  }
  if (c.cost_per_conv !== null && conv >= 3 && c.cost_per_conv > red) {
    flags.push({ level: 'yellow', text: '$' + grp(c.cost_per_conv, 0) + ' per conversion vs ≤$' + grp(red, 0) + ' red line.' });
  }
  if ((c.spend_7d || 0) >= 300 && (c.conv_7d || 0) === 0 && conv > 0) {
    flags.push({ level: 'red', text: 'No conversions in the last 7 days on $' + grp(c.spend_7d, 0) + ' — check the conversion tag before touching bids.' });
  }
  const tspend = sum(terms, (t) => t.spend);
  const unmanaged = sum(terms.filter((t) => t.term_status === 'NONE'), (t) => t.spend);
  if (tspend >= 200 && unmanaged / tspend > 0.5) {
    flags.push({ level: 'yellow', text: pct0(unmanaged / tspend) + ' of search-term spend ($' + grp(unmanaged, 0) + ") is on queries that aren't keywords — add negatives and move winners to exact." });
  }
  const off = sum(terms.filter((t) => t.flag === 'off-intent'), (t) => t.spend);
  if (off >= 50) flags.push({ level: 'yellow', text: '$' + grp(off, 0) + ' on off-intent queries (repair / DIY / how-to / auto).' });
  const broad = sum(keywords.filter((k) => k.match_type === 'BROAD'), (k) => k.spend);
  const kspend = sum(keywords, (k) => k.spend);
  if (kspend >= 100 && broad / kspend > 0.5) flags.push({ level: 'yellow', text: pct0(broad / kspend) + ' of keyword spend is broad match.' });
  const weak = ads.filter((a) => a.ad_type === 'RESPONSIVE_SEARCH_AD' && ((a.headlines || []).length < 8 || ['POOR', 'AVERAGE'].includes(a.ad_strength || '')));
  if (weak.length) flags.push({ level: 'yellow', text: weak.length + ' RSA' + (weak.length !== 1 ? 's' : '') + ' with under 8 headlines or Poor/Average strength.' });
  const urls = new Set(ads.flatMap((a) => a.final_urls || []));
  for (const u of urls) {
    const lp = landing[u];
    if (lp && lp.status === 'red') flags.push({ level: 'red', text: 'Landing page ' + u + ': ' + ((lp.flags || []).join(', ') || lp.error || 'failing') + '.' });
  }
  if (adgroups.length === 1 && keywords.length >= 15) {
    const intents = new Set(keywords.filter((k) => k.keyword_text).map((k) => { const w = k.keyword_text.trim().split(/\s+/); return w[w.length - 1]; }));
    if (intents.size >= 4) flags.push({ level: 'info', text: 'One ad group holds ' + keywords.length + ' keywords across mixed intents — split by intent so each RSA matches its query.' });
  }
  return flags;
};

const campaigns = data.campaigns.map(derive);
const adgroups = data.adgroups.map(derive);
const ads = data.ads.map(derive);
const keywords = data.keywords.map(derive);
const terms = data.terms.map(derive);
for (const t of terms) t.flag = termFlag(t);
const landingRows = data.landing.map(derive);
const budgets = {};
for (const b of data.budgets) budgets[b.campaign_id] = b;
const landing = {};
for (const r of landingRows) landing[r.url] = r;
const MT = ['EXACT', 'PHRASE', 'BROAD'];
const limit = input.limit;
for (const c of campaigns) {
  c.spend_7d = _f(c.spend_7d); c.conv_7d = _f(c.conv_7d);
  const b = budgets[c.campaign_id] || {};
  c.daily_budget = _f(b.daily_budget) || null;
  c.lifetime_budget = _f(b.lifetime_budget) || null;
  const cAg = adgroups.filter((a) => a.campaign_id === c.campaign_id);
  const cAds = ads.filter((a) => a.campaign_id === c.campaign_id);
  const cKw = keywords.filter((k) => k.campaign_id === c.campaign_id);
  const cTerms = terms.filter((t) => t.campaign_id === c.campaign_id);
  const tspend = sum(cTerms, (t) => t.spend);
  c.ad_groups = cAg;
  c.ads = cAds;
  c.keywords = cKw.slice(0, limit);
  c.keyword_count = cKw.length;
  c.match_mix = {};
  for (const mt of MT) c.match_mix[mt] = pyRound(sum(cKw.filter((k) => k.match_type === mt), (k) => k.spend), 2);
  c.search_terms = cTerms.slice(0, limit);
  c.converting_terms = cTerms.filter((t) => t.conversions > 0).slice(0, limit);
  c.term_stats = {
    terms: cTerms.length, spend: pyRound(tspend, 2),
    unmanaged_spend: pyRound(sum(cTerms.filter((t) => t.term_status === 'NONE'), (t) => t.spend), 2),
    off_intent_spend: pyRound(sum(cTerms.filter((t) => t.flag === 'off-intent'), (t) => t.spend), 2),
    zero_conv_spend: pyRound(sum(cTerms.filter((t) => t.clicks >= 3 && t.conversions === 0), (t) => t.spend), 2),
    converting_spend: pyRound(sum(cTerms.filter((t) => t.conversions > 0), (t) => t.spend), 2),
  };
  const seen = new Set();
  c.landing_pages = cAds.flatMap((a) => (a.final_urls || []).filter((u) => landing[u]).map((u) => landing[u]))
    .filter((lp) => (seen.has(lp.url) ? false : (seen.add(lp.url), true)));
  c.flags = campaignFlags(c, cAg, cAds, cKw, cTerms, landing);
}
const mix = {};
for (const mt of MT) mix[mt] = pyRound(sum(keywords.filter((k) => k.match_type === mt), (k) => k.spend), 2);
const totals = {
  spend: pyRound(sum(campaigns, (c) => c.spend), 2),
  clicks: sum(campaigns, (c) => c.clicks),
  conversions: pyRound(sum(campaigns, (c) => c.conversions), 1),
  phone_calls: pyRound(sum(campaigns, (c) => _f(c.phone_calls)), 1),
  term_spend: pyRound(sum(terms, (t) => t.spend), 2),
  unmanaged_spend: pyRound(sum(terms.filter((t) => t.term_status === 'NONE'), (t) => t.spend), 2),
  off_intent_spend: pyRound(sum(terms.filter((t) => t.flag === 'off-intent'), (t) => t.spend), 2),
  match_mix: mix,
  red_flags: campaigns.reduce((s, c) => s + c.flags.filter((f) => f.level === 'red').length, 0),
  yellow_flags: campaigns.reduce((s, c) => s + c.flags.filter((f) => f.level === 'yellow').length, 0),
};
return { body: {
  client: { name: data.client.name, slug: data.client.slug, customer_id: data.client.google_ads_customer_id,
    cpl_target_green: green, cpl_target_red: red },
  range: { start: input.start, end: input.end },
  totals, campaigns, landing_pages: landingRows,
} };`,
  },
];

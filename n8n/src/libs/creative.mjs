// Port of backend/app/services/creative_diag.py — analyze(client_id, end).
// CREATIVE_SQL($1 client uuid, $2 end date) bundles every query analyze() runs.

export const CREATIVE_SQL = `
with ad as (
  select l.ad_id, l.adset_id, l.campaign_id, (l.date > $2::date - 7) cur, max(l.ad_name) ad_name,
         sum(l.spend) spend, sum(l.impressions) imps, sum(l.clicks) clicks, sum(l.leads) leads, sum(l.reach) reach,
         sum(l.unique_link_clicks) ulc, sum(l.unique_outbound_clicks) uoc,
         sum(l.video_3s_plays) v3, sum(l.thruplays) thru,
         sum((select coalesce(sum((a->>'value')::numeric), 0) from jsonb_array_elements(coalesce(l.raw->'actions', '[]'::jsonb)) a
              where a->>'action_type' = 'landing_page_view')) lpv
  from ad_level_metrics_daily l
  where l.client_id = $1::uuid and l.platform = 'meta' and l.date > $2::date - 14 and l.date <= $2::date
  group by l.ad_id, l.adset_id, l.campaign_id, (l.date > $2::date - 7)
),
names as (
  select 'campaign' kind, campaign_id id, max(campaign_name) name from ad_metrics_daily
   where client_id = $1::uuid and platform = 'meta' and date > $2::date - 30 group by campaign_id
  union all
  select 'adset', adset_id, max(adset_name) from adset_metrics_daily
   where client_id = $1::uuid and platform = 'meta' and date > $2::date - 30 group by adset_id
),
cr as (
  select cr.ad_id, cr.title, cr.body, cr.video_id, cr.image_url, cr.link_url, cr.effective_status
  from meta_ad_creatives cr where cr.ad_id in (select ad_id from ad)
),
bk as (
  select adset_name, sum(appointments) filter (where date > $2::date - 7) cur, sum(appointments) filter (where date <= $2::date - 7) prev
  from ghl_adset_daily where client_id = $1::uuid and date > $2::date - 14 and date <= $2::date group by adset_name
),
bu as (
  select entity_type, entity_id, campaign_id, status, daily_budget, budget_source
  from campaign_budgets where client_id = $1::uuid and platform = 'meta'
),
cd as (
  select campaign_id, date, sum(leads) leads, sum(spend) spend
  from ad_metrics_daily where client_id = $1::uuid and platform = 'meta' and date > $2::date - 45 and date <= $2::date
  group by campaign_id, date
)
select json_build_object(
  'ads', coalesce((select json_agg(ad) from ad), '[]'::json),
  'names', coalesce((select json_agg(names) from names), '[]'::json),
  'creatives', coalesce((select json_agg(cr) from cr), '[]'::json),
  'bookings', coalesce((select json_agg(bk) from bk), '[]'::json),
  'budgets', coalesce((select json_agg(bu) from bu), '[]'::json),
  'campaign_daily', coalesce((select json_agg(cd) from cd), '[]'::json)
) as data`;

export const CREATIVE_LIB = String.raw`
const CD = { HOOK_LOW: 0.20, HOOK_BORDER: 0.25, HOLD_LOW: 0.20, HOLD_HIGH: 0.40, VIDEO_SHARE: 0.05, MIN_IMPS: 1500,
  CTR_LOW: 0.01, CPC_WARN: 4.0, FT_MIN_CLICKS: 40, FT_ABS_LOW: 0.05, LPV_MIN_CLICKS: 30, LPV_LOW: 0.60,
  PAGE_CVR_LOW: 0.03, FATIGUE_RISE: 0.20, FATIGUE_MIN_SPEND: 100.0, LEAD_DEATH_DROP: 0.40, ADS_PER_BUDGET: 10.0, MAX_SIGNALS: 8 };
const CD_PLAY = { new_hook: 'New hook', sharper_hook: 'Sharpen hook', fix_promise: 'Deliver the promise sooner',
  swap_open: 'Swap the first 3 seconds', new_angle: 'New angle', fix_form: 'Fix form / offer',
  fix_page: 'Fix landing page', fresh_test: 'Launch fresh test', trim_ads: 'Too many ads',
  add_ads: 'Add ads', consolidate: 'Consolidate budget', add_diversity: 'Add a new concept' };
const _cdf = (v) => (v === null || v === undefined ? 0 : Number(v));
const _cdgrp = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const _m = (v) => (v === null || v === undefined ? '—' : v >= 100 ? '$' + _cdgrp(v, 0) : '$' + _cdgrp(v, 2));
const _pct = (v, nd = 0) => (v === null || v === undefined ? '—' : (v * 100).toFixed(nd) + '%');
const _norm = (s, n) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, n);
const _isForm = (link) => !link || link.includes('fb.me') || link.includes('facebook.com');
const _r4 = (v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v);
const _median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const _signal = (play, sev, entityType, entityId, entityName, campaign, text, nextStep, spend, evidence) => ({
  kind: 'creative_signal', play, label: CD_PLAY[play], severity: sev,
  entity_type: entityType, entity_id: entityId, entity_name: entityName,
  campaign, message: entityName + ': ' + CD_PLAY[play].toLowerCase() + ' — ' + text,
  text, next_step: nextStep, spend: pyRound(spend, 2), evidence, action: null });
const _struggling = (bookings, adsetName, leadsCur, leadsPrev) => {
  const b = bookings[adsetName || ''];
  if (b && (b[0] || b[1])) return b[0] === 0 || b[0] < b[1];
  return leadsCur === 0 || (leadsPrev > 0 && leadsCur < 0.7 * leadsPrev);
};
const _dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

// data = CREATIVE_SQL result, end = ISO date
const analyzeCreative = (data, end) => {
  const names = {};
  for (const r of data.names) names[r.kind + '|' + r.id] = r.name;
  const ads = new Map();
  for (const r of data.ads) {
    if (!ads.has(r.ad_id)) ads.set(r.ad_id, { ad_id: r.ad_id, adset_id: r.adset_id, campaign_id: r.campaign_id, ad_name: r.ad_name, cur: {}, prev: {} });
    const a = ads.get(r.ad_id);
    const vals = {};
    for (const k of ['spend', 'imps', 'clicks', 'leads', 'reach', 'ulc', 'uoc', 'v3', 'thru', 'lpv']) vals[k] = _cdf(r[k]);
    a[r.cur ? 'cur' : 'prev'] = vals;
    if (r.cur) a.ad_name = r.ad_name || a.ad_name;
  }
  if (!ads.size) return { ads: [], signals: [], ft_median: null };
  const creatives = {};
  for (const r of data.creatives) creatives[r.ad_id] = r;
  const bookings = {};
  for (const r of data.bookings) bookings[r.adset_name] = [_cdf(r.cur), _cdf(r.prev)];
  const budgets = {};
  for (const r of data.budgets) budgets[r.entity_type + '|' + r.entity_id] = r;
  const g = (o, k) => o[k] || 0;
  let signals = [];

  for (const a of ads.values()) {
    const c = a.cur, pv = a.prev;
    const cr = creatives[a.ad_id] || {};
    const form = _isForm(cr.link_url);
    a.campaign = names['campaign|' + a.campaign_id] ?? null;
    a.adset = names['adset|' + a.adset_id] ?? null;
    a.format = cr.video_id || (c.imps && g(c, 'v3') >= CD.VIDEO_SHARE * c.imps) ? 'video' : 'image';
    a.destination = form ? 'instant form' : 'website';
    const imps = g(c, 'imps');
    const unique = (!form && g(c, 'uoc') >= 0.5 * g(c, 'ulc') && g(c, 'uoc') > 0 ? g(c, 'uoc') : g(c, 'ulc')) || g(c, 'clicks');
    a.m = {
      spend: g(c, 'spend'), imps, leads: g(c, 'leads'), unique_clicks: unique,
      ctr: imps ? unique / imps : null,
      cpc: unique ? g(c, 'spend') / unique : null,
      cpl: c.leads ? g(c, 'spend') / c.leads : null,
      hook: imps && c.v3 ? g(c, 'v3') / imps : null,
      hold: c.v3 ? g(c, 'thru') / c.v3 : null,
      form_through: form && c.ulc ? g(c, 'leads') / c.ulc : null,
      lpv_ratio: !form && unique ? g(c, 'lpv') / unique : null,
      page_cvr: !form && c.lpv ? g(c, 'leads') / c.lpv : null,
      freq: c.reach ? imps / c.reach : null,
      freq_prev: pv.reach ? g(pv, 'imps') / pv.reach : null,
      cpmr: c.reach ? g(c, 'spend') * 1000 / c.reach : null,
      cpmr_prev: pv.reach ? g(pv, 'spend') * 1000 / pv.reach : null,
      cpl_prev: pv.leads ? g(pv, 'spend') / pv.leads : null,
      spend_prev: g(pv, 'spend'), leads_prev: g(pv, 'leads'),
    };
  }

  const live = [...ads.values()].filter((a) => a.m.spend > 0);
  const fts = live.filter((a) => a.m.form_through !== null && g(a.cur, 'ulc') >= CD.FT_MIN_CLICKS).map((a) => a.m.form_through);
  const ftMedian = fts.length >= 3 ? _median(fts) : null;

  for (const a of live) {
    const m = a.m, name = a.ad_name || a.ad_id, camp = a.campaign;
    const adSignals = [];
    const ev = {};
    for (const [k, v] of Object.entries(m)) ev[k] = _r4(v);
    if (a.format === 'video' && m.imps >= CD.MIN_IMPS && m.hook !== null && m.hook >= CD.VIDEO_SHARE) {
      const hook = m.hook, hold = m.hold;
      if (hook < CD.HOOK_LOW && hold !== null && hold >= CD.HOLD_HIGH) {
        adSignals.push(_signal('swap_open', 'yellow', 'ad', a.ad_id, name, camp,
          'hook ' + _pct(hook) + ' (<20%) but hold ' + _pct(hold) + ' — the right people stay, too few are stopped',
          'Re-cut only the first 3 seconds (new opening shot / on-screen text); keep the rest of the video', m.spend, ev));
      } else if (hook < CD.HOOK_LOW) {
        adSignals.push(_signal('new_hook', 'yellow', 'ad', a.ad_id, name, camp,
          'hook ' + _pct(hook) + " (<20%) — the first 3 seconds aren't stopping the scroll",
          'Test 2–3 new openings on the same video in a fresh test', m.spend, ev));
      } else if (hook < CD.HOOK_BORDER) {
        adSignals.push(_signal('sharper_hook', 'info', 'ad', a.ad_id, name, camp,
          'hook ' + _pct(hook) + ' — borderline (20–25%)', 'Test a sharper opening line / visual', m.spend, ev));
      } else if (hold !== null && hold < CD.HOLD_LOW && g(a.cur, 'v3') >= 300) {
        adSignals.push(_signal('fix_promise', 'yellow', 'ad', a.ad_id, name, camp,
          'hook ' + _pct(hook) + ' is good but hold ' + _pct(hold) + ' (<20%) — attention without payoff',
          'Deliver the offer / result in the first 5–7 seconds after the hook', m.spend, ev));
      }
    }
    if (m.imps >= 2000 && m.ctr !== null && m.ctr < CD.CTR_LOW) {
      const cpc = m.cpc ? ', ' + _m(m.cpc) + ' per unique click' : '';
      const weak = _struggling(bookings, a.adset, m.leads, m.leads_prev);
      adSignals.push(_signal('new_angle', weak ? 'yellow' : 'info', 'ad', a.ad_id, name, camp,
        'unique CTR ' + _pct(m.ctr, 2) + ' (<1%)' + cpc + " — the message isn't landing" + (weak ? '' : '; the ad set is still booking, so keep it running'),
        weak ? 'Test a different angle / promise, not a copy tweak' : 'Test a new angle alongside it in a fresh test', m.spend, ev));
    } else if (m.cpc !== null && m.cpc > CD.CPC_WARN && m.unique_clicks >= 30) {
      adSignals.push(_signal('new_angle', 'info', 'ad', a.ad_id, name, camp,
        _m(m.cpc) + ' per unique click (above the $3–4 range)', 'Watch; test a stronger angle if bookings are weak', m.spend, ev));
    }
    if (m.form_through !== null && g(a.cur, 'ulc') >= CD.FT_MIN_CLICKS && (m.ctr || 0) >= CD.CTR_LOW) {
      const lowRel = ftMedian !== null && m.form_through < 0.5 * ftMedian;
      if (m.form_through < CD.FT_ABS_LOW || lowRel) {
        const rel = ftMedian ? ' vs ' + _pct(ftMedian) + " across this client's ads" : '';
        adSignals.push(_signal('fix_form', 'yellow', 'ad', a.ad_id, name, camp,
          'only ' + _pct(m.form_through) + ' of clickers submit' + rel + " — CTR is fine, so it's the form or offer",
          'Rewrite the greeting screen and offer headline; keep fields and questions minimal until volume returns', m.spend,
          { ...ev, working_threshold: 'form-through <5% or <half the client median' }));
      }
    }
    if (m.lpv_ratio !== null && m.unique_clicks >= CD.LPV_MIN_CLICKS) {
      if (m.lpv_ratio < CD.LPV_LOW) {
        adSignals.push(_signal('fix_page', 'yellow', 'ad', a.ad_id, name, camp,
          'only ' + _pct(m.lpv_ratio) + ' of clicks load the page — slow page or ad/page mismatch',
          'Check load time on mobile (<3 s) and that the page headline matches the ad', m.spend,
          { ...ev, working_threshold: 'landing-page views <60% of unique clicks' }));
      } else if (m.page_cvr !== null && g(a.cur, 'lpv') >= 30 && m.page_cvr < CD.PAGE_CVR_LOW) {
        adSignals.push(_signal('fix_page', 'yellow', 'ad', a.ad_id, name, camp,
          'page loads fine but only ' + _pct(m.page_cvr, 1) + ' of visitors become leads',
          "Repair the page's offer, proof and form placement", m.spend,
          { ...ev, working_threshold: 'leads <3% of landing-page views' }));
      }
    }
    if (m.spend >= CD.FATIGUE_MIN_SPEND && m.spend_prev >= CD.FATIGUE_MIN_SPEND && m.freq && m.freq_prev && m.cpmr && m.cpmr_prev) {
      const fUp = m.freq / m.freq_prev - 1;
      const rUp = m.cpmr / m.cpmr_prev - 1;
      const worse = (m.cpl === null && m.leads_prev > 0) || (m.cpl && m.cpl_prev && m.cpl > 1.3 * m.cpl_prev);
      const [bCur, bPrev] = bookings[a.adset || ''] || [0, 0];
      const holding = bCur > 0 && bCur >= bPrev;
      if (fUp >= CD.FATIGUE_RISE && rUp >= CD.FATIGUE_RISE && worse && !holding) {
        adSignals.push(_signal('fresh_test', 'yellow', 'ad', a.ad_id, name, camp,
          'frequency ' + m.freq_prev.toFixed(1) + '→' + m.freq.toFixed(1) + ' and cost per 1,000 reached ' + _m(m.cpmr_prev) + '→' + _m(m.cpmr) + ' while CPL rose — Meta is stuck in the same audience',
          "Launch the replacement as a fresh test (new campaign/ad set); keep this ad running until the replacement proves itself — don't pause it", m.spend,
          { ...ev, adset_bookings_cur: bCur, adset_bookings_prev: bPrev }));
      }
    }
    signals.push(...adSignals);
    a.plays = adSignals.map((s) => s.play);
  }

  const byAdset = new Map();
  for (const a of live) { if (!byAdset.has(a.adset_id)) byAdset.set(a.adset_id, []); byAdset.get(a.adset_id).push(a); }
  const campSpend = {};
  for (const a of live) campSpend[a.campaign_id] = (campSpend[a.campaign_id] || 0) + a.m.spend;
  for (const [adsetId, items] of byAdset) {
    const campId = items[0].campaign_id;
    const adsetName = items[0].adset || adsetId, camp = items[0].campaign;
    const spend7 = items.reduce((s, i) => s + i.m.spend, 0);
    const leads7 = items.reduce((s, i) => s + i.m.leads, 0);
    const b = budgets['adset|' + adsetId];
    const cb = budgets['campaign|' + campId];
    let budget = null, src = null;
    if (b && _cdf(b.daily_budget)) { budget = _cdf(b.daily_budget); src = 'ad set'; }
    else if (cb && _cdf(cb.daily_budget) && campSpend[campId]) { budget = _cdf(cb.daily_budget) * spend7 / campSpend[campId]; src = 'share of CBO'; }
    const n = items.length;
    const ev = { ads: n, daily_budget: budget ? pyRound(budget, 2) : null, budget_source: src, spend_7: pyRound(spend7, 2), leads_7: leads7 };
    if (budget && n > 5 && n > budget / CD.ADS_PER_BUDGET + 1) {
      signals.push(_signal('trim_ads', 'yellow', 'adset', adsetId, adsetName, camp,
        n + ' ads on about ' + _m(budget) + '/day (' + src + ') — about one ad per $10/day; spend is spread too thin for any ad to reach conversion volume',
        'Keep the 3–5 ads with the most bookings; move new creative into a fresh test', spend7, ev));
    }
    const cpl7 = leads7 ? spend7 / leads7 : null;
    if (spend7 >= 100 && leads7 < 7) {
      const cantBuy = budget && cpl7 && budget < cpl7;
      const canBuy = cantBuy ? "can't buy one lead a day at a " + _m(cpl7) + ' CPL' : 'under one lead a day';
      signals.push(_signal('consolidate', leads7 < 3 ? 'yellow' : 'info', 'adset', adsetId, adsetName, camp,
        leads7.toFixed(0) + ' lead' + (leads7 !== 1 ? 's' : '') + ' this week on ' + _m(spend7) + (budget ? ' (about ' + _m(budget) + '/day)' : '') + ' — ' + canBuy + '; ad sets without 1–2 conversions a day get lost',
        'Consolidate into one ad set with a budget of at least 2× CPL per day', spend7, ev));
    }
    if (n >= 3) {
      const concepts = new Set(items.map((i) => { const cr = creatives[i.ad_id] || {}; return _norm(cr.title, 40) + '\u0000' + _norm(cr.body, 80); }));
      concepts.delete('\u0000');
      const formats = [...new Set(items.map((i) => i.format))].sort();
      const leadsPrev = items.reduce((s, i) => s + i.m.leads_prev, 0);
      if (concepts.size === 1) {
        const weak = _struggling(bookings, items[0].adset, leads7, leadsPrev);
        signals.push(_signal('add_diversity', weak ? 'yellow' : 'info', 'adset', adsetId, adsetName, camp,
          n + ' ads but one concept (' + formats.join('/') + ") — copy variations of one angle aren't diversity; campaigns built this way die in week 2",
          'Add a second angle (different promise or pain point), video first, in a fresh test', spend7, { ...ev, concepts: 1, formats }));
      }
    } else if (n < 3 && budget && budget >= 30 && spend7 >= 100) {
      signals.push(_signal('add_ads', 'info', 'adset', adsetId, adsetName, camp,
        'only ' + n + ' ad' + (n !== 1 ? 's' : '') + ' on ~' + _m(budget) + '/day', 'Test 3–5 ads per ad set', spend7, ev));
    }
  }

  const daily = new Map();
  for (const r of data.campaign_daily) { if (!daily.has(r.campaign_id)) daily.set(r.campaign_id, []); daily.get(r.campaign_id).push([r.date, _cdf(r.leads)]); }
  for (const [campId, pts] of daily) {
    pts.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    const first = pts[0][0];
    const age = _dayDiff(end, first) + 1;
    if (!(age >= 10 && age <= 35)) continue;
    const firstPlus7 = addDays(first, 7), endMinus7 = addDays(end, -7);
    const first7 = pts.filter(([d]) => d < firstPlus7).reduce((s, [, l]) => s + l, 0);
    const last7 = pts.filter(([d]) => d > endMinus7).reduce((s, [, l]) => s + l, 0);
    if (first7 >= 10 && last7 <= CD.LEAD_DEATH_DROP * first7) {
      const name = names['campaign|' + campId] || campId;
      signals.push(_signal('new_angle', 'yellow', 'campaign', campId, name, name,
        'lead death pattern — ' + first7.toFixed(0) + ' leads in week 1 → ' + last7.toFixed(0) + ' in the last 7 days (' + age + " days live); Meta used up the warm pocket and the angle didn't scale",
        "Biggest levers are offer, then creative: launch a new angle as a fresh test — don't tweak this one", 0.0,
        { first7_leads: first7, last7_leads: last7, age_days: age }));
    }
  }

  const rank = { red: 0, yellow: 1, info: 2 };
  signals.sort((x, y) => rank[x.severity] - rank[y.severity] || y.spend - x.spend);
  const outRows = live.map((a) => {
    const row = { ad_id: a.ad_id, ad_name: a.ad_name, campaign: a.campaign, adset: a.adset,
      format: a.format, destination: a.destination, plays: a.plays || [] };
    for (const [k, v] of Object.entries(a.m)) row[k] = _r4(v);
    return row;
  });
  outRows.sort((x, y) => y.spend - x.spend);
  return { ads: outRows, signals: signals.slice(0, CD.MAX_SIGNALS), ft_median: ftMedian };
};
`;

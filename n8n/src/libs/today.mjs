// Port of backend/app/services/slack_report.py: build_cards() (Today page, client plays)
// and render_slack() (daily Slack post). TODAY_SQL loads every dataset build_cards reads,
// for one "yesterday" ($1::date), in one round trip; TODAY_LIB is injected into Code nodes.

export const TODAY_SQL = `
with ads as (
  select client_id,
         sum(spend) filter (where date = $1::date) spend_1, sum(leads) filter (where date = $1::date) leads_1,
         sum(spend) filter (where date > $1::date - 3) spend_3, sum(leads) filter (where date > $1::date - 3) leads_3,
         sum(spend) filter (where date > $1::date - 7) spend_7, sum(leads) filter (where date > $1::date - 7) leads_7,
         sum(spend) filter (where date > $1::date - 30) spend_30, sum(leads) filter (where date > $1::date - 30) leads_30,
         sum(spend) filter (where date > $1::date - 14 and date <= $1::date - 7) spend_prev7,
         sum(leads) filter (where date > $1::date - 14 and date <= $1::date - 7) leads_prev7,
         max(date) filter (where leads > 0) last_lead
  from ad_metrics_daily where date > $1::date - 60 and date <= $1::date group by client_id
),
ghl as (
  select client_id,
         sum(appointments_booked) filter (where date = $1::date) booked_1,
         sum(appointments_booked) filter (where date > $1::date - 7) booked_7,
         sum(appointments_booked) filter (where date > $1::date - 30) booked_30,
         sum(appointments_booked) filter (where date > $1::date - 14 and date <= $1::date - 7) booked_prev7
  from ghl_metrics_daily where date > $1::date - 30 and date <= $1::date group by client_id
),
cl as (
  select c.id, c.name, c.slug, c.booking_system, c.target_cpba, c.ghl_location_id,
         a.spend_1, a.leads_1, a.spend_3, a.leads_3, a.spend_7, a.leads_7, a.spend_30, a.leads_30,
         a.spend_prev7, a.leads_prev7, a.last_lead,
         g.booked_1, g.booked_7, g.booked_30, g.booked_prev7
  from clients c join ads a on a.client_id = c.id left join ghl g on g.client_id = c.id
  where c.is_active and (coalesce(a.spend_7, 0) > 0 or coalesce(a.spend_prev7, 0) > 0)
),
dry as (
  select client_id, platform, max(campaign_name) as name, sum(spend) as spend_3
  from ad_metrics_daily where date > $1::date - 3 and date <= $1::date
  group by client_id, platform, campaign_id
  having sum(spend) >= 75 and sum(leads) = 0
),
adc as (
  select l.ad_id, max(m.campaign_name) as campaign_name
  from ad_level_metrics_daily l
  join ad_metrics_daily m on m.client_id = l.client_id and m.campaign_id = l.campaign_id and m.date = l.date
  where l.date > $1::date - 14 and l.date <= $1::date
  group by l.ad_id
),
br as (
  select c.slug, b.brief_date, b.score, b.findings, b.platforms
  from daily_briefs b join clients c on c.id = b.client_id
  where b.brief_date = (select max(brief_date) from daily_briefs)
),
hl as (
  select c.slug, h.check_key from integration_health h join clients c on c.id = h.client_id
  where h.status = 'red' and c.is_active
)
select json_build_object(
  'clients', coalesce((select json_agg(cl) from cl), '[]'::json),
  'dry', coalesce((select json_agg(d order by d.spend_3 desc) from dry d), '[]'::json),
  'ad_campaigns', coalesce((select json_object_agg(ad_id, campaign_name) from adc), '{}'::json),
  'briefs', coalesce((select json_agg(br) from br), '[]'::json),
  'health', coalesce((select json_agg(hl) from hl), '[]'::json)
) as data`;

export const TODAY_LIB = String.raw`
const INTEGRATION_LABELS = {
  meta_sync: 'Meta Ads', google_sync: 'Google Ads', lsa_sync: 'Local Services Ads', ghl_token: 'GHL connection',
  ghl_stage_scheduled: 'Scheduled Appointment stage', ghl_stage_confirmed: 'Confirmed Appointment stage',
  ghl_won: 'Won opportunities', ghl_paid_attribution: 'Paid attribution on leads',
  ghl_appointments: 'Bookings from paid leads', utm_tags: 'Ad URL tagging', pixel_capi: 'Pixel / CAPI',
  landing_pages: 'Landing pages',
};
const PLAYS = {
  kill: ['⛔', 'Kill'], kill_or_rebuild: ['⛔', 'Kill or rebuild'], fix_tracking: ['🛠', 'Fix tracking'],
  fix_page: ['🐢', 'Fix landing page'], fix_form: ['📝', 'Fix form / offer'], new_hook: ['🎣', 'New hook'],
  sharper_hook: ['🎣', 'Sharpen hook'], swap_open: ['🎣', 'Swap first 3 seconds'], fix_promise: ['🎬', 'Deliver the promise sooner'],
  new_angle: ['💡', 'New angle'], fresh_test: ['🔁', 'Launch fresh test'], add_diversity: ['🎨', 'Add a new concept'],
  trim_ads: ['✂️', 'Too many ads'], add_ads: ['➕', 'Add ads'], consolidate: ['🧱', 'Consolidate budget'],
  fix_followup: ['📞', 'Fix lead follow-up'], quality: ['⚠️', 'Fix confirmations'], diagnose: ['🔎', 'Diagnose'],
  scale: ['🚀', 'Scale'], micro_scale: ['📈', 'Micro-scale'], no_leads: ['📉', 'No leads'],
  no_bookings: ['📅', 'No bookings'], over_target: ['💸', 'Over target'], cpl_up: ['🔺', 'CPL rising'],
  spend_stopped: ['⏸', 'Spend stopped'], search_terms: ['🔍', 'Search-term waste'], junk_traffic: ['🗑', 'Junk traffic'],
  integration: ['🔌', 'Integration'], note: ['ℹ️', 'Note'],
};
const LEGEND = '⛔ kill · 🛠 fix tracking · 🐢 fix page · 📝 fix form · 🎣 new hook · 🎬 promise sooner · 💡 new angle · 🔁 fresh test · 🎨 new concept · ✂️ too many ads · 🧱 consolidate · 📞 follow-up · 🚀 scale';
const VERDICT_PLAY = { fix: ['fix_tracking', 'red'], kill: ['kill', 'red'], kill_or_rebuild: ['kill_or_rebuild', 'red'],
  quality_fail: ['quality', 'yellow'], diagnose: ['diagnose', 'yellow'], scale: ['scale', 'green'], micro_scale: ['micro_scale', 'green'] };
const KIND_PLAY = [['landing_page_broken', 'fix_page'], ['missing_utm', 'fix_tracking'], ['signal_gap', 'fix_tracking'],
  ['google_junk_traffic', 'junk_traffic'], ['google_unmanaged_terms', 'search_terms'],
  ['cpba_unprofitable', 'over_target'], ['no_appointments', 'no_bookings'], ['spend_stopped', 'spend_stopped']];
const RANK = { red: 0, yellow: 1, green: 2, grey: 3, info: 4 };
const DOT = { red: '🔴', yellow: '🟡', green: '🟢', grey: '⚪' };
const STATUS_LABEL = { red: 'Needs action', yellow: 'Watch', green: 'On target', grey: 'Not graded' };
const NO_LEADS_MIN_SPEND = 50.0, CPL_UP = 0.30, CPL_MIN_LEADS = 3, SLACK_ISSUES_PER_CLIENT = 5;

// Python formatting
const rhe = (x) => { const f = Math.floor(x); const d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
const grp = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const _f = (v) => (v === null || v === undefined ? 0 : Number(v));
const _money = (v) => {
  if (v === null || v === undefined) return '—';
  if (v >= 10000) return '$' + grp(v / 1000, 1) + 'k';
  return v >= 100 ? '$' + grp(v, 0) : '$' + grp(v, 2);
};
const _n = (v) => { v = _f(v); return Math.abs(v - rhe(v)) < 0.05 ? v.toFixed(0) : v.toFixed(1); };
const _pct0 = (x) => rhe(x * 100) + '%';
const _delta = (now, before) => { if (before <= 0) return null; const p = rhe((now - before) / before * 100); return Math.abs(p) >= 10 ? p : null; };
const _mdy = (iso) => { const [y, m, d] = iso.split('-').map(Number); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + ' ' + d; };
const _lstrip = (s) => s.replace(/^[ :—-]+/, '');

const _human = (s) => {
  s = s || '';
  s = s.replace(/Gate [ABC]:\s*/g, '');
  s = s.split('CPAₛ').join('cost per booked').split('Tₛ').join('target').split('T꜀').join('confirmed target');
  s = s.split('scheduled').join('booked').split('two-window: ').join('');
  s = s.replace(/(\d+(?:\.\d+)?)×\s?target/g, '$1× target');
  s = s.includes('0 booked after')
    ? s.split('0 booked after').join('0 booked after spending').split('× target').join('× the target')
    : s.split('×target').join('× target');
  s = s.split('≤').join('at or under ').split('in 7d and 14d').join('in both 7 and 14 days');
  s = s.replace(/\s{2,}/g, ' ').split('near target: ').join('');
  return s.trim();
};
const _firstSentence = (s, n = 110) => {
  s = (s || '').split(';')[0].split('. ')[0].trim().replace(/\.+$/, '');
  return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+$/, '') + '…';
};
const _issue = (play, sev, text, campaign = null, nextStep = null) => {
  const [icon, label] = PLAYS[play] || PLAYS.note;
  text = text.trim();
  const words = label.split(' ');
  for (const prefix of [label, words[0] + ' ' + (label.includes(' ') ? words[1] : '')]) {
    const p = prefix.trim();
    if (p && text.toLowerCase().startsWith(p.toLowerCase())) {
      const rest = _lstrip(text.slice(p.length));
      text = rest ? rest[0].toUpperCase() + rest.slice(1) : text;
      break;
    }
  }
  return { play, icon, label, sev, campaign, text: text.trim().replace(/\.+$/, ''), next: nextStep ? _firstSentence(nextStep) : null };
};
const _tracks = (c) => c.booking_system === 'sheet' || (c.booking_system === 'ghl' && !!c.ghl_location_id);
const _layerPlay = (layer) => {
  const l = (layer || '').toLowerCase();
  if (l.includes('hook')) return 'new_hook';
  if (l.includes('ctr') || l.includes('angle')) return 'new_angle';
  if (l.includes('landing page') || l.includes('page /')) return 'fix_page';
  if (l.includes('form')) return 'fix_form';
  if (l.includes('lead quality') || l.includes('speed')) return 'fix_followup';
  return 'diagnose';
};
const _campaignOf = (f, adCampaigns) => {
  if (f.campaign) return f.campaign;
  if (f.entity_type === 'campaign') return f.entity_name ?? null;
  if (f.entity_type === 'ad') return adCampaigns[String(f.entity_id)] ?? null;
  return null;
};
const _stripCampaign = (msg, campaign) => {
  if (!campaign) return msg;
  msg = msg.split(' in ' + campaign).join('');
  if (msg.startsWith(campaign)) msg = _lstrip(msg.slice(campaign.length).replace(/^\s*\([^)]*\)/, ''));
  return msg;
};

const _alertIssues = (c, dry) => {
  const out = [];
  const spend3 = _f(c.spend_3), leads3 = _f(c.leads_3);
  if (spend3 >= NO_LEADS_MIN_SPEND && leads3 === 0) {
    const since = c.last_lead ? 'last lead ' + _mdy(c.last_lead) : 'none in 60 days';
    out.push(_issue('no_leads', 'red', 'No leads in the last 3 days on ' + _money(spend3) + ' (' + since + ')', null,
      'Check delivery, the form and the creative today'));
  } else {
    for (const d of dry.slice(0, 4)) {
      out.push(_issue('no_leads', 'yellow', 'No leads in 3 days on ' + _money(_f(d.spend_3)) + ' (' + d.platform + ')', d.name));
    }
  }
  const l7 = _f(c.leads_7), lp = _f(c.leads_prev7);
  if (l7 >= CPL_MIN_LEADS && lp >= CPL_MIN_LEADS) {
    const cpl7 = _f(c.spend_7) / l7, cplp = _f(c.spend_prev7) / lp;
    if (cplp && (cpl7 - cplp) / cplp >= CPL_UP) {
      out.push(_issue('cpl_up', 'yellow', 'CPL up ' + _pct0((cpl7 - cplp) / cplp) + ' week over week, ' + _money(cplp) + ' → ' + _money(cpl7), null,
        'Diagnostic only — bookings decide; check the plays below'));
    }
  }
  if (_tracks(c) && _f(c.booked_7) === 0 && _f(c.booked_prev7) >= 2) {
    out.push(_issue('no_bookings', 'red', 'Bookings stopped: 0 this week vs ' + _n(c.booked_prev7) + ' last week', null,
      'Check GHL stages and setter follow-up'));
  }
  return out;
};

const _briefIssues = (brief, adCampaigns) => {
  const out = [];
  if (!brief) return out;
  const findings = brief.findings || [];
  for (const f of findings) {
    if (f.kind === 'sop_verdict' && VERDICT_PLAY[f.verdict]) {
      let [play, sev] = VERDICT_PLAY[f.verdict];
      if (play === 'diagnose') play = _layerPlay(f.layer);
      const d = f.decision || {};
      let text = _human(f.gate);
      if (f.proposed_value) text = f.proposed_value + ' — ' + text;
      if (f.layer && sev !== 'green') text += '; ' + _human(f.layer.split(':')[0]);
      out.push(_issue(play, sev, text, f.entity_name ?? null, d.next_step ?? null));
    }
  }
  for (const f of findings) {
    if (f.kind === 'creative_signal' && (f.severity === 'yellow' || f.severity === 'info')) {
      const camp = f.entity_type !== 'campaign' ? _campaignOf(f, adCampaigns) : (f.entity_name ?? null);
      out.push({ ..._issue(f.play, f.severity, f.text || f.message, camp, f.next_step ?? null),
        where: f.entity_type === 'ad' || f.entity_type === 'adset' ? (f.entity_name ?? null) : null,
        where_type: f.entity_type ?? null, advice: true });
    }
  }
  for (const [kind, play] of KIND_PLAY) {
    const seen = new Set();
    for (const f of findings) {
      if (f.kind !== kind || (f.severity !== 'red' && f.severity !== 'yellow')) continue;
      const camp = _campaignOf(f, adCampaigns);
      if (seen.has(camp) || seen.size >= 3) continue;
      seen.add(camp);
      out.push(_issue(play, f.severity, _stripCampaign(f.message, camp).slice(0, 220), camp));
      if (camp === null) break;
    }
  }
  return out;
};

// data = TODAY_SQL result; y = ISO date string
const buildCards = (data, y) => {
  const base = DASHBOARD_URL.replace(/\/+$/, '');
  const briefs = {};
  for (const b of data.briefs) briefs[b.slug] = b;
  const dry = {};
  for (const r of data.dry) (dry[r.client_id] ||= []).push(r);
  const reds = {};
  for (const r of data.health) (reds[r.slug] ||= new Set()).add(INTEGRATION_LABELS[r.check_key] || r.check_key.split('_').join(' '));

  const cards = [];
  for (const c of data.clients) {
    const brief = briefs[c.slug] || null;
    const tracks = _tracks(c);
    const b7 = _f(c.booked_7), spend7 = _f(c.spend_7), leads7 = _f(c.leads_7);
    const cpba7 = b7 ? spend7 / b7 : null;
    const bt = ((brief || {}).platforms || {}).totals || {};
    const ts = _f(c.target_cpba) || _f(bt.expected_cpba_green) || _f(bt.cpba_max) || null;

    let status = 'grey';
    const first = [];
    if (tracks && ts) {
      if (b7 >= 3 && cpba7 !== null) {
        status = cpba7 <= ts ? 'green' : cpba7 <= ts * 1.3 ? 'yellow' : 'red';
        if (status !== 'green') first.push(_issue('over_target', status, 'Cost per booked ' + _money(cpba7) + ' vs ' + _money(ts) + ' target (' + (cpba7 / ts).toFixed(1) + '×) on ' + _n(b7) + ' bookings'));
      } else if (b7 > 0 && cpba7 !== null) {
        status = cpba7 <= ts ? 'green' : 'yellow';
        if (status === 'yellow') first.push(_issue('over_target', 'yellow', 'Cost per booked ' + _money(cpba7) + ' vs ' + _money(ts) + ' target, only ' + _n(b7) + ' booking' + (b7 !== 1 ? 's' : '') + ' — too thin to act on'));
      } else if (spend7 >= Math.max(ts, 150)) {
        status = 'red';
        first.push(_issue('no_bookings', 'red', 'No bookings this week on ' + _money(spend7) + ' (' + (spend7 / ts).toFixed(1) + '× the ' + _money(ts) + ' target)', null,
          'Audit lead quality and setter follow-up'));
      }
    } else if (tracks && b7 === 0 && spend7 >= 150) {
      status = 'red';
      first.push(_issue('no_bookings', 'red', 'No bookings this week on ' + _money(spend7)));
    }

    const issues = [...first, ..._alertIssues(c, dry[c.id] || []), ..._briefIssues(brief, data.ad_campaigns || {})];
    if (reds[c.slug]) issues.push(_issue('integration', 'yellow', [...reds[c.slug]].sort().join(', ') + ' not working — see the Integrations page'));
    if (!tracks) issues.push(_issue('note', 'info', 'Bookings not tracked — no GHL location or booking sheet linked'));
    for (const i of issues) {
      if ((i.sev === 'red' || i.sev === 'yellow') && i.play !== 'note' && i.play !== 'integration' && !i.advice && RANK[i.sev] < RANK[status]) status = i.sev;
    }
    issues.sort((a, b) => RANK[a.sev] - RANK[b.sev] || (a.campaign ? 1 : 0) - (b.campaign ? 1 : 0));

    cards.push({
      slug: c.slug, name: c.name, status, url: base + '/clients/' + c.slug,
      tracks_bookings: tracks, target_cpba: ts,
      leads: { y: _f(c.leads_1), d7: leads7, d30: _f(c.leads_30), delta7: _delta(leads7, _f(c.leads_prev7)) },
      booked: tracks ? { y: _f(c.booked_1), d7: b7, d30: _f(c.booked_30), delta7: _delta(b7, _f(c.booked_prev7)) } : null,
      spend: { y: _f(c.spend_1), d7: spend7, d30: _f(c.spend_30) },
      cpl7: leads7 ? spend7 / leads7 : null, cpba7,
      issues, spend30: _f(c.spend_30),
    });
  }
  cards.sort((a, b) => RANK[a.status] - RANK[b.status] || b.spend30 - a.spend30);
  const counts = {};
  for (const k of ['red', 'yellow', 'green', 'grey']) counts[k] = cards.filter((x) => x.status === k).length;
  const tot = (k, w) => cards.reduce((s, x) => s + (x[k] ? _f(x[k][w]) : 0), 0);
  const totals = {};
  for (const k of ['spend', 'leads', 'booked']) totals[k] = { y: tot(k, 'y'), d7: tot(k, 'd7'), d30: tot(k, 'd30') };
  const top = [];
  for (const x of cards) for (const i of x.issues) {
    if ((i.sev === 'red' || i.sev === 'yellow') && !['note', 'integration', 'cpl_up'].includes(i.play)) top.push({ ...i, client: x.name, slug: x.slug, spend30: x.spend30 });
  }
  top.sort((a, b) => RANK[a.sev] - RANK[b.sev] || b.spend30 - a.spend30);
  const wins = [];
  for (const x of cards) for (const i of x.issues) if (i.play === 'scale' || i.play === 'micro_scale') wins.push({ ...i, client: x.name, slug: x.slug });
  const bd = data.briefs.find((b) => b.brief_date);
  return { date: y, brief_date: bd ? bd.brief_date : null, counts, totals,
    top_actions: top.slice(0, 8), wins, clients: cards, legend: LEGEND, dashboard_url: base };
};

// ---- Slack rendering (render_slack)
const _playLine = (i, indent) => {
  const sub = i.where && i.where_type === 'ad' ? i.where + ': ' : '';
  let line = indent + i.icon + ' *' + i.label + '* — ' + sub + i.text;
  if (i.next && i.play !== 'over_target') line += '\n' + indent + '      _→ ' + i.next + '_';
  return line;
};
const _groupedLines = (issues) => {
  const lines = issues.filter((i) => !i.campaign).map((i) => _playLine(i, ''));
  const order = [];
  const by = {};
  for (const i of issues) if (i.campaign) { if (!by[i.campaign]) { order.push(i.campaign); by[i.campaign] = []; } by[i.campaign].push(i); }
  for (const camp of order) { lines.push('*' + camp + '*'); for (const i of by[camp]) lines.push(_playLine(i, '    ')); }
  return lines;
};
const _arrow = (d) => (d === null || d === undefined ? '' : d > 0 ? ' ▲' + d + '%' : ' ▼' + Math.abs(d) + '%');
const _clientBlocks = (card, base) => {
  const b = card.booked;
  const fields = [
    { type: 'mrkdwn', text: '*Leads*  _yday · 7d · 30d_\n' + _n(card.leads.y) + ' · ' + _n(card.leads.d7) + _arrow(card.leads.delta7) + ' · ' + _n(card.leads.d30) },
    { type: 'mrkdwn', text: b ? '*Booked*  _yday · 7d · 30d_\n' + _n(b.y) + ' · ' + _n(b.d7) + _arrow(b.delta7) + ' · ' + _n(b.d30) : '*Booked*\n_not tracked_' },
    { type: 'mrkdwn', text: '*7-day spend · CPL*\n' + _money(card.spend.d7) + ' · ' + _money(card.cpl7) },
    { type: 'mrkdwn', text: '*Cost per booked*  _7d_\n' + _money(card.cpba7) + (card.target_cpba && card.cpba7 ? '  vs ' + _money(card.target_cpba) + ' target' : '') },
  ];
  const visible = card.issues.filter((i) => ['red', 'yellow', 'green'].includes(i.sev));
  const shown = visible.slice(0, SLACK_ISSUES_PER_CLIENT);
  const hidden = visible.length - shown.length;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: DOT[card.status] + '  *<' + card.url + '|' + card.name + '>*' }, fields }];
  if (shown.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: _groupedLines(shown).join('\n').slice(0, 2900) } });
  else blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '✅ Nothing to change' }] });
  if (hidden > 0) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '+' + hidden + ' more · <' + card.url + '|open client> · <' + base + '/today|today>' }] });
  blocks.push({ type: 'divider' });
  return blocks;
};
const renderSlack = (data) => {
  const base = data.dashboard_url;
  const [yy, mm, dd] = data.date.split('-').map(Number);
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()];
  const t = data.totals, cnt = data.counts;
  const summary = [
    { type: 'header', text: { type: 'plain_text', text: '📊 Ads daily report · ' + dayName + ', ' + _mdy(data.date) } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*🔴 Needs action*\n' + cnt.red + ' clients' },
      { type: 'mrkdwn', text: '*🟡 Watch*\n' + cnt.yellow + ' clients' },
      { type: 'mrkdwn', text: '*🟢 On target*\n' + cnt.green + ' clients' },
      { type: 'mrkdwn', text: '*⚪ Not graded*\n' + cnt.grey + ' clients' },
      { type: 'mrkdwn', text: '*Spend*  _yday · 7d · 30d_\n' + _money(t.spend.y) + ' · ' + _money(t.spend.d7) + ' · ' + _money(t.spend.d30) },
      { type: 'mrkdwn', text: '*Leads · Booked*  _7d_\n' + _n(t.leads.d7) + ' leads · ' + _n(t.booked.d7) + ' booked' },
    ] },
  ];
  if (data.top_actions.length) {
    const lines = data.top_actions.slice(0, 6).map((i, n) => (n + 1) + '. ' + i.icon + ' *' + i.client + '*' + (i.campaign ? ' · ' + i.campaign : '') + ' — *' + i.label + '*: ' + _firstSentence(i.text, 90));
    summary.push({ type: 'section', text: { type: 'mrkdwn', text: '*Top actions today*\n' + lines.join('\n') } });
  }
  if (data.wins.length) {
    summary.push({ type: 'section', text: { type: 'mrkdwn', text: '*Ready to scale*\n' + data.wins.slice(0, 4).map((i) => i.icon + ' *' + i.client + '* · ' + i.campaign + ' — ' + _firstSentence(i.text, 70)).join('\n') } });
  }
  summary.push({ type: 'context', elements: [{ type: 'mrkdwn', text: LEGEND + '\nKills and scales wait in the Actions queue — nothing changes until someone approves. <' + base + '/today|Open today\'s board>' }] });
  const messages = [summary];
  let current = [];
  let group = null;
  for (const card of data.clients) {
    const blocks = _clientBlocks(card, base);
    let head = [];
    if (card.status !== group) { group = card.status; head = [{ type: 'header', text: { type: 'plain_text', text: DOT[group] + ' ' + STATUS_LABEL[group] + ' (' + cnt[group] + ')' } }]; }
    if (current.length && current.length + head.length + blocks.length > 48) { messages.push(current); current = []; }
    current.push(...head, ...blocks);
  }
  if (current.length) messages.push(current);
  return messages;
};
`;

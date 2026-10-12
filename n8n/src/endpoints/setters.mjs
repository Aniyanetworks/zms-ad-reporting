// GET /api/setters/leaderboard — port of routers/setters.py. Public (no auth), aggregates only.

// app.core.config setter_* defaults (app_settings keys override goal / default fee).
const SETTER_NAMES = ["Brooklyn", "Jonathan", "Matthew", "Morgan", "Natashia"];
const FLAT_RATE_FROM = "2026-10-01";
const FLAT_RATE = 3.0;
const TEAM_GOAL = 0;
const DEFAULT_ZEAL_FEE = 0;
const MONTH_HISTORY_LIMIT = 18;

export default [
  {
    file: "setters-leaderboard",
    method: "GET",
    path: "/api/setters/leaderboard",
    auth: "none",
    validate: `
const q = req.query || {};
const today = todayLA();
const current = today.slice(0, 7);
let month = current;
if (q.month !== undefined && q.month !== '') {
  if (!/^\\d{4}-\\d{2}$/.test(q.month)) return invalid(['query', 'month'], "String should match pattern '^\\\\d{4}-\\\\d{2}$'", 'string_pattern_mismatch');
  const mm = Number(q.month.slice(5, 7));
  if (mm < 1 || mm > 12) return fail(422, 'month must be YYYY-MM');
  month = q.month;
}
const next = (m) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); return (mo === 12 ? (y + 1) + '-01' : y + '-' + String(mo + 1).padStart(2, '0')) + '-01'; };
const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
const fl = ty * 12 + tm - 1 - ${MONTH_HISTORY_LIMIT};
const floor = Math.floor(fl / 12) + '-' + String((fl % 12) + 1).padStart(2, '0') + '-01';
return { today, current, month, start: month + '-01', nxt: next(month), next_of_current: next(current), floor };`,
    params:
      "[$('Validate').first().json.value.start, $('Validate').first().json.value.nxt, $('Validate').first().json.value.next_of_current, $('Validate').first().json.value.floor]",
    sql: `
select json_build_object(
  'settings', coalesce((select json_object_agg(key, value) from app_settings where key in ('setter_team_goal', 'setter_default_zeal_fee')), '{}'::json),
  'clients', coalesce((select json_agg(c) from (select name, setter_fee_per_appt from clients where is_active) c), '[]'::json),
  'rows', coalesce((
    select json_agg(r) from (
      select setter, client, status, commission, appointment_date,
             (date_booked >= $1::date and date_booked < $2::date) as booked_in_month,
             (appointment_date >= $1::date and appointment_date < $2::date) as happens_in_month
      from setter_appointments
      where (date_booked >= $1::date and date_booked < $2::date)
         or (appointment_date >= $1::date and appointment_date < $2::date)
    ) r), '[]'::json),
  'daily', coalesce((
    select json_agg(d) from (
      select setter, sum(new_leads) as new_leads, sum(appts_set) as appts_set, sum(contacted) as contacted
      from setter_daily_activity where date >= $1::date and date < $2::date group by setter
    ) d), '[]'::json),
  'months', coalesce((
    select json_agg(month order by month desc) from (
      select distinct to_char(d, 'YYYY-MM') as month
      from (
        select date_booked as d from setter_appointments
        union all
        select date from setter_daily_activity where new_leads > 0 or appts_set > 0
      ) x
      where d < $3::date and d >= $4::date
    ) m), '[]'::json),
  'last_run', (select to_json(l) from (
      select status, finished_at, error from sync_runs
      where source = 'setters' and finished_at is not null order by finished_at desc limit 1) l),
  'last_ok', (select max(finished_at) from sync_runs where source = 'setters' and status in ('success', 'partial'))
) as data`,
    shape: String.raw`
const ACTIVE = ${JSON.stringify(SETTER_NAMES)};
const CLIENT_ALIASES = { crba: 'constructionremodelinginbayarea', sna: 'snahomeimprovement', integratedhome: 'integratehomedesigns', dawnsky: 'dawnskypressurewashing' };
const CANCELLED = ['Cancelled', 'Not Interested'];
const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ratio = (n, d) => (d ? pyRound(n / d, 4) : null);
const ov = data.settings || {};
const goal = Number(ov.setter_team_goal || ${TEAM_GOAL});
const defaultFee = Number(ov.setter_default_zeal_fee || ${DEFAULT_ZEAL_FEE});
const known = {};
for (const c of data.clients) known[norm(c.name)] = c.setter_fee_per_appt;
const lookup = (name) => {
  let n = norm(name);
  n = CLIENT_ALIASES[n] || n;
  let value = known[n];
  if ((value === undefined || value === null) && n.length >= 4) {
    const hits = Object.keys(known).filter((k) => k.startsWith(n) || n.startsWith(k));
    if (hits.length === 1) value = known[hits[0]];
  }
  if (value) return [Number(value), 'client'];
  return [defaultFee, 'default'];
};
const commissionFor = (status, sheet, apptDate) => {
  if (apptDate !== null && apptDate !== undefined && apptDate >= '${FLAT_RATE_FROM}') return status === 'Show' ? ${FLAT_RATE} : 0;
  return Number(sheet || 0);
};
const blank = (name, active) => ({ name, active, booked: 0, shows: 0, no_shows: 0, pending: 0, cancelled: 0,
  earned: 0, revenue: 0, revenue_confirmed: 0, rows_using_default: 0, new_leads: 0, appts_set: 0 });
const byName = new Map(ACTIVE.map((n) => [n, blank(n, true)]));
const rowFor = (name) => { if (!byName.has(name)) byName.set(name, blank(name, false)); return byName.get(name); };

for (const r of data.rows) {
  const s = rowFor(r.setter);
  const status = r.status;
  const [value, source] = lookup(r.client);
  if (r.booked_in_month) {
    s.booked += 1;
    if (status === 'Scheduled' || status === '') s.pending += 1;
    if (CANCELLED.includes(status)) s.cancelled += 1;
    else { s.revenue += value; if (source === 'default') s.rows_using_default += 1; }
  }
  if (r.happens_in_month) {
    s.earned += commissionFor(status, r.commission, r.appointment_date);
    if (status === 'Show') { s.shows += 1; s.revenue_confirmed += value; }
    else if (status === 'No-Show') s.no_shows += 1;
  }
}
for (const d of data.daily) {
  if (ACTIVE.includes(d.setter) || Math.trunc(num(d.new_leads)) > 0 || Math.trunc(num(d.appts_set)) > 0) {
    const s = rowFor(d.setter);
    s.new_leads = Math.trunc(num(d.new_leads));
    s.appts_set = Math.trunc(num(d.appts_set));
  }
}
const rows = [];
for (const s of byName.values()) {
  if (!s.active && s.booked === 0 && s.appts_set === 0) continue;
  s.show_up_rate = ratio(s.shows, s.shows + s.no_shows);
  s.booking_ratio = ratio(s.appts_set, s.new_leads);
  for (const k of ['earned', 'revenue', 'revenue_confirmed']) s[k] = pyRound(s[k], 2);
  rows.push(s);
}
rows.sort((a, b) => b.booked - a.booked || b.appts_set - a.appts_set || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
let rank = 0, prev = null;
rows.forEach((r, i) => { const key = r.booked + '|' + r.appts_set; if (key !== prev) { rank = i + 1; prev = key; } r.rank = rank; });
const total = (k) => rows.reduce((s, r) => s + r[k], 0);
const team = {
  booked: total('booked'), shows: total('shows'), no_shows: total('no_shows'), pending: total('pending'), cancelled: total('cancelled'),
  earned: pyRound(total('earned'), 2), revenue: pyRound(total('revenue'), 2), revenue_confirmed: pyRound(total('revenue_confirmed'), 2),
  new_leads: total('new_leads'), appts_set: total('appts_set'),
};
team.show_up_rate = ratio(team.shows, team.shows + team.no_shows);
team.booking_ratio = ratio(team.appts_set, team.new_leads);
team.goal = goal;
team.goal_progress = goal > 0 ? ratio(team.revenue, goal) : null;
const y = Number(input.month.slice(0, 4)), m = Number(input.month.slice(5, 7));
const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
team.month_elapsed = input.month === input.current ? pyRound(Number(input.today.slice(8, 10)) / daysInMonth, 4) : 1.0;
const months = data.months;
return { body: {
  month: input.month,
  is_current: input.month === input.current,
  months: months.includes(input.current) ? months : [input.current, ...months],
  booked_available: data.rows.some((r) => r.booked_in_month),
  last_updated: data.last_ok || null,
  sync_status: data.last_run ? data.last_run.status : null,
  fee: { default: defaultFee, rows_using_default: total('rows_using_default'), rows_total: team.booked - team.cancelled },
  team,
  setters: rows,
} };`,
  },
];

// GET /api/today, /api/clients/{slug}/plays, /api/clients/{slug}/creative-health
// — port of routers/today.py (slack_report.build_cards, creative_diag.analyze).
import { TODAY_SQL, TODAY_LIB } from "../libs/today.mjs";
import { CREATIVE_SQL, CREATIVE_LIB } from "../libs/creative.mjs";

// creative_diag.analyze() for a client looked up by slug ($1) — null data when unknown.
const CREATIVE_BY_SLUG = `
with cl as (select id from clients where slug = $1)
select case when exists (select 1 from cl) then (
${CREATIVE_SQL.trim().replace(/\$1::uuid/g, "(select id from cl)").replace(/\s+as data$/, "")}
) end as data`;

export default [
  {
    file: "today",
    method: "GET",
    path: "/api/today",
    auth: "user",
    libs: [TODAY_LIB],
    validate: `
const a = (req.query || {}).as_of;
if (a !== undefined && a !== '' && !isDate(a)) return invalid(['query', 'as_of'], 'Input should be a valid date');
return { y: a || yesterdayLA() };`,
    params: "[$('Validate').first().json.value.y]",
    sql: TODAY_SQL,
    shape: "return { body: buildCards(data, input.y) };",
  },
  {
    file: "client-plays",
    method: "GET",
    path: "/api/clients/:slug/plays",
    auth: "user",
    libs: [TODAY_LIB],
    validate: "return { y: yesterdayLA() };",
    params: "[$('Validate').first().json.value.y]",
    sql: TODAY_SQL,
    shape: `
const d = buildCards(data, input.y);
const card = d.clients.find((c) => c.slug === req.params.slug) || null;
return { body: { date: d.date, brief_date: d.brief_date, legend: d.legend, card } };`,
  },
  {
    file: "client-creative-health",
    method: "GET",
    path: "/api/clients/:slug/creative-health",
    auth: "user",
    libs: [CREATIVE_LIB],
    validate: `
const e = (req.query || {}).end;
if (e !== undefined && e !== '' && !isDate(e)) return invalid(['query', 'end'], 'Input should be a valid date');
return { slug: req.params.slug, end: e || yesterdayLA() };`,
    params: "[$('Validate').first().json.value.slug, $('Validate').first().json.value.end]",
    sql: CREATIVE_BY_SLUG,
    shape: `
if (!data) return { status: 404, body: { detail: 'Client not found' } };
const r = analyzeCreative(data, input.end);
return { body: { end: input.end, window_days: 7, ft_median: r.ft_median, ads: r.ads, signals: r.signals,
  benchmarks: { hook_low: CD.HOOK_LOW, hook_border: CD.HOOK_BORDER, hold_low: CD.HOLD_LOW, hold_high: CD.HOLD_HIGH,
    ctr_low: CD.CTR_LOW, cpc_warn: CD.CPC_WARN, lpv_low: CD.LPV_LOW, ft_low: CD.FT_ABS_LOW } } };`,
  },
];

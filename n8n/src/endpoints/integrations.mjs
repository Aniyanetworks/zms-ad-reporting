// GET /api/integrations — port of routers/integrations.py (matrix read).
// POST /integrations/run and /propose-tracking live with the external-API workflows.

export const CHECKS = [
  ["meta_sync", "Meta Ads", "ads"], ["google_sync", "Google Ads", "ads"], ["lsa_sync", "Local Services Ads", "ads"],
  ["ghl_token", "GHL connection", "ghl"], ["ghl_stage_scheduled", "Scheduled Appointment stage", "ghl"],
  ["ghl_stage_confirmed", "Confirmed Appointment stage", "ghl"], ["ghl_won", "Won opportunities", "ghl"],
  ["ghl_paid_attribution", "Paid attribution on leads", "ghl"], ["ghl_appointments", "Bookings from paid leads", "ghl"],
  ["utm_tags", "Ad URL tagging", "ads"], ["pixel_capi", "Pixel / CAPI", "ads"], ["landing_pages", "Landing pages", "ads"],
];

export default [
  {
    file: "integrations",
    method: "GET",
    path: "/api/integrations",
    auth: "user",
    sql: `
select coalesce(json_agg(x order by x.name), '[]'::json) as data from (
  select h.client_id, c.slug, c.name, c.booking_system, h.check_key, h.status, h.detail, h.checked_at
  from integration_health h join clients c on c.id = h.client_id
  where c.is_active
) x`,
    shape: `
const RANK = { red: 0, yellow: 1, green: 2, grey: 3 };
const clients = new Map();
let checkedAt = null;
for (const r of data) {
  if (!clients.has(r.client_id)) clients.set(r.client_id, { client_id: r.client_id, slug: r.slug, name: r.name, booking_system: r.booking_system, checks: {} });
  clients.get(r.client_id).checks[r.check_key] = { status: r.status, detail: r.detail };
  if (r.checked_at && (!checkedAt || Date.parse(r.checked_at) > Date.parse(checkedAt))) checkedAt = r.checked_at;
}
const out = [];
for (const c of clients.values()) {
  const st = Object.values(c.checks).map((v) => v.status).filter((s) => s !== 'grey');
  c.overall = st.includes('red') ? 'red' : st.includes('yellow') ? 'yellow' : st.length ? 'green' : 'grey';
  out.push(c);
}
out.sort((a, b) => RANK[a.overall] - RANK[b.overall] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
return { body: { checked_at: checkedAt, checks: ${JSON.stringify(CHECKS)}.map(([key, label, group]) => ({ key, label, group })), clients: out } };`,
  },
];

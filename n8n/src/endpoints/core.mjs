// health, me, clients — ports of backend/app/routers/{health,me,clients}.py (GET only).

// Mirrors app.core.policy / app.services.builder.guards.
const BUDGET_INCREASE_OWNER_THRESHOLD_PCT = 20;
const DEFAULT_MEDIA_BUYER_MAX_DAILY_CENTS = 50000;
const HUMAN_CONTROL_RULES = [
  "AI can prepare and modify drafts.",
  "AI can provide recommendations.",
  "AI cannot approve itself.",
  "Campaign creation requires human approval.",
  "Created campaigns must initially be paused.",
  "Campaign launch requires a separate human confirmation.",
  `Budget increases above ${BUDGET_INCREASE_OWNER_THRESHOLD_PCT}% require the Agency Owner.`,
  "Every consequential action is recorded in the audit log.",
];

const CLIENT_COLUMNS = `
  c.id, c.name, c.slug, c.meta_ad_account_id, c.google_ads_customer_id, c.google_lsa_customer_id, c.ghl_location_id,
  c.avg_job_value, c.close_rate, c.gross_margin_pct, c.max_ad_cost_share, c.setter_fee_per_appt, c.default_service, c.trade, c.booking_system,
  c.meta_campaign_filter, c.meta_pixel_id, c.cpl_target_green, c.cpl_target_red, c.is_active, c.created_at`;

export default [
  {
    file: "health-live",
    method: "GET",
    path: "/api/health/live",
    auth: "none",
    shape: "return { body: { status: 'ok' } };",
  },
  {
    file: "health",
    method: "GET",
    path: "/api/health",
    auth: "none",
    // Redis is not part of the n8n stack, so the deep check covers db + syncs only.
    sql: `
select coalesce(json_object_agg(source, last_success), '{}'::json) as data
from (
  select source, max(finished_at) as last_success
  from sync_runs where status = 'success' and source in ('meta', 'google', 'ghl')
  group by source
) t`,
    shape: `
const STALE_MS = 26 * 3600 * 1000;
const now = Date.now();
const syncs = {};
for (const s of ['meta', 'google', 'ghl']) {
  const ts = data[s] ?? null;
  syncs[s] = { ok: ts !== null && now - Date.parse(ts) <= STALE_MS, last_success: ts };
}
const ok = Object.values(syncs).every((v) => v.ok);
return { body: {
  status: ok ? 'ok' : 'degraded', service: 'api', environment: 'production', version: 'n8n',
  checked_at: new Date().toISOString().slice(0, 19) + '+00:00',
  checks: { db: { ok: true }, syncs },
} };`,
    onDbError: `
return { status: 503, body: {
  status: 'unhealthy', service: 'api', environment: 'production', version: 'n8n',
  checked_at: new Date().toISOString().slice(0, 19) + '+00:00',
  checks: { db: { ok: false, error: 'DatabaseError' } },
} };`,
  },
  {
    file: "me",
    method: "GET",
    path: "/api/me",
    auth: "user",
    shape: `
const r = user.role;
const isAdmin = r === 'admin';
const approver = r === 'admin' || r === 'media_buyer';
return { body: {
  id: user.id, email: user.email, role: r, full_name: user.full_name,
  permissions: {
    manage_clients: isAdmin,
    trigger_sync: isAdmin,
    dismiss: approver,
    approve: approver,
    approve_large_budget: isAdmin,
    view_audit_log: isAdmin,
    create_build: approver,
    approve_build_max_daily_cents: isAdmin ? null : r === 'media_buyer' ? ${DEFAULT_MEDIA_BUYER_MAX_DAILY_CENTS} : 0,
  },
  budget_owner_threshold_pct: ${BUDGET_INCREASE_OWNER_THRESHOLD_PCT}.0,
  human_control_rules: ${JSON.stringify(HUMAN_CONTROL_RULES)},
} };`,
  },
  {
    file: "clients-list",
    method: "GET",
    path: "/api/clients",
    auth: "user",
    sql: `
select coalesce(json_agg(t order by t.name), '[]'::json) as data
from (
  select ${CLIENT_COLUMNS.trim()}, (s.ghl_token is not null) as has_ghl_token
  from clients c left join client_secrets s on s.client_id = c.id
) t`,
    shape: "return { body: data };",
  },
];

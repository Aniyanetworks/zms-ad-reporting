// POST /api/clients, PATCH /api/clients/{client_id} — port of routers/clients.py writes.
// Admin only. The GHL token goes to client_secrets; audit_log gets a redacted copy.
import { CLIENT_COLUMNS } from "./core.mjs";

const cols = CLIENT_COLUMNS.trim();

const FIELDS = {
  name: { type: "str", min: 1, max: 200 },
  slug: { type: "str", min: 1, max: 100, pattern: "^[a-z0-9-]+$" },
  meta_ad_account_id: { type: "str", max: 40, pattern: "^(act_)?\\d*$" },
  google_ads_customer_id: { type: "str", max: 20 },
  google_lsa_customer_id: { type: "str" },
  avg_job_value: { type: "num" },
  close_rate: { type: "num" },
  gross_margin_pct: { type: "num" },
  max_ad_cost_share: { type: "num" },
  setter_fee_per_appt: { type: "num" },
  ghl_location_id: { type: "str", max: 60 },
  ghl_token: { type: "str", max: 500 },
  meta_campaign_filter: { type: "str", max: 200 },
  meta_pixel_id: { type: "str", max: 40, pattern: "^\\d*$" },
  cpl_target_green: { type: "num" },
  cpl_target_red: { type: "num" },
  is_active: { type: "bool" },
};

// ClientIn: name/slug required; targets and is_active have defaults and may not be null.
const CREATE_SPEC = {
  ...FIELDS,
  name: { ...FIELDS.name, required: true, nullable: false },
  slug: { ...FIELDS.slug, required: true, nullable: false },
  cpl_target_green: { ...FIELDS.cpl_target_green, default: 75, nullable: false },
  cpl_target_red: { ...FIELDS.cpl_target_red, default: 150, nullable: false },
  is_active: { ...FIELDS.is_active, default: true, nullable: false },
};
// ClientUpdate: everything optional except slug (immutable).
const { slug: _slug, ...UPDATE_SPEC } = FIELDS;
UPDATE_SPEC.name = { ...FIELDS.name };

// Column → SQL cast for the PATCH set list.
const UPDATABLE = {
  name: "text", meta_ad_account_id: "text", google_ads_customer_id: "text", google_lsa_customer_id: "text",
  avg_job_value: "numeric", close_rate: "numeric", gross_margin_pct: "numeric", max_ad_cost_share: "numeric",
  setter_fee_per_appt: "numeric", ghl_location_id: "text", meta_campaign_filter: "text", meta_pixel_id: "text",
  cpl_target_green: "numeric", cpl_target_red: "numeric", is_active: "boolean",
};

const NORMALIZE = `
for (const k of ['google_ads_customer_id', 'google_lsa_customer_id']) {
  if (v[k]) v[k] = String(v[k]).replace(/\\D/g, '');
}`;

const AUDIT_INSERT = `insert into audit_log (actor_type, actor_id, actor_email, action, entity_type, entity_id,
                         client_id, before, after, request_id, ip, user_agent, environment)`;

export default [
  {
    file: "clients-create",
    method: "POST",
    path: "/api/clients",
    auth: ["admin"],
    validate: `
const r = checkBody(${JSON.stringify(CREATE_SPEC)}, req.body);
if (r.__fail) return r;
const v = r.value;${NORMALIZE}
return { body: v, ctx: auditCtx(req, user) };`,
    params: "[JSON.stringify($('Validate').first().json.value.body), JSON.stringify($('Validate').first().json.value.ctx)]",
    sql: `
with b as (select $1::jsonb as j, $2::jsonb as ctx),
ins as (
  insert into clients as c (name, slug, meta_ad_account_id, google_ads_customer_id, ghl_location_id,
                            meta_campaign_filter, cpl_target_green, cpl_target_red, is_active, google_lsa_customer_id)
  select j->>'name', j->>'slug', j->>'meta_ad_account_id', j->>'google_ads_customer_id', j->>'ghl_location_id',
         j->>'meta_campaign_filter', (j->>'cpl_target_green')::numeric, (j->>'cpl_target_red')::numeric,
         (j->>'is_active')::boolean, j->>'google_lsa_customer_id'
  from b
  returning ${cols}
),
sec as (
  insert into client_secrets (client_id, ghl_token)
  select ins.id, b.j->>'ghl_token' from ins, b where coalesce(b.j->>'ghl_token', '') <> ''
  on conflict (client_id) do update set ghl_token = excluded.ghl_token, updated_at = now()
),
res as (
  select to_jsonb(ins) || jsonb_build_object('has_ghl_token', coalesce(b.j->>'ghl_token', '') <> '') as row
  from ins, b
),
aud as (
  ${AUDIT_INSERT}
  select 'user', (b.ctx->>'actor_id')::uuid, b.ctx->>'actor_email', 'client.create', 'client', res.row->>'id',
         (res.row->>'id')::uuid, null, res.row || '{"ghl_token": "[redacted]"}'::jsonb, null,
         (b.ctx->>'ip')::inet, b.ctx->>'user_agent', 'production'
  from res, b
)
select (select row from res) as data`,
    shape: "return { status: 201, body: data };",
  },
  {
    file: "clients-update",
    method: "PATCH",
    path: "/api/clients/:client_id",
    auth: ["admin"],
    validate: `
const r = checkBody(${JSON.stringify(UPDATE_SPEC)}, req.body, true);
if (r.__fail) return r;
const v = r.value;${NORMALIZE}
const { ghl_token, ...data } = v;
if (!Object.keys(data).length && !ghl_token) return fail(400, 'No fields to update');
return { data, ghl_token: ghl_token || null, ctx: auditCtx(req, user), id: req.params.client_id };`,
    params:
      "[JSON.stringify($('Validate').first().json.value.data), $('Validate').first().json.value.ghl_token, JSON.stringify($('Validate').first().json.value.ctx), $('Validate').first().json.value.id]",
    sql: `
with b as (select $1::jsonb as j, $2::text as tok, $3::jsonb as ctx, $4::uuid as id),
prev as (select ${cols} from clients c, b where c.id = b.id),
upd as (
  update clients c set
${Object.entries(UPDATABLE)
  .map(([col, t]) => `    ${col} = case when jsonb_exists(b.j, '${col}') then (b.j->>'${col}')::${t} else c.${col} end`)
  .join(",\n")}
  from b where c.id = b.id and exists (select 1 from prev)
  returning ${cols}
),
sec as (
  insert into client_secrets (client_id, ghl_token)
  select b.id, b.tok from b where coalesce(b.tok, '') <> '' and exists (select 1 from prev)
  on conflict (client_id) do update set ghl_token = excluded.ghl_token, updated_at = now()
),
res as (
  select to_jsonb(upd) || jsonb_build_object('has_ghl_token',
           coalesce(b.tok, '') <> '' or exists (select 1 from client_secrets s where s.client_id = b.id and s.ghl_token is not null)) as row
  from upd, b
),
aud as (
  ${AUDIT_INSERT}
  select 'user', (b.ctx->>'actor_id')::uuid, b.ctx->>'actor_email', 'client.update', 'client', b.id::text, b.id,
         (select to_jsonb(prev) from prev),
         b.j || case when coalesce(b.tok, '') <> '' then '{"ghl_token": "[redacted]"}'::jsonb else '{}'::jsonb end,
         null, (b.ctx->>'ip')::inet, b.ctx->>'user_agent', 'production'
  from res, b
)
select (select row from res) as data`,
    shape: "if (!data) return { status: 404, body: { detail: 'Client not found' } };\nreturn { body: data };",
  },
];

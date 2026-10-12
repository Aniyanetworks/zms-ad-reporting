// Shared SQL fragments.

// audit_log insert (core/audit.py record()). ctx = SQL expression of the jsonb built by
// auditCtx() in the Validate step: { actor_id, actor_email, ip, user_agent }.
export const auditInsert = ({ action, entityType, entityId, clientId = "null", before = "null", after = "null", from = "", ctx, actorType = "'user'" }) => `
insert into audit_log (actor_type, actor_id, actor_email, action, entity_type, entity_id,
                       client_id, before, after, request_id, ip, user_agent, environment)
select ${actorType}, (${ctx}->>'actor_id')::uuid, ${ctx}->>'actor_email', ${action}, ${entityType}, ${entityId},
       ${clientId}, ${before}, ${after}, null, (${ctx}->>'ip')::inet, ${ctx}->>'user_agent', 'production'
${from}`;

// policy.can_approve(role, action, pct_change) → deny reason (null = allowed), for a row alias.
export const approveDeny = (role, r) => `
case when ${r}.action = 'activate' then 'Activation is done by a person in the ad platform; it cannot be approved for execution.'
     when ${role} = 'admin' then null
     when ${role} = 'media_buyer' and ${r}.action = 'budget_change' and ${r}.pct_change is not null and ${r}.pct_change::float8 > 20
       then 'Budget increase of ' || round(${r}.pct_change::numeric)::text || '% exceeds 20%; Agency Owner approval required.'
     when ${role} = 'media_buyer' then null
     else 'Your role cannot approve recommendations.' end`;

// campaigns.py CAMPAIGN_APPTS_SQL: booked appointments per campaign. Tagged bookings
// (GHL utm_medium = ad set name) split across same-named ad sets by lead share; the
// client's untagged bookings spread over its campaigns by lead share. Returns a SELECT
// with columns (platform, campaign_id, appointments).
export const campaignAppts = (cid, start, end) => `
with camp as (
  select platform, campaign_id, sum(leads) leads from ad_metrics_daily
  where client_id = ${cid} and date between ${start} and ${end} group by 1, 2
),
adsets as (
  select campaign_id, adset_name, sum(leads) leads, sum(spend) spend from adset_metrics_daily
  where client_id = ${cid} and platform = 'meta' and date between ${start} and ${end} group by 1, 2
),
same_name as (select adset_name, sum(leads) leads, sum(spend) spend from adsets group by 1),
booked as (
  select adset_name, sum(appointments) appointments from ghl_adset_daily
  where client_id = ${cid} and date between ${start} and ${end} group by 1
),
tagged as (
  select a.campaign_id,
         sum(b.appointments * case when s.leads > 0 then a.leads / s.leads
                                   when s.spend > 0 then a.spend / s.spend else 0 end) appointments
  from booked b join same_name s on s.adset_name = b.adset_name
  join adsets a on a.adset_name = b.adset_name
  group by 1
),
totals as (
  select (select coalesce(sum(appointments_booked), 0) from ghl_metrics_daily where client_id = ${cid} and date between ${start} and ${end}) total,
         (select coalesce(sum(appointments), 0) from tagged) tagged_total,
         (select coalesce(sum(leads), 0) from camp) leads
)
select c.platform, c.campaign_id,
       coalesce(t.appointments, 0)
         + greatest(totals.total - totals.tagged_total, 0)
           * case when totals.leads > 0 then c.leads / totals.leads else 0 end as appointments
from camp c cross join totals
left join tagged t on t.campaign_id = c.campaign_id`;

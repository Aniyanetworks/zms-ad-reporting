-- Hardening (2026-09-17): roles, append-only audit log, approval provenance,
-- Supabase security-advisor fixes, FK indexes. REVIEW BEFORE APPLYING.
-- Non-destructive: no drops of tables/columns, no data changes.

-- ============================================================
-- 1. Roles: admin = Agency Owner, media_buyer = can approve/dismiss
--    recommendations (owner-only above the budget threshold), viewer = read.
-- ============================================================
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'media_buyer', 'viewer'));
comment on column profiles.role is
  'admin = Agency Owner (everything); media_buyer = approve/dismiss recommendations, budget increases > 20% need admin; viewer = read-only.';

-- ============================================================
-- 2. Approval provenance: who (auth user id) and when. approved_by (text/email)
--    stays for display and for rows created before this migration.
-- ============================================================
alter table recommendations
  add column if not exists approved_by_id uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz;

-- ============================================================
-- 3. audit_log: every consequential action. Append-only (trigger + grants).
--    Written only by the API service role; people read via RLS below.
-- ============================================================
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'plugin', 'system')),
  actor_id uuid,                 -- auth.users.id for actor_type = 'user'
  actor_email text,
  action text not null,          -- dotted verb, e.g. recommendation.approve, client.update, sync.trigger
  entity_type text,
  entity_id text,
  client_id uuid references clients(id),
  before jsonb,
  after jsonb,
  request_id text,
  ip inet,
  user_agent text,
  environment text
);
create index if not exists idx_audit_log_at on audit_log (at desc);
create index if not exists idx_audit_log_client on audit_log (client_id, at desc);
create index if not exists idx_audit_log_actor on audit_log (actor_id, at desc);
create index if not exists idx_audit_log_entity on audit_log (entity_type, entity_id);

alter table audit_log enable row level security;
create policy "admins read all audit rows" on audit_log
  for select to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));
create policy "users read their own audit rows" on audit_log
  for select to authenticated
  using (actor_id = auth.uid());
-- No insert/update/delete policies: only the service role (API) writes.

create or replace function public.audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only (%)', tg_op;
end $$;
drop trigger if exists audit_log_no_update_delete on audit_log;
create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each statement execute function public.audit_log_immutable();
revoke update, delete, truncate on audit_log from public, anon, authenticated;

-- ============================================================
-- 4. Supabase security-advisor fixes (2026-09-16 report)
--    - v_client_scorecard was SECURITY DEFINER (ERROR): run as the caller.
--      plugin_reader already has SELECT on the underlying tables.
--    - handle_new_user() was executable by anon/authenticated (WARN): it is a
--      trigger function; only the trigger needs it.
-- ============================================================
alter view v_client_scorecard set (security_invoker = true);
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.audit_log_immutable() from public, anon, authenticated;

-- ============================================================
-- 5. Performance-advisor fixes: unindexed foreign keys
-- ============================================================
create index if not exists idx_recommendations_triage_run on recommendations (triage_run_id);
create index if not exists idx_sync_runs_client on sync_runs (client_id);

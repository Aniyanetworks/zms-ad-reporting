-- Secrets for the n8n backend (n8n/README.md): API tokens the workflows need at run time
-- (Meta system-user token, Google Ads OAuth, Slack webhooks, plugin token, LLM key …).
-- Same model as client_secrets: RLS on with no policies, so only the service role and the
-- direct Postgres connection n8n uses can read or write it; the browser never can.
create table if not exists app_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table app_secrets enable row level security;
revoke all on table app_secrets from anon, authenticated;

comment on table app_secrets is
  'Runtime secrets for the n8n workflows (service role / direct Postgres only). Keys: see n8n/README.md.';

-- Per-client secrets (GHL location-level Private Integration tokens).
-- GHL only offers contacts/calendars/conversations scopes on LOCATION-level
-- private integrations, so each client sub-account gets its own token.
-- RLS enabled with NO policies: only the service role can read or write.
create table client_secrets (
  client_id uuid primary key references clients(id) on delete cascade,
  ghl_token text,
  updated_at timestamptz default now()
);

alter table client_secrets enable row level security;

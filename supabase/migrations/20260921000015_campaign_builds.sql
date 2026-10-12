-- Campaign Builder (2026-09-21): chat-driven campaign drafting in the dashboard.
-- Drafts persist here; objects are created PAUSED in the ad platform only after a
-- signed-in person approves. Non-destructive migration.

create table if not exists campaign_builds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  platform text not null default 'meta' check (platform in ('meta', 'google')),
  title text,
  status text not null default 'draft' check (status in (
    'draft', 'planned', 'approved', 'creating', 'created', 'failed', 'cancelled')),
  brief jsonb not null default '{}'::jsonb,
  plan jsonb,
  plan_version int not null default 0,
  validation jsonb,
  account_context jsonb,
  created_objects jsonb,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  approved_by_id uuid references auth.users(id) on delete set null,
  approved_by_email text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_campaign_builds_client on campaign_builds (client_id, updated_at desc);
create index if not exists idx_campaign_builds_status on campaign_builds (status, updated_at desc);

-- Full conversation, stored as Claude API content blocks so a turn can be replayed
-- exactly (tool_use / tool_result / thinking blocks included). `text` is the
-- display copy the UI shows.
create table if not exists campaign_build_messages (
  id bigint generated always as identity primary key,
  build_id uuid not null references campaign_builds(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content jsonb not null,
  text text,
  tool_name text,
  tool_status text check (tool_status in ('ok', 'error')),
  plan_version int,
  usage jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_campaign_build_messages_build on campaign_build_messages (build_id, id);

-- Creative files: stored in Supabase Storage (bucket campaign-assets, private);
-- uploaded to the ad account (hash / video id) only when the build executes.
create table if not exists campaign_build_assets (
  id uuid primary key default gen_random_uuid(),
  build_id uuid not null references campaign_builds(id) on delete cascade,
  kind text not null check (kind in ('image', 'video')),
  filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  width int,
  height int,
  storage_bucket text not null,
  storage_path text not null,
  meta_image_hash text,
  meta_video_id text,
  created_at timestamptz not null default now()
);
create index if not exists idx_campaign_build_assets_build on campaign_build_assets (build_id, created_at);

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists campaign_builds_touch on campaign_builds;
create trigger campaign_builds_touch before update on campaign_builds
  for each row execute function public.touch_updated_at();
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

-- RLS: dashboard users read (single agency); only the API service role writes.
alter table campaign_builds enable row level security;
alter table campaign_build_messages enable row level security;
alter table campaign_build_assets enable row level security;
create policy "authenticated read campaign_builds" on campaign_builds for select to authenticated using (true);
create policy "authenticated read campaign_build_messages" on campaign_build_messages for select to authenticated using (true);
create policy "authenticated read campaign_build_assets" on campaign_build_assets for select to authenticated using (true);

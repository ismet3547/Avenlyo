-- Avenlyo Phase 0 foundation. Supabase Auth owns authentication identities; public.users stores
-- application profile data. Tenant-scoped rows always carry organization_id and location_id when
-- a physical location context applies.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by uuid references public.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  timezone text not null default 'UTC',
  address jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.organization_members (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  user_id uuid not null references public.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.industry_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete cascade,
  industry_id text not null,
  name text not null,
  description text,
  configuration jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((is_system and organization_id is null and location_id is null) or not is_system)
);

create table public.ai_agents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete cascade,
  industry_template_id uuid references public.industry_templates (id) on delete set null,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete cascade,
  ai_agent_id uuid not null references public.ai_agents (id) on delete cascade,
  name text not null,
  rule_type text not null,
  configuration jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.phone_numbers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  phone_number text not null,
  label text,
  status text not null default 'unconfigured' check (status in ('unconfigured', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone_number)
);

create table public.channels (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete cascade,
  channel_type text not null check (channel_type in ('phone', 'web', 'email', 'sms', 'whatsapp')),
  display_name text not null,
  status text not null default 'inactive' check (status in ('inactive', 'active', 'disabled')),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  first_name text,
  last_name text,
  email text,
  phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  channel_id uuid references public.channels (id) on delete set null,
  ai_agent_id uuid references public.ai_agents (id) on delete set null,
  assigned_user_id uuid references public.users (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  metadata jsonb not null default '{}'::jsonb,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  message_type text not null default 'text',
  body text,
  external_id text,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_id)
);

create table public.calls (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  phone_number_id uuid references public.phone_numbers (id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null default 'initiated' check (status in ('initiated', 'ringing', 'completed', 'failed')),
  started_at timestamptz,
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.appointments (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  title text not null,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'cancelled', 'completed')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create table public.leads (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  status text not null default 'new' check (status in ('new', 'qualified', 'converted', 'lost')),
  source text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.knowledge_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  title text not null,
  source_type text not null,
  source_reference text,
  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.knowledge_chunks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  document_id uuid not null references public.knowledge_documents (id) on delete cascade,
  content text not null,
  chunk_index integer not null check (chunk_index >= 0),
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create table public.integrations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  provider text not null,
  status text not null default 'unconfigured' check (status in ('unconfigured', 'connected', 'disabled', 'error')),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, location_id, provider)
);

create table public.handoffs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  requested_by_agent_id uuid references public.ai_agents (id) on delete set null,
  assigned_user_id uuid references public.users (id) on delete set null,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.action_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  actor_user_id uuid references public.users (id) on delete set null,
  actor_agent_id uuid references public.ai_agents (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index locations_organization_id_idx on public.locations (organization_id);
create index organization_members_user_id_idx on public.organization_members (user_id);
create index ai_agents_organization_id_idx on public.ai_agents (organization_id);
create index agent_rules_agent_id_idx on public.agent_rules (ai_agent_id);
create index phone_numbers_location_id_idx on public.phone_numbers (location_id);
create index channels_organization_id_idx on public.channels (organization_id);
create index contacts_organization_id_idx on public.contacts (organization_id);
create index conversations_organization_last_message_at_idx on public.conversations (organization_id, last_message_at desc);
create index messages_conversation_created_at_idx on public.messages (conversation_id, created_at);
create index calls_conversation_id_idx on public.calls (conversation_id);
create index appointments_location_starts_at_idx on public.appointments (location_id, starts_at);
create index leads_organization_status_idx on public.leads (organization_id, status);
create index knowledge_documents_organization_id_idx on public.knowledge_documents (organization_id);
create index knowledge_chunks_document_id_idx on public.knowledge_chunks (document_id);
create index integrations_organization_id_idx on public.integrations (organization_id);
create index handoffs_conversation_status_idx on public.handoffs (conversation_id, status);
create index action_logs_organization_created_at_idx on public.action_logs (organization_id, created_at desc);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do update set email = excluded.email, display_name = excluded.display_name;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'users', 'organizations', 'locations', 'organization_members', 'industry_templates',
    'ai_agents', 'agent_rules', 'phone_numbers', 'channels', 'contacts', 'conversations',
    'messages', 'calls', 'appointments', 'leads', 'knowledge_documents', 'knowledge_chunks',
    'integrations', 'handoffs', 'action_logs'
  ]
  loop
    execute format(
      'create trigger set_%1$s_updated_at before update on public.%1$I for each row execute procedure public.set_updated_at()',
      table_name
    );
  end loop;
end;
$$;

create function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = target_organization_id
      and user_id = auth.uid()
  );
$$;

create function public.is_organization_admin(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = target_organization_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

alter table public.users enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.industry_templates enable row level security;

create policy users_select_self on public.users
  for select using (id = auth.uid());
create policy users_update_self on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy organizations_select_member on public.organizations
  for select using (public.is_organization_member(id));
create policy organizations_insert_authenticated on public.organizations
  for insert with check (auth.uid() is not null and created_by = auth.uid());
create policy organizations_update_admin on public.organizations
  for update using (public.is_organization_admin(id)) with check (public.is_organization_admin(id));
create policy organizations_delete_admin on public.organizations
  for delete using (public.is_organization_admin(id));

create policy organization_members_select on public.organization_members
  for select using (user_id = auth.uid() or public.is_organization_admin(organization_id));
create policy organization_members_insert on public.organization_members
  for insert with check (
    public.is_organization_admin(organization_id)
    or (
      user_id = auth.uid()
      and exists (
        select 1
        from public.organizations
        where id = organization_id and created_by = auth.uid()
      )
    )
  );
create policy organization_members_update_admin on public.organization_members
  for update using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));
create policy organization_members_delete_admin on public.organization_members
  for delete using (public.is_organization_admin(organization_id));

create policy industry_templates_select on public.industry_templates
  for select using (organization_id is null or public.is_organization_member(organization_id));
create policy industry_templates_insert_admin on public.industry_templates
  for insert with check (organization_id is not null and public.is_organization_admin(organization_id));
create policy industry_templates_update_admin on public.industry_templates
  for update using (organization_id is not null and public.is_organization_admin(organization_id))
  with check (organization_id is not null and public.is_organization_admin(organization_id));
create policy industry_templates_delete_admin on public.industry_templates
  for delete using (organization_id is not null and public.is_organization_admin(organization_id));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'locations', 'ai_agents', 'agent_rules', 'phone_numbers', 'channels', 'contacts',
    'conversations', 'messages', 'calls', 'appointments', 'leads', 'knowledge_documents',
    'knowledge_chunks', 'integrations', 'handoffs', 'action_logs'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy tenant_member_access on public.%I for all using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id))',
      table_name
    );
  end loop;
end;
$$;

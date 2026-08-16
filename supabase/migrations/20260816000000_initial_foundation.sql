-- Avenlyo Phase 0 foundation. Supabase Auth owns authentication identities; public.users stores
-- application profile data. Tenant relationships use composite foreign keys so a child cannot
-- reference a parent from another organization.

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
  constraint locations_organization_name_key unique (organization_id, name),
  constraint locations_organization_id_id_key unique (organization_id, id)
);

create table public.organization_members (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_organization_user_key unique (organization_id, user_id),
  constraint organization_members_organization_id_id_key unique (organization_id, id)
);

create table public.organization_member_locations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  organization_member_id uuid not null,
  location_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_member_locations_member_fk
    foreign key (organization_id, organization_member_id)
    references public.organization_members (organization_id, id) on delete cascade,
  constraint organization_member_locations_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint organization_member_locations_member_location_key
    unique (organization_member_id, location_id),
  constraint organization_member_locations_organization_id_id_key
    unique (organization_id, id)
);

create table public.industry_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  location_id uuid,
  industry_id text not null,
  name text not null,
  description text,
  configuration jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint industry_templates_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint industry_templates_scope_check check (
    (is_system and organization_id is null and location_id is null)
    or (not is_system and organization_id is not null)
  ),
  constraint industry_templates_organization_id_id_key unique (organization_id, id)
);

create table public.ai_agents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  industry_template_id uuid references public.industry_templates (id),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agents_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint ai_agents_organization_id_id_key unique (organization_id, id)
);

create table public.agent_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  ai_agent_id uuid not null,
  name text not null,
  rule_type text not null,
  configuration jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_rules_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint agent_rules_agent_fk
    foreign key (organization_id, ai_agent_id)
    references public.ai_agents (organization_id, id) on delete cascade,
  constraint agent_rules_organization_id_id_key unique (organization_id, id)
);

create table public.phone_numbers (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  phone_number text not null,
  label text,
  status text not null default 'unconfigured' check (status in ('unconfigured', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phone_numbers_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint phone_numbers_organization_phone_key unique (organization_id, phone_number),
  constraint phone_numbers_organization_id_id_key unique (organization_id, id)
);

create table public.channels (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  channel_type text not null check (channel_type in ('phone', 'web', 'email', 'sms', 'whatsapp')),
  display_name text not null,
  status text not null default 'inactive' check (status in ('inactive', 'active', 'disabled')),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channels_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint channels_organization_id_id_key unique (organization_id, id)
);

create table public.contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint contacts_organization_id_id_key unique (organization_id, id)
);

create table public.conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  contact_id uuid,
  channel_id uuid,
  ai_agent_id uuid,
  assigned_user_id uuid,
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  metadata jsonb not null default '{}'::jsonb,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint conversations_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id),
  constraint conversations_channel_fk
    foreign key (organization_id, channel_id)
    references public.channels (organization_id, id),
  constraint conversations_agent_fk
    foreign key (organization_id, ai_agent_id)
    references public.ai_agents (organization_id, id),
  constraint conversations_assigned_member_fk
    foreign key (organization_id, assigned_user_id)
    references public.organization_members (organization_id, user_id),
  constraint conversations_organization_id_id_key unique (organization_id, id)
);

create table public.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  conversation_id uuid not null,
  contact_id uuid,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  message_type text not null default 'text',
  body text,
  external_id text,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messages_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint messages_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint messages_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id),
  constraint messages_organization_external_key unique (organization_id, external_id),
  constraint messages_organization_id_id_key unique (organization_id, id)
);

create table public.calls (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  conversation_id uuid,
  contact_id uuid,
  phone_number_id uuid,
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null default 'initiated' check (status in ('initiated', 'ringing', 'completed', 'failed')),
  started_at timestamptz,
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calls_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint calls_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id),
  constraint calls_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id),
  constraint calls_phone_number_fk
    foreign key (organization_id, phone_number_id)
    references public.phone_numbers (organization_id, id),
  constraint calls_organization_id_id_key unique (organization_id, id)
);

create table public.appointments (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  contact_id uuid,
  conversation_id uuid,
  title text not null,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'cancelled', 'completed')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint appointments_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id),
  constraint appointments_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id),
  constraint appointments_time_check check (ends_at is null or ends_at > starts_at),
  constraint appointments_organization_id_id_key unique (organization_id, id)
);

create table public.leads (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  contact_id uuid,
  conversation_id uuid,
  status text not null default 'new' check (status in ('new', 'qualified', 'converted', 'lost')),
  source text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint leads_contact_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id),
  constraint leads_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id),
  constraint leads_organization_id_id_key unique (organization_id, id)
);

create table public.knowledge_documents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  title text not null,
  source_type text not null,
  source_reference text,
  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_documents_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint knowledge_documents_organization_id_id_key unique (organization_id, id)
);

create table public.knowledge_chunks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  document_id uuid not null,
  content text not null,
  chunk_index integer not null check (chunk_index >= 0),
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_chunks_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint knowledge_chunks_document_fk
    foreign key (organization_id, document_id)
    references public.knowledge_documents (organization_id, id) on delete cascade,
  constraint knowledge_chunks_document_index_key unique (document_id, chunk_index),
  constraint knowledge_chunks_organization_id_id_key unique (organization_id, id)
);

create table public.integrations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  provider text not null,
  status text not null default 'unconfigured' check (status in ('unconfigured', 'connected', 'disabled', 'error')),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integrations_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint integrations_organization_location_provider_key
    unique nulls not distinct (organization_id, location_id, provider),
  constraint integrations_organization_id_id_key unique (organization_id, id)
);

create table public.handoffs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  conversation_id uuid not null,
  requested_by_agent_id uuid,
  assigned_user_id uuid,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint handoffs_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint handoffs_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint handoffs_requested_agent_fk
    foreign key (organization_id, requested_by_agent_id)
    references public.ai_agents (organization_id, id),
  constraint handoffs_assigned_member_fk
    foreign key (organization_id, assigned_user_id)
    references public.organization_members (organization_id, user_id),
  constraint handoffs_organization_id_id_key unique (organization_id, id)
);

create table public.action_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  actor_user_id uuid,
  actor_agent_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_logs_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint action_logs_actor_member_fk
    foreign key (organization_id, actor_user_id)
    references public.organization_members (organization_id, user_id),
  constraint action_logs_actor_agent_fk
    foreign key (organization_id, actor_agent_id)
    references public.ai_agents (organization_id, id)
);

create index locations_organization_id_idx on public.locations (organization_id);
create index organization_members_user_id_idx on public.organization_members (user_id);
create index organization_member_locations_member_id_idx
  on public.organization_member_locations (organization_member_id);
create index organization_member_locations_location_id_idx
  on public.organization_member_locations (location_id);
create index ai_agents_organization_id_idx on public.ai_agents (organization_id);
create index agent_rules_agent_id_idx on public.agent_rules (ai_agent_id);
create index phone_numbers_location_id_idx on public.phone_numbers (location_id);
create index channels_organization_id_idx on public.channels (organization_id);
create index contacts_organization_id_idx on public.contacts (organization_id);
create index conversations_organization_last_message_at_idx
  on public.conversations (organization_id, last_message_at desc);
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
set search_path = ''
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
set search_path = ''
as $$
begin
  insert into public.users (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do update set email = excluded.email, display_name = excluded.display_name;
  return new;
end;
$$;

create function public.validate_ai_agent_template_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.industry_template_id is not null and not exists (
    select 1
    from public.industry_templates as template
    where template.id = new.industry_template_id
      and (template.is_system or template.organization_id = new.organization_id)
  ) then
    raise exception using
      errcode = '23503',
      constraint = 'ai_agents_industry_template_scope_fk',
      message = 'Industry template must be system-owned or belong to the agent organization';
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create trigger validate_ai_agent_template_scope
  before insert or update of organization_id, industry_template_id on public.ai_agents
  for each row execute procedure public.validate_ai_agent_template_scope();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'users', 'organizations', 'locations', 'organization_members',
    'organization_member_locations', 'industry_templates', 'ai_agents', 'agent_rules',
    'phone_numbers', 'channels', 'contacts', 'conversations', 'messages', 'calls',
    'appointments', 'leads', 'knowledge_documents', 'knowledge_chunks', 'integrations',
    'handoffs', 'action_logs'
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
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
  );
$$;

create function public.is_organization_admin(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.role in ('owner', 'admin')
  );
$$;

create function public.is_organization_owner(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.role = 'owner'
  );
$$;

create function public.is_organization_creator(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organizations as organization
    where organization.id = target_organization_id
      and organization.created_by = auth.uid()
  );
$$;

create function public.organization_has_members(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
  );
$$;

create function public.has_location_access(
  target_organization_id uuid,
  target_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and (
        member.role in ('owner', 'admin')
        or target_location_id is null
        or exists (
          select 1
          from public.organization_member_locations as member_location
          where member_location.organization_id = target_organization_id
            and member_location.organization_member_id = member.id
            and member_location.location_id = target_location_id
        )
      )
  );
$$;

create function public.has_location_write_access(
  target_organization_id uuid,
  target_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and (
        member.role in ('owner', 'admin')
        or (
          target_location_id is not null
          and exists (
            select 1
            from public.organization_member_locations as member_location
            where member_location.organization_id = target_organization_id
              and member_location.organization_member_id = member.id
              and member_location.location_id = target_location_id
          )
        )
      )
  );
$$;

revoke all on function public.is_organization_member(uuid) from public;
revoke all on function public.is_organization_admin(uuid) from public;
revoke all on function public.is_organization_owner(uuid) from public;
revoke all on function public.is_organization_creator(uuid) from public;
revoke all on function public.organization_has_members(uuid) from public;
revoke all on function public.has_location_access(uuid, uuid) from public;
revoke all on function public.has_location_write_access(uuid, uuid) from public;

grant execute on function public.is_organization_member(uuid) to authenticated;
grant execute on function public.is_organization_admin(uuid) to authenticated;
grant execute on function public.is_organization_owner(uuid) to authenticated;
grant execute on function public.is_organization_creator(uuid) to authenticated;
grant execute on function public.organization_has_members(uuid) to authenticated;
grant execute on function public.has_location_access(uuid, uuid) to authenticated;
grant execute on function public.has_location_write_access(uuid, uuid) to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'users', 'organizations', 'locations', 'organization_members',
    'organization_member_locations', 'industry_templates', 'ai_agents', 'agent_rules',
    'phone_numbers', 'channels', 'contacts', 'conversations', 'messages', 'calls',
    'appointments', 'leads', 'knowledge_documents', 'knowledge_chunks', 'integrations',
    'handoffs', 'action_logs'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end;
$$;

create policy users_select_self on public.users
  for select to authenticated
  using (id = auth.uid());
create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy organizations_select_member on public.organizations
  for select to authenticated
  using (public.is_organization_member(id));
create policy organizations_insert_authenticated on public.organizations
  for insert to authenticated
  with check (auth.uid() is not null and created_by = auth.uid());
create policy organizations_update_admin on public.organizations
  for update to authenticated
  using (public.is_organization_admin(id))
  with check (public.is_organization_admin(id));
create policy organizations_delete_owner on public.organizations
  for delete to authenticated
  using (public.is_organization_owner(id));

create policy organization_members_select_member on public.organization_members
  for select to authenticated
  using (public.is_organization_member(organization_id));
create policy organization_members_insert_admin on public.organization_members
  for insert to authenticated
  with check (
    public.is_organization_owner(organization_id)
    or (public.is_organization_admin(organization_id) and role <> 'owner')
    or (
      role = 'owner'
      and user_id = auth.uid()
      and public.is_organization_creator(organization_id)
      and not public.organization_has_members(organization_id)
    )
  );
create policy organization_members_update_admin on public.organization_members
  for update to authenticated
  using (
    public.is_organization_owner(organization_id)
    or (public.is_organization_admin(organization_id) and role <> 'owner')
  )
  with check (
    public.is_organization_owner(organization_id)
    or (public.is_organization_admin(organization_id) and role <> 'owner')
  );
create policy organization_members_delete_admin on public.organization_members
  for delete to authenticated
  using (
    public.is_organization_owner(organization_id)
    or (public.is_organization_admin(organization_id) and role <> 'owner')
  );

create policy organization_member_locations_select_member
  on public.organization_member_locations
  for select to authenticated
  using (public.is_organization_member(organization_id));
create policy organization_member_locations_insert_admin
  on public.organization_member_locations
  for insert to authenticated
  with check (public.is_organization_admin(organization_id));
create policy organization_member_locations_update_admin
  on public.organization_member_locations
  for update to authenticated
  using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));
create policy organization_member_locations_delete_admin
  on public.organization_member_locations
  for delete to authenticated
  using (public.is_organization_admin(organization_id));

create policy industry_templates_select_member on public.industry_templates
  for select to authenticated
  using (
    is_system
    or public.has_location_access(organization_id, location_id)
  );
create policy industry_templates_insert_admin on public.industry_templates
  for insert to authenticated
  with check (
    not is_system
    and organization_id is not null
    and public.is_organization_admin(organization_id)
  );
create policy industry_templates_update_admin on public.industry_templates
  for update to authenticated
  using (
    not is_system
    and organization_id is not null
    and public.is_organization_admin(organization_id)
  )
  with check (
    not is_system
    and organization_id is not null
    and public.is_organization_admin(organization_id)
  );
create policy industry_templates_delete_admin on public.industry_templates
  for delete to authenticated
  using (
    not is_system
    and organization_id is not null
    and public.is_organization_admin(organization_id)
  );

create policy locations_select_member on public.locations
  for select to authenticated
  using (public.has_location_access(organization_id, id));
create policy locations_insert_admin on public.locations
  for insert to authenticated
  with check (public.is_organization_admin(organization_id));
create policy locations_update_admin on public.locations
  for update to authenticated
  using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));
create policy locations_delete_admin on public.locations
  for delete to authenticated
  using (public.is_organization_admin(organization_id));

-- Configuration and knowledge resources are readable by authorized members but writable only by
-- organization owners/admins. Policies are generated separately per operation for auditability.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'ai_agents', 'agent_rules', 'phone_numbers', 'channels', 'integrations',
    'knowledge_documents', 'knowledge_chunks'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_location_access(organization_id, location_id))',
      table_name || '_select_member', table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_organization_admin(organization_id))',
      table_name || '_insert_admin', table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_organization_admin(organization_id)) with check (public.is_organization_admin(organization_id))',
      table_name || '_update_admin', table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_organization_admin(organization_id))',
      table_name || '_delete_admin', table_name
    );
  end loop;
end;
$$;

-- Operational resources may be created and updated by location-authorized members. Deletion is an
-- administrative action so normal members cannot destructively remove operational history.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contacts', 'conversations', 'messages', 'calls', 'appointments', 'leads', 'handoffs'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_location_access(organization_id, location_id))',
      table_name || '_select_member', table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_location_write_access(organization_id, location_id))',
      table_name || '_insert_member', table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_location_access(organization_id, location_id)) with check (public.has_location_write_access(organization_id, location_id))',
      table_name || '_update_member', table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_organization_admin(organization_id))',
      table_name || '_delete_admin', table_name
    );
  end loop;
end;
$$;

-- Audit logs are client-readable but append-only through RLS. Trusted backend/service-role code is
-- responsible for writing them and bypasses RLS explicitly.
create policy action_logs_select_member on public.action_logs
  for select to authenticated
  using (public.has_location_access(organization_id, location_id));

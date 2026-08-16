-- Phase 5: veterinary scheduling through ezyVet. Credentials are kept only in Supabase Vault;
-- all candidate, intent, and provider-write transitions are backend-only.

create extension if not exists supabase_vault with schema vault;

alter table public.integrations
  add column if not exists environment text,
  add column if not exists site_uid text,
  add column if not exists site_timezone text,
  add column if not exists last_catalog_synced_at timestamptz,
  add column if not exists last_verified_at timestamptz,
  add column if not exists last_error_category text,
  add constraint integrations_ezyvet_environment_check check (
    provider <> 'ezyvet' or environment in ('production', 'trial')
  ),
  add constraint integrations_ezyvet_secretless_configuration_check check (
    provider <> 'ezyvet'
    or not (configuration ?| array['access_token', 'authorization', 'client_secret', 'clientSecret'])
  ),
  add constraint integrations_organization_location_id_key unique (organization_id, location_id, id);

create table public.integration_credentials (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  integration_id uuid not null,
  vault_secret_id uuid not null,
  credential_version integer not null default 1 check (credential_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_credentials_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint integration_credentials_integration_scope_fk
    foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id) on delete cascade,
  constraint integration_credentials_organization_integration_key unique (organization_id, integration_id),
  constraint integration_credentials_organization_id_id_key unique (organization_id, id)
);

create table public.scheduling_appointment_types (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  integration_id uuid not null,
  provider text not null check (provider = 'ezyvet'),
  external_uid text not null,
  name text not null,
  default_duration_minutes integer not null check (default_duration_minutes between 10 and 480),
  active boolean not null default true,
  bookable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduling_appointment_types_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint scheduling_appointment_types_integration_scope_fk
    foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id) on delete cascade,
  constraint scheduling_appointment_types_external_key unique (organization_id, integration_id, external_uid),
  constraint scheduling_appointment_types_organization_id_id_key unique (organization_id, id),
  constraint scheduling_appointment_types_scope_id_key unique (organization_id, location_id, integration_id, id)
);

create table public.scheduling_resources (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  integration_id uuid not null,
  provider text not null check (provider = 'ezyvet'),
  external_uid text not null,
  name text not null,
  external_ownership_id text not null,
  active boolean not null default true,
  bookable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduling_resources_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint scheduling_resources_integration_scope_fk
    foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id) on delete cascade,
  constraint scheduling_resources_external_key unique (organization_id, integration_id, external_uid),
  constraint scheduling_resources_organization_id_id_key unique (organization_id, id),
  constraint scheduling_resources_scope_id_key unique (organization_id, location_id, integration_id, id)
);

create table public.booking_candidates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  integration_id uuid not null,
  appointment_type_id uuid not null,
  resource_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  status text not null default 'offered' check (status in ('offered', 'consumed', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_candidates_time_check check (ends_at > starts_at and expires_at > created_at),
  constraint booking_candidates_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint booking_candidates_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint booking_candidates_integration_scope_fk
    foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id) on delete cascade,
  constraint booking_candidates_type_scope_fk
    foreign key (organization_id, location_id, integration_id, appointment_type_id)
    references public.scheduling_appointment_types (organization_id, location_id, integration_id, id),
  constraint booking_candidates_resource_scope_fk
    foreign key (organization_id, location_id, integration_id, resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id),
  constraint booking_candidates_organization_id_id_key unique (organization_id, id),
  constraint booking_candidates_scope_id_key unique (organization_id, location_id, conversation_id, integration_id, id)
);

create table public.booking_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  integration_id uuid not null,
  candidate_id uuid not null,
  external_contact_uid text not null,
  external_subject_uid text not null,
  subject_name text not null,
  status text not null default 'awaiting_confirmation'
    check (status in ('awaiting_confirmation', 'booking', 'completed', 'failed', 'provider_state_unknown', 'expired')),
  booking_tool_call_id text,
  failure_category text,
  confirmed_message_id uuid,
  provider_appointment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint booking_intents_subject_name_check check (length(btrim(subject_name)) between 1 and 80),
  constraint booking_intents_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint booking_intents_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint booking_intents_candidate_scope_fk
    foreign key (organization_id, location_id, conversation_id, integration_id, candidate_id)
    references public.booking_candidates (organization_id, location_id, conversation_id, integration_id, id),
  constraint booking_intents_confirmed_message_fk
    foreign key (organization_id, confirmed_message_id)
    references public.messages (organization_id, id),
  constraint booking_intents_organization_candidate_key unique (organization_id, candidate_id),
  constraint booking_intents_organization_id_id_key unique (organization_id, id)
);

alter table public.appointments
  add column if not exists provider text,
  add column if not exists external_appointment_id text,
  add column if not exists integration_id uuid,
  add column if not exists booking_intent_id uuid,
  add column if not exists appointment_type text,
  add column if not exists provider_status text,
  add column if not exists external_contact_uid text,
  add column if not exists external_subject_uid text,
  add constraint appointments_integration_scope_fk
    foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id),
  add constraint appointments_booking_intent_fk
    foreign key (organization_id, booking_intent_id)
    references public.booking_intents (organization_id, id),
  add constraint appointments_organization_booking_intent_key unique (organization_id, booking_intent_id);

create unique index appointments_provider_external_identity_key
  on public.appointments (organization_id, provider, external_appointment_id)
  where external_appointment_id is not null;

create index integration_credentials_integration_id_idx on public.integration_credentials (integration_id);
create index scheduling_appointment_types_scope_idx
  on public.scheduling_appointment_types (organization_id, location_id, integration_id, bookable)
  where active;
create index scheduling_resources_scope_idx
  on public.scheduling_resources (organization_id, location_id, integration_id, bookable)
  where active;
create index booking_candidates_expiry_idx on public.booking_candidates (expires_at) where status = 'offered';
create index booking_intents_conversation_idx on public.booking_intents (conversation_id, created_at desc);

alter table public.integration_credentials enable row level security;
alter table public.scheduling_appointment_types enable row level security;
alter table public.scheduling_resources enable row level security;
alter table public.booking_candidates enable row level security;
alter table public.booking_intents enable row level security;

-- Integration credentials, offered slots, and intent state are never client-mutable. Catalog rows
-- and completed appointments are readable to the same location-scoped members who may view calls.
create policy scheduling_types_select_member on public.scheduling_appointment_types
  for select to authenticated
  using (public.has_location_access(organization_id, location_id));
create policy scheduling_resources_select_member on public.scheduling_resources
  for select to authenticated
  using (public.has_location_access(organization_id, location_id));
create policy booking_candidates_select_admin on public.booking_candidates
  for select to authenticated
  using (public.is_organization_admin(organization_id));
create policy booking_intents_select_admin on public.booking_intents
  for select to authenticated
  using (public.is_organization_admin(organization_id));

-- Catalog visibility is location-scoped through RLS. Credential, candidate, intent, and provider
-- execution tables intentionally receive no direct authenticated table privileges.
grant select on public.scheduling_appointment_types, public.scheduling_resources to authenticated;

drop policy if exists integrations_insert_admin on public.integrations;
drop policy if exists integrations_update_admin on public.integrations;
drop policy if exists integrations_delete_admin on public.integrations;
drop policy if exists appointments_insert_member on public.appointments;
drop policy if exists appointments_update_member on public.appointments;
drop policy if exists appointments_delete_admin on public.appointments;

create function public.require_ezyvet_service_role()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted scheduling backend access is required';
  end if;
end;
$$;

create function public.get_ezyvet_backend_authorization(
  target_user_id uuid,
  target_location_id uuid
)
returns table (organization_id uuid, location_id uuid, location_timezone text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_ezyvet_service_role();
  return query
  select member.organization_id, location.id, location.timezone
  from public.organization_members as member
  join public.organizations as organization on organization.id = member.organization_id
  join public.locations as location on location.organization_id = member.organization_id
  where member.user_id = target_user_id
    and member.role in ('owner', 'admin')
    and location.id = target_location_id
    and organization.primary_industry_id = 'veterinary';
end;
$$;

create function public.store_ezyvet_connection(
  target_organization_id uuid,
  target_location_id uuid,
  target_client_id text,
  target_client_secret text,
  target_environment text,
  target_site_uid text,
  target_provider_site_id text,
  target_provider_timezone text
)
returns table (integration_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_integration_id uuid;
  previous_version integer;
  secret_id uuid;
begin
  perform public.require_ezyvet_service_role();
  if target_environment not in ('production', 'trial')
    or length(btrim(coalesce(target_client_id, ''))) = 0
    or length(btrim(coalesce(target_client_secret, ''))) = 0
    or length(btrim(coalesce(target_site_uid, ''))) = 0
    or length(btrim(coalesce(target_provider_site_id, ''))) = 0
    or length(btrim(coalesce(target_provider_timezone, ''))) = 0 then
    raise exception using errcode = '22023', message = 'ezyVet connection details are invalid';
  end if;
  if not exists (
    select 1 from public.organizations as organization
    join public.locations as location on location.organization_id = organization.id
    where organization.id = target_organization_id
      and organization.primary_industry_id = 'veterinary'
      and location.id = target_location_id
  ) then
    raise exception using errcode = '23503', message = 'Veterinary location is not available';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ezyvet:' || target_location_id::text, 0)
  );
  insert into public.integrations (
    organization_id, location_id, provider, status, environment, site_uid, site_timezone,
    configuration, last_verified_at, last_error_category
  ) values (
    target_organization_id, target_location_id, 'ezyvet', 'connected', target_environment,
    target_site_uid, target_provider_timezone,
    jsonb_build_object('provider_site_id', target_provider_site_id), now(), null
  ) on conflict (organization_id, location_id, provider) do update
  set status = 'connected', environment = excluded.environment, site_uid = excluded.site_uid,
      site_timezone = excluded.site_timezone, configuration = excluded.configuration,
      last_verified_at = now(), last_error_category = null, updated_at = now()
  returning id into saved_integration_id;

  select credential_version into previous_version
  from public.integration_credentials
  where organization_id = target_organization_id and integration_id = saved_integration_id;
  select vault.create_secret(
    jsonb_build_object(
      'client_id', target_client_id,
      'client_secret', target_client_secret,
      'environment', target_environment,
      'site_uid', target_site_uid
    )::text,
    'avenlyo-ezyvet-' || saved_integration_id::text || '-' || extract(epoch from now())::bigint::text,
    'Avenlyo ezyVet credential'
  ) into secret_id;
  insert into public.integration_credentials (
    organization_id, location_id, integration_id, vault_secret_id, credential_version
  ) values (
    target_organization_id, target_location_id, saved_integration_id, secret_id,
    coalesce(previous_version, 0) + 1
  ) on conflict (organization_id, integration_id) do update
  set vault_secret_id = excluded.vault_secret_id,
      credential_version = excluded.credential_version,
      updated_at = now();
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (target_organization_id, target_location_id, 'integration.ezyvet.connected', 'integration',
    saved_integration_id, jsonb_build_object('environment', target_environment));
  return query select saved_integration_id;
end;
$$;

create function public.get_ezyvet_execution_credentials(target_integration_id uuid)
returns table (
  organization_id uuid,
  location_id uuid,
  environment text,
  site_uid text,
  site_timezone text,
  client_id text,
  client_secret text,
  credential_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare decrypted text;
begin
  perform public.require_ezyvet_service_role();
  select vault_secret.decrypted_secret into decrypted
  from public.integration_credentials as credential
  join vault.decrypted_secrets as vault_secret on vault_secret.id = credential.vault_secret_id
  where credential.integration_id = target_integration_id;
  if decrypted is null then
    raise exception using errcode = '42501', message = 'ezyVet credentials are not available';
  end if;
  return query
  select integration.organization_id, integration.location_id, integration.environment,
    credential_secret.value ->> 'site_uid', integration.site_timezone,
    credential_secret.value ->> 'client_id', credential_secret.value ->> 'client_secret',
    credential.credential_version
  from public.integration_credentials as credential
  join public.integrations as integration
    on integration.organization_id = credential.organization_id and integration.id = credential.integration_id
  cross join lateral (select decrypted::jsonb as value) as credential_secret
  where credential.integration_id = target_integration_id
    and integration.provider = 'ezyvet'
    and integration.status = 'connected';
end;
$$;

create function public.get_ezyvet_integration_for_location(
  target_organization_id uuid,
  target_location_id uuid
)
returns table (integration_id uuid, status text, site_timezone text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_ezyvet_service_role();
  return query
  select integration.id, integration.status, integration.site_timezone
  from public.integrations as integration
  where integration.organization_id = target_organization_id
    and integration.location_id = target_location_id
    and integration.provider = 'ezyvet';
end;
$$;

create function public.save_ezyvet_catalog(
  target_integration_id uuid,
  appointment_types jsonb,
  resources jsonb,
  target_site_timezone text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare integration public.integrations%rowtype;
begin
  perform public.require_ezyvet_service_role();
  select * into integration from public.integrations
  where id = target_integration_id and provider = 'ezyvet' and status = 'connected';
  if integration.id is null then
    raise exception using errcode = '42501', message = 'Connected ezyVet integration is not available';
  end if;
  if jsonb_typeof(appointment_types) <> 'array' or jsonb_typeof(resources) <> 'array'
    or jsonb_array_length(appointment_types) > 200 or jsonb_array_length(resources) > 200
    or length(btrim(coalesce(target_site_timezone, ''))) = 0 then
    raise exception using errcode = '22023', message = 'ezyVet catalog is invalid';
  end if;

  insert into public.scheduling_appointment_types (
    organization_id, location_id, integration_id, provider, external_uid, name,
    default_duration_minutes, active, bookable, last_synced_at
  )
  select integration.organization_id, integration.location_id, integration.id, 'ezyvet',
    entry.external_uid, entry.name, entry.default_duration_minutes, entry.active, false, now()
  from jsonb_to_recordset(appointment_types) as entry(
    external_uid text, name text, default_duration_minutes integer, active boolean
  )
  where length(btrim(coalesce(entry.external_uid, ''))) > 0
    and length(btrim(coalesce(entry.name, ''))) > 0
    and entry.default_duration_minutes between 10 and 480
    and entry.active is not null
  on conflict (organization_id, integration_id, external_uid) do update
  set name = excluded.name,
      default_duration_minutes = excluded.default_duration_minutes,
      active = excluded.active,
      last_synced_at = now(),
      updated_at = now();

  insert into public.scheduling_resources (
    organization_id, location_id, integration_id, provider, external_uid, name,
    external_ownership_id, active, bookable, last_synced_at
  )
  select integration.organization_id, integration.location_id, integration.id, 'ezyvet',
    entry.external_uid, entry.name, entry.external_ownership_id, entry.active, false, now()
  from jsonb_to_recordset(resources) as entry(
    external_uid text, name text, external_ownership_id text, active boolean
  )
  where length(btrim(coalesce(entry.external_uid, ''))) > 0
    and length(btrim(coalesce(entry.name, ''))) > 0
    and length(btrim(coalesce(entry.external_ownership_id, ''))) > 0
    and entry.active is not null
  on conflict (organization_id, integration_id, external_uid) do update
  set name = excluded.name,
      external_ownership_id = excluded.external_ownership_id,
      active = excluded.active,
      last_synced_at = now(),
      updated_at = now();

  update public.scheduling_appointment_types as appointment_type
  set active = false, updated_at = now()
  where appointment_type.integration_id = integration.id
    and not exists (
      select 1 from jsonb_to_recordset(appointment_types) as entry(external_uid text)
      where entry.external_uid = appointment_type.external_uid
    );
  update public.scheduling_resources as resource
  set active = false, updated_at = now()
  where resource.integration_id = integration.id
    and not exists (
      select 1 from jsonb_to_recordset(resources) as entry(external_uid text)
      where entry.external_uid = resource.external_uid
    );
  update public.integrations
  set site_timezone = target_site_timezone, last_catalog_synced_at = now(),
      last_error_category = null, updated_at = now()
  where id = integration.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (integration.organization_id, integration.location_id, 'integration.ezyvet.catalog_synced',
    'integration', integration.id, '{}');
end;
$$;

create function public.get_my_ezyvet_integration_configuration(target_location_id uuid)
returns table (
  integration_id uuid,
  status text,
  environment text,
  site_timezone text,
  last_catalog_synced_at timestamptz,
  last_verified_at timestamptz,
  timezone_attention boolean,
  appointment_type_id uuid,
  appointment_type_name text,
  appointment_type_duration_minutes integer,
  appointment_type_active boolean,
  appointment_type_bookable boolean,
  resource_id uuid,
  resource_name text,
  resource_active boolean,
  resource_bookable boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare target_organization_id uuid;
begin
  select location.organization_id into target_organization_id
  from public.locations as location where location.id = target_location_id;
  if target_organization_id is null or not public.has_location_access(target_organization_id, target_location_id) then
    raise exception using errcode = '42501', message = 'Location access is required';
  end if;
  return query
  select integration.id, integration.status, integration.environment, integration.site_timezone,
    integration.last_catalog_synced_at, integration.last_verified_at,
    integration.site_timezone is not null and integration.site_timezone <> location.timezone,
    appointment_type.id, appointment_type.name, appointment_type.default_duration_minutes,
    appointment_type.active, appointment_type.bookable,
    resource.id, resource.name, resource.active, resource.bookable
  from public.locations as location
  left join public.integrations as integration
    on integration.organization_id = location.organization_id
    and integration.location_id = location.id
    and integration.provider = 'ezyvet'
  left join public.scheduling_appointment_types as appointment_type
    on appointment_type.organization_id = integration.organization_id
    and appointment_type.integration_id = integration.id
  left join public.scheduling_resources as resource
    on resource.organization_id = integration.organization_id
    and resource.integration_id = integration.id
  where location.id = target_location_id
  order by appointment_type.name nulls last, resource.name nulls last;
end;
$$;

create function public.update_my_ezyvet_booking_policy(
  target_location_id uuid,
  selected_appointment_type_ids uuid[],
  selected_resource_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare target_organization_id uuid;
declare target_integration_id uuid;
begin
  select location.organization_id into target_organization_id
  from public.locations as location where location.id = target_location_id;
  if target_organization_id is null or not public.is_organization_admin(target_organization_id) then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;
  select id into target_integration_id from public.integrations
  where organization_id = target_organization_id and location_id = target_location_id
    and provider = 'ezyvet' and status = 'connected';
  if target_integration_id is null then
    raise exception using errcode = '42501', message = 'Connected ezyVet integration is required';
  end if;
  if cardinality(coalesce(selected_appointment_type_ids, array[]::uuid[])) > 100
    or cardinality(coalesce(selected_resource_ids, array[]::uuid[])) > 100 then
    raise exception using errcode = '22023', message = 'Bookable scheduling policy is invalid';
  end if;
  if exists (
    select 1 from unnest(coalesce(selected_appointment_type_ids, array[]::uuid[])) as selected(id)
    where not exists (
      select 1 from public.scheduling_appointment_types as appointment_type
      where appointment_type.id = selected.id
        and appointment_type.organization_id = target_organization_id
        and appointment_type.location_id = target_location_id
        and appointment_type.integration_id = target_integration_id
        and appointment_type.active
    )
  ) or exists (
    select 1 from unnest(coalesce(selected_resource_ids, array[]::uuid[])) as selected(id)
    where not exists (
      select 1 from public.scheduling_resources as resource
      where resource.id = selected.id
        and resource.organization_id = target_organization_id
        and resource.location_id = target_location_id
        and resource.integration_id = target_integration_id
        and resource.active
    )
  ) then
    raise exception using errcode = '23503', message = 'Bookable scheduling selection is invalid';
  end if;
  update public.scheduling_appointment_types set bookable = id = any(coalesce(selected_appointment_type_ids, array[]::uuid[])), updated_at = now()
  where organization_id = target_organization_id and integration_id = target_integration_id;
  update public.scheduling_resources set bookable = id = any(coalesce(selected_resource_ids, array[]::uuid[])), updated_at = now()
  where organization_id = target_organization_id and integration_id = target_integration_id;
end;
$$;

create function public.disable_ezyvet_integration(target_organization_id uuid, target_location_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare target_integration_id uuid;
begin
  perform public.require_ezyvet_service_role();
  select id into target_integration_id from public.integrations
  where organization_id = target_organization_id and location_id = target_location_id and provider = 'ezyvet';
  if target_integration_id is null then return; end if;
  update public.integrations set status = 'disabled', updated_at = now() where id = target_integration_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (target_organization_id, target_location_id, 'integration.ezyvet.disabled', 'integration',
    target_integration_id, '{}');
end;
$$;

create function public.get_voice_ezyvet_scheduling_context(target_call_id text)
returns table (
  organization_id uuid,
  location_id uuid,
  conversation_id uuid,
  contact_id uuid,
  caller_e164 text,
  integration_id uuid,
  site_timezone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_ezyvet_service_role();
  return query
  select call.organization_id, call.location_id, call.conversation_id, call.contact_id, contact.phone,
    integration.id, integration.site_timezone
  from public.calls as call
  join public.integrations as integration
    on integration.organization_id = call.organization_id
    and integration.location_id = call.location_id
    and integration.provider = 'ezyvet'
    and integration.status = 'connected'
  left join public.contacts as contact
    on contact.organization_id = call.organization_id and contact.id = call.contact_id
  where call.provider = 'openai-realtime-sip'
    and call.external_call_id = target_call_id;
end;
$$;

create function public.get_ezyvet_bookable_catalog(target_integration_id uuid)
returns table (
  appointment_type_id uuid,
  appointment_type_uid text,
  appointment_type_name text,
  default_duration_minutes integer,
  resource_id uuid,
  resource_uid text,
  resource_name text,
  site_timezone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_ezyvet_service_role();
  return query
  select appointment_type.id, appointment_type.external_uid, appointment_type.name,
    appointment_type.default_duration_minutes, resource.id, resource.external_uid, resource.name,
    integration.site_timezone
  from public.integrations as integration
  join public.scheduling_appointment_types as appointment_type
    on appointment_type.organization_id = integration.organization_id
    and appointment_type.integration_id = integration.id
    and appointment_type.active and appointment_type.bookable
  join public.scheduling_resources as resource
    on resource.organization_id = integration.organization_id
    and resource.integration_id = integration.id
    and resource.active and resource.bookable
  where integration.id = target_integration_id
    and integration.provider = 'ezyvet'
    and integration.status = 'connected';
end;
$$;

create function public.create_voice_booking_candidates(
  target_call_id text,
  available_slots jsonb
)
returns table (
  candidate_id uuid,
  appointment_type_name text,
  resource_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare context record;
begin
  perform public.require_ezyvet_service_role();
  select * into context from public.get_voice_ezyvet_scheduling_context(target_call_id);
  if context.integration_id is null then
    raise exception using errcode = '42501', message = 'Bookable ezyVet integration is not available';
  end if;
  if jsonb_typeof(available_slots) <> 'array' or jsonb_array_length(available_slots) = 0
    or jsonb_array_length(available_slots) > 5 then
    raise exception using errcode = '22023', message = 'Availability slots are invalid';
  end if;
  return query
  with supplied as (
    select entry.appointment_type_uid, entry.resource_uid, entry.starts_at, entry.ends_at
    from jsonb_to_recordset(available_slots) as entry(
      appointment_type_uid text, resource_uid text, starts_at timestamptz, ends_at timestamptz
    )
  ), inserted as (
    insert into public.booking_candidates (
      organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id,
      starts_at, ends_at, timezone, expires_at
    )
    select context.organization_id, context.location_id, context.conversation_id, context.integration_id,
      appointment_type.id, resource.id, supplied.starts_at, supplied.ends_at, context.site_timezone,
      now() + interval '10 minutes'
    from supplied
    join public.scheduling_appointment_types as appointment_type
      on appointment_type.organization_id = context.organization_id
      and appointment_type.integration_id = context.integration_id
      and appointment_type.external_uid = supplied.appointment_type_uid
      and appointment_type.active and appointment_type.bookable
    join public.scheduling_resources as resource
      on resource.organization_id = context.organization_id
      and resource.integration_id = context.integration_id
      and resource.external_uid = supplied.resource_uid
      and resource.active and resource.bookable
    where supplied.starts_at is not null and supplied.ends_at is not null
      and supplied.ends_at > supplied.starts_at
      and supplied.starts_at <= now() + interval '14 days'
      and supplied.starts_at >= now()
    returning id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at
  )
  select inserted.id, appointment_type.name, resource.name, inserted.starts_at, inserted.ends_at,
    inserted.timezone, inserted.expires_at
  from inserted
  join public.scheduling_appointment_types as appointment_type
    on appointment_type.organization_id = context.organization_id and appointment_type.id = inserted.appointment_type_id
  join public.scheduling_resources as resource
    on resource.organization_id = context.organization_id and resource.id = inserted.resource_id;
  if not found then
    raise exception using errcode = '22023', message = 'No trusted availability slots were supplied';
  end if;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (context.organization_id, context.location_id, 'booking.availability.searched', 'conversation',
    context.conversation_id, '{}');
end;
$$;

create function public.prepare_voice_booking_intent(
  target_call_id text,
  target_candidate_id uuid,
  resolved_contact_uid text,
  resolved_subject_uid text,
  resolved_subject_name text
)
returns table (
  booking_intent_id uuid,
  appointment_type_name text,
  starts_at timestamptz,
  timezone text,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare context record;
declare existing_intent public.booking_intents%rowtype;
declare candidate public.booking_candidates%rowtype;
begin
  perform public.require_ezyvet_service_role();
  if length(btrim(coalesce(resolved_contact_uid, ''))) = 0
    or length(btrim(coalesce(resolved_subject_uid, ''))) = 0
    or length(btrim(coalesce(resolved_subject_name, ''))) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'Resolved booking identity is invalid';
  end if;
  select * into context from public.get_voice_ezyvet_scheduling_context(target_call_id);
  if context.integration_id is null then
    raise exception using errcode = '42501', message = 'Bookable ezyVet integration is not available';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-candidate:' || target_candidate_id::text, 0)
  );
  select * into existing_intent from public.booking_intents
  where organization_id = context.organization_id and candidate_id = target_candidate_id;
  if existing_intent.id is not null then
    return query
    select existing_intent.id, appointment_type.name, candidate.starts_at, candidate.timezone, existing_intent.status
    from public.booking_candidates as candidate
    join public.scheduling_appointment_types as appointment_type
      on appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id
    where candidate.organization_id = context.organization_id and candidate.id = target_candidate_id;
    return;
  end if;
  select * into candidate from public.booking_candidates
  where organization_id = context.organization_id
    and location_id = context.location_id
    and conversation_id = context.conversation_id
    and integration_id = context.integration_id
    and id = target_candidate_id;
  if candidate.id is null then
    raise exception using errcode = '42501', message = 'Booking candidate is not available for this conversation';
  end if;
  if candidate.status <> 'offered' or candidate.expires_at <= now() then
    update public.booking_candidates set status = 'expired', updated_at = now()
    where organization_id = context.organization_id and id = candidate.id and status = 'offered';
    raise exception using errcode = '22023', message = 'Booking candidate has expired';
  end if;
  insert into public.booking_intents (
    organization_id, location_id, conversation_id, integration_id, candidate_id,
    external_contact_uid, external_subject_uid, subject_name
  ) values (
    context.organization_id, context.location_id, context.conversation_id, context.integration_id,
    candidate.id, btrim(resolved_contact_uid), btrim(resolved_subject_uid), btrim(resolved_subject_name)
  ) returning id into existing_intent.id;
  update public.booking_candidates set status = 'consumed', updated_at = now()
  where organization_id = context.organization_id and id = candidate.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (context.organization_id, context.location_id, 'booking.intent.prepared', 'booking_intent',
    existing_intent.id, '{}');
  return query
  select existing_intent.id, appointment_type.name, candidate.starts_at, candidate.timezone, 'awaiting_confirmation'::text
  from public.scheduling_appointment_types as appointment_type
  where appointment_type.organization_id = context.organization_id and appointment_type.id = candidate.appointment_type_id;
end;
$$;

create function public.claim_voice_booking_intent(
  target_call_id text,
  target_booking_intent_id uuid,
  target_tool_call_id text
)
returns table (
  state text,
  booking_intent_id uuid,
  confirmed_message_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare context record;
declare intent public.booking_intents%rowtype;
declare candidate public.booking_candidates%rowtype;
declare inbound_message_id uuid;
begin
  perform public.require_ezyvet_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) = 0 or length(target_tool_call_id) > 200 then
    raise exception using errcode = '22023', message = 'Booking tool call is invalid';
  end if;
  select * into context from public.get_voice_ezyvet_scheduling_context(target_call_id);
  if context.integration_id is null then
    raise exception using errcode = '42501', message = 'Bookable ezyVet integration is not available';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)
  );
  select * into intent from public.booking_intents
  where organization_id = context.organization_id
    and location_id = context.location_id
    and conversation_id = context.conversation_id
    and integration_id = context.integration_id
    and id = target_booking_intent_id;
  if intent.id is null then
    raise exception using errcode = '42501', message = 'Booking intent is not available for this conversation';
  end if;
  if intent.status = 'completed' then
    return query select 'completed'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status = 'booking' then
    return query select 'booking'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status = 'provider_state_unknown' then
    return query select 'provider_state_unknown'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status <> 'awaiting_confirmation' then
    return query select intent.status, intent.id, intent.confirmed_message_id;
    return;
  end if;
  select * into candidate from public.booking_candidates
  where organization_id = intent.organization_id and id = intent.candidate_id;
  if candidate.expires_at <= now() then
    update public.booking_intents set status = 'expired', updated_at = now() where id = intent.id;
    return query select 'expired'::text, intent.id, null::uuid;
    return;
  end if;
  select message.id into inbound_message_id
  from public.messages as message
  where message.organization_id = intent.organization_id
    and message.conversation_id = intent.conversation_id
    and message.direction = 'inbound'
    and message.created_at > intent.created_at
  order by message.created_at desc
  limit 1;
  if inbound_message_id is null then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  update public.booking_intents
  set status = 'booking', booking_tool_call_id = target_tool_call_id,
      confirmed_message_id = inbound_message_id, updated_at = now()
  where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound_message_id;
end;
$$;

create function public.get_voice_booking_execution_context(target_booking_intent_id uuid)
returns table (
  booking_intent_id uuid,
  organization_id uuid,
  location_id uuid,
  conversation_id uuid,
  contact_id uuid,
  integration_id uuid,
  external_contact_uid text,
  external_subject_uid text,
  subject_name text,
  appointment_type_uid text,
  appointment_type_name text,
  default_duration_minutes integer,
  resource_uid text,
  resource_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_ezyvet_service_role();
  return query
  select intent.id, intent.organization_id, intent.location_id, intent.conversation_id,
    call.contact_id, intent.integration_id, intent.external_contact_uid, intent.external_subject_uid,
    intent.subject_name, appointment_type.external_uid, appointment_type.name,
    appointment_type.default_duration_minutes, resource.external_uid, resource.name,
    candidate.starts_at, candidate.ends_at, candidate.timezone
  from public.booking_intents as intent
  join public.booking_candidates as candidate
    on candidate.organization_id = intent.organization_id and candidate.id = intent.candidate_id
  join public.scheduling_appointment_types as appointment_type
    on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id
  join public.scheduling_resources as resource
    on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id
  left join public.calls as call
    on call.organization_id = intent.organization_id
    and call.conversation_id = intent.conversation_id
    and call.provider = 'openai-realtime-sip'
  where intent.id = target_booking_intent_id
    and intent.status = 'booking'
    and appointment_type.active and appointment_type.bookable
    and resource.active and resource.bookable;
end;
$$;

create function public.complete_voice_booking_intent(
  target_booking_intent_id uuid,
  target_external_appointment_id text,
  target_provider_status text
)
returns table (appointment_id uuid, is_existing boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare intent public.booking_intents%rowtype;
declare candidate public.booking_candidates%rowtype;
declare appointment_type public.scheduling_appointment_types%rowtype;
declare inserted_appointment_id uuid;
begin
  perform public.require_ezyvet_service_role();
  if length(btrim(coalesce(target_external_appointment_id, ''))) = 0
    or length(target_external_appointment_id) > 200
    or target_provider_status not in ('unconfirmed', 'confirmed') then
    raise exception using errcode = '22023', message = 'Provider booking result is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)
  );
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then
    raise exception using errcode = '42501', message = 'Booking intent is not available';
  end if;
  select id into inserted_appointment_id from public.appointments
  where organization_id = intent.organization_id and booking_intent_id = intent.id;
  if inserted_appointment_id is not null then
    return query select inserted_appointment_id, true;
    return;
  end if;
  if intent.status <> 'booking' then
    raise exception using errcode = '22023', message = 'Booking intent is not claimed';
  end if;
  select * into candidate from public.booking_candidates
  where organization_id = intent.organization_id and id = intent.candidate_id;
  select * into appointment_type from public.scheduling_appointment_types
  where organization_id = intent.organization_id and id = candidate.appointment_type_id;
  insert into public.appointments (
    organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at,
    provider, external_appointment_id, integration_id, booking_intent_id, appointment_type,
    provider_status, external_contact_uid, external_subject_uid, metadata
  ) values (
    intent.organization_id, intent.location_id,
    (select call.contact_id from public.calls as call where call.organization_id = intent.organization_id
      and call.conversation_id = intent.conversation_id and call.provider = 'openai-realtime-sip' limit 1),
    intent.conversation_id, appointment_type.name || ' — ' || intent.subject_name,
    'requested', candidate.starts_at, candidate.ends_at, 'ezyvet', btrim(target_external_appointment_id),
    intent.integration_id, intent.id, appointment_type.name, target_provider_status,
    intent.external_contact_uid, intent.external_subject_uid,
    jsonb_build_object('source', 'inbound_voice', 'subject_name', intent.subject_name)
  ) returning id into inserted_appointment_id;
  update public.booking_intents
  set status = 'completed', provider_appointment_id = btrim(target_external_appointment_id),
      completed_at = now(), failure_category = null, updated_at = now()
  where id = intent.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (intent.organization_id, intent.location_id, 'booking.confirmed', 'appointment',
    inserted_appointment_id, jsonb_build_object('provider', 'ezyvet'));
  return query select inserted_appointment_id, false;
end;
$$;

create function public.fail_voice_booking_intent(
  target_booking_intent_id uuid,
  target_status text,
  target_error_category text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare intent public.booking_intents%rowtype;
begin
  perform public.require_ezyvet_service_role();
  if target_status not in ('awaiting_confirmation', 'failed', 'provider_state_unknown', 'expired') then
    raise exception using errcode = '22023', message = 'Booking outcome is invalid';
  end if;
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then
    raise exception using errcode = '42501', message = 'Booking intent is not available';
  end if;
  if intent.status = 'completed' then return; end if;
  update public.booking_intents
  set status = target_status, failure_category = nullif(btrim(coalesce(target_error_category, '')), ''),
      updated_at = now()
  where id = intent.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (intent.organization_id, intent.location_id,
    case when target_status = 'provider_state_unknown' then 'booking.provider_unknown' else 'booking.failed' end,
    'booking_intent', intent.id,
    jsonb_build_object('category', nullif(btrim(coalesce(target_error_category, '')), '')));
end;
$$;

create function public.get_my_scheduling_appointments(target_location_id uuid)
returns table (
  appointment_id uuid,
  title text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  provider text,
  provider_status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_location_access(
    (select location.organization_id from public.locations as location where location.id = target_location_id),
    target_location_id
  ) then
    raise exception using errcode = '42501', message = 'Location access is required';
  end if;
  return query
  select appointment.id, appointment.title, appointment.status, appointment.starts_at,
    appointment.ends_at, appointment.provider, appointment.provider_status, appointment.created_at
  from public.appointments as appointment
  where appointment.location_id = target_location_id
  order by appointment.starts_at asc nulls last, appointment.created_at desc
  limit 100;
end;
$$;

revoke all on function public.require_ezyvet_service_role() from public;
revoke all on function public.get_ezyvet_backend_authorization(uuid, uuid) from public;
revoke all on function public.store_ezyvet_connection(uuid, uuid, text, text, text, text, text, text) from public;
revoke all on function public.get_ezyvet_execution_credentials(uuid) from public;
revoke all on function public.get_ezyvet_integration_for_location(uuid, uuid) from public;
revoke all on function public.save_ezyvet_catalog(uuid, jsonb, jsonb, text) from public;
revoke all on function public.get_my_ezyvet_integration_configuration(uuid) from public;
revoke all on function public.update_my_ezyvet_booking_policy(uuid, uuid[], uuid[]) from public;
revoke all on function public.disable_ezyvet_integration(uuid, uuid) from public;
revoke all on function public.get_voice_ezyvet_scheduling_context(text) from public;
revoke all on function public.get_ezyvet_bookable_catalog(uuid) from public;
revoke all on function public.create_voice_booking_candidates(text, jsonb) from public;
revoke all on function public.prepare_voice_booking_intent(text, uuid, text, text, text) from public;
revoke all on function public.claim_voice_booking_intent(text, uuid, text) from public;
revoke all on function public.get_voice_booking_execution_context(uuid) from public;
revoke all on function public.complete_voice_booking_intent(uuid, text, text) from public;
revoke all on function public.fail_voice_booking_intent(uuid, text, text) from public;
revoke all on function public.get_my_scheduling_appointments(uuid) from public;

grant execute on function public.get_my_ezyvet_integration_configuration(uuid) to authenticated;
grant execute on function public.update_my_ezyvet_booking_policy(uuid, uuid[], uuid[]) to authenticated;
grant execute on function public.get_my_scheduling_appointments(uuid) to authenticated;
grant execute on function public.get_ezyvet_backend_authorization(uuid, uuid) to service_role;
grant execute on function public.store_ezyvet_connection(uuid, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.get_ezyvet_execution_credentials(uuid) to service_role;
grant execute on function public.get_ezyvet_integration_for_location(uuid, uuid) to service_role;
grant execute on function public.save_ezyvet_catalog(uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.disable_ezyvet_integration(uuid, uuid) to service_role;
grant execute on function public.get_voice_ezyvet_scheduling_context(text) to service_role;
grant execute on function public.get_ezyvet_bookable_catalog(uuid) to service_role;
grant execute on function public.create_voice_booking_candidates(text, jsonb) to service_role;
grant execute on function public.prepare_voice_booking_intent(text, uuid, text, text, text) to service_role;
grant execute on function public.claim_voice_booking_intent(text, uuid, text) to service_role;
grant execute on function public.get_voice_booking_execution_context(uuid) to service_role;
grant execute on function public.complete_voice_booking_intent(uuid, text, text) to service_role;
grant execute on function public.fail_voice_booking_intent(uuid, text, text) to service_role;

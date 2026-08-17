-- Phase 6: provider-neutral scheduling with a Google Calendar connector. Provider secrets,
-- booking state, OAuth state, and execution leases remain backend-only.

create extension if not exists btree_gist with schema extensions;

alter table public.scheduling_appointment_types
  drop constraint if exists scheduling_appointment_types_provider_check,
  add constraint scheduling_appointment_types_provider_check
    check (provider in ('ezyvet', 'google_calendar')),
  add column if not exists catalog_source text not null default 'ezyvet'
    check (catalog_source in ('ezyvet', 'avenlyo')),
  add constraint scheduling_appointment_types_google_source_check
    check ((provider = 'google_calendar') = (catalog_source = 'avenlyo'));

alter table public.scheduling_resources
  drop constraint if exists scheduling_resources_provider_check,
  alter column external_ownership_id drop not null,
  add constraint scheduling_resources_provider_check
    check (provider in ('ezyvet', 'google_calendar')),
  add constraint scheduling_resources_ezyvet_ownership_check
    check (provider <> 'ezyvet' or length(btrim(coalesce(external_ownership_id, ''))) > 0);

alter table public.booking_intents
  alter column external_contact_uid drop not null,
  alter column external_subject_uid drop not null,
  alter column subject_name drop not null,
  add column if not exists contact_id uuid,
  add constraint booking_intents_contact_scope_fk
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id),
  drop constraint if exists booking_intents_subject_name_check,
  add constraint booking_intents_subject_name_check
    check (subject_name is null or length(btrim(subject_name)) between 1 and 80);

create table public.location_scheduling_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  active_integration_id uuid,
  minimum_lead_minutes integer not null default 60 check (minimum_lead_minutes between 15 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_scheduling_settings_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint location_scheduling_settings_integration_fk foreign key (organization_id, location_id, active_integration_id)
    references public.integrations (organization_id, location_id, id),
  constraint location_scheduling_settings_location_key unique (organization_id, location_id)
);

create table public.scheduling_appointment_type_resources (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  integration_id uuid not null,
  appointment_type_id uuid not null,
  resource_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (appointment_type_id, resource_id),
  constraint scheduling_type_resource_type_fk foreign key (organization_id, location_id, integration_id, appointment_type_id)
    references public.scheduling_appointment_types (organization_id, location_id, integration_id, id) on delete cascade,
  constraint scheduling_type_resource_resource_fk foreign key (organization_id, location_id, integration_id, resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id) on delete cascade
);

create table public.oauth_connection_states (
  id uuid primary key default extensions.gen_random_uuid(),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider = 'google_calendar'),
  user_id uuid not null references public.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_connection_states_expiry_check check (expires_at > created_at),
  constraint oauth_connection_states_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade
);

create table public.booking_slot_leases (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  integration_id uuid not null,
  resource_id uuid not null,
  booking_intent_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'released', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_slot_leases_time_check check (ends_at > starts_at and expires_at > created_at),
  constraint booking_slot_leases_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint booking_slot_leases_integration_fk foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id) on delete cascade,
  constraint booking_slot_leases_resource_fk foreign key (organization_id, location_id, integration_id, resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id),
  constraint booking_slot_leases_intent_fk foreign key (organization_id, booking_intent_id)
    references public.booking_intents (organization_id, id) on delete cascade,
  constraint booking_slot_leases_one_intent_key unique (organization_id, booking_intent_id)
);
alter table public.booking_slot_leases add constraint booking_slot_leases_no_overlap
  exclude using gist (organization_id with =, resource_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status = 'active');

alter table public.location_scheduling_settings enable row level security;
alter table public.scheduling_appointment_type_resources enable row level security;
alter table public.oauth_connection_states enable row level security;
alter table public.booking_slot_leases enable row level security;
create policy location_scheduling_settings_select_admin on public.location_scheduling_settings for select to authenticated
  using (public.is_organization_admin(organization_id));
create policy scheduling_type_resources_select_member on public.scheduling_appointment_type_resources for select to authenticated
  using (public.has_location_access(organization_id, location_id));
grant select on public.location_scheduling_settings, public.scheduling_appointment_type_resources to authenticated;

-- Preserve a configured Phase 5 ezyVet location. We never auto-select Google Calendar.
insert into public.location_scheduling_settings (organization_id, location_id, active_integration_id)
select integration.organization_id, integration.location_id, integration.id
from public.integrations as integration
where integration.provider = 'ezyvet' and integration.status = 'connected'
  and exists (select 1 from public.scheduling_appointment_types as appointment_type
    where appointment_type.organization_id = integration.organization_id and appointment_type.integration_id = integration.id
      and appointment_type.active and appointment_type.bookable)
  and exists (select 1 from public.scheduling_resources as resource
    where resource.organization_id = integration.organization_id and resource.integration_id = integration.id
      and resource.active and resource.bookable)
on conflict (organization_id, location_id) do nothing;

create function public.require_scheduling_service_role() returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted scheduling backend access is required';
  end if;
end; $$;

create function public.get_google_backend_authorization(target_user_id uuid, target_location_id uuid)
returns table (organization_id uuid, location_id uuid, location_timezone text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select member.organization_id, location.id, location.timezone
  from public.organization_members as member join public.locations as location on location.organization_id = member.organization_id
  where member.user_id = target_user_id and member.role in ('owner', 'admin') and location.id = target_location_id;
end; $$;

create function public.create_google_oauth_state(target_user_id uuid, target_location_id uuid, target_state_hash text)
returns table (organization_id uuid, location_id uuid)
language plpgsql security definer set search_path = '' as $$
declare authz record;
begin
  perform public.require_scheduling_service_role();
  if coalesce(target_state_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'OAuth state is invalid';
  end if;
  select * into authz from public.get_google_backend_authorization(target_user_id, target_location_id);
  if authz.organization_id is null then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  insert into public.oauth_connection_states (state_hash, provider, user_id, organization_id, location_id, expires_at)
  values (target_state_hash, 'google_calendar', target_user_id, authz.organization_id, authz.location_id, now() + interval '10 minutes');
  return query select authz.organization_id, authz.location_id;
end; $$;

create function public.consume_google_oauth_state(target_state_hash text)
returns table (user_id uuid, organization_id uuid, location_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query update public.oauth_connection_states set consumed_at = now()
  where state_hash = target_state_hash and provider = 'google_calendar' and consumed_at is null and expires_at > now()
  returning oauth_connection_states.user_id, oauth_connection_states.organization_id, oauth_connection_states.location_id;
end; $$;

create function public.store_google_calendar_connection(
  target_organization_id uuid, target_location_id uuid, target_refresh_token text
) returns table (integration_id uuid)
language plpgsql security definer set search_path = '' as $$
declare saved_integration_id uuid; existing_secret_id uuid; previous_version integer;
begin
  perform public.require_scheduling_service_role();
  if not exists (select 1 from public.locations where organization_id = target_organization_id and id = target_location_id) then
    raise exception using errcode = '23503', message = 'Location is not available';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-calendar:' || target_location_id::text, 0));
  insert into public.integrations (organization_id, location_id, provider, status, environment, site_timezone, configuration, last_verified_at, last_error_category)
  values (target_organization_id, target_location_id, 'google_calendar', 'connected', 'production',
    (select timezone from public.locations where id = target_location_id), '{}'::jsonb, now(), null)
  on conflict (organization_id, location_id, provider) do update set status = 'connected', last_verified_at = now(), last_error_category = null, updated_at = now()
  returning id into saved_integration_id;
  select vault_secret_id, credential_version into existing_secret_id, previous_version from public.integration_credentials
  where organization_id = target_organization_id and integration_id = saved_integration_id;
  if length(btrim(coalesce(target_refresh_token, ''))) > 0 then
    if existing_secret_id is null then
      select vault.create_secret(jsonb_build_object('refresh_token', target_refresh_token)::text, 'avenlyo-google-calendar-' || saved_integration_id::text, 'Avenlyo Google Calendar refresh token') into existing_secret_id;
      insert into public.integration_credentials (organization_id, location_id, integration_id, vault_secret_id)
      values (target_organization_id, target_location_id, saved_integration_id, existing_secret_id);
    else
      perform vault.update_secret(existing_secret_id, jsonb_build_object('refresh_token', target_refresh_token)::text, 'avenlyo-google-calendar-' || saved_integration_id::text, 'Avenlyo Google Calendar refresh token');
      update public.integration_credentials set credential_version = previous_version + 1, updated_at = now()
      where organization_id = target_organization_id and integration_id = saved_integration_id;
    end if;
  elsif existing_secret_id is null then
    raise exception using errcode = '22023', message = 'Google Calendar did not provide a refresh token';
  end if;
  return query select saved_integration_id;
end; $$;

create function public.get_google_calendar_execution_credentials(target_integration_id uuid)
returns table (organization_id uuid, location_id uuid, refresh_token text, credential_version integer)
language plpgsql security definer set search_path = '' as $$
declare decrypted text;
begin
  perform public.require_scheduling_service_role();
  select secret.decrypted_secret into decrypted from public.integration_credentials as credential
  join vault.decrypted_secrets as secret on secret.id = credential.vault_secret_id where credential.integration_id = target_integration_id;
  if decrypted is null then raise exception using errcode = '42501', message = 'Google Calendar credentials are not available'; end if;
  return query select integration.organization_id, integration.location_id, (decrypted::jsonb ->> 'refresh_token'), credential.credential_version
  from public.integration_credentials as credential join public.integrations as integration
    on integration.organization_id = credential.organization_id and integration.id = credential.integration_id
  where credential.integration_id = target_integration_id and integration.provider = 'google_calendar' and integration.status = 'connected';
end; $$;

create function public.get_google_calendar_integration_for_location(target_organization_id uuid, target_location_id uuid)
returns table (integration_id uuid, status text, last_verified_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select id, status, last_verified_at from public.integrations
  where organization_id = target_organization_id and location_id = target_location_id and provider = 'google_calendar';
end; $$;

create function public.get_my_google_scheduling_configuration(target_location_id uuid)
returns table (integration_id uuid, status text, last_verified_at timestamptz, is_active boolean, minimum_lead_minutes integer, appointment_type_id uuid, appointment_type_name text, appointment_type_duration_minutes integer, appointment_type_bookable boolean, resource_id uuid, resource_name text, resource_access_role text, resource_bookable boolean)
language plpgsql stable security definer set search_path = '' as $$
declare target_org uuid;
begin
  select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not public.has_location_access(target_org, target_location_id) then raise exception using errcode = '42501', message = 'Location access is required'; end if;
  return query select integration.id, integration.status, integration.last_verified_at, settings.active_integration_id = integration.id, coalesce(settings.minimum_lead_minutes, 60), appointment_type.id, appointment_type.name, appointment_type.default_duration_minutes, appointment_type.bookable, resource.id, resource.name, resource.metadata ->> 'access_role', resource.bookable
  from public.integrations integration left join public.location_scheduling_settings settings on settings.organization_id = integration.organization_id and settings.location_id = integration.location_id
  left join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = integration.organization_id and appointment_type.integration_id = integration.id
  left join public.scheduling_resources resource on resource.organization_id = integration.organization_id and resource.integration_id = integration.id
  where integration.organization_id = target_org and integration.location_id = target_location_id and integration.provider = 'google_calendar'
  order by appointment_type.name nulls last, resource.name nulls last;
end; $$;

create function public.save_google_calendar_resources(target_integration_id uuid, calendars jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare integration public.integrations%rowtype;
begin
  perform public.require_scheduling_service_role();
  select * into integration from public.integrations where id = target_integration_id and provider = 'google_calendar' and status = 'connected';
  if integration.id is null then raise exception using errcode = '42501', message = 'Connected Google Calendar integration is required'; end if;
  if jsonb_typeof(calendars) <> 'array' or jsonb_array_length(calendars) > 100 then raise exception using errcode = '22023', message = 'Calendar discovery data is invalid'; end if;
  if exists (select 1 from jsonb_to_recordset(calendars) as entry(external_uid text, name text, access_role text, timezone text)
    where length(btrim(coalesce(entry.external_uid, ''))) = 0 or length(btrim(coalesce(entry.name, ''))) = 0 or entry.access_role not in ('writer', 'owner')) then
    raise exception using errcode = '22023', message = 'Only writable calendars may be saved';
  end if;
  insert into public.scheduling_resources (organization_id, location_id, integration_id, provider, external_uid, name, external_ownership_id, active, bookable, metadata, last_synced_at)
  select integration.organization_id, integration.location_id, integration.id, 'google_calendar', entry.external_uid, entry.name, null, true, false,
    jsonb_build_object('access_role', entry.access_role, 'timezone', entry.timezone), now()
  from jsonb_to_recordset(calendars) as entry(external_uid text, name text, access_role text, timezone text)
  on conflict (organization_id, integration_id, external_uid) do update set name = excluded.name, active = true, metadata = excluded.metadata, last_synced_at = now(), updated_at = now();
  update public.scheduling_resources set active = false, bookable = false, updated_at = now()
  where scheduling_resources.integration_id = integration.id and scheduling_resources.provider = 'google_calendar' and not exists (select 1 from jsonb_to_recordset(calendars) as entry(external_uid text) where entry.external_uid = scheduling_resources.external_uid);
  update public.integrations set last_catalog_synced_at = now(), last_error_category = null, updated_at = now() where id = integration.id;
end; $$;

create function public.create_my_google_appointment_type(target_location_id uuid, target_name text, target_duration_minutes integer)
returns table (appointment_type_id uuid) language plpgsql security definer set search_path = '' as $$
declare target_org uuid; target_integration uuid; saved_id uuid;
begin
  select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not public.is_organization_admin(target_org) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  if length(btrim(coalesce(target_name, ''))) not between 1 and 160 or target_duration_minutes not between 10 and 360 or mod(target_duration_minutes, 5) <> 0 then raise exception using errcode = '22023', message = 'Appointment type is invalid'; end if;
  select id into target_integration from public.integrations where organization_id = target_org and location_id = target_location_id and provider = 'google_calendar' and status = 'connected';
  if target_integration is null then raise exception using errcode = '42501', message = 'Connected Google Calendar integration is required'; end if;
  insert into public.scheduling_appointment_types (organization_id, location_id, integration_id, provider, catalog_source, external_uid, name, default_duration_minutes, active, bookable)
  values (target_org, target_location_id, target_integration, 'google_calendar', 'avenlyo', 'avenlyo:' || extensions.gen_random_uuid()::text, btrim(target_name), target_duration_minutes, true, false) returning id into saved_id;
  return query select saved_id;
end; $$;

create function public.update_my_google_booking_policy(target_location_id uuid, selected_appointment_type_ids uuid[], selected_resource_ids uuid[], mappings jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare target_org uuid; target_integration uuid;
begin
  select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not public.is_organization_admin(target_org) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  select id into target_integration from public.integrations where organization_id = target_org and location_id = target_location_id and provider = 'google_calendar' and status = 'connected';
  if target_integration is null or cardinality(coalesce(selected_appointment_type_ids, array[]::uuid[])) > 100 or cardinality(coalesce(selected_resource_ids, array[]::uuid[])) > 100 or jsonb_typeof(coalesce(mappings, '[]'::jsonb)) <> 'array' then raise exception using errcode = '22023', message = 'Google Calendar booking policy is invalid'; end if;
  if exists (select 1 from unnest(coalesce(selected_appointment_type_ids, array[]::uuid[])) as picked(id) where not exists (select 1 from public.scheduling_appointment_types where id = picked.id and organization_id = target_org and location_id = target_location_id and integration_id = target_integration and provider = 'google_calendar' and active))
    or exists (select 1 from unnest(coalesce(selected_resource_ids, array[]::uuid[])) as picked(id) where not exists (select 1 from public.scheduling_resources where id = picked.id and organization_id = target_org and location_id = target_location_id and integration_id = target_integration and provider = 'google_calendar' and active)) then raise exception using errcode = '23503', message = 'Google Calendar booking selection is invalid'; end if;
  update public.scheduling_appointment_types set bookable = id = any(coalesce(selected_appointment_type_ids, array[]::uuid[])), updated_at = now() where organization_id = target_org and integration_id = target_integration;
  update public.scheduling_resources set bookable = id = any(coalesce(selected_resource_ids, array[]::uuid[])), updated_at = now() where organization_id = target_org and integration_id = target_integration;
  delete from public.scheduling_appointment_type_resources where organization_id = target_org and integration_id = target_integration;
  insert into public.scheduling_appointment_type_resources (organization_id, location_id, integration_id, appointment_type_id, resource_id)
  select target_org, target_location_id, target_integration, entry.appointment_type_id, entry.resource_id
  from jsonb_to_recordset(mappings) as entry(appointment_type_id uuid, resource_id uuid)
  where entry.appointment_type_id = any(coalesce(selected_appointment_type_ids, array[]::uuid[])) and entry.resource_id = any(coalesce(selected_resource_ids, array[]::uuid[]));
  if exists (select 1 from unnest(coalesce(selected_appointment_type_ids, array[]::uuid[])) as selected(id)
    where not exists (select 1 from public.scheduling_appointment_type_resources as mapping
      where mapping.organization_id = target_org and mapping.integration_id = target_integration and mapping.appointment_type_id = selected.id)) then
    raise exception using errcode = '23503', message = 'Every bookable Google appointment type needs a resource mapping';
  end if;
  if exists (select 1 from public.scheduling_appointment_type_resources where organization_id = target_org and integration_id = target_integration
    and (not exists (select 1 from public.scheduling_appointment_types where id = appointment_type_id and bookable) or not exists (select 1 from public.scheduling_resources where id = resource_id and bookable))) then raise exception using errcode = '23503', message = 'Google Calendar resource mapping is invalid'; end if;
end; $$;

create function public.set_my_active_scheduling_integration(target_location_id uuid, target_integration_id uuid, target_minimum_lead_minutes integer default 60)
returns void language plpgsql security definer set search_path = '' as $$
declare target_org uuid;
begin
  select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not public.is_organization_admin(target_org) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  if target_minimum_lead_minutes not between 15 and 1440 or not exists (select 1 from public.integrations where id = target_integration_id and organization_id = target_org and location_id = target_location_id and status = 'connected') then raise exception using errcode = '23503', message = 'Active scheduling integration is invalid'; end if;
  if not exists (select 1 from public.scheduling_appointment_types where organization_id = target_org and location_id = target_location_id and integration_id = target_integration_id and active and bookable)
    or not exists (select 1 from public.scheduling_resources where organization_id = target_org and location_id = target_location_id and integration_id = target_integration_id and active and bookable) then raise exception using errcode = '22023', message = 'A bookable type and resource are required'; end if;
  insert into public.location_scheduling_settings (organization_id, location_id, active_integration_id, minimum_lead_minutes) values (target_org, target_location_id, target_integration_id, target_minimum_lead_minutes)
  on conflict (organization_id, location_id) do update set active_integration_id = excluded.active_integration_id, minimum_lead_minutes = excluded.minimum_lead_minutes, updated_at = now();
end; $$;

create function public.disable_google_calendar_integration(target_organization_id uuid, target_location_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_id uuid;
begin
  perform public.require_scheduling_service_role();
  select id into target_id from public.integrations where organization_id = target_organization_id and location_id = target_location_id and provider = 'google_calendar';
  if target_id is null then return; end if;
  update public.integrations set status = 'disabled', updated_at = now() where id = target_id;
  update public.location_scheduling_settings set active_integration_id = null, updated_at = now() where organization_id = target_organization_id and location_id = target_location_id and active_integration_id = target_id;
end; $$;

-- Generic, service-only execution context. The selected provider is data, never a tool argument.
create function public.get_voice_scheduling_context(target_call_id text)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, caller_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select call.organization_id, call.location_id, call.conversation_id, call.contact_id, contact.phone,
    nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), integration.id, integration.provider,
    location.timezone, location.business_hours, settings.minimum_lead_minutes
  from public.calls as call join public.locations as location on location.organization_id = call.organization_id and location.id = call.location_id
  join public.location_scheduling_settings as settings on settings.organization_id = call.organization_id and settings.location_id = call.location_id
  join public.integrations as integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id and integration.status = 'connected'
  left join public.contacts as contact on contact.organization_id = call.organization_id and contact.id = call.contact_id
  where call.provider = 'openai-realtime-sip' and call.external_call_id = target_call_id;
end; $$;

create function public.get_scheduling_bookable_catalog(target_integration_id uuid)
returns table (appointment_type_id uuid, appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, resource_id uuid, resource_uid text, resource_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select appointment_type.id, appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes, resource.id, resource.external_uid, resource.name
  from public.integrations as integration join public.scheduling_appointment_types as appointment_type on appointment_type.organization_id = integration.organization_id and appointment_type.integration_id = integration.id and appointment_type.active and appointment_type.bookable
  join public.scheduling_resources as resource on resource.organization_id = integration.organization_id and resource.integration_id = integration.id and resource.active and resource.bookable
  left join public.scheduling_appointment_type_resources as mapping on mapping.organization_id = integration.organization_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = resource.id
  where integration.id = target_integration_id and integration.status = 'connected' and (integration.provider = 'ezyvet' or mapping.appointment_type_id is not null);
end; $$;

create or replace function public.create_voice_booking_candidates(target_call_id text, available_slots jsonb)
returns table (candidate_id uuid, appointment_type_name text, resource_name text, starts_at timestamptz, ends_at timestamptz, timezone text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare context record;
begin
  perform public.require_scheduling_service_role(); select * into context from public.get_voice_scheduling_context(target_call_id);
  if context.integration_id is null or jsonb_typeof(available_slots) <> 'array' or jsonb_array_length(available_slots) not between 1 and 5 then raise exception using errcode = '22023', message = 'Availability slots are invalid'; end if;
  return query with supplied as (select entry.appointment_type_uid, entry.resource_uid, entry.starts_at, entry.ends_at from jsonb_to_recordset(available_slots) as entry(appointment_type_uid text, resource_uid text, starts_at timestamptz, ends_at timestamptz)), inserted as (
    insert into public.booking_candidates (organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
    select context.organization_id, context.location_id, context.conversation_id, context.integration_id, appointment_type.id, resource.id, supplied.starts_at, supplied.ends_at, context.timezone, now() + interval '10 minutes'
    from supplied join public.scheduling_appointment_types as appointment_type on appointment_type.organization_id = context.organization_id and appointment_type.integration_id = context.integration_id and appointment_type.external_uid = supplied.appointment_type_uid and appointment_type.active and appointment_type.bookable
    join public.scheduling_resources as resource on resource.organization_id = context.organization_id and resource.integration_id = context.integration_id and resource.external_uid = supplied.resource_uid and resource.active and resource.bookable
    left join public.scheduling_appointment_type_resources as mapping on mapping.organization_id = context.organization_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = resource.id
    where supplied.ends_at > supplied.starts_at and supplied.starts_at between now() and now() + interval '14 days' and (context.provider = 'ezyvet' or mapping.appointment_type_id is not null)
    returning id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
  select inserted.id, appointment_type.name, resource.name, inserted.starts_at, inserted.ends_at, inserted.timezone, inserted.expires_at from inserted join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = context.organization_id and appointment_type.id = inserted.appointment_type_id join public.scheduling_resources resource on resource.organization_id = context.organization_id and resource.id = inserted.resource_id;
  if not found then raise exception using errcode = '22023', message = 'No trusted availability slots were supplied'; end if;
end; $$;

create function public.prepare_voice_scheduling_booking_intent(target_call_id text, target_candidate_id uuid, resolved_contact_uid text, resolved_subject_uid text, resolved_subject_name text, trusted_contact_id uuid)
returns table (booking_intent_id uuid, appointment_type_name text, starts_at timestamptz, timezone text, status text)
language plpgsql security definer set search_path = '' as $$
declare context record; candidate public.booking_candidates%rowtype; existing public.booking_intents%rowtype; provider_name text;
begin
  perform public.require_scheduling_service_role(); select * into context from public.get_voice_scheduling_context(target_call_id);
  if context.integration_id is null then raise exception using errcode = '42501', message = 'Bookable scheduling integration is not available'; end if;
  if context.provider = 'ezyvet' and (length(btrim(coalesce(resolved_contact_uid, ''))) = 0 or length(btrim(coalesce(resolved_subject_uid, ''))) = 0 or length(btrim(coalesce(resolved_subject_name, ''))) not between 1 and 80) then raise exception using errcode = '22023', message = 'Resolved ezyVet booking identity is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-candidate:' || target_candidate_id::text, 0));
  select * into candidate from public.booking_candidates where id = target_candidate_id and organization_id = context.organization_id and location_id = context.location_id and conversation_id = context.conversation_id and integration_id = context.integration_id;
  if candidate.id is null or candidate.status <> 'offered' or candidate.expires_at <= now() then raise exception using errcode = '42501', message = 'Booking candidate is not available'; end if;
  select * into existing from public.booking_intents where organization_id = candidate.organization_id and candidate_id = candidate.id;
  if existing.id is not null then return query select existing.id, appointment_type.name, candidate.starts_at, candidate.timezone, existing.status from public.scheduling_appointment_types appointment_type where appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id; return; end if;
  insert into public.booking_intents (organization_id, location_id, conversation_id, integration_id, candidate_id, contact_id, external_contact_uid, external_subject_uid, subject_name)
  values (candidate.organization_id, candidate.location_id, candidate.conversation_id, candidate.integration_id, candidate.id, coalesce(trusted_contact_id, context.contact_id), nullif(btrim(coalesce(resolved_contact_uid, '')), ''), nullif(btrim(coalesce(resolved_subject_uid, '')), ''), nullif(btrim(coalesce(resolved_subject_name, '')), '')) returning id into existing.id;
  update public.booking_candidates set status = 'consumed', updated_at = now() where id = candidate.id;
  return query select existing.id, appointment_type.name, candidate.starts_at, candidate.timezone, existing.status from public.scheduling_appointment_types appointment_type where appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id;
end; $$;

create function public.claim_voice_scheduling_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid) language plpgsql security definer set search_path = '' as $$
declare context record; intent public.booking_intents%rowtype; candidate public.booking_candidates%rowtype; inbound_message_id uuid;
begin
  perform public.require_scheduling_service_role(); select * into context from public.get_voice_scheduling_context(target_call_id);
  if context.integration_id is null or length(btrim(coalesce(target_tool_call_id, ''))) = 0 then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents where id = target_booking_intent_id and organization_id = context.organization_id and location_id = context.location_id and conversation_id = context.conversation_id and integration_id = context.integration_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'booking') then return query select case when intent.status = 'booking' then 'booking_recovery' else intent.status end, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  select * into candidate from public.booking_candidates where id = intent.candidate_id and organization_id = intent.organization_id;
  if candidate.expires_at <= now() then update public.booking_intents set status = 'expired', updated_at = now() where id = intent.id; return query select 'expired'::text, intent.id, null::uuid; return; end if;
  select id into inbound_message_id from public.messages where organization_id = intent.organization_id and conversation_id = intent.conversation_id and direction = 'inbound' and created_at > intent.created_at order by created_at desc limit 1;
  if inbound_message_id is null then return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  update public.booking_intents set status = 'booking', booking_tool_call_id = target_tool_call_id, confirmed_message_id = inbound_message_id, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound_message_id;
end; $$;

create function public.claim_booking_slot_lease(target_booking_intent_id uuid)
returns table (lease_id uuid) language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; candidate public.booking_candidates%rowtype; saved_id uuid;
begin
  perform public.require_scheduling_service_role();
  update public.booking_slot_leases set status = 'expired', updated_at = now() where status = 'active' and expires_at <= now();
  select * into intent from public.booking_intents where id = target_booking_intent_id and status = 'booking';
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not claimed'; end if;
  select * into candidate from public.booking_candidates where id = intent.candidate_id and organization_id = intent.organization_id;
  insert into public.booking_slot_leases (organization_id, location_id, integration_id, resource_id, booking_intent_id, starts_at, ends_at, expires_at)
  values (intent.organization_id, intent.location_id, intent.integration_id, candidate.resource_id, intent.id, candidate.starts_at, candidate.ends_at, now() + interval '2 minutes')
  on conflict (organization_id, booking_intent_id) do update set expires_at = excluded.expires_at, status = 'active', updated_at = now() returning id into saved_id;
  return query select saved_id;
exception when exclusion_violation then raise exception using errcode = '23P01', message = 'Booking slot is no longer available';
end; $$;

create function public.release_booking_slot_lease(target_booking_intent_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin perform public.require_scheduling_service_role(); update public.booking_slot_leases set status = 'released', updated_at = now() where booking_intent_id = target_booking_intent_id and status = 'active'; end; $$;

-- Generalize the Phase 5 durable success transition without exposing it to clients.
create or replace function public.record_voice_booking_provider_success(target_booking_intent_id uuid, target_external_appointment_id text, target_provider_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role();
  if length(btrim(coalesce(target_external_appointment_id, ''))) = 0 or length(target_external_appointment_id) > 200 or target_provider_status not in ('unconfirmed', 'confirmed') then raise exception using errcode = '22023', message = 'Provider booking result is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)); select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status = 'provider_success_pending_persistence' then if intent.provider_appointment_id <> btrim(target_external_appointment_id) then raise exception using errcode = '22023', message = 'Provider booking result conflicts with the claimed intent'; end if; return; end if;
  if intent.status <> 'booking' then raise exception using errcode = '22023', message = 'Booking intent is not claimed'; end if;
  update public.booking_intents set status = 'provider_success_pending_persistence', provider_appointment_id = btrim(target_external_appointment_id), failure_category = null, updated_at = now() where id = intent.id;
end; $$;

drop function public.get_voice_booking_execution_context(uuid);
create function public.get_voice_booking_execution_context(target_booking_intent_id uuid)
returns table (booking_intent_id uuid, organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, integration_id uuid, provider text, external_contact_uid text, external_subject_uid text, subject_name text, trusted_phone_e164 text, customer_display_name text, appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, resource_uid text, resource_name text, starts_at timestamptz, ends_at timestamptz, timezone text, business_hours jsonb, minimum_lead_minutes integer, provider_appointment_id text, intent_status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select intent.id, intent.organization_id, intent.location_id, intent.conversation_id, intent.contact_id, intent.integration_id, integration.provider, intent.external_contact_uid, intent.external_subject_uid, intent.subject_name, contact.phone, nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes, resource.external_uid, resource.name, candidate.starts_at, candidate.ends_at, candidate.timezone, location.business_hours, settings.minimum_lead_minutes, intent.provider_appointment_id, intent.status
  from public.booking_intents intent join public.booking_candidates candidate on candidate.organization_id = intent.organization_id and candidate.id = intent.candidate_id join public.integrations integration on integration.organization_id = intent.organization_id and integration.id = intent.integration_id join public.locations location on location.organization_id = intent.organization_id and location.id = intent.location_id join public.location_scheduling_settings settings on settings.organization_id = intent.organization_id and settings.location_id = intent.location_id and settings.active_integration_id = intent.integration_id join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id join public.scheduling_resources resource on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id left join public.contacts contact on contact.organization_id = intent.organization_id and contact.id = intent.contact_id
  where intent.id = target_booking_intent_id and intent.status in ('booking', 'provider_success_pending_persistence') and integration.status = 'connected';
end; $$;

create or replace function public.complete_voice_booking_intent(target_booking_intent_id uuid, target_external_appointment_id text, target_provider_status text)
returns table (appointment_id uuid, is_existing boolean) language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; candidate public.booking_candidates%rowtype; appointment_type public.scheduling_appointment_types%rowtype; integration public.integrations%rowtype; saved_id uuid;
begin
  perform public.require_scheduling_service_role(); if length(btrim(coalesce(target_external_appointment_id, ''))) = 0 or target_provider_status not in ('unconfirmed', 'confirmed') then raise exception using errcode = '22023', message = 'Provider booking result is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)); select * into intent from public.booking_intents where id = target_booking_intent_id; if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  select id into saved_id from public.appointments where organization_id = intent.organization_id and booking_intent_id = intent.id; if saved_id is not null then return query select saved_id, true; return; end if;
  if intent.status <> 'provider_success_pending_persistence' or intent.provider_appointment_id <> btrim(target_external_appointment_id) then raise exception using errcode = '22023', message = 'Provider booking result has not been recorded'; end if;
  select * into candidate from public.booking_candidates where organization_id = intent.organization_id and id = intent.candidate_id; select * into appointment_type from public.scheduling_appointment_types where organization_id = intent.organization_id and id = candidate.appointment_type_id; select * into integration from public.integrations where organization_id = intent.organization_id and id = intent.integration_id;
  insert into public.appointments (organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at, provider, external_appointment_id, integration_id, booking_intent_id, appointment_type, provider_status, external_contact_uid, external_subject_uid, metadata)
  values (intent.organization_id, intent.location_id, intent.contact_id, intent.conversation_id, appointment_type.name || coalesce(' — ' || intent.subject_name, ''), 'requested', candidate.starts_at, candidate.ends_at, integration.provider, intent.provider_appointment_id, intent.integration_id, intent.id, appointment_type.name, target_provider_status, intent.external_contact_uid, intent.external_subject_uid, jsonb_build_object('source', 'inbound_voice', 'subject_name', intent.subject_name)) returning id into saved_id;
  update public.booking_intents set status = 'completed', completed_at = now(), failure_category = null, updated_at = now() where id = intent.id; perform public.release_booking_slot_lease(intent.id); return query select saved_id, false;
end; $$;

create or replace function public.fail_voice_booking_intent(target_booking_intent_id uuid, target_status text, target_error_category text)
returns void language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role(); if target_status not in ('awaiting_confirmation', 'failed', 'provider_state_unknown') then raise exception using errcode = '22023', message = 'Booking outcome is invalid'; end if;
  select * into intent from public.booking_intents where id = target_booking_intent_id; if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown') then return; end if; if intent.status <> 'booking' then raise exception using errcode = '22023', message = 'Booking intent cannot transition to this outcome'; end if;
  update public.booking_intents set status = target_status, failure_category = nullif(btrim(coalesce(target_error_category, '')), ''), updated_at = now() where id = intent.id; perform public.release_booking_slot_lease(intent.id);
end; $$;

revoke all on table public.oauth_connection_states, public.booking_slot_leases from public, anon, authenticated, service_role;
revoke all on function public.create_google_oauth_state(uuid, uuid, text), public.consume_google_oauth_state(text), public.store_google_calendar_connection(uuid, uuid, text), public.get_google_calendar_execution_credentials(uuid), public.get_google_calendar_integration_for_location(uuid, uuid), public.save_google_calendar_resources(uuid, jsonb), public.disable_google_calendar_integration(uuid, uuid), public.get_voice_scheduling_context(text), public.get_scheduling_bookable_catalog(uuid), public.create_voice_booking_candidates(text, jsonb), public.prepare_voice_scheduling_booking_intent(text, uuid, text, text, text, uuid), public.claim_voice_scheduling_booking_intent(text, uuid, text), public.claim_booking_slot_lease(uuid), public.release_booking_slot_lease(uuid) from public;
revoke all on function public.get_voice_booking_execution_context(uuid), public.record_voice_booking_provider_success(uuid, text, text), public.complete_voice_booking_intent(uuid, text, text), public.fail_voice_booking_intent(uuid, text, text) from public;
grant execute on function public.create_my_google_appointment_type(uuid, text, integer), public.update_my_google_booking_policy(uuid, uuid[], uuid[], jsonb), public.set_my_active_scheduling_integration(uuid, uuid, integer) to authenticated;
grant execute on function public.get_my_google_scheduling_configuration(uuid) to authenticated;
grant execute on function public.get_google_backend_authorization(uuid, uuid), public.create_google_oauth_state(uuid, uuid, text), public.consume_google_oauth_state(text), public.store_google_calendar_connection(uuid, uuid, text), public.get_google_calendar_execution_credentials(uuid), public.get_google_calendar_integration_for_location(uuid, uuid), public.save_google_calendar_resources(uuid, jsonb), public.disable_google_calendar_integration(uuid, uuid), public.get_voice_scheduling_context(text), public.get_scheduling_bookable_catalog(uuid), public.create_voice_booking_candidates(text, jsonb), public.prepare_voice_scheduling_booking_intent(text, uuid, text, text, text, uuid), public.claim_voice_scheduling_booking_intent(text, uuid, text), public.claim_booking_slot_lease(uuid), public.release_booking_slot_lease(uuid), public.get_voice_booking_execution_context(uuid), public.record_voice_booking_provider_success(uuid, text, text), public.complete_voice_booking_intent(uuid, text, text), public.fail_voice_booking_intent(uuid, text, text) to service_role;

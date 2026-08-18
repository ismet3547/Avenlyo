-- Phase 9: durable customer/staff appointment cancellation and rescheduling.  All provider
-- mutations are executed by the trusted backend through the change-intent state machine.

alter table public.appointments
  add column if not exists scheduling_resource_id uuid,
  add constraint appointments_scheduling_resource_scope_fk
    foreign key (organization_id, location_id, integration_id, scheduling_resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id);

create table public.appointment_management_targets (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  appointment_id uuid not null,
  inbound_message_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_management_targets_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint appointment_management_targets_conversation_fk foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint appointment_management_targets_appointment_fk foreign key (organization_id, location_id, appointment_id)
    references public.appointments (organization_id, location_id, id) on delete cascade,
  constraint appointment_management_targets_message_fk foreign key (organization_id, location_id, inbound_message_id)
    references public.messages (organization_id, location_id, id) on delete cascade,
  constraint appointment_management_targets_expiry_check check (expires_at > created_at),
  constraint appointment_management_targets_scope_key unique (organization_id, conversation_id, appointment_id, inbound_message_id),
  constraint appointment_management_targets_organization_id_key unique (organization_id, id)
);

create table public.appointment_change_candidates (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  target_id uuid not null,
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
  constraint appointment_change_candidates_time_check check (ends_at > starts_at and expires_at > created_at),
  constraint appointment_change_candidates_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint appointment_change_candidates_target_fk foreign key (organization_id, target_id)
    references public.appointment_management_targets (organization_id, id) on delete cascade,
  constraint appointment_change_candidates_integration_fk foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id),
  constraint appointment_change_candidates_type_fk foreign key (organization_id, location_id, integration_id, appointment_type_id)
    references public.scheduling_appointment_types (organization_id, location_id, integration_id, id),
  constraint appointment_change_candidates_resource_fk foreign key (organization_id, location_id, integration_id, resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id),
  constraint appointment_change_candidates_organization_id_key unique (organization_id, id)
);

create table public.appointment_change_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  appointment_id uuid not null,
  booking_intent_id uuid,
  integration_id uuid not null,
  provider text not null check (provider in ('ezyvet', 'google_calendar')),
  operation text not null check (operation in ('cancel', 'reschedule')),
  status text not null default 'awaiting_confirmation' check (status in ('awaiting_confirmation', 'executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'completed', 'failed', 'expired', 'handoff_required')),
  prepared_message_id uuid not null,
  confirmed_message_id uuid,
  candidate_id uuid,
  original_starts_at timestamptz not null,
  original_ends_at timestamptz not null,
  original_resource_id uuid not null,
  target_starts_at timestamptz,
  target_ends_at timestamptz,
  target_resource_id uuid,
  provider_operation_id text,
  provider_state text,
  failure_category text,
  mutation_attempt_count integer not null default 0 check (mutation_attempt_count between 0 and 1),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_change_intents_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint appointment_change_intents_conversation_fk foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint appointment_change_intents_appointment_fk foreign key (organization_id, location_id, appointment_id)
    references public.appointments (organization_id, location_id, id) on delete cascade,
  constraint appointment_change_intents_booking_fk foreign key (organization_id, booking_intent_id)
    references public.booking_intents (organization_id, id),
  constraint appointment_change_intents_integration_fk foreign key (organization_id, location_id, integration_id)
    references public.integrations (organization_id, location_id, id),
  constraint appointment_change_intents_prepared_message_fk foreign key (organization_id, location_id, prepared_message_id)
    references public.messages (organization_id, location_id, id),
  constraint appointment_change_intents_confirmed_message_fk foreign key (organization_id, location_id, confirmed_message_id)
    references public.messages (organization_id, location_id, id),
  constraint appointment_change_intents_candidate_fk foreign key (organization_id, candidate_id)
    references public.appointment_change_candidates (organization_id, id),
  constraint appointment_change_intents_original_resource_fk foreign key (organization_id, location_id, integration_id, original_resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id),
  constraint appointment_change_intents_target_resource_fk foreign key (organization_id, location_id, integration_id, target_resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id),
  constraint appointment_change_intents_target_check check ((operation = 'cancel' and target_starts_at is null and target_ends_at is null and target_resource_id is null) or (operation = 'reschedule' and target_starts_at is not null and target_ends_at is not null and target_resource_id is not null and target_ends_at > target_starts_at)),
  constraint appointment_change_intents_expiry_check check (expires_at > created_at)
);
create unique index appointment_change_intents_one_active_appointment_key
  on public.appointment_change_intents (appointment_id)
  where status in ('awaiting_confirmation', 'executing', 'provider_success_pending_persistence', 'provider_state_unknown');

create table public.appointment_change_slot_leases (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  integration_id uuid not null,
  resource_id uuid not null,
  change_intent_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'released', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_change_slot_leases_time_check check (ends_at > starts_at and expires_at > created_at),
  constraint appointment_change_slot_leases_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint appointment_change_slot_leases_resource_fk foreign key (organization_id, location_id, integration_id, resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id),
  constraint appointment_change_slot_leases_intent_fk foreign key (change_intent_id)
    references public.appointment_change_intents (id) on delete cascade,
  constraint appointment_change_slot_leases_intent_key unique (change_intent_id)
);
alter table public.appointment_change_slot_leases add constraint appointment_change_slot_leases_no_overlap
  exclude using gist (organization_id with =, resource_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status = 'active');

alter table public.appointment_management_targets enable row level security;
alter table public.appointment_change_candidates enable row level security;
alter table public.appointment_change_intents enable row level security;
alter table public.appointment_change_slot_leases enable row level security;
create policy appointment_change_intents_select_location_member on public.appointment_change_intents for select to authenticated
  using (public.has_location_access(organization_id, location_id));
revoke all on table public.appointment_management_targets, public.appointment_change_candidates, public.appointment_change_intents, public.appointment_change_slot_leases from public, anon, authenticated, service_role;
grant select on public.appointment_change_intents to authenticated;

create function public.require_appointment_lifecycle_service_role() returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'Trusted appointment lifecycle backend access is required'; end if;
end; $$;

create function public.is_explicit_appointment_change_confirmation(target_operation text, target_body text)
returns boolean language sql immutable set search_path = '' as $$
  select case target_operation
    when 'cancel' then coalesce(target_body, '') ~* '(^|[^a-z])(cancel|yes[,! ]+cancel|please cancel)([^a-z]|$)'
    when 'reschedule' then coalesce(target_body, '') ~* '(^|[^a-z])(yes|confirm|reschedule)([^a-z]|$)'
    else false end;
$$;

create function public.create_conversation_appointment_management_targets(target_conversation_id uuid, target_inbound_message_id uuid)
returns table (appointment_reference uuid, title text, starts_at timestamptz, ends_at timestamptz, timezone text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; conversation_row public.conversations%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  select * into inbound from public.messages where id = target_inbound_message_id and conversation_id = target_conversation_id and direction = 'inbound' and author_type = 'customer';
  select * into conversation_row from public.conversations where id = target_conversation_id;
  if inbound.id is null or conversation_row.id is null then raise exception using errcode = '42501', message = 'Trusted customer context is required'; end if;
  return query with eligible as (
    select appointment.id, appointment.title, appointment.starts_at, appointment.ends_at, location.timezone
    from public.appointments appointment join public.locations location on location.organization_id = appointment.organization_id and location.id = appointment.location_id
    left join public.booking_intents booking on booking.organization_id = appointment.organization_id and booking.id = appointment.booking_intent_id
    left join public.channels channel on channel.organization_id = conversation_row.organization_id and channel.id = conversation_row.channel_id
    where appointment.organization_id = conversation_row.organization_id and appointment.location_id = conversation_row.location_id
      and appointment.status = 'confirmed' and appointment.starts_at > now() and appointment.integration_id is not null
      and ((channel.channel_type = 'web' and appointment.conversation_id = conversation_row.id)
        or (channel.channel_type = 'sms' and inbound.transport_sender_e164 is not null and inbound.transport_sender_e164 = coalesce(appointment.trusted_sms_recipient_e164, booking.trusted_transport_phone_e164))
        or (channel.channel_type = 'phone' and exists (select 1 from public.calls call where call.organization_id = conversation_row.organization_id and call.conversation_id = conversation_row.id and call.transport_caller_e164 = coalesce(appointment.trusted_sms_recipient_e164, booking.trusted_transport_phone_e164))))
  ), saved as (
    insert into public.appointment_management_targets (organization_id, location_id, conversation_id, appointment_id, inbound_message_id, expires_at)
    select conversation_row.organization_id, conversation_row.location_id, conversation_row.id, eligible.id, inbound.id, now() + interval '10 minutes' from eligible
    on conflict (organization_id, conversation_id, appointment_id, inbound_message_id) do update set expires_at = excluded.expires_at, updated_at = now()
    returning id, appointment_id, expires_at
  )
  select saved.id, eligible.title, eligible.starts_at, eligible.ends_at, eligible.timezone, saved.expires_at from saved join eligible on eligible.id = saved.appointment_id;
end; $$;

create function public.create_appointment_change_candidates(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid, target_slots jsonb)
returns table (candidate_id uuid, starts_at timestamptz, ends_at timestamptz, timezone text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare target public.appointment_management_targets%rowtype; appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  if jsonb_typeof(target_slots) <> 'array' or jsonb_array_length(target_slots) not between 1 and 5 then raise exception using errcode = '22023', message = 'Appointment change slots are invalid'; end if;
  select * into target from public.appointment_management_targets where id = target_reference_id and conversation_id = target_conversation_id and inbound_message_id = target_inbound_message_id and expires_at > now();
  if target.id is null then raise exception using errcode = '42501', message = 'Appointment reference is not available'; end if;
  select * into appointment_row from public.appointments where id = target.appointment_id; select * into booking from public.booking_intents where organization_id = appointment_row.organization_id and id = appointment_row.booking_intent_id;
  if booking.id is null then raise exception using errcode = '42501', message = 'Appointment cannot be rescheduled safely'; end if;
  return query with supplied as (select value.resource_uid, value.starts_at, value.ends_at from jsonb_to_recordset(target_slots) as value(resource_uid text, starts_at timestamptz, ends_at timestamptz)), saved as (
    insert into public.appointment_change_candidates (organization_id, location_id, conversation_id, target_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
    select target.organization_id, target.location_id, target.conversation_id, target.id, appointment_row.integration_id, booking_candidate.appointment_type_id, resource.id, supplied.starts_at, supplied.ends_at, location.timezone, now() + interval '10 minutes'
    from supplied join public.scheduling_resources resource on resource.organization_id = target.organization_id and resource.location_id = target.location_id and resource.integration_id = appointment_row.integration_id and resource.external_uid = supplied.resource_uid and resource.active and resource.bookable
    join public.booking_candidates booking_candidate on booking_candidate.organization_id = booking.organization_id and booking_candidate.id = booking.candidate_id
    join public.locations location on location.organization_id = target.organization_id and location.id = target.location_id
    where supplied.ends_at > supplied.starts_at and supplied.starts_at > now() and supplied.starts_at <= now() + interval '14 days'
      and exists (select 1 from public.scheduling_appointment_type_resources mapping where mapping.organization_id = target.organization_id and mapping.location_id = target.location_id and mapping.integration_id = appointment_row.integration_id and mapping.appointment_type_id = booking_candidate.appointment_type_id and mapping.resource_id = resource.id)
    returning id, starts_at, ends_at, timezone, expires_at)
  select * from saved;
end; $$;

create function public.get_appointment_change_target_context(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid)
returns table (organization_id uuid, location_id uuid, integration_id uuid, provider text, appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, timezone text, business_hours jsonb, minimum_lead_minutes integer)
language sql stable security definer set search_path = '' as $$
  select target.organization_id, target.location_id, appointment.integration_id, appointment.provider,
    appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes,
    location.timezone, location.business_hours, settings.minimum_lead_minutes
  from public.appointment_management_targets target
  join public.appointments appointment on appointment.organization_id = target.organization_id and appointment.id = target.appointment_id
  join public.booking_intents booking on booking.organization_id = appointment.organization_id and booking.id = appointment.booking_intent_id
  join public.booking_candidates candidate on candidate.organization_id = booking.organization_id and candidate.id = booking.candidate_id
  join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id
  join public.locations location on location.organization_id = target.organization_id and location.id = target.location_id
  join public.location_scheduling_settings settings on settings.organization_id = target.organization_id and settings.location_id = target.location_id and settings.active_integration_id = appointment.integration_id
  where target.id = target_reference_id and target.conversation_id = target_conversation_id and target.inbound_message_id = target_inbound_message_id and target.expires_at > now()
    and appointment.status = 'confirmed' and appointment.starts_at > now() and appointment.integration_id is not null;
$$;

create function public.prepare_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid, target_operation text, target_candidate_id uuid default null)
returns table (change_intent_id uuid, operation text, starts_at timestamptz, timezone text, status text)
language plpgsql security definer set search_path = '' as $$
declare target public.appointment_management_targets%rowtype; appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype; candidate public.appointment_change_candidates%rowtype; existing public.appointment_change_intents%rowtype; resource_id uuid;
begin
  perform public.require_appointment_lifecycle_service_role();
  if target_operation not in ('cancel', 'reschedule') then raise exception using errcode = '22023', message = 'Appointment change operation is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change-target:' || coalesce(target_reference_id, target_candidate_id)::text, 0));
  if target_reference_id is null and target_candidate_id is not null then
    select management.* into target from public.appointment_change_candidates candidate join public.appointment_management_targets management on management.organization_id = candidate.organization_id and management.id = candidate.target_id
      where candidate.id = target_candidate_id and candidate.conversation_id = target_conversation_id and management.inbound_message_id = target_inbound_message_id and candidate.status = 'offered' and candidate.expires_at > now();
  else
    select * into target from public.appointment_management_targets where id = target_reference_id and conversation_id = target_conversation_id and inbound_message_id = target_inbound_message_id and expires_at > now();
  end if;
  if target.id is null then raise exception using errcode = '42501', message = 'Appointment reference is not available'; end if;
  select * into appointment_row from public.appointments where id = target.appointment_id and status = 'confirmed' and starts_at > now();
  select * into booking from public.booking_intents where organization_id = target.organization_id and id = appointment_row.booking_intent_id;
  resource_id := coalesce(appointment_row.scheduling_resource_id, (select resource_id from public.booking_candidates where organization_id = booking.organization_id and id = booking.candidate_id));
  if appointment_row.id is null or booking.id is null or appointment_row.integration_id is null or resource_id is null then raise exception using errcode = '42501', message = 'Appointment cannot be changed safely'; end if;
  if target_operation = 'reschedule' then select * into candidate from public.appointment_change_candidates where id = target_candidate_id and target_id = target.id and status = 'offered' and expires_at > now(); if candidate.id is null then raise exception using errcode = '42501', message = 'Appointment change candidate is not available'; end if; end if;
  select * into existing from public.appointment_change_intents where appointment_id = appointment_row.id and status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown');
  if existing.id is not null then return query select existing.id, existing.operation, existing.target_starts_at, candidate.timezone, existing.status; return; end if;
  insert into public.appointment_change_intents (organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, prepared_message_id, candidate_id, original_starts_at, original_ends_at, original_resource_id, target_starts_at, target_ends_at, target_resource_id, expires_at)
  select target.organization_id, target.location_id, target.conversation_id, appointment_row.id, booking.id, appointment_row.integration_id, appointment_row.provider, target_operation, target_inbound_message_id, candidate.id, appointment_row.starts_at, appointment_row.ends_at, resource_id, candidate.starts_at, candidate.ends_at, candidate.resource_id, now() + interval '10 minutes';
  select * into existing from public.appointment_change_intents where appointment_id = appointment_row.id and status = 'awaiting_confirmation' order by created_at desc limit 1;
  if candidate.id is not null then update public.appointment_change_candidates set status = 'consumed', updated_at = now() where id = candidate.id; end if;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (target.organization_id, target.location_id, 'appointment_change_prepared', 'appointment_change_intent', existing.id, jsonb_build_object('operation', target_operation));
  return query select existing.id, existing.operation, existing.target_starts_at, coalesce(candidate.timezone, (select timezone from public.locations where id = target.location_id)), existing.status;
end; $$;

create function public.claim_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_change_intent_id uuid, target_tool_call_id text)
returns table (state text, change_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype; inbound public.messages%rowtype; eligible boolean;
begin
  perform public.require_appointment_lifecycle_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) not between 1 and 200 then raise exception using errcode = '22023', message = 'Appointment change tool call is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change:' || target_change_intent_id::text, 0));
  select * into intent from public.appointment_change_intents where id = target_change_intent_id and conversation_id = target_conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Appointment change intent is not available'; end if;
  if intent.status in ('completed','provider_success_pending_persistence','provider_state_unknown','executing','handoff_required') then return query select case when intent.status = 'executing' then 'recovery' else intent.status end, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' or intent.expires_at <= now() then update public.appointment_change_intents set status = 'expired', updated_at = now() where id = intent.id and status = 'awaiting_confirmation'; return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and organization_id = intent.organization_id and location_id = intent.location_id and conversation_id = intent.conversation_id and direction = 'inbound' and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= intent.created_at or not public.is_explicit_appointment_change_confirmation(intent.operation, inbound.body) then return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  select exists(select 1 from public.appointments appointment join public.integrations integration on integration.organization_id = appointment.organization_id and integration.location_id = appointment.location_id and integration.id = appointment.integration_id join public.location_scheduling_settings settings on settings.organization_id = appointment.organization_id and settings.location_id = appointment.location_id and settings.active_integration_id = appointment.integration_id where appointment.id = intent.appointment_id and appointment.status = 'confirmed' and appointment.starts_at > now() and integration.status = 'connected') into eligible;
  if not eligible then update public.appointment_change_intents set status = 'failed', failure_category = 'configuration_changed', updated_at = now() where id = intent.id; return query select 'configuration_changed'::text, intent.id, null::uuid; return; end if;
  update public.appointment_change_intents set status = 'executing', confirmed_message_id = inbound.id, mutation_attempt_count = 1, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound.id;
end; $$;

create function public.claim_appointment_change_slot_lease(target_change_intent_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role(); update public.appointment_change_slot_leases set status = 'expired', updated_at = now() where status = 'active' and expires_at <= now();
  select * into intent from public.appointment_change_intents where id = target_change_intent_id and status = 'executing' and operation = 'reschedule';
  if intent.id is null then raise exception using errcode = '42501', message = 'Appointment change intent is not claimed'; end if;
  insert into public.appointment_change_slot_leases (organization_id, location_id, integration_id, resource_id, change_intent_id, starts_at, ends_at, expires_at) values (intent.organization_id, intent.location_id, intent.integration_id, intent.target_resource_id, intent.id, intent.target_starts_at, intent.target_ends_at, now() + interval '2 minutes') on conflict (change_intent_id) do update set status = 'active', expires_at = excluded.expires_at, updated_at = now();
exception when exclusion_violation then raise exception using errcode = '23P01', message = 'Appointment change slot is no longer available';
end; $$;

create function public.get_appointment_change_execution_context(target_change_intent_id uuid)
returns table (change_intent_id uuid, organization_id uuid, location_id uuid, appointment_id uuid, booking_intent_id uuid, integration_id uuid, provider text, operation text, external_appointment_id text, original_starts_at timestamptz, original_ends_at timestamptz, target_starts_at timestamptz, target_ends_at timestamptz, resource_uid text, resource_name text, timezone text, business_hours jsonb, minimum_lead_minutes integer, intent_status text)
language sql stable security definer set search_path = '' as $$
  select intent.id, intent.organization_id, intent.location_id, intent.appointment_id, intent.booking_intent_id, intent.integration_id, intent.provider, intent.operation, appointment.external_appointment_id, intent.original_starts_at, intent.original_ends_at, intent.target_starts_at, intent.target_ends_at, resource.external_uid, resource.name, location.timezone, location.business_hours, settings.minimum_lead_minutes, intent.status
  from public.appointment_change_intents intent join public.appointments appointment on appointment.organization_id = intent.organization_id and appointment.id = intent.appointment_id join public.scheduling_resources resource on resource.organization_id = intent.organization_id and resource.id = coalesce(intent.target_resource_id, intent.original_resource_id) join public.locations location on location.organization_id = intent.organization_id and location.id = intent.location_id join public.location_scheduling_settings settings on settings.organization_id = intent.organization_id and settings.location_id = intent.location_id
  where intent.id = target_change_intent_id and intent.status in ('executing','provider_success_pending_persistence','provider_state_unknown');
$$;

create function public.record_appointment_change_provider_success(target_change_intent_id uuid, target_provider_state text default 'confirmed') returns void
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role(); select * into intent from public.appointment_change_intents where id = target_change_intent_id for update;
  if intent.id is null or intent.status not in ('executing','provider_state_unknown','provider_success_pending_persistence') then raise exception using errcode = '42501', message = 'Appointment change result is not available'; end if;
  update public.appointment_change_intents set status = 'provider_success_pending_persistence', provider_state = left(nullif(btrim(target_provider_state), ''), 80), failure_category = null, updated_at = now() where id = intent.id;
end; $$;

create function public.complete_appointment_change_intent(target_change_intent_id uuid) returns table (appointment_id uuid, operation text)
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role(); select * into intent from public.appointment_change_intents where id = target_change_intent_id for update;
  if intent.id is null or intent.status <> 'provider_success_pending_persistence' then raise exception using errcode = '42501', message = 'Appointment change has not recorded provider success'; end if;
  if intent.operation = 'cancel' then
    update public.appointments set status = 'cancelled', provider_status = 'cancelled', updated_at = now() where id = intent.appointment_id;
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_cancelled', claimed_at = null, claimed_by = null, updated_at = now() where appointment_id = intent.appointment_id and status in ('scheduled','processing');
  else
    update public.appointments set starts_at = intent.target_starts_at, ends_at = intent.target_ends_at, scheduling_resource_id = intent.target_resource_id, provider_status = 'confirmed', updated_at = now() where id = intent.appointment_id;
    perform public.refresh_appointment_reminders_internal(intent.appointment_id);
  end if;
  update public.appointment_change_intents set status = 'completed', completed_at = now(), updated_at = now() where id = intent.id;
  update public.appointment_change_slot_leases set status = 'released', updated_at = now() where change_intent_id = intent.id and status = 'active';
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (intent.organization_id, intent.location_id, 'appointment_change_completed', 'appointment_change_intent', intent.id, jsonb_build_object('operation', intent.operation));
  return query select intent.appointment_id, intent.operation;
end; $$;

create function public.fail_appointment_change_intent(target_change_intent_id uuid, target_status text, target_error_category text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_appointment_lifecycle_service_role();
  if target_status not in ('awaiting_confirmation','failed','provider_state_unknown','handoff_required') then raise exception using errcode = '22023', message = 'Appointment change outcome is invalid'; end if;
  update public.appointment_change_intents set status = target_status, failure_category = left(nullif(btrim(coalesce(target_error_category, '')), ''), 80), updated_at = now() where id = target_change_intent_id and status = 'executing';
  update public.appointment_change_slot_leases set status = 'released', updated_at = now() where change_intent_id = target_change_intent_id and status = 'active';
end; $$;

revoke all on function public.require_appointment_lifecycle_service_role(), public.is_explicit_appointment_change_confirmation(text, text), public.create_conversation_appointment_management_targets(uuid, uuid), public.get_appointment_change_target_context(uuid, uuid, uuid), public.create_appointment_change_candidates(uuid, uuid, uuid, jsonb), public.prepare_appointment_change_intent(uuid, uuid, uuid, text, uuid), public.claim_appointment_change_intent(uuid, uuid, uuid, text), public.claim_appointment_change_slot_lease(uuid), public.get_appointment_change_execution_context(uuid), public.record_appointment_change_provider_success(uuid, text), public.complete_appointment_change_intent(uuid), public.fail_appointment_change_intent(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_conversation_appointment_management_targets(uuid, uuid), public.get_appointment_change_target_context(uuid, uuid, uuid), public.create_appointment_change_candidates(uuid, uuid, uuid, jsonb), public.prepare_appointment_change_intent(uuid, uuid, uuid, text, uuid), public.claim_appointment_change_intent(uuid, uuid, uuid, text), public.claim_appointment_change_slot_lease(uuid), public.get_appointment_change_execution_context(uuid), public.record_appointment_change_provider_success(uuid, text), public.complete_appointment_change_intent(uuid), public.fail_appointment_change_intent(uuid, text, text) to service_role;

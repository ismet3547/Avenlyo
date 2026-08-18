-- Phase 9 follow-up: preserve a provider's immutable mutation target and tighten lifecycle
-- transitions.  All writes remain behind service-role SECURITY DEFINER functions.

alter table public.appointment_change_intents
  add column if not exists provider_mutation_target_id text,
  add column if not exists actor_category text not null default 'customer' check (actor_category in ('customer', 'staff')),
  alter column prepared_message_id drop not null,
  add constraint appointment_change_intents_ezyvet_mutation_target_check
    check (provider <> 'ezyvet' or provider_mutation_target_id is null or provider_mutation_target_id ~ '^[1-9][0-9]*$');

-- A single lease namespace prevents a booking and a reschedule from reserving the same resource
-- and interval in two independent exclusion constraints.
create table public.scheduling_slot_leases (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  integration_id uuid not null,
  resource_id uuid not null,
  booking_intent_id uuid,
  change_intent_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'released', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduling_slot_leases_owner_check check (num_nonnulls(booking_intent_id, change_intent_id) = 1),
  constraint scheduling_slot_leases_time_check check (ends_at > starts_at and expires_at > created_at),
  constraint scheduling_slot_leases_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint scheduling_slot_leases_resource_fk foreign key (organization_id, location_id, integration_id, resource_id)
    references public.scheduling_resources (organization_id, location_id, integration_id, id),
  constraint scheduling_slot_leases_booking_fk foreign key (organization_id, booking_intent_id)
    references public.booking_intents (organization_id, id) on delete cascade,
  constraint scheduling_slot_leases_change_fk foreign key (change_intent_id)
    references public.appointment_change_intents (id) on delete cascade,
  constraint scheduling_slot_leases_booking_key unique (organization_id, booking_intent_id),
  constraint scheduling_slot_leases_change_key unique (change_intent_id)
);
alter table public.scheduling_slot_leases add constraint scheduling_slot_leases_no_overlap
  exclude using gist (organization_id with =, resource_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status = 'active');
alter table public.scheduling_slot_leases enable row level security;
revoke all on table public.scheduling_slot_leases from public, anon, authenticated, service_role;

-- Existing booking RPCs keep their stable table/API.  This trigger mirrors their active lease
-- into the shared exclusion namespace before the booking lease is accepted.
create function public.sync_booking_slot_lease_to_scheduling_namespace() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'active' then
    insert into public.scheduling_slot_leases (organization_id, location_id, integration_id, resource_id, booking_intent_id, starts_at, ends_at, expires_at, status)
    values (new.organization_id, new.location_id, new.integration_id, new.resource_id, new.booking_intent_id, new.starts_at, new.ends_at, new.expires_at, 'active')
    on conflict (organization_id, booking_intent_id) do update set resource_id = excluded.resource_id,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, expires_at = excluded.expires_at,
      status = 'active', updated_at = now();
  elsif old.status = 'active' then
    update public.scheduling_slot_leases set status = new.status, updated_at = now()
      where organization_id = new.organization_id and booking_intent_id = new.booking_intent_id and status = 'active';
  end if;
  return new;
end;
$$;
create trigger booking_slot_lease_shared_namespace
  after insert or update of status, resource_id, starts_at, ends_at, expires_at on public.booking_slot_leases
  for each row execute function public.sync_booking_slot_lease_to_scheduling_namespace();

create or replace function public.is_explicit_appointment_change_confirmation(target_operation text, target_body text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare value text := lower(btrim(coalesce(target_body, '')));
begin
  -- A question, hesitation, or an explicit negative is never consent to a destructive action.
  if value = '' or value ~ '[?]' or value ~ '(^|[^a-z])(no|not|don''t|dont|do not|maybe|perhaps|later)([^a-z]|$)' then
    return false;
  end if;
  if target_operation = 'cancel' then
    return value ~ '(^|[^a-z])(cancel|cancel it|yes cancel|please cancel)([^a-z]|$)';
  end if;
  if target_operation = 'reschedule' then
    return value ~ '^(yes|yes reschedule|confirm|confirm it|move|move it)[!. ]*$';
  end if;
  return false;
end;
$$;

-- A fresh operation observes current integration, type, resource, and target-candidate state.
-- Recovery skips this check because a prior write may already have reached the provider.
create or replace function public.claim_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_change_intent_id uuid, target_tool_call_id text)
returns table (state text, change_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype; inbound public.messages%rowtype; eligible boolean;
begin
  perform public.require_appointment_lifecycle_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Appointment change tool call is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change:' || target_change_intent_id::text, 0));
  select * into intent from public.appointment_change_intents where id = target_change_intent_id and conversation_id = target_conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Appointment change intent is not available'; end if;
  if intent.status in ('completed','provider_success_pending_persistence','provider_state_unknown','executing','handoff_required') then
    return query select case when intent.status = 'executing' then 'recovery' else intent.status end, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status <> 'awaiting_confirmation' or intent.expires_at <= now() then
    update public.appointment_change_intents set status = 'expired', updated_at = now() where id = intent.id and status = 'awaiting_confirmation';
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  select * into inbound from public.messages where id = target_inbound_message_id and organization_id = intent.organization_id
    and location_id = intent.location_id and conversation_id = intent.conversation_id and direction = 'inbound' and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= intent.created_at
      or not public.is_explicit_appointment_change_confirmation(intent.operation, inbound.body) then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  select exists(
    select 1
    from public.appointments appointment
    join public.integrations integration on integration.organization_id = appointment.organization_id
      and integration.location_id = appointment.location_id and integration.id = appointment.integration_id
    join public.location_scheduling_settings settings on settings.organization_id = appointment.organization_id
      and settings.location_id = appointment.location_id and settings.active_integration_id = appointment.integration_id
    join public.booking_intents booking on booking.organization_id = appointment.organization_id and booking.id = intent.booking_intent_id
    join public.booking_candidates original_candidate on original_candidate.organization_id = booking.organization_id and original_candidate.id = booking.candidate_id
    join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = appointment.organization_id
      and appointment_type.id = original_candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
    join public.scheduling_resources original_resource on original_resource.organization_id = appointment.organization_id
      and original_resource.id = intent.original_resource_id and original_resource.integration_id = intent.integration_id
    left join public.appointment_change_candidates target_candidate on target_candidate.organization_id = intent.organization_id and target_candidate.id = intent.candidate_id
    left join public.scheduling_resources target_resource on target_resource.organization_id = intent.organization_id and target_resource.id = intent.target_resource_id
    where appointment.id = intent.appointment_id and appointment.status = 'confirmed' and appointment.starts_at > now()
      and integration.status = 'connected' and appointment_type.active and appointment_type.bookable
      and original_resource.active and original_resource.bookable
      and (intent.operation = 'cancel' or ((target_candidate.id is not null and target_candidate.status = 'consumed'
        and target_candidate.expires_at > now()) or (intent.actor_category = 'staff' and target_candidate.id is null
        and intent.target_starts_at > now() and intent.target_ends_at > intent.target_starts_at)) and target_resource.active and target_resource.bookable
        and (integration.provider <> 'google_calendar' or target_resource.id = original_resource.id)
        and (integration.provider = 'ezyvet' or exists (
          select 1 from public.scheduling_appointment_type_resources mapping where mapping.organization_id = intent.organization_id
            and mapping.location_id = intent.location_id and mapping.integration_id = intent.integration_id
            and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = target_resource.id
        ))))
  ) into eligible;
  if not eligible then
    update public.appointment_change_intents set status = 'failed', failure_category = 'configuration_changed', updated_at = now() where id = intent.id;
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (intent.organization_id, intent.location_id, 'appointment.' || intent.operation || '.failed', 'appointment_change_intent', intent.id, jsonb_build_object('category', 'configuration_changed'));
    return query select 'configuration_changed'::text, intent.id, null::uuid;
    return;
  end if;
  update public.appointment_change_intents set status = 'executing', confirmed_message_id = inbound.id, mutation_attempt_count = 1, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound.id;
end;
$$;

-- The only accepted write target is persisted before the first mutation.  A conflicting target
-- cannot overwrite an in-flight/recovery target.
create function public.persist_appointment_change_mutation_target(target_change_intent_id uuid, target_mutation_target_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  select * into intent from public.appointment_change_intents where id = target_change_intent_id for update;
  if intent.id is null or intent.status <> 'executing' then raise exception using errcode = '42501', message = 'Appointment change is not executing'; end if;
  if intent.provider = 'ezyvet' and btrim(coalesce(target_mutation_target_id, '')) !~ '^[1-9][0-9]*$' then
    raise exception using errcode = '22023', message = 'ezyVet mutation target is invalid';
  end if;
  if intent.provider_mutation_target_id is not null and intent.provider_mutation_target_id <> btrim(target_mutation_target_id) then
    raise exception using errcode = '22023', message = 'Provider mutation target conflicts with the durable intent';
  end if;
  update public.appointment_change_intents set provider_mutation_target_id = btrim(target_mutation_target_id), updated_at = now() where id = intent.id;
end;
$$;

create function public.get_appointment_change_execution_context_v2(target_change_intent_id uuid)
returns table (
  change_intent_id uuid, organization_id uuid, location_id uuid, appointment_id uuid, booking_intent_id uuid,
  integration_id uuid, provider text, operation text, external_appointment_id text, provider_mutation_target_id text,
  original_starts_at timestamptz, original_ends_at timestamptz, target_starts_at timestamptz, target_ends_at timestamptz,
  original_resource_uid text, original_resource_name text, target_resource_uid text, target_resource_name text,
  appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, timezone text,
  business_hours jsonb, minimum_lead_minutes integer, candidate_expires_at timestamptz, intent_status text,
  current_write_eligible boolean
) language sql stable security definer set search_path = '' as $$
  select intent.id, intent.organization_id, intent.location_id, intent.appointment_id, intent.booking_intent_id,
    intent.integration_id, intent.provider, intent.operation, appointment.external_appointment_id, intent.provider_mutation_target_id,
    intent.original_starts_at, intent.original_ends_at, intent.target_starts_at, intent.target_ends_at,
    original_resource.external_uid, original_resource.name, target_resource.external_uid, target_resource.name,
    appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes, location.timezone,
    location.business_hours, settings.minimum_lead_minutes, candidate.expires_at, intent.status,
    coalesce(intent.status = 'executing' and appointment.status = 'confirmed' and appointment.starts_at > now()
      and integration.status = 'connected' and settings.active_integration_id = intent.integration_id
      and appointment_type.active and appointment_type.bookable and original_resource.active and original_resource.bookable
      and (intent.operation = 'cancel' or (((candidate.status = 'consumed' and candidate.expires_at > now())
        or (intent.actor_category = 'staff' and candidate.id is null and intent.target_starts_at > now() and intent.target_ends_at > intent.target_starts_at))
        and target_resource.active and target_resource.bookable and (integration.provider <> 'google_calendar' or target_resource.id = original_resource.id)
        and (integration.provider = 'ezyvet' or exists (select 1 from public.scheduling_appointment_type_resources mapping
          where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id
            and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id
            and mapping.resource_id = target_resource.id)))), false)
  from public.appointment_change_intents intent
  join public.appointments appointment on appointment.organization_id = intent.organization_id and appointment.id = intent.appointment_id
  join public.booking_intents booking on booking.organization_id = intent.organization_id and booking.id = intent.booking_intent_id
  join public.booking_candidates booking_candidate on booking_candidate.organization_id = booking.organization_id and booking_candidate.id = booking.candidate_id
  join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = booking_candidate.appointment_type_id
  join public.integrations integration on integration.organization_id = intent.organization_id and integration.id = intent.integration_id
  join public.scheduling_resources original_resource on original_resource.organization_id = intent.organization_id and original_resource.id = intent.original_resource_id
  left join public.scheduling_resources target_resource on target_resource.organization_id = intent.organization_id and target_resource.id = intent.target_resource_id
  left join public.appointment_change_candidates candidate on candidate.organization_id = intent.organization_id and candidate.id = intent.candidate_id
  join public.locations location on location.organization_id = intent.organization_id and location.id = intent.location_id
  left join public.location_scheduling_settings settings on settings.organization_id = intent.organization_id and settings.location_id = intent.location_id
  where intent.id = target_change_intent_id and intent.status in ('executing','provider_success_pending_persistence','provider_state_unknown');
$$;

create function public.get_appointment_change_target_context_v2(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid)
returns table (
  organization_id uuid, location_id uuid, integration_id uuid, provider text, appointment_type_uid text,
  appointment_type_name text, default_duration_minutes integer, timezone text, business_hours jsonb,
  minimum_lead_minutes integer, original_resource_uid text, original_resource_name text,
  original_starts_at timestamptz, original_ends_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select target.organization_id, target.location_id, appointment.integration_id, appointment.provider,
    appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes,
    location.timezone, location.business_hours, settings.minimum_lead_minutes, resource.external_uid, resource.name,
    appointment.starts_at, appointment.ends_at
  from public.appointment_management_targets target
  join public.appointments appointment on appointment.organization_id = target.organization_id and appointment.id = target.appointment_id
  join public.booking_intents booking on booking.organization_id = appointment.organization_id and booking.id = appointment.booking_intent_id
  join public.booking_candidates candidate on candidate.organization_id = booking.organization_id and candidate.id = booking.candidate_id
  join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id
  join public.scheduling_resources resource on resource.organization_id = appointment.organization_id and resource.id = coalesce(appointment.scheduling_resource_id, candidate.resource_id)
  join public.locations location on location.organization_id = target.organization_id and location.id = target.location_id
  join public.location_scheduling_settings settings on settings.organization_id = target.organization_id and settings.location_id = target.location_id and settings.active_integration_id = appointment.integration_id
  where target.id = target_reference_id and target.conversation_id = target_conversation_id and target.inbound_message_id = target_inbound_message_id
    and target.expires_at > now() and appointment.status = 'confirmed' and appointment.starts_at > now() and appointment.integration_id is not null;
$$;

create function public.get_voice_appointment_lifecycle_turn(target_call_id text, target_inbound_message_id uuid)
returns table (conversation_id uuid, inbound_message_id uuid)
language sql stable security definer set search_path = '' as $$
  select call.conversation_id, message.id
  from public.calls call
  join public.messages message on message.organization_id = call.organization_id and message.location_id = call.location_id
    and message.conversation_id = call.conversation_id and message.id = target_inbound_message_id
  where call.external_call_id = target_call_id and message.direction = 'inbound' and message.author_type = 'customer'
    and message.source_channel = 'phone';
$$;

-- Staff cancellation enters the exact same executing/provider-success/completed state machine.
-- It is service-role-only because the Fastify route first verifies the caller's JWT and forwards
-- only that trusted user id; no browser gets direct table or provider access.
create function public.create_staff_appointment_cancellation_intent(target_user_id uuid, target_location_id uuid, target_appointment_id uuid)
returns table (change_intent_id uuid)
language plpgsql security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype; resource_id uuid; saved_id uuid; target_org uuid;
begin
  perform public.require_appointment_lifecycle_service_role();
  select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not exists (select 1 from public.organization_members member where member.organization_id = target_org
    and member.user_id = target_user_id and member.role in ('owner','admin')) then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change-appointment:' || target_appointment_id::text, 0));
  if exists (select 1 from public.appointment_change_intents where appointment_id = target_appointment_id
    and status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown')) then
    raise exception using errcode = '22023', message = 'An appointment change is already in progress';
  end if;
  select * into appointment_row from public.appointments where organization_id = target_org and location_id = target_location_id
    and id = target_appointment_id and status = 'confirmed' and starts_at > now() and integration_id is not null;
  select * into booking from public.booking_intents where organization_id = target_org and id = appointment_row.booking_intent_id;
  resource_id := coalesce(appointment_row.scheduling_resource_id, (select resource_id from public.booking_candidates where organization_id = target_org and id = booking.candidate_id));
  if appointment_row.id is null or booking.id is null or resource_id is null then raise exception using errcode = '42501', message = 'Appointment cannot be cancelled safely'; end if;
  insert into public.appointment_change_intents (organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, actor_category, original_starts_at, original_ends_at, original_resource_id, status, mutation_attempt_count, expires_at)
  values (target_org, target_location_id, appointment_row.conversation_id, appointment_row.id, booking.id, appointment_row.integration_id,
    appointment_row.provider, 'cancel', 'staff', appointment_row.starts_at, appointment_row.ends_at, resource_id, 'executing', 1, now() + interval '10 minutes')
  returning id into saved_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (target_org, target_location_id, 'appointment.cancel.prepared', 'appointment_change_intent', saved_id, jsonb_build_object('actor', 'staff'));
  return query select saved_id;
end;
$$;

create function public.create_staff_appointment_reschedule_intent(target_user_id uuid, target_location_id uuid, target_appointment_id uuid, target_starts_at timestamptz, target_ends_at timestamptz)
returns table (change_intent_id uuid)
language plpgsql security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype; resource_id uuid; type_row public.scheduling_appointment_types%rowtype; saved_id uuid; target_org uuid;
begin
  perform public.require_appointment_lifecycle_service_role();
  select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not exists (select 1 from public.organization_members member where member.organization_id = target_org and member.user_id = target_user_id and member.role in ('owner','admin')) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  if target_ends_at <= target_starts_at or target_starts_at <= now() then raise exception using errcode = '22023', message = 'Reschedule time is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change-appointment:' || target_appointment_id::text, 0));
  if exists (select 1 from public.appointment_change_intents where appointment_id = target_appointment_id and status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown')) then raise exception using errcode = '22023', message = 'An appointment change is already in progress'; end if;
  select * into appointment_row from public.appointments where organization_id = target_org and location_id = target_location_id and id = target_appointment_id and status = 'confirmed' and starts_at > now() and integration_id is not null;
  select * into booking from public.booking_intents where organization_id = target_org and id = appointment_row.booking_intent_id;
  select appointment_type.* into type_row from public.booking_candidates candidate join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id where candidate.organization_id = target_org and candidate.id = booking.candidate_id;
  resource_id := coalesce(appointment_row.scheduling_resource_id, (select resource_id from public.booking_candidates where organization_id = target_org and id = booking.candidate_id));
  if appointment_row.id is null or booking.id is null or resource_id is null or type_row.id is null or target_ends_at - target_starts_at <> make_interval(mins => type_row.default_duration_minutes) then raise exception using errcode = '42501', message = 'Appointment cannot be rescheduled safely'; end if;
  insert into public.appointment_change_intents (organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, actor_category, original_starts_at, original_ends_at, original_resource_id, target_starts_at, target_ends_at, target_resource_id, status, mutation_attempt_count, expires_at)
  values (target_org, target_location_id, appointment_row.conversation_id, appointment_row.id, booking.id, appointment_row.integration_id, appointment_row.provider, 'reschedule', 'staff', appointment_row.starts_at, appointment_row.ends_at, resource_id, target_starts_at, target_ends_at, resource_id, 'executing', 1, now() + interval '10 minutes') returning id into saved_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (target_org, target_location_id, 'appointment.reschedule.prepared', 'appointment_change_intent', saved_id, jsonb_build_object('actor', 'staff'));
  return query select saved_id;
end;
$$;

create or replace function public.claim_appointment_change_slot_lease(target_change_intent_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  update public.scheduling_slot_leases set status = 'expired', updated_at = now() where status = 'active' and expires_at <= now();
  select * into intent from public.appointment_change_intents where id = target_change_intent_id and status = 'executing' and operation = 'reschedule';
  if intent.id is null or intent.expires_at <= now() then raise exception using errcode = '42501', message = 'Appointment change intent is not claimed'; end if;
  if intent.actor_category <> 'staff' and not exists (select 1 from public.appointment_change_candidates candidate where candidate.id = intent.candidate_id and candidate.status = 'consumed' and candidate.expires_at > now()) then
    raise exception using errcode = '22023', message = 'Appointment change candidate has expired';
  end if;
  insert into public.scheduling_slot_leases (organization_id, location_id, integration_id, resource_id, change_intent_id, starts_at, ends_at, expires_at)
  values (intent.organization_id, intent.location_id, intent.integration_id, intent.target_resource_id, intent.id, intent.target_starts_at, intent.target_ends_at, least(intent.expires_at, now() + interval '2 minutes'))
  on conflict (change_intent_id) do update set status = 'active', expires_at = excluded.expires_at, updated_at = now();
exception when exclusion_violation then raise exception using errcode = '23P01', message = 'Appointment change slot is no longer available';
end;
$$;

create or replace function public.record_appointment_change_provider_success(target_change_intent_id uuid, target_provider_state text default 'confirmed') returns void
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  select * into intent from public.appointment_change_intents where id = target_change_intent_id for update;
  if intent.id is null or intent.status not in ('executing','provider_state_unknown','provider_success_pending_persistence') then
    raise exception using errcode = '42501', message = 'Appointment change result is not available';
  end if;
  update public.appointment_change_intents set status = 'provider_success_pending_persistence', provider_state = left(nullif(btrim(target_provider_state), ''), 80), failure_category = null, updated_at = now() where id = intent.id;
end;
$$;

create or replace function public.complete_appointment_change_intent(target_change_intent_id uuid) returns table (appointment_id uuid, operation text)
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  select * into intent from public.appointment_change_intents where id = target_change_intent_id for update;
  if intent.id is null or intent.status <> 'provider_success_pending_persistence' then raise exception using errcode = '42501', message = 'Appointment change has not recorded provider success'; end if;
  if intent.operation = 'cancel' then
    update public.appointments set status = 'cancelled', provider_status = 'cancelled', updated_at = now() where id = intent.appointment_id;
    update public.message_deliveries delivery set status = 'suppressed', error_code = 'appointment_cancelled', updated_at = now()
      from public.messages message where message.id = delivery.message_id and message.appointment_reminder_id is not null
        and message.appointment_reminder_id in (select id from public.appointment_reminders where appointment_id = intent.appointment_id)
        and delivery.status = 'queued';
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_cancelled', claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = intent.appointment_id and status in ('scheduled','processing','sent');
  else
    update public.message_deliveries delivery set status = 'suppressed', error_code = 'appointment_rescheduled', updated_at = now()
      from public.messages message where message.id = delivery.message_id and message.appointment_reminder_id is not null
        and message.appointment_reminder_id in (select id from public.appointment_reminders where appointment_id = intent.appointment_id)
        and delivery.status = 'queued';
    update public.appointment_reminders set status = 'scheduled', message_id = null, last_error_code = null, claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = intent.appointment_id and status in ('scheduled','processing','sent');
    update public.appointments set starts_at = intent.target_starts_at, ends_at = intent.target_ends_at, scheduling_resource_id = intent.target_resource_id, provider_status = 'confirmed', updated_at = now() where id = intent.appointment_id;
    perform public.refresh_appointment_reminders_internal(intent.appointment_id);
  end if;
  update public.appointment_change_intents set status = 'completed', completed_at = now(), updated_at = now() where id = intent.id;
  update public.appointment_change_slot_leases set status = 'released', updated_at = now() where change_intent_id = intent.id and status = 'active';
  update public.scheduling_slot_leases set status = 'released', updated_at = now() where change_intent_id = intent.id and status = 'active';
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (intent.organization_id, intent.location_id, 'appointment.' || intent.operation || '.completed', 'appointment_change_intent', intent.id, jsonb_build_object('provider_state', intent.provider_state));
  return query select intent.appointment_id, intent.operation;
end;
$$;

create or replace function public.fail_appointment_change_intent(target_change_intent_id uuid, target_status text, target_error_category text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  if target_status not in ('awaiting_confirmation','failed','provider_state_unknown','handoff_required') then raise exception using errcode = '22023', message = 'Appointment change outcome is invalid'; end if;
  select * into intent from public.appointment_change_intents where id = target_change_intent_id for update;
  if intent.id is null then raise exception using errcode = '42501', message = 'Appointment change is not available'; end if;
  update public.appointment_change_intents set status = target_status, failure_category = left(nullif(btrim(coalesce(target_error_category, '')), ''), 80), updated_at = now()
    where id = intent.id and status = 'executing';
  update public.appointment_change_slot_leases set status = 'released', updated_at = now() where change_intent_id = intent.id and status = 'active';
  update public.scheduling_slot_leases set status = 'released', updated_at = now() where change_intent_id = intent.id and status = 'active';
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (intent.organization_id, intent.location_id, 'appointment.' || intent.operation || '.failed', 'appointment_change_intent', intent.id, jsonb_build_object('category', left(coalesce(target_error_category, ''), 80)));
end;
$$;

-- Preparation is serialised per appointment.  An unconfirmed different operation is superseded;
-- an executing/unknown/provider-success intent is never replaced.
create or replace function public.prepare_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid, target_operation text, target_candidate_id uuid default null)
returns table (change_intent_id uuid, operation text, starts_at timestamptz, timezone text, status text)
language plpgsql security definer set search_path = '' as $$
declare target public.appointment_management_targets%rowtype; appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype;
  candidate public.appointment_change_candidates%rowtype; existing public.appointment_change_intents%rowtype; resource_id uuid; expiry timestamptz;
begin
  perform public.require_appointment_lifecycle_service_role();
  if target_operation not in ('cancel', 'reschedule') then raise exception using errcode = '22023', message = 'Appointment change operation is invalid'; end if;
  if target_reference_id is null and target_candidate_id is not null then
    select management.* into target from public.appointment_change_candidates candidate join public.appointment_management_targets management on management.organization_id = candidate.organization_id and management.id = candidate.target_id
      where candidate.id = target_candidate_id and candidate.conversation_id = target_conversation_id and management.inbound_message_id = target_inbound_message_id and candidate.status = 'offered' and candidate.expires_at > now();
  else
    select * into target from public.appointment_management_targets where id = target_reference_id and conversation_id = target_conversation_id and inbound_message_id = target_inbound_message_id and expires_at > now();
  end if;
  if target.id is null then raise exception using errcode = '42501', message = 'Appointment reference is not available'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change-appointment:' || target.appointment_id::text, 0));
  select * into appointment_row from public.appointments where id = target.appointment_id and status = 'confirmed' and starts_at > now();
  select * into booking from public.booking_intents where organization_id = target.organization_id and id = appointment_row.booking_intent_id;
  resource_id := coalesce(appointment_row.scheduling_resource_id, (select resource_id from public.booking_candidates where organization_id = booking.organization_id and id = booking.candidate_id));
  if appointment_row.id is null or booking.id is null or appointment_row.integration_id is null or resource_id is null then raise exception using errcode = '42501', message = 'Appointment cannot be changed safely'; end if;
  if target_operation = 'reschedule' then
    select * into candidate from public.appointment_change_candidates where id = target_candidate_id and target_id = target.id and status = 'offered' and expires_at > now();
    if candidate.id is null then raise exception using errcode = '42501', message = 'Appointment change candidate is not available'; end if;
    if appointment_row.provider = 'google_calendar' and candidate.resource_id <> resource_id then raise exception using errcode = '42501', message = 'Google Calendar reschedules must retain the original resource'; end if;
  end if;
  select * into existing from public.appointment_change_intents where appointment_id = appointment_row.id and status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown') order by created_at desc limit 1 for update;
  if existing.id is not null and existing.status <> 'awaiting_confirmation' then
    return query select existing.id, existing.operation, existing.target_starts_at, coalesce(candidate.timezone, (select timezone from public.locations where id = target.location_id)), existing.status;
    return;
  end if;
  if existing.id is not null and existing.operation = target_operation and (target_operation = 'cancel' or existing.candidate_id = candidate.id) then
    return query select existing.id, existing.operation, existing.target_starts_at, coalesce(candidate.timezone, (select timezone from public.locations where id = target.location_id)), existing.status;
    return;
  end if;
  if existing.id is not null then
    update public.appointment_change_intents set status = 'expired', failure_category = 'superseded', updated_at = now() where id = existing.id;
    update public.appointment_change_slot_leases set status = 'released', updated_at = now() where change_intent_id = existing.id and status = 'active';
    update public.scheduling_slot_leases set status = 'released', updated_at = now() where change_intent_id = existing.id and status = 'active';
  end if;
  expiry := least(now() + interval '10 minutes', coalesce(candidate.expires_at, now() + interval '10 minutes'));
  insert into public.appointment_change_intents (organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, prepared_message_id, candidate_id, original_starts_at, original_ends_at, original_resource_id, target_starts_at, target_ends_at, target_resource_id, expires_at)
  values (target.organization_id, target.location_id, target.conversation_id, appointment_row.id, booking.id, appointment_row.integration_id, appointment_row.provider, target_operation, target_inbound_message_id, candidate.id, appointment_row.starts_at, appointment_row.ends_at, resource_id, candidate.starts_at, candidate.ends_at, candidate.resource_id, expiry)
  returning * into existing;
  if candidate.id is not null then update public.appointment_change_candidates set status = 'consumed', updated_at = now() where id = candidate.id; end if;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (target.organization_id, target.location_id, 'appointment.' || target_operation || '.prepared', 'appointment_change_intent', existing.id, jsonb_build_object('actor', 'customer'));
  return query select existing.id, existing.operation, existing.target_starts_at, coalesce(candidate.timezone, (select timezone from public.locations where id = target.location_id)), existing.status;
end;
$$;

revoke all on function public.persist_appointment_change_mutation_target(uuid, text), public.get_appointment_change_execution_context_v2(uuid), public.get_appointment_change_target_context_v2(uuid, uuid, uuid), public.get_voice_appointment_lifecycle_turn(text, uuid), public.create_staff_appointment_cancellation_intent(uuid, uuid, uuid), public.create_staff_appointment_reschedule_intent(uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.persist_appointment_change_mutation_target(uuid, text), public.get_appointment_change_execution_context_v2(uuid), public.get_appointment_change_target_context_v2(uuid, uuid, uuid), public.get_voice_appointment_lifecycle_turn(text, uuid), public.create_staff_appointment_cancellation_intent(uuid, uuid, uuid), public.create_staff_appointment_reschedule_intent(uuid, uuid, uuid, timestamptz, timestamptz) to service_role;

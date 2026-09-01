-- Phase 23: harden the renamed appointment-change prepare implementation against PL/pgSQL
-- output-column ambiguity.
--
-- The historical RPC returns columns named starts_at and status. Its final Phase 9 body also
-- referenced appointment/candidate/intent columns with those names without table qualification.
-- PostgreSQL therefore treats those references as ambiguous when the function is actually
-- exercised through the Phase 23 correction wrapper. This replacement preserves the final Phase 9
-- behavior and immutable provider-target snapshot while making every potentially conflicting
-- relation reference explicit. The base function remains an internal validation engine only.

create or replace function public.prepare_appointment_change_intent_base(
  target_conversation_id uuid,
  target_inbound_message_id uuid,
  target_reference_id uuid,
  target_operation text,
  target_candidate_id uuid default null
)
returns table (
  change_intent_id uuid,
  operation text,
  starts_at timestamptz,
  timezone text,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.appointment_management_targets%rowtype;
  appointment_row public.appointments%rowtype;
  booking public.booking_intents%rowtype;
  candidate public.appointment_change_candidates%rowtype;
  existing public.appointment_change_intents%rowtype;
  resource_id uuid;
  expiry timestamptz;
begin
  perform public.require_appointment_lifecycle_service_role();

  if target_operation not in ('cancel', 'reschedule') then
    raise exception using errcode = '22023', message = 'Appointment change operation is invalid';
  end if;

  if target_reference_id is null and target_candidate_id is not null then
    select management.* into target
    from public.appointment_change_candidates change_candidate
    join public.appointment_management_targets management
      on management.organization_id = change_candidate.organization_id
     and management.id = change_candidate.target_id
    where change_candidate.id = target_candidate_id
      and change_candidate.conversation_id = target_conversation_id
      and management.inbound_message_id = target_inbound_message_id
      and change_candidate.status = 'offered'
      and change_candidate.expires_at > now();
  else
    select management.* into target
    from public.appointment_management_targets management
    where management.id = target_reference_id
      and management.conversation_id = target_conversation_id
      and management.inbound_message_id = target_inbound_message_id
      and management.expires_at > now();
  end if;

  if target.id is null then
    raise exception using errcode = '42501', message = 'Appointment reference is not available';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('appointment-change-appointment:' || target.appointment_id::text, 0)
  );

  select appointment.* into appointment_row
  from public.appointments appointment
  where appointment.id = target.appointment_id
    and appointment.status = 'confirmed'
    and appointment.starts_at > now();

  select booking_intent.* into booking
  from public.booking_intents booking_intent
  where booking_intent.organization_id = target.organization_id
    and booking_intent.id = appointment_row.booking_intent_id;

  resource_id := coalesce(
    appointment_row.scheduling_resource_id,
    (
      select booking_candidate.resource_id
      from public.booking_candidates booking_candidate
      where booking_candidate.organization_id = booking.organization_id
        and booking_candidate.id = booking.candidate_id
    )
  );

  if appointment_row.id is null
    or booking.id is null
    or appointment_row.integration_id is null
    or resource_id is null
    or nullif(btrim(appointment_row.external_appointment_id), '') is null then
    raise exception using errcode = '42501', message = 'Appointment cannot be changed safely';
  end if;

  if target_operation = 'reschedule' then
    select change_candidate.* into candidate
    from public.appointment_change_candidates change_candidate
    where change_candidate.id = target_candidate_id
      and change_candidate.target_id = target.id
      and change_candidate.status = 'offered'
      and change_candidate.expires_at > now();

    if candidate.id is null then
      raise exception using errcode = '42501', message = 'Appointment change candidate is not available';
    end if;

    if appointment_row.provider = 'google_calendar' and candidate.resource_id <> resource_id then
      raise exception using errcode = '42501', message = 'Google Calendar reschedules must retain the original resource';
    end if;
  end if;

  select change_intent.* into existing
  from public.appointment_change_intents change_intent
  where change_intent.appointment_id = appointment_row.id
    and change_intent.status in (
      'awaiting_confirmation',
      'executing',
      'provider_success_pending_persistence',
      'provider_state_unknown'
    )
  order by change_intent.created_at desc
  limit 1
  for update;

  if existing.id is not null and existing.status <> 'awaiting_confirmation' then
    return query
    select existing.id,
      existing.operation,
      existing.target_starts_at,
      coalesce(
        candidate.timezone,
        (select location.timezone from public.locations location where location.id = target.location_id)
      ),
      existing.status;
    return;
  end if;

  if existing.id is not null
    and existing.operation = target_operation
    and (target_operation = 'cancel' or existing.candidate_id = candidate.id) then
    return query
    select existing.id,
      existing.operation,
      existing.target_starts_at,
      coalesce(
        candidate.timezone,
        (select location.timezone from public.locations location where location.id = target.location_id)
      ),
      existing.status;
    return;
  end if;

  if existing.id is not null then
    update public.appointment_change_intents change_intent
    set status = 'expired', failure_category = 'superseded', updated_at = now()
    where change_intent.id = existing.id;

    update public.appointment_change_slot_leases change_lease
    set status = 'released', updated_at = now()
    where change_lease.change_intent_id = existing.id
      and change_lease.status = 'active';

    update public.scheduling_slot_leases scheduling_lease
    set status = 'released', updated_at = now()
    where scheduling_lease.change_intent_id = existing.id
      and scheduling_lease.status = 'active';
  end if;

  expiry := least(
    now() + interval '10 minutes',
    coalesce(candidate.expires_at, now() + interval '10 minutes')
  );

  insert into public.appointment_change_intents as inserted (
    organization_id,
    location_id,
    conversation_id,
    appointment_id,
    booking_intent_id,
    integration_id,
    provider,
    operation,
    prepared_message_id,
    candidate_id,
    original_external_appointment_id,
    original_starts_at,
    original_ends_at,
    original_resource_id,
    target_starts_at,
    target_ends_at,
    target_resource_id,
    expires_at
  )
  values (
    target.organization_id,
    target.location_id,
    target.conversation_id,
    appointment_row.id,
    booking.id,
    appointment_row.integration_id,
    appointment_row.provider,
    target_operation,
    target_inbound_message_id,
    candidate.id,
    appointment_row.external_appointment_id,
    appointment_row.starts_at,
    appointment_row.ends_at,
    resource_id,
    candidate.starts_at,
    candidate.ends_at,
    candidate.resource_id,
    expiry
  )
  returning inserted.* into existing;

  if candidate.id is not null then
    update public.appointment_change_candidates change_candidate
    set status = 'consumed', updated_at = now()
    where change_candidate.id = candidate.id;
  end if;

  insert into public.action_logs (
    organization_id,
    location_id,
    action,
    entity_type,
    entity_id,
    details
  )
  values (
    target.organization_id,
    target.location_id,
    'appointment.' || target_operation || '.prepared',
    'appointment_change_intent',
    existing.id,
    jsonb_build_object('actor', 'customer')
  );

  return query
  select existing.id,
    existing.operation,
    existing.target_starts_at,
    coalesce(
      candidate.timezone,
      (select location.timezone from public.locations location where location.id = target.location_id)
    ),
    existing.status;
end;
$$;

revoke all on function public.prepare_appointment_change_intent_base(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

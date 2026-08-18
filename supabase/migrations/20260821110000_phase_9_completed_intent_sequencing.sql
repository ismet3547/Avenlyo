-- Completed staff intents are immutable history. They may answer an exact idempotent retry, but
-- they cannot block a later lifecycle operation that must be validated against the current row.

create or replace function public.get_or_resume_staff_appointment_change_intent(
  target_user_id uuid,
  target_location_id uuid,
  target_appointment_id uuid,
  target_operation text,
  target_starts_at timestamptz default null,
  target_ends_at timestamptz default null
)
returns table (change_intent_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_org uuid;
  appointment_row public.appointments%rowtype;
  booking public.booking_intents%rowtype;
  appointment_type public.scheduling_appointment_types%rowtype;
  active_intent public.appointment_change_intents%rowtype;
  completed_intent public.appointment_change_intents%rowtype;
  resource_id uuid;
  created_intent_id uuid;
begin
  perform public.require_appointment_lifecycle_service_role();

  if target_operation not in ('cancel', 'reschedule') then
    raise exception using errcode = '22023', message = 'Appointment change operation is invalid';
  end if;
  if target_operation = 'reschedule'
    and (target_starts_at is null or target_ends_at is null or target_ends_at <= target_starts_at or target_starts_at <= now()) then
    raise exception using errcode = '22023', message = 'Reschedule time is invalid';
  end if;

  select location.organization_id into target_org
  from public.locations location
  where location.id = target_location_id;
  if target_org is null or not exists (
    select 1
    from public.organization_members member
    where member.organization_id = target_org
      and member.user_id = target_user_id
      and member.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('appointment-change-appointment:' || target_appointment_id::text, 0)
  );

  -- In-progress and recovery state is the only history that can block a later operation.
  select * into active_intent
  from public.appointment_change_intents intent
  where intent.organization_id = target_org
    and intent.location_id = target_location_id
    and intent.appointment_id = target_appointment_id
    and intent.actor_category = 'staff'
    and intent.status in (
      'executing',
      'provider_success_pending_persistence',
      'provider_state_unknown',
      'handoff_required'
    )
  order by intent.created_at desc
  limit 1
  for update;

  if active_intent.id is not null then
    if active_intent.operation <> target_operation then
      raise exception using errcode = '22023', message = 'A different appointment change is already in progress';
    end if;
    if target_operation = 'reschedule'
      and (active_intent.target_starts_at is distinct from target_starts_at or active_intent.target_ends_at is distinct from target_ends_at) then
      raise exception using errcode = '22023', message = 'The in-progress reschedule does not match this retry';
    end if;
    return query select active_intent.id;
    return;
  end if;

  -- The latest completed row may only serve the exact operation it completed. Earlier completed
  -- rows deliberately do not shadow a more recent lifecycle outcome.
  select * into completed_intent
  from public.appointment_change_intents intent
  where intent.organization_id = target_org
    and intent.location_id = target_location_id
    and intent.appointment_id = target_appointment_id
    and intent.actor_category = 'staff'
    and intent.status = 'completed'
  order by intent.completed_at desc nulls last, intent.created_at desc
  limit 1
  for update;

  if completed_intent.id is not null
    and completed_intent.operation = target_operation
    and (
      target_operation = 'cancel'
      or (
        completed_intent.target_starts_at is not distinct from target_starts_at
        and completed_intent.target_ends_at is not distinct from target_ends_at
      )
    ) then
    return query select completed_intent.id;
    return;
  end if;

  if exists (
    select 1
    from public.appointment_change_intents intent
    where intent.appointment_id = target_appointment_id
      and intent.status in (
        'awaiting_confirmation',
        'executing',
        'provider_success_pending_persistence',
        'provider_state_unknown',
        'handoff_required'
      )
  ) then
    raise exception using errcode = '22023', message = 'A different appointment change is already in progress';
  end if;

  select * into appointment_row
  from public.appointments appointment
  where appointment.organization_id = target_org
    and appointment.location_id = target_location_id
    and appointment.id = target_appointment_id
    and appointment.status = 'confirmed'
    and appointment.starts_at > now()
    and appointment.integration_id is not null;
  if appointment_row.id is null then
    raise exception using errcode = '42501', message = 'Appointment cannot be changed safely';
  end if;

  -- ezyVet supports durable cancellation only. Reject before an intent or provider target exists.
  if target_operation = 'reschedule' and appointment_row.provider = 'ezyvet' then
    raise exception using errcode = '22023', message = 'Provider reschedule is unsupported';
  end if;

  select * into booking
  from public.booking_intents intent
  where intent.organization_id = target_org
    and intent.id = appointment_row.booking_intent_id;
  resource_id := coalesce(
    appointment_row.scheduling_resource_id,
    (
      select candidate.resource_id
      from public.booking_candidates candidate
      where candidate.organization_id = target_org
        and candidate.id = booking.candidate_id
    )
  );
  if appointment_row.id is null
    or booking.id is null
    or resource_id is null
    or nullif(btrim(appointment_row.external_appointment_id), '') is null then
    raise exception using errcode = '42501', message = 'Appointment cannot be changed safely';
  end if;

  if target_operation = 'reschedule' then
    select type_row.* into appointment_type
    from public.booking_candidates candidate
    join public.scheduling_appointment_types type_row
      on type_row.organization_id = candidate.organization_id
      and type_row.id = candidate.appointment_type_id
    where candidate.organization_id = target_org
      and candidate.id = booking.candidate_id;
    if appointment_type.id is null
      or target_ends_at - target_starts_at <> make_interval(mins => appointment_type.default_duration_minutes) then
      raise exception using errcode = '42501', message = 'Appointment cannot be rescheduled safely';
    end if;
  end if;

  insert into public.appointment_change_intents (
    organization_id,
    location_id,
    conversation_id,
    appointment_id,
    booking_intent_id,
    integration_id,
    provider,
    operation,
    actor_category,
    original_external_appointment_id,
    original_starts_at,
    original_ends_at,
    original_resource_id,
    target_starts_at,
    target_ends_at,
    target_resource_id,
    status,
    mutation_attempt_count,
    expires_at
  )
  values (
    target_org,
    target_location_id,
    appointment_row.conversation_id,
    appointment_row.id,
    booking.id,
    appointment_row.integration_id,
    appointment_row.provider,
    target_operation,
    'staff',
    appointment_row.external_appointment_id,
    appointment_row.starts_at,
    appointment_row.ends_at,
    resource_id,
    target_starts_at,
    target_ends_at,
    case when target_operation = 'reschedule' then resource_id else null end,
    'executing',
    1,
    now() + interval '10 minutes'
  )
  returning id into created_intent_id;

  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (
    target_org,
    target_location_id,
    'appointment.' || target_operation || '.prepared',
    'appointment_change_intent',
    created_intent_id,
    jsonb_build_object('actor', 'staff')
  );
  return query select created_intent_id;
end;
$$;

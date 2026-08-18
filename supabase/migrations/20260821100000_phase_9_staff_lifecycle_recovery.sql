-- Phase 9 follow-up: a staff retry resumes the one durable provider operation rather than
-- constructing a second mutation. All entry points remain service-role SECURITY DEFINER RPCs.

create function public.get_or_resume_staff_appointment_change_intent(
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
  existing public.appointment_change_intents%rowtype;
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

  -- An in-flight/recovery intent always wins over a completed record. For a completed
  -- reschedule, only an identical retry is idempotent; a new time may start a new operation.
  select * into existing
  from public.appointment_change_intents intent
  where intent.organization_id = target_org
    and intent.location_id = target_location_id
    and intent.appointment_id = target_appointment_id
    and intent.actor_category = 'staff'
    and intent.status in (
      'executing',
      'provider_success_pending_persistence',
      'provider_state_unknown',
      'handoff_required',
      'completed'
    )
  order by
    case when intent.status in ('executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'handoff_required') then 0 else 1 end,
    intent.created_at desc
  limit 1
  for update;

  if existing.id is not null then
    if existing.operation <> target_operation then
      raise exception using errcode = '22023', message = 'A different appointment change is already in progress';
    end if;
    if target_operation = 'reschedule'
      and (existing.target_starts_at is distinct from target_starts_at or existing.target_ends_at is distinct from target_ends_at)
      and existing.status <> 'completed' then
      raise exception using errcode = '22023', message = 'The in-progress reschedule does not match this retry';
    end if;
    if not (
      target_operation = 'reschedule'
      and existing.status = 'completed'
      and (existing.target_starts_at is distinct from target_starts_at or existing.target_ends_at is distinct from target_ends_at)
    ) then
      return query select existing.id;
      return;
    end if;
  end if;

  if exists (
    select 1
    from public.appointment_change_intents intent
    where intent.appointment_id = target_appointment_id
      and intent.status in (
        'awaiting_confirmation',
        'executing',
        'provider_success_pending_persistence',
        'provider_state_unknown'
      )
      and intent.id is distinct from existing.id
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

create or replace function public.create_staff_appointment_cancellation_intent(
  target_user_id uuid,
  target_location_id uuid,
  target_appointment_id uuid
)
returns table (change_intent_id uuid)
language sql
security definer
set search_path = ''
as $$
  select resumed.change_intent_id
  from public.get_or_resume_staff_appointment_change_intent(
    target_user_id,
    target_location_id,
    target_appointment_id,
    'cancel'
  ) resumed;
$$;

create or replace function public.create_staff_appointment_reschedule_intent(
  target_user_id uuid,
  target_location_id uuid,
  target_appointment_id uuid,
  target_starts_at timestamptz,
  target_ends_at timestamptz
)
returns table (change_intent_id uuid)
language sql
security definer
set search_path = ''
as $$
  select resumed.change_intent_id
  from public.get_or_resume_staff_appointment_change_intent(
    target_user_id,
    target_location_id,
    target_appointment_id,
    'reschedule',
    target_starts_at,
    target_ends_at
  ) resumed;
$$;

-- Staff retries must be able to read a completed durable result without issuing another provider
-- request. Other statuses remain in the same trusted execution context.
create or replace function public.get_appointment_change_execution_context_v2(target_change_intent_id uuid)
returns table (
  change_intent_id uuid, organization_id uuid, location_id uuid, appointment_id uuid, booking_intent_id uuid,
  integration_id uuid, provider text, operation text, external_appointment_id text, provider_mutation_target_id text,
  original_starts_at timestamptz, original_ends_at timestamptz, target_starts_at timestamptz, target_ends_at timestamptz,
  original_resource_uid text, original_resource_name text, target_resource_uid text, target_resource_name text,
  appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, timezone text,
  business_hours jsonb, minimum_lead_minutes integer, candidate_expires_at timestamptz, intent_status text,
  current_write_eligible boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select intent.id, intent.organization_id, intent.location_id, intent.appointment_id, intent.booking_intent_id,
    intent.integration_id, intent.provider, intent.operation, intent.original_external_appointment_id, intent.provider_mutation_target_id,
    intent.original_starts_at, intent.original_ends_at, intent.target_starts_at, intent.target_ends_at,
    original_resource.external_uid, original_resource.name, target_resource.external_uid, target_resource.name,
    appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes, location.timezone,
    location.business_hours, settings.minimum_lead_minutes, candidate.expires_at, intent.status,
    coalesce(intent.status = 'executing' and appointment.status = 'confirmed' and appointment.starts_at > now()
      and appointment.provider = intent.provider and appointment.integration_id = intent.integration_id
      and appointment.external_appointment_id = intent.original_external_appointment_id
      and appointment.starts_at = intent.original_starts_at and appointment.ends_at = intent.original_ends_at
      and coalesce(appointment.scheduling_resource_id, booking_candidate.resource_id) = intent.original_resource_id
      and integration.status = 'connected' and settings.active_integration_id = intent.integration_id
      and appointment_type.active and appointment_type.bookable and original_resource.active and original_resource.bookable
      and (intent.operation = 'cancel' or (((candidate.status = 'consumed' and candidate.expires_at > now()) or (intent.actor_category = 'staff' and candidate.id is null and intent.target_starts_at > now() and intent.target_ends_at > intent.target_starts_at)) and target_resource.active and target_resource.bookable and (integration.provider <> 'google_calendar' or target_resource.id = original_resource.id) and (integration.provider = 'ezyvet' or exists (select 1 from public.scheduling_appointment_type_resources mapping where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = target_resource.id)))), false)
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
  where intent.id = target_change_intent_id
    and intent.status in ('executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'handoff_required', 'completed');
$$;

revoke all on function public.get_or_resume_staff_appointment_change_intent(uuid, uuid, uuid, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_or_resume_staff_appointment_change_intent(uuid, uuid, uuid, text, timestamptz, timestamptz)
  to service_role;
revoke all on function public.create_staff_appointment_cancellation_intent(uuid, uuid, uuid), public.create_staff_appointment_reschedule_intent(uuid, uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_staff_appointment_cancellation_intent(uuid, uuid, uuid), public.create_staff_appointment_reschedule_intent(uuid, uuid, uuid, timestamptz, timestamptz)
  to service_role;

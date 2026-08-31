-- Phase 23: material customer corrections replace only uncommitted confirmation snapshots.
--
-- The locked appointment contract requires an old action intent to become INVALIDATED when the
-- customer materially changes the requested action. A delayed YES must never revive that stale
-- snapshot. Provider-crossed or ambiguous operations are deliberately outside this replacement
-- path: they remain reconciliation/handoff truth and block preparation of a new consequential
-- mutation until resolved.

alter table public.booking_intents
  drop constraint if exists booking_intents_status_check,
  add constraint booking_intents_status_check check (
    status in (
      'awaiting_confirmation', 'booking', 'provider_success_pending_persistence',
      'completed', 'failed', 'provider_state_unknown', 'expired', 'invalidated'
    )
  );

alter table public.appointment_change_intents
  drop constraint if exists appointment_change_intents_status_check,
  add constraint appointment_change_intents_status_check check (
    status in (
      'awaiting_confirmation', 'executing', 'provider_success_pending_persistence',
      'provider_state_unknown', 'completed', 'failed', 'expired', 'handoff_required', 'invalidated'
    )
  );

-- Prepared booking candidates are consumed by the authoritative prepare function. The work-state
-- read model therefore accepts both the canonical consumed state and legacy offered rows so a
-- valid pending action is never accidentally hidden from the model-independent authority gate.
create or replace function public.get_message_agent_work_state(target_message_id uuid)
returns table (
  control_state text,
  pending_mutation_intent_id uuid,
  pending_mutation_intent_type text,
  pending_mutation_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  inbound public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  resolved_pending_id uuid;
  resolved_pending_type text;
  resolved_pending_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted messaging backend access is required';
  end if;

  select * into inbound
  from public.messages
  where id = target_message_id
    and direction = 'inbound'
    and author_type = 'customer';
  if inbound.id is null then
    raise exception using errcode = '42501', message = 'Trusted customer message is required';
  end if;

  select * into conversation_row
  from public.conversations
  where id = inbound.conversation_id
    and organization_id = inbound.organization_id;
  if conversation_row.id is null or conversation_row.mode <> 'customer' then
    raise exception using errcode = '42501', message = 'Customer conversation is not available';
  end if;

  with pending as (
    select
      booking.id as intent_id,
      'APPOINTMENT_BOOK'::text as intent_type,
      booking.created_at
    from public.booking_intents booking
    join public.booking_candidates candidate
      on candidate.organization_id = booking.organization_id
     and candidate.id = booking.candidate_id
    where booking.organization_id = conversation_row.organization_id
      and booking.conversation_id = conversation_row.id
      and booking.status = 'awaiting_confirmation'
      and candidate.status in ('offered', 'consumed')
      and candidate.expires_at > now()

    union all

    select
      change_intent.id as intent_id,
      case change_intent.operation
        when 'cancel' then 'APPOINTMENT_CANCEL'::text
        when 'reschedule' then 'APPOINTMENT_RESCHEDULE'::text
      end as intent_type,
      change_intent.created_at
    from public.appointment_change_intents change_intent
    where change_intent.organization_id = conversation_row.organization_id
      and change_intent.conversation_id = conversation_row.id
      and change_intent.status = 'awaiting_confirmation'
      and change_intent.actor_category = 'customer'
      and change_intent.expires_at > now()
  )
  select count(*)::integer
  into resolved_pending_count
  from pending;

  if resolved_pending_count = 1 then
    with pending as (
      select
        booking.id as intent_id,
        'APPOINTMENT_BOOK'::text as intent_type,
        booking.created_at
      from public.booking_intents booking
      join public.booking_candidates candidate
        on candidate.organization_id = booking.organization_id
       and candidate.id = booking.candidate_id
      where booking.organization_id = conversation_row.organization_id
        and booking.conversation_id = conversation_row.id
        and booking.status = 'awaiting_confirmation'
        and candidate.status in ('offered', 'consumed')
        and candidate.expires_at > now()

      union all

      select
        change_intent.id,
        case change_intent.operation
          when 'cancel' then 'APPOINTMENT_CANCEL'::text
          when 'reschedule' then 'APPOINTMENT_RESCHEDULE'::text
        end,
        change_intent.created_at
      from public.appointment_change_intents change_intent
      where change_intent.organization_id = conversation_row.organization_id
        and change_intent.conversation_id = conversation_row.id
        and change_intent.status = 'awaiting_confirmation'
        and change_intent.actor_category = 'customer'
        and change_intent.expires_at > now()
    )
    select pending.intent_id, pending.intent_type
    into resolved_pending_id, resolved_pending_type
    from pending
    order by pending.created_at asc, pending.intent_id asc
    limit 1;
  end if;

  return query select
    case conversation_row.ai_mode when 'ai' then 'ai_active'::text else 'human_paused'::text end,
    resolved_pending_id,
    resolved_pending_type,
    resolved_pending_count;
end;
$$;

-- Keep the historical prepare implementations as validation engines, but remove their direct
-- service-role entry points. The original public names become ownership-aware correction wrappers.
alter function public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid, uuid)
  rename to prepare_conversation_scheduling_booking_intent_base;
alter function public.prepare_appointment_change_intent(uuid, uuid, uuid, text, uuid)
  rename to prepare_appointment_change_intent_base;

create function public.invalidate_customer_pending_mutations_for_correction(target_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Callers already hold lock_conversation_ownership(). Only uncommitted confirmation snapshots
  -- are replaceable; provider-crossed states are intentionally absent from these updates.
  with invalidated as (
    update public.booking_intents
    set status = 'invalidated',
        failure_category = 'customer_correction',
        completed_at = coalesce(completed_at, now()),
        updated_at = now()
    where conversation_id = target_conversation_id
      and status = 'awaiting_confirmation'
    returning organization_id, location_id, id
  )
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  select invalidated.organization_id, invalidated.location_id, 'booking.invalidated',
    'booking_intent', invalidated.id, jsonb_build_object('reason', 'customer_correction')
  from invalidated;

  with invalidated as (
    update public.appointment_change_intents
    set status = 'invalidated',
        failure_category = 'customer_correction',
        completed_at = coalesce(completed_at, now()),
        updated_at = now()
    where conversation_id = target_conversation_id
      and actor_category = 'customer'
      and status = 'awaiting_confirmation'
    returning organization_id, location_id, id, operation
  )
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  select invalidated.organization_id, invalidated.location_id, 'appointment_change.invalidated',
    'appointment_change_intent', invalidated.id,
    jsonb_build_object('reason', 'customer_correction', 'operation', invalidated.operation)
  from invalidated;
end;
$$;

create function public.prepare_conversation_scheduling_booking_intent(
  target_conversation_id uuid,
  target_candidate_id uuid,
  resolved_contact_uid text,
  resolved_subject_uid text,
  resolved_subject_name text,
  trusted_contact_id uuid,
  target_inbound_message_id uuid
)
returns table (booking_intent_id uuid, appointment_type_name text, starts_at timestamptz, timezone text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  pending_count integer;
  replay record;
  prepared record;
begin
  perform public.require_scheduling_service_role();
  if target_conversation_id is null or target_candidate_id is null then
    raise exception using errcode = '22023', message = 'Customer booking preparation is invalid';
  end if;

  perform public.lock_conversation_ownership(target_conversation_id);
  select * into conversation_row
  from public.conversations
  where id = target_conversation_id
  for update;
  if conversation_row.id is null or conversation_row.mode <> 'customer' then
    raise exception using errcode = '42501', message = 'Customer conversation is not available';
  end if;
  if conversation_row.ai_mode <> 'ai' then
    raise exception using errcode = '42501', message = 'Customer mutation preparation is not available';
  end if;

  -- No correction may run alongside an operation that may already have crossed the provider
  -- boundary. Reconciliation/handoff must establish truth first.
  if exists (
    select 1 from public.booking_intents booking
    where booking.conversation_id = target_conversation_id
      and booking.status in ('booking', 'provider_success_pending_persistence', 'provider_state_unknown')
  ) or exists (
    select 1 from public.appointment_change_intents change_intent
    where change_intent.conversation_id = target_conversation_id
      and change_intent.actor_category = 'customer'
      and change_intent.status in (
        'executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'handoff_required'
      )
  ) then
    raise exception using errcode = '55000', message = 'Customer mutation outcome must be resolved before another mutation is prepared';
  end if;

  select count(*)::integer into pending_count
  from (
    select booking.id
    from public.booking_intents booking
    where booking.conversation_id = target_conversation_id
      and booking.status = 'awaiting_confirmation'
    union all
    select change_intent.id
    from public.appointment_change_intents change_intent
    where change_intent.conversation_id = target_conversation_id
      and change_intent.actor_category = 'customer'
      and change_intent.status = 'awaiting_confirmation'
  ) pending;

  -- Exact prepare replay is idempotent even though the candidate was consumed by the first prepare.
  if pending_count = 1 then
    select booking.id as booking_intent_id, appointment_type.name as appointment_type_name,
      candidate.starts_at, candidate.timezone, booking.status
    into replay
    from public.booking_intents booking
    join public.booking_candidates candidate
      on candidate.organization_id = booking.organization_id and candidate.id = booking.candidate_id
    join public.scheduling_appointment_types appointment_type
      on appointment_type.organization_id = candidate.organization_id
     and appointment_type.id = candidate.appointment_type_id
    where booking.organization_id = conversation_row.organization_id
      and booking.location_id = conversation_row.location_id
      and booking.conversation_id = target_conversation_id
      and booking.candidate_id = target_candidate_id
      and booking.status = 'awaiting_confirmation'
      and candidate.status in ('offered', 'consumed')
      and candidate.expires_at > now();
    if replay.booking_intent_id is not null then
      return query select replay.booking_intent_id, replay.appointment_type_name,
        replay.starts_at, replay.timezone, replay.status;
      return;
    end if;
  end if;

  perform public.invalidate_customer_pending_mutations_for_correction(target_conversation_id);

  select * into prepared
  from public.prepare_conversation_scheduling_booking_intent_base(
    target_conversation_id,
    target_candidate_id,
    resolved_contact_uid,
    resolved_subject_uid,
    resolved_subject_name,
    trusted_contact_id,
    target_inbound_message_id
  );
  if prepared.booking_intent_id is null or prepared.status <> 'awaiting_confirmation' then
    raise exception using errcode = '55000', message = 'Replacement booking intent was not prepared';
  end if;
  return query select prepared.booking_intent_id, prepared.appointment_type_name,
    prepared.starts_at, prepared.timezone, prepared.status;
end;
$$;

create function public.prepare_appointment_change_intent(
  target_conversation_id uuid,
  target_inbound_message_id uuid,
  target_reference_id uuid,
  target_operation text,
  target_candidate_id uuid default null
)
returns table (change_intent_id uuid, operation text, starts_at timestamptz, timezone text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  requested_appointment_id uuid;
  pending_count integer;
  replay record;
  prepared record;
begin
  perform public.require_appointment_lifecycle_service_role();
  if target_conversation_id is null or target_inbound_message_id is null
    or target_operation not in ('cancel', 'reschedule') then
    raise exception using errcode = '22023', message = 'Customer appointment-change preparation is invalid';
  end if;

  perform public.lock_conversation_ownership(target_conversation_id);
  select * into conversation_row
  from public.conversations
  where id = target_conversation_id
  for update;
  if conversation_row.id is null or conversation_row.mode <> 'customer' then
    raise exception using errcode = '42501', message = 'Customer conversation is not available';
  end if;
  if conversation_row.ai_mode <> 'ai' then
    raise exception using errcode = '42501', message = 'Customer mutation preparation is not available';
  end if;

  if target_operation = 'reschedule' then
    select target.appointment_id into requested_appointment_id
    from public.appointment_change_candidates candidate
    join public.appointment_management_targets target
      on target.organization_id = candidate.organization_id and target.id = candidate.target_id
    where candidate.id = target_candidate_id
      and candidate.conversation_id = target_conversation_id
      and candidate.status in ('offered', 'consumed')
      and candidate.expires_at > now()
      and target.conversation_id = target_conversation_id
      and target.inbound_message_id = target_inbound_message_id
      and target.expires_at > now();
  else
    select target.appointment_id into requested_appointment_id
    from public.appointment_management_targets target
    where target.id = target_reference_id
      and target.conversation_id = target_conversation_id
      and target.inbound_message_id = target_inbound_message_id
      and target.expires_at > now();
  end if;
  if requested_appointment_id is null then
    raise exception using errcode = '42501', message = 'Appointment reference is not available';
  end if;

  if exists (
    select 1 from public.booking_intents booking
    where booking.conversation_id = target_conversation_id
      and booking.status in ('booking', 'provider_success_pending_persistence', 'provider_state_unknown')
  ) or exists (
    select 1 from public.appointment_change_intents change_intent
    where change_intent.conversation_id = target_conversation_id
      and change_intent.actor_category = 'customer'
      and change_intent.status in (
        'executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'handoff_required'
      )
  ) then
    raise exception using errcode = '55000', message = 'Customer mutation outcome must be resolved before another mutation is prepared';
  end if;

  select count(*)::integer into pending_count
  from (
    select booking.id
    from public.booking_intents booking
    where booking.conversation_id = target_conversation_id
      and booking.status = 'awaiting_confirmation'
    union all
    select change_intent.id
    from public.appointment_change_intents change_intent
    where change_intent.conversation_id = target_conversation_id
      and change_intent.actor_category = 'customer'
      and change_intent.status = 'awaiting_confirmation'
  ) pending;

  if pending_count = 1 then
    select change_intent.id as change_intent_id, change_intent.operation,
      change_intent.target_starts_at as starts_at,
      coalesce(candidate.timezone, location.timezone) as timezone,
      change_intent.status
    into replay
    from public.appointment_change_intents change_intent
    join public.locations location
      on location.organization_id = change_intent.organization_id and location.id = change_intent.location_id
    left join public.appointment_change_candidates candidate
      on candidate.organization_id = change_intent.organization_id and candidate.id = change_intent.candidate_id
    where change_intent.organization_id = conversation_row.organization_id
      and change_intent.location_id = conversation_row.location_id
      and change_intent.conversation_id = target_conversation_id
      and change_intent.appointment_id = requested_appointment_id
      and change_intent.actor_category = 'customer'
      and change_intent.operation = target_operation
      and change_intent.candidate_id is not distinct from target_candidate_id
      and change_intent.status = 'awaiting_confirmation'
      and change_intent.expires_at > now();
    if replay.change_intent_id is not null then
      return query select replay.change_intent_id, replay.operation,
        replay.starts_at, replay.timezone, replay.status;
      return;
    end if;
  end if;

  perform public.invalidate_customer_pending_mutations_for_correction(target_conversation_id);

  select * into prepared
  from public.prepare_appointment_change_intent_base(
    target_conversation_id,
    target_inbound_message_id,
    target_reference_id,
    target_operation,
    target_candidate_id
  );
  if prepared.change_intent_id is null or prepared.status <> 'awaiting_confirmation' then
    raise exception using errcode = '55000', message = 'Replacement appointment-change intent was not prepared';
  end if;
  return query select prepared.change_intent_id, prepared.operation,
    prepared.starts_at, prepared.timezone, prepared.status;
end;
$$;

-- Delayed confirmations for terminally invalidated snapshots map to the existing unavailable state
-- understood by the application. The durable row retains INVALIDATED/customer_correction truth.
create or replace function public.claim_conversation_scheduling_booking_intent(
  target_conversation_id uuid,
  target_inbound_message_id uuid,
  target_booking_intent_id uuid,
  target_tool_call_id text
)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  intent public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role();
  if target_conversation_id is null or target_booking_intent_id is null then
    raise exception using errcode = '22023', message = 'Customer booking claim is invalid';
  end if;
  perform public.lock_conversation_ownership(target_conversation_id);
  select * into conversation_row from public.conversations where id = target_conversation_id for update;
  if conversation_row.id is null or conversation_row.mode <> 'customer' then
    raise exception using errcode = '42501', message = 'Customer conversation is not available';
  end if;
  select * into intent
  from public.booking_intents
  where id = target_booking_intent_id
    and conversation_id = target_conversation_id
    and organization_id = conversation_row.organization_id
    and location_id = conversation_row.location_id
  for update;
  if intent.id is null then
    raise exception using errcode = '42501', message = 'Booking intent is not available';
  end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'booking') then
    return query
    select claim.state, claim.booking_intent_id, claim.confirmed_message_id
    from public.claim_conversation_scheduling_booking_intent_without_ownership(
      target_conversation_id, target_inbound_message_id, target_booking_intent_id, target_tool_call_id
    ) claim;
    return;
  end if;
  if intent.status = 'invalidated'
    or (intent.status = 'failed' and intent.failure_category = 'human_control') then
    return query select 'configuration_changed'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if conversation_row.ai_mode <> 'ai' and intent.status = 'awaiting_confirmation' then
    update public.booking_intents
    set status = 'failed', failure_category = 'human_control', updated_at = now()
    where id = intent.id and status = 'awaiting_confirmation';
    return query select 'configuration_changed'::text, intent.id, null::uuid;
    return;
  end if;
  if intent.status = 'awaiting_confirmation'
    and not public.billing_feature_available(intent.organization_id, 'appointments') then
    return query select 'billing_unavailable'::text, intent.id, null::uuid;
    return;
  end if;
  return query
  select claim.state, claim.booking_intent_id, claim.confirmed_message_id
  from public.claim_conversation_scheduling_booking_intent_without_ownership(
    target_conversation_id, target_inbound_message_id, target_booking_intent_id, target_tool_call_id
  ) claim;
end;
$$;

create or replace function public.claim_appointment_change_intent(
  target_conversation_id uuid,
  target_inbound_message_id uuid,
  target_change_intent_id uuid,
  target_tool_call_id text
)
returns table (state text, change_intent_id uuid, confirmed_message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  if target_conversation_id is null or target_change_intent_id is null then
    raise exception using errcode = '22023', message = 'Customer appointment-change claim is invalid';
  end if;
  perform public.lock_conversation_ownership(target_conversation_id);
  select * into conversation_row from public.conversations where id = target_conversation_id for update;
  if conversation_row.id is null or conversation_row.mode <> 'customer' then
    raise exception using errcode = '42501', message = 'Customer conversation is not available';
  end if;
  select * into intent
  from public.appointment_change_intents
  where id = target_change_intent_id
    and conversation_id = target_conversation_id
    and organization_id = conversation_row.organization_id
    and location_id = conversation_row.location_id
  for update;
  if intent.id is null or intent.actor_category <> 'customer' then
    raise exception using errcode = '42501', message = 'Customer appointment-change intent is not available';
  end if;
  if intent.status in (
    'completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'executing', 'handoff_required'
  ) then
    return query
    select claim.state, claim.change_intent_id, claim.confirmed_message_id
    from public.claim_appointment_change_intent_without_ownership(
      target_conversation_id, target_inbound_message_id, target_change_intent_id, target_tool_call_id
    ) claim;
    return;
  end if;
  if intent.status = 'invalidated'
    or (intent.status = 'failed' and intent.failure_category = 'human_control') then
    return query select 'configuration_changed'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if conversation_row.ai_mode <> 'ai' and intent.status = 'awaiting_confirmation' then
    update public.appointment_change_intents
    set status = 'failed', failure_category = 'human_control', updated_at = now()
    where id = intent.id and status = 'awaiting_confirmation';
    return query select 'configuration_changed'::text, intent.id, null::uuid;
    return;
  end if;
  return query
  select claim.state, claim.change_intent_id, claim.confirmed_message_id
  from public.claim_appointment_change_intent_without_ownership(
    target_conversation_id, target_inbound_message_id, target_change_intent_id, target_tool_call_id
  ) claim;
end;
$$;

-- Newly introduced internal helpers are not client/backend entry points. Only the original public
-- prepare names remain callable by service_role.
revoke all on function public.prepare_conversation_scheduling_booking_intent_base(uuid, uuid, text, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_appointment_change_intent_base(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.invalidate_customer_pending_mutations_for_correction(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.prepare_appointment_change_intent(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid, uuid)
  to service_role;
grant execute on function public.prepare_appointment_change_intent(uuid, uuid, uuid, text, uuid)
  to service_role;

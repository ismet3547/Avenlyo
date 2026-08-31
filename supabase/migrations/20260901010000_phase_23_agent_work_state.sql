-- Phase 23: trusted per-turn agent work state for customer messaging.
--
-- The model is never the authority for conversation control or pending action identity. This
-- service-role read model binds a customer inbound message to its current conversation control
-- state and, when exactly one valid consequential mutation awaits confirmation, to that opaque
-- durable action intent. Multiple pending mutations are surfaced explicitly so the application can
-- fail closed and request human recovery rather than choosing one arbitrarily.

create function public.get_message_agent_work_state(target_message_id uuid)
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
      and candidate.status = 'offered'
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
        and candidate.status = 'offered'
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

revoke all on function public.get_message_agent_work_state(uuid) from public, anon, authenticated;
grant execute on function public.get_message_agent_work_state(uuid) to service_role;

-- Phase 23 closure: a customer confirmation can authorize a text mutation only if the exact
-- bound prompt was already customer-visible when that inbound event was persisted.
--
-- `confirmation_prompt_message_id` proves which prompt belongs to an action. Delivery status proves
-- that the prompt is visible now. Neither fact alone proves ordering. In particular, an SMS can be
-- persisted while queued, a generic YES can arrive, and Twilio can report the prompt sent only
-- afterwards. A delayed/retried inbound job must never turn that earlier YES into retroactive
-- authorization merely because the delivery is visible by processing time.
--
-- `message_deliveries.sent_at` is the durable first-visible boundary: Web writes it atomically with
-- its `web_chat/sent` delivery, while Twilio sets it when delivery first reaches sent/delivered and
-- preserves it on later transitions. The effective presentation time is never earlier than the
-- prompt row itself, which also makes malformed/backfilled delivery timestamps fail closed.

create function public.customer_mutation_confirmation_prompt_visible_at(
  target_message_id uuid,
  target_conversation_id uuid
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select min(greatest(prompt.created_at, delivery.sent_at))
  from public.messages prompt
  join public.message_deliveries delivery
    on delivery.organization_id = prompt.organization_id
   and delivery.message_id = prompt.id
  where prompt.id = target_message_id
    and prompt.conversation_id = target_conversation_id
    and prompt.direction = 'outbound'
    and prompt.author_type = 'ai'
    and delivery.sent_at is not null
    and (
      (prompt.source_channel = 'web' and delivery.provider = 'web_chat' and delivery.status = 'sent')
      or
      (prompt.source_channel = 'sms' and delivery.provider = 'twilio' and delivery.status in ('sent', 'delivered'))
    );
$$;

create or replace function public.customer_mutation_confirmation_prompt_is_visible(
  target_message_id uuid,
  target_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.customer_mutation_confirmation_prompt_visible_at(
    target_message_id,
    target_conversation_id
  ) is not null;
$$;

-- Work state is evaluated for one exact inbound customer event. A prompt that became visible only
-- after that event is not authority for that event, even if the worker processes the event later.
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
    select booking.id as intent_id, 'APPOINTMENT_BOOK'::text as intent_type, booking.created_at
    from public.booking_intents booking
    join public.booking_candidates candidate
      on candidate.organization_id = booking.organization_id and candidate.id = booking.candidate_id
    where booking.organization_id = conversation_row.organization_id
      and booking.conversation_id = conversation_row.id
      and booking.status = 'awaiting_confirmation'
      and booking.confirmation_prompt_message_id is not null
      and public.customer_mutation_confirmation_prompt_visible_at(
        booking.confirmation_prompt_message_id, conversation_row.id
      ) < inbound.created_at
      and candidate.status in ('offered', 'consumed')
      and candidate.expires_at > now()
    union all
    select change_intent.id,
      case change_intent.operation
        when 'cancel' then 'APPOINTMENT_CANCEL'::text
        when 'reschedule' then 'APPOINTMENT_RESCHEDULE'::text
      end,
      change_intent.created_at
    from public.appointment_change_intents change_intent
    where change_intent.organization_id = conversation_row.organization_id
      and change_intent.conversation_id = conversation_row.id
      and change_intent.actor_category = 'customer'
      and change_intent.status = 'awaiting_confirmation'
      and change_intent.confirmation_prompt_message_id is not null
      and public.customer_mutation_confirmation_prompt_visible_at(
        change_intent.confirmation_prompt_message_id, conversation_row.id
      ) < inbound.created_at
      and change_intent.expires_at > now()
  )
  select count(*)::integer into resolved_pending_count from pending;

  if resolved_pending_count = 1 then
    with pending as (
      select booking.id as intent_id, 'APPOINTMENT_BOOK'::text as intent_type, booking.created_at
      from public.booking_intents booking
      join public.booking_candidates candidate
        on candidate.organization_id = booking.organization_id and candidate.id = booking.candidate_id
      where booking.organization_id = conversation_row.organization_id
        and booking.conversation_id = conversation_row.id
        and booking.status = 'awaiting_confirmation'
        and booking.confirmation_prompt_message_id is not null
        and public.customer_mutation_confirmation_prompt_visible_at(
          booking.confirmation_prompt_message_id, conversation_row.id
        ) < inbound.created_at
        and candidate.status in ('offered', 'consumed')
        and candidate.expires_at > now()
      union all
      select change_intent.id,
        case change_intent.operation
          when 'cancel' then 'APPOINTMENT_CANCEL'::text
          when 'reschedule' then 'APPOINTMENT_RESCHEDULE'::text
        end,
        change_intent.created_at
      from public.appointment_change_intents change_intent
      where change_intent.organization_id = conversation_row.organization_id
        and change_intent.conversation_id = conversation_row.id
        and change_intent.actor_category = 'customer'
        and change_intent.status = 'awaiting_confirmation'
        and change_intent.confirmation_prompt_message_id is not null
        and public.customer_mutation_confirmation_prompt_visible_at(
          change_intent.confirmation_prompt_message_id, conversation_row.id
        ) < inbound.created_at
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

create or replace function public.claim_presented_conversation_scheduling_booking_intent(
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
  intent public.booking_intents%rowtype;
  inbound public.messages%rowtype;
  presented_at timestamptz;
begin
  perform public.require_scheduling_service_role();
  select * into intent
  from public.booking_intents
  where id = target_booking_intent_id
    and conversation_id = target_conversation_id;
  if intent.id is null then
    raise exception using errcode = '42501', message = 'Booking intent is not available';
  end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'booking') then
    return query select * from public.claim_conversation_scheduling_booking_intent(
      target_conversation_id, target_inbound_message_id, target_booking_intent_id, target_tool_call_id
    );
    return;
  end if;
  if intent.status <> 'awaiting_confirmation' then
    return query select * from public.claim_conversation_scheduling_booking_intent(
      target_conversation_id, target_inbound_message_id, target_booking_intent_id, target_tool_call_id
    );
    return;
  end if;

  presented_at := public.customer_mutation_confirmation_prompt_visible_at(
    intent.confirmation_prompt_message_id,
    target_conversation_id
  );
  if presented_at is null then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;

  select * into inbound
  from public.messages
  where id = target_inbound_message_id
    and organization_id = intent.organization_id
    and location_id = intent.location_id
    and conversation_id = target_conversation_id
    and direction = 'inbound'
    and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= presented_at then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;

  return query select * from public.claim_conversation_scheduling_booking_intent(
    target_conversation_id, target_inbound_message_id, target_booking_intent_id, target_tool_call_id
  );
end;
$$;

create or replace function public.claim_presented_appointment_change_intent(
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
  intent public.appointment_change_intents%rowtype;
  inbound public.messages%rowtype;
  presented_at timestamptz;
begin
  perform public.require_appointment_lifecycle_service_role();
  select * into intent
  from public.appointment_change_intents
  where id = target_change_intent_id
    and conversation_id = target_conversation_id;
  if intent.id is null or intent.actor_category <> 'customer' then
    raise exception using errcode = '42501', message = 'Customer appointment-change intent is not available';
  end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'executing', 'handoff_required') then
    return query select * from public.claim_appointment_change_intent(
      target_conversation_id, target_inbound_message_id, target_change_intent_id, target_tool_call_id
    );
    return;
  end if;
  if intent.status <> 'awaiting_confirmation' then
    return query select * from public.claim_appointment_change_intent(
      target_conversation_id, target_inbound_message_id, target_change_intent_id, target_tool_call_id
    );
    return;
  end if;

  presented_at := public.customer_mutation_confirmation_prompt_visible_at(
    intent.confirmation_prompt_message_id,
    target_conversation_id
  );
  if presented_at is null then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;

  select * into inbound
  from public.messages
  where id = target_inbound_message_id
    and organization_id = intent.organization_id
    and location_id = intent.location_id
    and conversation_id = target_conversation_id
    and direction = 'inbound'
    and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= presented_at then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;

  return query select * from public.claim_appointment_change_intent(
    target_conversation_id, target_inbound_message_id, target_change_intent_id, target_tool_call_id
  );
end;
$$;

-- The transition triggers are the final backstop. They cover a stale binary accidentally calling a
-- legacy claim name and any future trusted code path that reaches the table transition directly.
create or replace function public.enforce_presented_booking_confirmation_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  confirmed public.messages%rowtype;
  presented_at timestamptz;
begin
  if old.status = 'awaiting_confirmation'
    and new.status = 'booking'
    and old.confirmation_prompt_message_id is not null then
    presented_at := public.customer_mutation_confirmation_prompt_visible_at(
      old.confirmation_prompt_message_id,
      old.conversation_id
    );
    if new.confirmed_message_id is null or presented_at is null then
      raise exception using errcode = '42501', message = 'Presented booking confirmation is required';
    end if;
    select * into confirmed
    from public.messages
    where id = new.confirmed_message_id
      and organization_id = old.organization_id
      and location_id = old.location_id
      and conversation_id = old.conversation_id
      and direction = 'inbound'
      and author_type = 'customer';
    if confirmed.id is null or confirmed.created_at <= presented_at then
      raise exception using errcode = '42501', message = 'Presented booking confirmation is required';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_presented_appointment_change_confirmation_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  confirmed public.messages%rowtype;
  presented_at timestamptz;
begin
  if old.actor_category = 'customer'
    and old.status = 'awaiting_confirmation'
    and new.status = 'executing'
    and old.confirmation_prompt_message_id is not null then
    presented_at := public.customer_mutation_confirmation_prompt_visible_at(
      old.confirmation_prompt_message_id,
      old.conversation_id
    );
    if new.confirmed_message_id is null or presented_at is null then
      raise exception using errcode = '42501', message = 'Presented appointment-change confirmation is required';
    end if;
    select * into confirmed
    from public.messages
    where id = new.confirmed_message_id
      and organization_id = old.organization_id
      and location_id = old.location_id
      and conversation_id = old.conversation_id
      and direction = 'inbound'
      and author_type = 'customer';
    if confirmed.id is null or confirmed.created_at <= presented_at then
      raise exception using errcode = '42501', message = 'Presented appointment-change confirmation is required';
    end if;
  end if;
  return new;
end;
$$;

-- New helper is internal implementation only. Reassert the intended grants on replaced functions so
-- the closure migration cannot widen the client/backend privilege surface.
revoke all on function public.customer_mutation_confirmation_prompt_visible_at(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.customer_mutation_confirmation_prompt_is_visible(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_message_agent_work_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_message_agent_work_state(uuid) to service_role;
revoke all on function public.claim_presented_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_presented_appointment_change_intent(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_presented_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.claim_presented_appointment_change_intent(uuid, uuid, uuid, text)
  to service_role;
revoke all on function public.enforce_presented_booking_confirmation_transition()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_presented_appointment_change_confirmation_transition()
  from public, anon, authenticated, service_role;

-- Schema 20 was emitted by the first presentation migration before the transition guard and final
-- visibility hardening existed. The current binary must not advertise readiness against that
-- intermediate state. Version 21 is declared only after this final ordering backstop is installed.
update public.platform_schema_contract
set schema_version = 21, updated_at = now()
where id;

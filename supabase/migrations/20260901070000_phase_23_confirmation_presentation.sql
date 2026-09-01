-- Phase 23: a durable prepared mutation is not customer authorization.
--
-- Text channels require one additional durable fact before a generic confirmation can claim a
-- consequential mutation: the exact customer-facing confirmation prompt must have been persisted
-- for that same conversation/action. Web prompts are visible when their web delivery is `sent`;
-- SMS prompts are eligible only after provider delivery truth reaches `sent` or `delivered`.
-- A queued/submitting/submitted/suppressed/unknown/failed SMS is not treated as presented.
--
-- The previous claim RPC names are intentionally retained for rollback compatibility with older
-- binaries. Phase 23 uses new `claim_presented_*` entry points. That keeps schema >= rollback
-- semantics true while making prompt presentation mandatory for the current runtime.

alter table public.booking_intents
  add column if not exists confirmation_prompt_message_id uuid;
alter table public.booking_intents
  add constraint booking_intents_confirmation_prompt_message_fk
  foreign key (organization_id, confirmation_prompt_message_id)
  references public.messages (organization_id, id);

alter table public.appointment_change_intents
  add column if not exists confirmation_prompt_message_id uuid;
alter table public.appointment_change_intents
  add constraint appointment_change_intents_confirmation_prompt_message_fk
  foreign key (organization_id, confirmation_prompt_message_id)
  references public.messages (organization_id, id);

-- Internal visibility predicate. It is deliberately stricter for SMS than "provider accepted":
-- a submitted-but-not-sent confirmation cannot safely authorize a later generic YES.
create function public.customer_mutation_confirmation_prompt_is_visible(
  target_message_id uuid,
  target_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.messages prompt
    join public.message_deliveries delivery
      on delivery.organization_id = prompt.organization_id
     and delivery.message_id = prompt.id
    where prompt.id = target_message_id
      and prompt.conversation_id = target_conversation_id
      and prompt.direction = 'outbound'
      and prompt.author_type = 'ai'
      and (
        (prompt.source_channel = 'web' and delivery.provider = 'web_chat' and delivery.status = 'sent')
        or
        (prompt.source_channel = 'sms' and delivery.provider = 'twilio' and delivery.status in ('sent', 'delivered'))
      )
  );
$$;

-- Persist the canonical text reply through the Phase 13 ownership boundary, then bind the resulting
-- message id to the exact still-awaiting action in the same transaction. If a human wins ownership
-- first, persist_ai_message_reply returns no message and no action binding is written.
create function public.persist_ai_mutation_confirmation_reply(
  target_inbound_message_id uuid,
  target_body text,
  target_action_intent_id uuid,
  target_action_intent_type text
)
returns table (message_id uuid, created boolean, bound boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inbound public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  booking public.booking_intents%rowtype;
  change_intent public.appointment_change_intents%rowtype;
  saved record;
  persisted public.messages%rowtype;
  prior_prompt_id uuid;
begin
  perform public.require_messaging_service_role();
  if target_action_intent_type not in ('APPOINTMENT_BOOK', 'APPOINTMENT_CANCEL', 'APPOINTMENT_RESCHEDULE')
    or target_action_intent_id is null
    or length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Mutation confirmation reply is invalid';
  end if;

  select * into inbound
  from public.messages
  where id = target_inbound_message_id
    and direction = 'inbound'
    and author_type = 'customer';
  if inbound.id is null then
    raise exception using errcode = '42501', message = 'Inbound message is unavailable';
  end if;

  perform public.lock_conversation_ownership(inbound.conversation_id);
  select * into conversation_row
  from public.conversations
  where organization_id = inbound.organization_id
    and id = inbound.conversation_id
    and mode = 'customer'
  for update;
  if conversation_row.id is null then
    raise exception using errcode = '42501', message = 'Customer conversation is unavailable';
  end if;

  if target_action_intent_type = 'APPOINTMENT_BOOK' then
    select intent.* into booking
    from public.booking_intents intent
    join public.booking_candidates candidate
      on candidate.organization_id = intent.organization_id
     and candidate.id = intent.candidate_id
    where intent.id = target_action_intent_id
      and intent.organization_id = inbound.organization_id
      and intent.location_id = inbound.location_id
      and intent.conversation_id = inbound.conversation_id
      and intent.status = 'awaiting_confirmation'
      and candidate.status in ('offered', 'consumed')
      and candidate.expires_at > now()
    for update of intent;
    if booking.id is null then
      raise exception using errcode = '42501', message = 'Booking confirmation is unavailable';
    end if;
    prior_prompt_id := booking.confirmation_prompt_message_id;
  else
    select intent.* into change_intent
    from public.appointment_change_intents intent
    where intent.id = target_action_intent_id
      and intent.organization_id = inbound.organization_id
      and intent.location_id = inbound.location_id
      and intent.conversation_id = inbound.conversation_id
      and intent.actor_category = 'customer'
      and intent.status = 'awaiting_confirmation'
      and intent.expires_at > now()
      and intent.operation = case target_action_intent_type
        when 'APPOINTMENT_CANCEL' then 'cancel'
        when 'APPOINTMENT_RESCHEDULE' then 'reschedule'
      end
    for update;
    if change_intent.id is null then
      raise exception using errcode = '42501', message = 'Appointment-change confirmation is unavailable';
    end if;
    prior_prompt_id := change_intent.confirmation_prompt_message_id;
  end if;

  select * into saved
  from public.persist_ai_message_reply(target_inbound_message_id, target_body, false);
  if saved.message_id is null then
    return query select null::uuid, false, false;
    return;
  end if;

  select * into persisted
  from public.messages
  where id = saved.message_id
    and organization_id = inbound.organization_id
    and location_id = inbound.location_id
    and conversation_id = inbound.conversation_id
    and direction = 'outbound'
    and author_type = 'ai'
    and in_reply_to_message_id = inbound.id;
  if persisted.id is null or btrim(coalesce(persisted.body, '')) <> btrim(target_body) then
    raise exception using errcode = '55000', message = 'Persisted confirmation reply conflicts with the prepared action';
  end if;

  if target_action_intent_type = 'APPOINTMENT_BOOK' then
    update public.booking_intents
    set confirmation_prompt_message_id = persisted.id,
        updated_at = now()
    where id = booking.id
      and status = 'awaiting_confirmation';
    if not found then
      raise exception using errcode = '55000', message = 'Booking confirmation binding became stale';
    end if;
    if prior_prompt_id is distinct from persisted.id then
      insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (booking.organization_id, booking.location_id, 'booking.confirmation_presented',
        'booking_intent', booking.id, jsonb_build_object('channel', persisted.source_channel));
    end if;
  else
    update public.appointment_change_intents
    set confirmation_prompt_message_id = persisted.id,
        updated_at = now()
    where id = change_intent.id
      and actor_category = 'customer'
      and status = 'awaiting_confirmation';
    if not found then
      raise exception using errcode = '55000', message = 'Appointment-change confirmation binding became stale';
    end if;
    if prior_prompt_id is distinct from persisted.id then
      insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (change_intent.organization_id, change_intent.location_id,
        'appointment_change.confirmation_presented', 'appointment_change_intent', change_intent.id,
        jsonb_build_object('operation', change_intent.operation, 'channel', persisted.source_channel));
    end if;
  end if;

  return query select persisted.id, coalesce(saved.created, false), true;
end;
$$;

-- Text-channel execution authority exists only after a prompt was bound. The count therefore means
-- "presented and actionable pending mutations", not merely "durable rows in awaiting_confirmation".
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

-- Trusted summary snapshot for deterministic text confirmation. This reads only the immutable
-- prepared action and current location label; the model never supplies these facts.
create function public.get_customer_appointment_change_confirmation_snapshot(target_change_intent_id uuid)
returns table (
  change_intent_id uuid,
  operation text,
  appointment_title text,
  original_starts_at timestamptz,
  target_starts_at timestamptz,
  timezone text,
  location_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_appointment_lifecycle_service_role();
  return query
  select intent.id,
    intent.operation,
    coalesce(nullif(btrim(appointment.title), ''), 'Appointment')::text,
    intent.original_starts_at,
    intent.target_starts_at,
    location.timezone,
    location.name
  from public.appointment_change_intents intent
  join public.appointments appointment
    on appointment.organization_id = intent.organization_id
   and appointment.id = intent.appointment_id
  join public.locations location
    on location.organization_id = intent.organization_id
   and location.id = intent.location_id
  where intent.id = target_change_intent_id
    and intent.actor_category = 'customer'
    and intent.status = 'awaiting_confirmation'
    and intent.expires_at > now();
end;
$$;

-- Phase 23 current-runtime claim entry points. Recovery states delegate immediately because the
-- external provider boundary may already have been crossed. A fresh awaiting action must point at a
-- visible prompt in the same conversation, and the customer confirmation must be a later inbound
-- event in that conversation before the existing ownership/confirmation/capability claim runs.
create function public.claim_presented_conversation_scheduling_booking_intent(
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
  prompt public.messages%rowtype;
  inbound public.messages%rowtype;
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
  if intent.confirmation_prompt_message_id is null
    or not public.customer_mutation_confirmation_prompt_is_visible(
      intent.confirmation_prompt_message_id, target_conversation_id
    ) then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  select * into prompt from public.messages where id = intent.confirmation_prompt_message_id;
  select * into inbound
  from public.messages
  where id = target_inbound_message_id
    and organization_id = intent.organization_id
    and location_id = intent.location_id
    and conversation_id = target_conversation_id
    and direction = 'inbound'
    and author_type = 'customer';
  if inbound.id is null or inbound.created_at < prompt.created_at then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  return query select * from public.claim_conversation_scheduling_booking_intent(
    target_conversation_id, target_inbound_message_id, target_booking_intent_id, target_tool_call_id
  );
end;
$$;

create function public.claim_presented_appointment_change_intent(
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
  prompt public.messages%rowtype;
  inbound public.messages%rowtype;
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
  if intent.confirmation_prompt_message_id is null
    or not public.customer_mutation_confirmation_prompt_is_visible(
      intent.confirmation_prompt_message_id, target_conversation_id
    ) then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  select * into prompt from public.messages where id = intent.confirmation_prompt_message_id;
  select * into inbound
  from public.messages
  where id = target_inbound_message_id
    and organization_id = intent.organization_id
    and location_id = intent.location_id
    and conversation_id = target_conversation_id
    and direction = 'inbound'
    and author_type = 'customer';
  if inbound.id is null or inbound.created_at < prompt.created_at then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  return query select * from public.claim_appointment_change_intent(
    target_conversation_id, target_inbound_message_id, target_change_intent_id, target_tool_call_id
  );
end;
$$;

-- Every new function is backend-only. Internal helpers retain no service_role grant; current runtime
-- entry points are granted narrowly.
revoke all on function public.customer_mutation_confirmation_prompt_is_visible(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.persist_ai_mutation_confirmation_reply(uuid, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.get_customer_appointment_change_confirmation_snapshot(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_presented_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_presented_appointment_change_intent(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.persist_ai_mutation_confirmation_reply(uuid, text, uuid, text)
  to service_role;
grant execute on function public.get_customer_appointment_change_confirmation_snapshot(uuid)
  to service_role;
grant execute on function public.claim_presented_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.claim_presented_appointment_change_intent(uuid, uuid, uuid, text)
  to service_role;

-- The Phase 23 API now depends on get_message_agent_work_state, confirmation presentation binding,
-- and the claim_presented_* RPCs. It must not report ready against a Phase 19-only schema.
update public.platform_schema_contract
set schema_version = 20, updated_at = now()
where id;

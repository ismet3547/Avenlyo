-- Phase 23: serialize fresh customer provider-mutation claims against human conversation ownership.
--
-- Phase 13 already defines the authoritative per-conversation ownership lock used by handoff,
-- takeover, human reply, AI persistence, and the SMS send boundary. A fresh consequential customer
-- mutation must enter its existing booking/executing state under that same lock. That state is the
-- durable point of no return for the provider operation:
--
--   takeover wins first -> the still-awaiting mutation becomes failed/human_control and no fresh
--                          provider write can be claimed;
--   mutation claim wins -> the provider operation is considered started. A later takeover may stop
--                          AI conversation/output ownership, but it must not rewrite or retry provider
--                          truth.
--
-- Existing recovery states deliberately bypass the human-control veto. They may already have crossed
-- the external boundary and therefore stay reconciliation-only. The wrappers below delegate all
-- confirmation, billing, capability, freshness, and recovery semantics to the existing authoritative
-- claim functions instead of copying them.

create function public.claim_customer_conversation_scheduling_booking_intent(
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

  select * into conversation_row
  from public.conversations
  where id = target_conversation_id
  for update;
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

  -- A takeover-vetoed intent never comes back to life after Resume AI.
  if intent.status = 'failed' and intent.failure_category = 'human_control' then
    return query select 'human_control'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;

  -- Only a fresh, not-yet-claimed mutation loses to current human control. Recovery/completed states
  -- are delegated below because they may already represent external provider truth.
  if conversation_row.ai_mode <> 'ai' and intent.status = 'awaiting_confirmation' then
    update public.booking_intents
    set status = 'failed', failure_category = 'human_control', updated_at = now()
    where id = intent.id and status = 'awaiting_confirmation';
    return query select 'human_control'::text, intent.id, null::uuid;
    return;
  end if;

  return query
  select claim.state, claim.booking_intent_id, claim.confirmed_message_id
  from public.claim_conversation_scheduling_booking_intent(
    target_conversation_id,
    target_inbound_message_id,
    target_booking_intent_id,
    target_tool_call_id
  ) claim;
end;
$$;

create function public.claim_customer_appointment_change_intent(
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

  select * into conversation_row
  from public.conversations
  where id = target_conversation_id
  for update;
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

  if intent.status = 'failed' and intent.failure_category = 'human_control' then
    return query select 'human_control'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;

  if conversation_row.ai_mode <> 'ai' and intent.status = 'awaiting_confirmation' then
    update public.appointment_change_intents
    set status = 'failed', failure_category = 'human_control', updated_at = now()
    where id = intent.id and status = 'awaiting_confirmation';
    return query select 'human_control'::text, intent.id, null::uuid;
    return;
  end if;

  return query
  select claim.state, claim.change_intent_id, claim.confirmed_message_id
  from public.claim_appointment_change_intent(
    target_conversation_id,
    target_inbound_message_id,
    target_change_intent_id,
    target_tool_call_id
  ) claim;
end;
$$;

revoke all on function public.claim_customer_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_customer_appointment_change_intent(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_customer_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.claim_customer_appointment_change_intent(uuid, uuid, uuid, text)
  to service_role;

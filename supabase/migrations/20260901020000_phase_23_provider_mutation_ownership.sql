-- Phase 23: serialize fresh customer provider mutations against human conversation ownership.
--
-- A model/tool revalidation in application memory cannot close the final race by itself: a staff
-- takeover can commit after that read but before the external scheduling request begins. Phase 13
-- already defines the authoritative per-conversation ownership lock. These two boundaries reuse it
-- immediately before a FRESH customer provider write. The winner establishes the point of no return:
--
--   takeover wins first  -> stale customer mutation is terminally failed, provider is never called
--   begin boundary wins  -> provider operation is considered started; a later takeover suppresses
--                           AI conversation/output ownership but does not rewrite provider truth
--
-- Recovery paths never call these functions. An intent already in recovery may have crossed the
-- provider boundary and must remain reconciliation-only rather than being re-authorized or retried.

create function public.begin_customer_booking_provider_mutation(
  target_conversation_id uuid,
  target_booking_intent_id uuid
)
returns table (state text)
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
    raise exception using errcode = '22023', message = 'Customer booking provider boundary is invalid';
  end if;

  -- Same lock used by handoff, claim/release, manual takeover, human reply, AI persistence and SMS
  -- submission. The authoritative state is re-read only after this transaction owns that lock.
  perform public.lock_conversation_ownership(target_conversation_id);

  select * into conversation_row
  from public.conversations
  where id = target_conversation_id
  for update;

  select * into intent
  from public.booking_intents
  where id = target_booking_intent_id
    and conversation_id = target_conversation_id
  for update;

  if conversation_row.id is null
    or conversation_row.mode <> 'customer'
    or intent.id is null
    or intent.organization_id is distinct from conversation_row.organization_id
    or intent.location_id is distinct from conversation_row.location_id
    or intent.status <> 'booking'
    or intent.confirmed_message_id is null
    or intent.booking_tool_call_id is null then
    return query select 'not_authorized'::text;
    return;
  end if;

  if conversation_row.ai_mode <> 'ai' then
    update public.booking_intents
    set status = 'failed', failure_category = 'human_control', updated_at = now()
    where id = intent.id and status = 'booking';
    return query select 'human_control'::text;
    return;
  end if;

  return query select 'authorized'::text;
end;
$$;

create function public.begin_customer_appointment_change_provider_mutation(
  target_conversation_id uuid,
  target_change_intent_id uuid
)
returns table (state text)
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
    raise exception using errcode = '22023', message = 'Customer appointment-change provider boundary is invalid';
  end if;

  perform public.lock_conversation_ownership(target_conversation_id);

  select * into conversation_row
  from public.conversations
  where id = target_conversation_id
  for update;

  select * into intent
  from public.appointment_change_intents
  where id = target_change_intent_id
    and conversation_id = target_conversation_id
  for update;

  if conversation_row.id is null
    or conversation_row.mode <> 'customer'
    or intent.id is null
    or intent.organization_id is distinct from conversation_row.organization_id
    or intent.location_id is distinct from conversation_row.location_id
    or intent.actor_category <> 'customer'
    or intent.status <> 'executing'
    or intent.confirmed_message_id is null then
    return query select 'not_authorized'::text;
    return;
  end if;

  if conversation_row.ai_mode <> 'ai' then
    update public.appointment_change_intents
    set status = 'failed', failure_category = 'human_control', updated_at = now()
    where id = intent.id and status = 'executing';
    return query select 'human_control'::text;
    return;
  end if;

  return query select 'authorized'::text;
end;
$$;

revoke all on function public.begin_customer_booking_provider_mutation(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.begin_customer_appointment_change_provider_mutation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_customer_booking_provider_mutation(uuid, uuid) to service_role;
grant execute on function public.begin_customer_appointment_change_provider_mutation(uuid, uuid) to service_role;

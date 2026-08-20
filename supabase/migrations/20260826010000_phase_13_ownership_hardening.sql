-- Phase 13 follow-up: one deterministic serialization protocol for conversation ownership, one
-- central place that pauses automation, and a send boundary that loses to a person every time.
--
-- Ownership mutations previously took row locks in two different orders: claim locked the handoff
-- and then the conversation, while manual takeover and human reply locked the conversation and
-- then the handoff.  Two concurrent sessions could therefore form a real lock cycle.  Every
-- mutation that can touch active handoff assignment, conversations.ai_mode, or
-- conversations.assigned_user_id now takes the same per-conversation advisory transaction lock
-- BEFORE any row lock, so the row-lock order can no longer matter.  Deadlock retry is not control
-- flow here, and no in-memory coordination is introduced.

-- Legacy operational state: Phase 0-12 voice and text paths could leave an active customer handoff
-- on a conversation that automation still owned.  A durable active handoff means a person is
-- needed, so automation is paused for those conversations.  No staff assignment is invented, no
-- message is synthesised, no provider call state is touched, and every handoff row is kept.
update public.conversations conversation
set ai_mode = 'human', updated_at = now()
where conversation.mode = 'customer'
  and conversation.ai_mode <> 'human'
  and exists (
    select 1 from public.handoffs handoff
    where handoff.organization_id = conversation.organization_id
      and handoff.conversation_id = conversation.id
      and handoff.mode = 'customer'
      and handoff.status in ('open', 'acknowledged')
  );

-- The single serialization point.  Its key is the same one Phase 13 already used for handoff
-- coalescing, so creation, claim, release, resolve, takeover, resume, human reply, automated
-- persistence, and the SMS send boundary all queue behind one lock per conversation.
create function public.lock_conversation_ownership(target_conversation_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if target_conversation_id is null then
    raise exception using errcode = '22023', message = 'Conversation ownership lock requires a conversation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('conversation-handoff:' || target_conversation_id::text, 0)
  );
end;
$$;

-- The one place automation is paused.  Callers must already hold the ownership lock.  The audit is
-- written only when this call performs a real ai -> human transition, so handoff replay, urgency
-- escalation, coalescing onto an already-human conversation, and claim replay add nothing.
create function public.pause_conversation_automation(
  target_conversation_id uuid,
  target_actor_user_id uuid,
  target_trigger text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype;
begin
  if target_trigger not in ('handoff', 'staff', 'human_reply') then
    raise exception using errcode = '22023', message = 'Conversation pause trigger is invalid';
  end if;
  select * into conversation_row from public.conversations
  where id = target_conversation_id for update;
  if conversation_row.id is null then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;
  if conversation_row.ai_mode = 'human' then
    return false;
  end if;

  update public.conversations set ai_mode = 'human', updated_at = now()
  where organization_id = conversation_row.organization_id and id = conversation_row.id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (conversation_row.organization_id, conversation_row.location_id, target_actor_user_id,
    'conversation.human_takeover', 'conversation', conversation_row.id,
    jsonb_build_object('transition', 'ai_to_human', 'trigger', target_trigger));
  return true;
end;
$$;

-- One definition of "mine" for the operator queue and its summary count, so a filtered list and a
-- headline number can never disagree about who owns a conversation.
create function public.handoff_queue_row_is_mine(
  target_conversation_assigned_user_id uuid,
  target_handoff_assigned_user_id uuid,
  target_handoff_is_active boolean,
  target_operator_user_id uuid
)
returns boolean language sql immutable set search_path = '' as $$
  select target_operator_user_id is not null
    and (
      (coalesce(target_handoff_is_active, false)
        and target_handoff_assigned_user_id = target_operator_user_id)
      or (
        target_conversation_assigned_user_id = target_operator_user_id
        and (
          not coalesce(target_handoff_is_active, false)
          or target_handoff_assigned_user_id is null
          or target_handoff_assigned_user_id = target_operator_user_id
        )
      )
    );
$$;

-- Creation now owns the whole invariant: one active episode, the durable tenant scope, and a
-- paused conversation.  A caller can no longer forget any part of it.
create or replace function public.persist_active_conversation_handoff(
  target_organization_id uuid,
  target_location_id uuid,
  target_conversation_id uuid,
  target_reason text,
  target_urgency text,
  target_idempotency_key text,
  target_source_message_id uuid default null,
  target_source_call_id uuid default null
)
returns table (handoff_id uuid, created boolean, escalated boolean)
language plpgsql security definer set search_path = '' as $$
declare
  existing public.handoffs%rowtype;
  conversation_row public.conversations%rowtype;
  resolved_channel_type text;
  persisted_id uuid;
  did_escalate boolean := false;
begin
  if target_urgency not in ('normal', 'urgent')
    or length(btrim(coalesce(target_reason, ''))) not between 3 and 500
    or length(btrim(coalesce(target_idempotency_key, ''))) not between 1 and 240
    or target_conversation_id is null or target_organization_id is null then
    raise exception using errcode = '22023', message = 'Handoff request is invalid';
  end if;

  perform public.lock_conversation_ownership(target_conversation_id);

  select * into conversation_row from public.conversations
  where id = target_conversation_id for update;
  -- Organization, location, and conversation must be one durable scope even when no source
  -- message or call is bound, so a future trusted caller cannot mis-scope an episode.
  if conversation_row.id is null
    or conversation_row.mode <> 'customer'
    or conversation_row.organization_id is distinct from target_organization_id
    or conversation_row.location_id is distinct from target_location_id then
    raise exception using errcode = '42501', message = 'Handoff conversation is not available';
  end if;

  select * into existing from public.handoffs
  where organization_id = target_organization_id and idempotency_key = target_idempotency_key;
  if existing.id is not null then
    if existing.status in ('open', 'acknowledged') then
      perform public.pause_conversation_automation(conversation_row.id, null, 'handoff');
    end if;
    return query select existing.id, false, false;
    return;
  end if;

  select * into existing from public.handoffs
  where conversation_id = target_conversation_id and mode = 'customer'
    and status in ('open', 'acknowledged')
  order by created_at asc, id asc
  limit 1
  for update;

  if existing.id is not null then
    -- The original reason is durable operational context for the episode.  Repeated AI calls
    -- never rewrite it and never accumulate a generated reason history.
    if target_urgency = 'urgent' and existing.urgency = 'normal' then
      update public.handoffs
      set urgency = 'urgent', last_escalated_at = now(), updated_at = now()
      where id = existing.id;
      did_escalate := true;
      insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (existing.organization_id, existing.location_id, 'handoff.escalated', 'handoff', existing.id,
        jsonb_build_object('transition', 'normal_to_urgent', 'urgency', 'urgent'));
    end if;
    perform public.pause_conversation_automation(conversation_row.id, null, 'handoff');
    return query select existing.id, false, did_escalate;
    return;
  end if;

  select channel.channel_type into resolved_channel_type from public.channels channel
  where channel.organization_id = conversation_row.organization_id and channel.id = conversation_row.channel_id;

  insert into public.handoffs (
    organization_id, location_id, conversation_id, reason, mode, urgency, idempotency_key,
    source_message_id, call_id
  ) values (
    target_organization_id, target_location_id, target_conversation_id, btrim(target_reason),
    'customer', target_urgency, target_idempotency_key, target_source_message_id, target_source_call_id
  ) returning id into persisted_id;

  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (target_organization_id, target_location_id, 'handoff.created', 'handoff', persisted_id,
    jsonb_build_object(
      'transition', 'created',
      'urgency', target_urgency,
      'channel', coalesce(resolved_channel_type, 'unknown')
    ));

  -- Requesting a person pauses automation but never assigns one: assigned_user_id stays null
  -- until a staff member claims or takes over.
  perform public.pause_conversation_automation(conversation_row.id, null, 'handoff');

  return query select persisted_id, true, false;
end;
$$;

-- Text ingress no longer pauses automation itself; the central creation path owns that invariant
-- for SMS, web chat, deterministic media handling, voice, and any future trusted caller.
create or replace function public.request_message_handoff(
  target_inbound_message_id uuid,
  target_tool_call_id text,
  target_reason text,
  target_urgency text default 'normal'
)
returns table (handoff_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; outcome record;
begin
  perform public.require_messaging_service_role();
  if target_urgency not in ('normal', 'urgent')
    or length(btrim(coalesce(target_reason, ''))) not between 3 and 500
    or length(btrim(coalesce(target_tool_call_id, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Message handoff is invalid';
  end if;
  select * into inbound from public.messages where id = target_inbound_message_id and direction = 'inbound';
  if inbound.id is null then
    raise exception using errcode = '42501', message = 'Inbound message is unavailable';
  end if;
  select * into outcome from public.persist_active_conversation_handoff(
    inbound.organization_id, inbound.location_id, inbound.conversation_id,
    target_reason, target_urgency,
    'message:' || inbound.id::text || ':' || btrim(target_tool_call_id),
    inbound.id, null
  );
  return query select outcome.handoff_id, outcome.created;
end;
$$;

-- One ownership transition, now serialized before it takes any row lock.
create or replace function public.apply_handoff_claim(target_handoff_id uuid, target_user_id uuid)
returns table (
  claim_outcome text,
  claimed_handoff_id uuid,
  claimed_conversation_id uuid,
  claimed_status text,
  claimed_urgency text,
  owner_user_id uuid,
  claimed_acknowledged_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  handoff_row public.handoffs%rowtype;
  conversation_row public.conversations%rowtype;
  locked_conversation_id uuid;
begin
  -- Identity read first, with no mutation and no row lock, purely to derive the lock key.
  select handoff.conversation_id into locked_conversation_id from public.handoffs handoff
  where handoff.id = target_handoff_id and handoff.mode = 'customer';
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);

  -- Authoritative re-read under the lock: anything that changed while waiting is seen here.
  select * into handoff_row from public.handoffs where id = target_handoff_id for update;
  if handoff_row.id is null
    or handoff_row.mode <> 'customer'
    or handoff_row.conversation_id is distinct from locked_conversation_id then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  if handoff_row.status = 'resolved' then
    return query select 'already_resolved', handoff_row.id, handoff_row.conversation_id,
      handoff_row.status, handoff_row.urgency, handoff_row.assigned_user_id, handoff_row.first_acknowledged_at;
    return;
  end if;

  select * into conversation_row from public.conversations
  where organization_id = handoff_row.organization_id and id = handoff_row.conversation_id
  for update;

  -- No last-write-wins ownership.  A concurrent claimer that arrives second, or an operator whose
  -- teammate already owns the conversation, gets a safe refresh result instead of stealing work.
  if handoff_row.assigned_user_id is not null and handoff_row.assigned_user_id <> target_user_id then
    return query select 'already_claimed', handoff_row.id, handoff_row.conversation_id,
      handoff_row.status, handoff_row.urgency, handoff_row.assigned_user_id, handoff_row.first_acknowledged_at;
    return;
  end if;
  if conversation_row.assigned_user_id is not null and conversation_row.assigned_user_id <> target_user_id then
    return query select 'already_claimed', handoff_row.id, handoff_row.conversation_id,
      handoff_row.status, handoff_row.urgency, conversation_row.assigned_user_id, handoff_row.first_acknowledged_at;
    return;
  end if;

  -- Replay by the same operator is an idempotent success: no second audit, and the original first
  -- acknowledgement time is never rewritten.
  if handoff_row.assigned_user_id = target_user_id and handoff_row.status = 'acknowledged' then
    perform public.pause_conversation_automation(conversation_row.id, target_user_id, 'staff');
    if conversation_row.assigned_user_id is distinct from target_user_id then
      update public.conversations set assigned_user_id = target_user_id, updated_at = now()
      where organization_id = handoff_row.organization_id and id = handoff_row.conversation_id;
    end if;
    return query select 'claimed', handoff_row.id, handoff_row.conversation_id,
      handoff_row.status, handoff_row.urgency, handoff_row.assigned_user_id, handoff_row.first_acknowledged_at;
    return;
  end if;

  update public.handoffs
  set assigned_user_id = target_user_id,
      assigned_at = now(),
      first_acknowledged_at = coalesce(handoff_row.first_acknowledged_at, now()),
      status = 'acknowledged',
      updated_at = now()
  where id = handoff_row.id
  returning * into handoff_row;

  perform public.pause_conversation_automation(conversation_row.id, target_user_id, 'staff');
  update public.conversations set assigned_user_id = target_user_id, updated_at = now()
  where organization_id = handoff_row.organization_id and id = handoff_row.conversation_id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (handoff_row.organization_id, handoff_row.location_id, target_user_id, 'handoff.claimed', 'handoff',
    handoff_row.id, jsonb_build_object('transition', 'open_to_acknowledged', 'urgency', handoff_row.urgency));

  return query select 'claimed', handoff_row.id, handoff_row.conversation_id,
    handoff_row.status, handoff_row.urgency, handoff_row.assigned_user_id, handoff_row.first_acknowledged_at;
end;
$$;

create or replace function public.claim_my_handoff(target_handoff_id uuid)
returns table (
  outcome text,
  handoff_id uuid,
  conversation_id uuid,
  handoff_status text,
  urgency text,
  assigned_to_me boolean,
  assigned_display_name text,
  first_acknowledged_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare claim_result record; locked_conversation_id uuid;
begin
  select handoff.conversation_id into locked_conversation_id from public.handoffs handoff
  where handoff.id = target_handoff_id and handoff.mode = 'customer';
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);
  -- Authorization is evaluated after serialization, so access removed while this call waited
  -- cannot be exercised against stale authority.
  perform public.authorize_my_handoff_operation(target_handoff_id, false);
  select * into claim_result from public.apply_handoff_claim(target_handoff_id, auth.uid());
  return query select claim_result.claim_outcome, claim_result.claimed_handoff_id,
    claim_result.claimed_conversation_id, claim_result.claimed_status, claim_result.claimed_urgency,
    coalesce(claim_result.owner_user_id = auth.uid(), false),
    public.handoff_operator_display_name(claim_result.owner_user_id),
    claim_result.claimed_acknowledged_at;
end;
$$;

create or replace function public.release_my_handoff(target_handoff_id uuid)
returns table (outcome text, handoff_id uuid, conversation_id uuid, handoff_status text)
language plpgsql security definer set search_path = '' as $$
declare handoff_row public.handoffs%rowtype; released_user_id uuid; recovered boolean; locked_conversation_id uuid;
begin
  select handoff.conversation_id into locked_conversation_id from public.handoffs handoff
  where handoff.id = target_handoff_id and handoff.mode = 'customer';
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);
  perform public.authorize_my_handoff_operation(target_handoff_id, false);

  select * into handoff_row from public.handoffs where id = target_handoff_id for update;
  if handoff_row.id is null
    or handoff_row.mode <> 'customer'
    or handoff_row.conversation_id is distinct from locked_conversation_id then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  if handoff_row.status = 'resolved' then
    return query select 'not_active', handoff_row.id, handoff_row.conversation_id, handoff_row.status;
    return;
  end if;
  -- Releasing an already-unowned episode is a safe no-op rather than an error, so a double submit
  -- from the operator UI cannot fail after the work is already back in the queue.
  if handoff_row.assigned_user_id is null then
    return query select 'released', handoff_row.id, handoff_row.conversation_id, handoff_row.status;
    return;
  end if;
  if handoff_row.assigned_user_id <> auth.uid()
    and not public.is_organization_admin(handoff_row.organization_id) then
    raise exception using errcode = '42501', message = 'Handoff is owned by another teammate';
  end if;

  released_user_id := handoff_row.assigned_user_id;
  recovered := released_user_id is distinct from auth.uid();

  update public.handoffs
  set status = 'open', assigned_user_id = null, assigned_at = null, updated_at = now()
  where id = handoff_row.id;

  -- Conversation assignment is cleared only when it still reflects the ownership being released.
  update public.conversations set assigned_user_id = null, updated_at = now()
  where organization_id = handoff_row.organization_id
    and id = handoff_row.conversation_id
    and assigned_user_id = released_user_id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (handoff_row.organization_id, handoff_row.location_id, auth.uid(), 'handoff.released', 'handoff',
    handoff_row.id, jsonb_build_object(
      'transition', 'acknowledged_to_open',
      'urgency', handoff_row.urgency,
      'scope', case when recovered then 'admin_recovery' else 'self' end
    ));

  return query select 'released', handoff_row.id, handoff_row.conversation_id, 'open'::text;
end;
$$;

create or replace function public.resolve_my_handoff(target_handoff_id uuid)
returns table (outcome text, handoff_id uuid, conversation_id uuid, handoff_status text, ai_mode text)
language plpgsql security definer set search_path = '' as $$
declare handoff_row public.handoffs%rowtype; conversation_mode text; locked_conversation_id uuid;
begin
  select handoff.conversation_id into locked_conversation_id from public.handoffs handoff
  where handoff.id = target_handoff_id and handoff.mode = 'customer';
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);
  perform public.authorize_my_handoff_operation(target_handoff_id, false);

  select * into handoff_row from public.handoffs where id = target_handoff_id for update;
  if handoff_row.id is null
    or handoff_row.mode <> 'customer'
    or handoff_row.conversation_id is distinct from locked_conversation_id then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  if handoff_row.assigned_user_id is distinct from auth.uid()
    and not public.is_organization_admin(handoff_row.organization_id) then
    raise exception using errcode = '42501', message = 'Handoff is owned by another teammate';
  end if;

  select conversation.ai_mode into conversation_mode from public.conversations conversation
  where conversation.organization_id = handoff_row.organization_id and conversation.id = handoff_row.conversation_id;

  if handoff_row.status = 'resolved' then
    return query select 'already_resolved', handoff_row.id, handoff_row.conversation_id,
      handoff_row.status, conversation_mode;
    return;
  end if;

  update public.handoffs
  set status = 'resolved', resolved_at = now(), resolved_by_user_id = auth.uid(), updated_at = now()
  where id = handoff_row.id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (handoff_row.organization_id, handoff_row.location_id, auth.uid(), 'handoff.resolved', 'handoff',
    handoff_row.id, jsonb_build_object('transition', 'resolved', 'urgency', handoff_row.urgency));

  return query select 'resolved', handoff_row.id, handoff_row.conversation_id, 'resolved'::text, conversation_mode;
end;
$$;

create or replace function public.take_over_my_conversation(target_conversation_id uuid)
returns table (outcome text, conversation_id uuid, handoff_id uuid, assigned_display_name text)
language plpgsql security definer set search_path = '' as $$
declare
  conversation_row public.conversations%rowtype;
  active_handoff_id uuid;
  claim_result record;
  locked_conversation_id uuid;
begin
  select conversation.id into locked_conversation_id from public.conversations conversation
  where conversation.id = target_conversation_id and conversation.mode = 'customer';
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);

  select * into conversation_row from public.conversations where id = target_conversation_id for update;
  if conversation_row.id is null
    or conversation_row.mode <> 'customer'
    or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;

  select handoff.id into active_handoff_id from public.handoffs handoff
  where handoff.conversation_id = conversation_row.id and handoff.mode = 'customer'
    and handoff.status in ('open', 'acknowledged')
  order by handoff.created_at asc, handoff.id asc
  limit 1;

  if active_handoff_id is not null then
    select * into claim_result from public.apply_handoff_claim(active_handoff_id, auth.uid());
    return query select
      case when claim_result.claim_outcome = 'claimed' then 'taken_over' else claim_result.claim_outcome end,
      conversation_row.id, claim_result.claimed_handoff_id,
      public.handoff_operator_display_name(claim_result.owner_user_id);
    return;
  end if;

  if conversation_row.assigned_user_id is not null and conversation_row.assigned_user_id <> auth.uid() then
    return query select 'owned_by_other', conversation_row.id, null::uuid,
      public.handoff_operator_display_name(conversation_row.assigned_user_id);
    return;
  end if;

  perform public.pause_conversation_automation(conversation_row.id, auth.uid(), 'staff');
  if conversation_row.assigned_user_id is distinct from auth.uid() then
    update public.conversations set assigned_user_id = auth.uid(), updated_at = now()
    where organization_id = conversation_row.organization_id and id = conversation_row.id;
  end if;

  return query select 'taken_over', conversation_row.id, null::uuid,
    public.handoff_operator_display_name(auth.uid());
end;
$$;

create or replace function public.resume_my_conversation_ai(target_conversation_id uuid)
returns table (outcome text, conversation_id uuid, ai_mode text, assigned_display_name text)
language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype; locked_conversation_id uuid;
begin
  select conversation.id into locked_conversation_id from public.conversations conversation
  where conversation.id = target_conversation_id and conversation.mode = 'customer';
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);

  select * into conversation_row from public.conversations where id = target_conversation_id for update;
  if conversation_row.id is null
    or conversation_row.mode <> 'customer'
    or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;

  if exists (
    select 1 from public.handoffs handoff
    where handoff.conversation_id = conversation_row.id and handoff.mode = 'customer'
      and handoff.status in ('open', 'acknowledged')
  ) then
    return query select 'resolve_handoff_first', conversation_row.id, conversation_row.ai_mode,
      public.handoff_operator_display_name(conversation_row.assigned_user_id);
    return;
  end if;

  if conversation_row.assigned_user_id is not null
    and conversation_row.assigned_user_id <> auth.uid()
    and not public.is_organization_admin(conversation_row.organization_id) then
    return query select 'owned_by_other', conversation_row.id, conversation_row.ai_mode,
      public.handoff_operator_display_name(conversation_row.assigned_user_id);
    return;
  end if;

  if conversation_row.ai_mode = 'ai' and conversation_row.assigned_user_id is null then
    return query select 'resumed', conversation_row.id, conversation_row.ai_mode, null::text;
    return;
  end if;

  update public.conversations set ai_mode = 'ai', assigned_user_id = null, updated_at = now()
  where organization_id = conversation_row.organization_id and id = conversation_row.id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (conversation_row.organization_id, conversation_row.location_id, auth.uid(),
    'conversation.ai_resumed', 'conversation', conversation_row.id,
    jsonb_build_object('transition', 'human_to_ai'));

  return query select 'resumed', conversation_row.id, 'ai'::text, null::text;
end;
$$;

create or replace function public.create_my_human_reply(target_conversation_id uuid, target_body text)
returns table (outcome text, message_id uuid, source_channel text, assigned_display_name text)
language plpgsql security definer set search_path = '' as $$
declare
  conversation_row public.conversations%rowtype;
  channel_row public.channels%rowtype;
  trusted_inbound public.messages%rowtype;
  sms_route public.phone_numbers%rowtype;
  handoff_row public.handoffs%rowtype;
  claim_result record;
  saved_message_id uuid;
  contact_opted_out boolean;
  locked_conversation_id uuid;
begin
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Reply is invalid';
  end if;
  select conversation.id into locked_conversation_id from public.conversations conversation
  where conversation.id = target_conversation_id;
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);

  select * into conversation_row from public.conversations where id = target_conversation_id for update;
  if conversation_row.id is null
    or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;
  select * into channel_row from public.channels
  where organization_id = conversation_row.organization_id and id = conversation_row.channel_id;
  if channel_row.channel_type not in ('sms', 'web') then
    raise exception using errcode = '22023', message = 'Text reply is not supported for this conversation';
  end if;

  select * into handoff_row from public.handoffs handoff
  where handoff.conversation_id = conversation_row.id and handoff.mode = 'customer'
    and handoff.status in ('open', 'acknowledged')
  order by handoff.created_at asc, handoff.id asc
  limit 1;

  if handoff_row.id is not null then
    select * into claim_result from public.apply_handoff_claim(handoff_row.id, auth.uid());
    if claim_result.claim_outcome <> 'claimed' then
      return query select 'owned_by_other', null::uuid, channel_row.channel_type,
        public.handoff_operator_display_name(claim_result.owner_user_id);
      return;
    end if;
  elsif conversation_row.assigned_user_id is not null and conversation_row.assigned_user_id <> auth.uid() then
    return query select 'owned_by_other', null::uuid, channel_row.channel_type,
      public.handoff_operator_display_name(conversation_row.assigned_user_id);
    return;
  end if;

  if channel_row.channel_type = 'sms' then
    select * into sms_route from public.phone_numbers phone
    where phone.organization_id = conversation_row.organization_id
      and phone.location_id = conversation_row.location_id
      and phone.id = conversation_row.transport_phone_number_id
      and phone.status = 'active' and phone.sms_enabled;
    if conversation_row.status <> 'open' or sms_route.id is null then
      raise exception using errcode = '42501', message = 'SMS route is unavailable';
    end if;
    select * into trusted_inbound from public.messages inbound
    where inbound.organization_id = conversation_row.organization_id
      and inbound.location_id = conversation_row.location_id
      and inbound.conversation_id = conversation_row.id
      and inbound.direction = 'inbound' and inbound.source_channel = 'sms'
      and inbound.author_type = 'customer' and inbound.transport_sender_e164 is not null
    order by inbound.created_at desc, inbound.id desc limit 1;
    if trusted_inbound.id is null then
      raise exception using errcode = '42501', message = 'SMS transport identity is unavailable';
    end if;
    select exists (
      select 1 from public.messaging_contact_preferences preference
      where preference.organization_id = conversation_row.organization_id
        and preference.location_id = conversation_row.location_id
        and preference.contact_id = conversation_row.contact_id
        and preference.channel_type = 'sms'
        and preference.sender_phone_number_id = conversation_row.transport_phone_number_id
        and preference.status = 'opted_out'
    ) into contact_opted_out;
    if contact_opted_out then
      raise exception using errcode = '42501', message = 'SMS contact has opted out';
    end if;
  end if;

  insert into public.messages (
    organization_id, location_id, conversation_id, contact_id, direction, message_type, body,
    metadata, source_channel, author_type, sent_by_user_id, in_reply_to_message_id, sent_at
  ) values (
    conversation_row.organization_id, conversation_row.location_id, conversation_row.id,
    conversation_row.contact_id, 'outbound', 'text', btrim(target_body),
    jsonb_build_object('transport', channel_row.channel_type), channel_row.channel_type, 'human',
    auth.uid(), trusted_inbound.id, now()
  ) returning id into saved_message_id;

  if channel_row.channel_type = 'sms' then
    insert into public.message_deliveries (organization_id, location_id, message_id, provider)
    values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
    values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, saved_message_id, 'outbound_delivery');
  else
    insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, sent_at)
    values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'web_chat', 'sent', now());
  end if;

  perform public.pause_conversation_automation(conversation_row.id, auth.uid(), 'human_reply');
  update public.conversations
  set assigned_user_id = auth.uid(), last_message_at = now(), updated_at = now()
  where id = conversation_row.id;

  return query select 'sent', saved_message_id, channel_row.channel_type,
    public.handoff_operator_display_name(auth.uid());
end;
$$;

-- Automation must re-check ownership immediately before it persists, and it now does so under the
-- same serialization the staff mutations use.
create or replace function public.persist_ai_message_reply(target_inbound_message_id uuid, target_body text, target_handoff_requested boolean default false)
returns table (message_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; conversation_row public.conversations%rowtype; channel_row public.channels%rowtype; saved_message_id uuid; opted_out boolean; has_turn_handoff boolean;
declare human_owned boolean;
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then raise exception using errcode = '22023', message = 'Assistant reply is invalid'; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and direction = 'inbound';
  if inbound.id is null then raise exception using errcode = '42501', message = 'Inbound message is unavailable'; end if;
  -- Serialize against every staff ownership mutation before taking the conversation row lock.
  perform public.lock_conversation_ownership(inbound.conversation_id);
  select * into conversation_row from public.conversations where organization_id = inbound.organization_id and id = inbound.conversation_id for update;
  -- Once a person owns the episode, automation stops competing.  This also closes the race where
  -- a model call completes and a staff member claims the handoff before persistence runs.
  select exists (
    select 1 from public.handoffs handoff
    where handoff.organization_id = inbound.organization_id
      and handoff.conversation_id = inbound.conversation_id
      and handoff.mode = 'customer' and handoff.status in ('open', 'acknowledged')
      and handoff.assigned_user_id is not null
  ) or conversation_row.assigned_user_id is not null into human_owned;
  if human_owned then return query select null::uuid, false; return; end if;
  select exists(select 1 from public.handoffs handoff where handoff.organization_id = inbound.organization_id
    and handoff.conversation_id = inbound.conversation_id
    and (handoff.idempotency_key like ('message:' || inbound.id::text || ':%')
      or (handoff.mode = 'customer' and handoff.status in ('open', 'acknowledged')))) into has_turn_handoff;
  if conversation_row.ai_mode <> 'ai' and not (target_handoff_requested and has_turn_handoff) then return query select null::uuid, false; return; end if;
  if target_handoff_requested and not has_turn_handoff then raise exception using errcode = '42501', message = 'Handoff acknowledgement is unavailable'; end if;
  select * into channel_row from public.channels where organization_id = conversation_row.organization_id and id = conversation_row.channel_id;
  select exists(select 1 from public.messaging_contact_preferences preference where preference.organization_id = conversation_row.organization_id
    and preference.location_id = conversation_row.location_id and preference.contact_id = conversation_row.contact_id
    and preference.channel_type = 'sms' and preference.sender_phone_number_id = conversation_row.transport_phone_number_id
    and preference.status = 'opted_out') into opted_out;
  if channel_row.channel_type = 'sms' and opted_out then return query select null::uuid, false; return; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, in_reply_to_message_id, sent_at)
  values (inbound.organization_id, inbound.location_id, inbound.conversation_id, inbound.contact_id, 'outbound', 'text', btrim(target_body),
    jsonb_build_object('transport', channel_row.channel_type), case when channel_row.channel_type = 'sms' then 'sms' else 'web' end, 'ai', inbound.id, now())
  on conflict (in_reply_to_message_id) where author_type = 'ai' and in_reply_to_message_id is not null do nothing returning id into saved_message_id;
  if saved_message_id is null then select id into saved_message_id from public.messages where in_reply_to_message_id = inbound.id and author_type = 'ai'; return query select saved_message_id, false; return; end if;
  if channel_row.channel_type = 'sms' then
    insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (inbound.organization_id, inbound.location_id, saved_message_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (inbound.organization_id, inbound.location_id, inbound.conversation_id, saved_message_id, 'outbound_delivery');
  else
    insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, sent_at) values (inbound.organization_id, inbound.location_id, saved_message_id, 'web_chat', 'sent', now());
  end if;
  if target_handoff_requested then perform public.pause_conversation_automation(conversation_row.id, null, 'handoff'); end if;
  update public.conversations set last_message_at = now(), updated_at = now() where id = conversation_row.id;
  return query select saved_message_id, true;
end;
$$;

-- The provider send boundary, hardened so human ownership always beats queued automation.
create or replace function public.claim_sms_delivery_submission(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql security definer set search_path = '' as $$
declare
  delivery public.message_deliveries%rowtype;
  message public.messages%rowtype;
  conversation public.conversations%rowtype;
  phone public.phone_numbers%rowtype;
  reminder public.appointment_reminders%rowtype;
  appointment public.appointments%rowtype;
  settings public.appointment_reminder_settings%rowtype;
  location public.locations%rowtype;
  reminder_enabled boolean;
  expected_scheduled_for timestamptz;
  nominal_scheduled_for timestamptz;
  locked_conversation_id uuid;
begin
  perform public.require_messaging_service_role();

  -- The send boundary reads ownership, so it queues behind ownership mutations on the same
  -- conversation before it takes the delivery row lock. No lock cycle is possible.
  select message.conversation_id into locked_conversation_id
  from public.messages message where message.id = target_message_id;
  if locked_conversation_id is not null then
    perform public.lock_conversation_ownership(locked_conversation_id);
  end if;

  select * into delivery
  from public.message_deliveries as message_delivery
  where message_delivery.message_id = target_message_id and message_delivery.provider = 'twilio'
  for update;
  if delivery.id is null or delivery.status <> 'queued' then return; end if;

  select * into message from public.messages where id = delivery.message_id;

  if message.appointment_reminder_id is not null then
    select * into reminder
    from public.appointment_reminders reminder_row
    where reminder_row.organization_id = message.organization_id
      and reminder_row.location_id = message.location_id
      and reminder_row.id = message.appointment_reminder_id
      and reminder_row.message_id = message.id
      and reminder_row.status = 'delivery_pending'
    for share;

    select * into appointment
    from public.appointments appointment_row
    where appointment_row.organization_id = message.organization_id
      and appointment_row.location_id = message.location_id
      and appointment_row.id = reminder.appointment_id
    for share;

    select * into settings
    from public.appointment_reminder_settings settings_row
    where settings_row.organization_id = message.organization_id
      and settings_row.location_id = message.location_id
    for share;

    select * into location
    from public.locations location_row
    where location_row.organization_id = message.organization_id and location_row.id = message.location_id
    for share;

    reminder_enabled := case reminder.reminder_type
      when 'appointment_24h' then settings.reminder_24h_enabled
      when 'appointment_2h' then settings.reminder_2h_enabled
      else false
    end;
    nominal_scheduled_for := appointment.starts_at - case reminder.reminder_type
      when 'appointment_24h' then interval '24 hours'
      when 'appointment_2h' then interval '2 hours'
      else null
    end;
    expected_scheduled_for := public.reminder_local_time(
      nominal_scheduled_for,
      location.timezone,
      settings.quiet_hours_start,
      settings.quiet_hours_end
    );

    if reminder.id is null
      or appointment.id is null
      or appointment.status <> 'confirmed'
      or appointment.starts_at <= now()
      or settings.id is null
      or not settings.sms_enabled
      or not reminder_enabled
      or reminder.schedule_version is distinct from settings.schedule_version
      or expected_scheduled_for is null
      or not public.is_appointment_reminder_send_time(reminder.reminder_type, expected_scheduled_for, appointment.starts_at)
      or expected_scheduled_for is distinct from reminder.scheduled_for
    then
      update public.message_deliveries
      set status = 'suppressed', error_code = 'appointment_reminder_ineligible', updated_at = now()
      where id = delivery.id;
      return;
    end if;
  end if;

  select * into conversation
  from public.conversations
  where organization_id = message.organization_id and id = message.conversation_id;

  -- An automated reply that has not yet crossed the provider boundary loses once a PERSON owns
  -- the conversation: a manual takeover with no handoff, and a resolved handoff whose conversation
  -- is still human-owned, both count.  Ownership is deliberately not inferred from ai_mode alone,
  -- so the intended handoff acknowledgement produced during the request-human turn still sends
  -- while the episode is unclaimed.  Anything already submitted keeps its provider truth untouched.
  if message.author_type = 'ai' and (
    conversation.assigned_user_id is not null
    or exists (
      select 1 from public.handoffs handoff
      where handoff.organization_id = message.organization_id
        and handoff.conversation_id = message.conversation_id
        and handoff.mode = 'customer' and handoff.status in ('open', 'acknowledged')
        and handoff.assigned_user_id is not null
    )
  ) then
    update public.message_deliveries
    set status = 'suppressed', error_code = 'human_ownership_suppressed', updated_at = now()
    where id = delivery.id;
    return;
  end if;
  select * into phone
  from public.phone_numbers
  where organization_id = message.organization_id and id = conversation.transport_phone_number_id;

  if conversation.id is null or phone.id is null or phone.status <> 'active' or not phone.sms_enabled
    or exists (
      select 1 from public.messaging_contact_preferences preference
      where preference.organization_id = message.organization_id
        and preference.location_id = conversation.location_id
        and preference.contact_id = conversation.contact_id
        and preference.channel_type = 'sms'
        and preference.sender_phone_number_id = phone.id
        and preference.status = 'opted_out'
    )
  then
    update public.message_deliveries
    set status = 'suppressed', error_code = 'delivery_suppressed', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  if message.body is null then
    update public.message_deliveries
    set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  if message.appointment_reminder_id is not null then
    select reminder_row.trusted_sms_recipient_e164 into to_e164
    from public.appointment_reminders reminder_row
    where reminder_row.organization_id = message.organization_id
      and reminder_row.location_id = message.location_id
      and reminder_row.id = message.appointment_reminder_id
      and reminder_row.message_id = message.id
      and reminder_row.status = 'delivery_pending';
  else
    select inbound.transport_sender_e164 into to_e164
    from public.messages inbound
    where inbound.organization_id = message.organization_id
      and inbound.conversation_id = message.conversation_id
      and inbound.id = message.in_reply_to_message_id
      and inbound.direction = 'inbound'
      and inbound.source_channel = 'sms'
      and inbound.author_type = 'customer';
  end if;

  if to_e164 is null then
    update public.message_deliveries
    set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  update public.message_deliveries
  set status = 'submitting', attempted_at = now(), updated_at = now()
  where id = delivery.id;

  return query
  select message.id, delivery.id, to_e164, phone.phone_number, message.body, 'submitting'::text;
end;
$$;

-- The operator queue and its summary now share one ownership predicate, so "Mine" and
-- "Assigned to you" can never disagree about the same conversation.
create or replace function public.get_my_handoff_queue_summary(target_location_id uuid default null)
returns table (needs_attention integer, urgent integer, assigned_to_me integer)
language sql stable security definer set search_path = '' as $$
  with scoped as (
    select
      conversation.organization_id,
      conversation.id as conversation_id,
      conversation.ai_mode,
      conversation.assigned_user_id as conversation_assigned_user_id,
      active_handoff.id as handoff_id,
      active_handoff.urgency,
      active_handoff.assigned_user_id as handoff_assigned_user_id
    from public.conversations conversation
    left join lateral (
      select handoff.id, handoff.urgency, handoff.assigned_user_id
      from public.handoffs handoff
      where handoff.conversation_id = conversation.id and handoff.mode = 'customer'
        and handoff.status in ('open', 'acknowledged')
      order by handoff.created_at asc, handoff.id asc
      limit 1
    ) active_handoff on true
    where conversation.mode = 'customer'
      and public.has_location_access(conversation.organization_id, conversation.location_id)
      and (target_location_id is null or conversation.location_id = target_location_id)
  )
  select
    count(*) filter (
      where scoped.handoff_id is not null
        or (
          scoped.ai_mode = 'human'
          and public.conversation_customer_waiting_since(scoped.organization_id, scoped.conversation_id) is not null
        )
    )::integer,
    count(*) filter (where scoped.handoff_id is not null and scoped.urgency = 'urgent')::integer,
    count(*) filter (
      where public.handoff_queue_row_is_mine(
        scoped.conversation_assigned_user_id,
        scoped.handoff_assigned_user_id,
        scoped.handoff_id is not null,
        auth.uid()
      )
    )::integer
  from scoped;
$$;

-- Helpers stay internal: they are the shared implementation of the ownership protocol, not a
-- callable boundary for any client or backend role.
revoke all on function
  public.lock_conversation_ownership(uuid),
  public.pause_conversation_automation(uuid, uuid, text),
  public.handoff_queue_row_is_mine(uuid, uuid, boolean, uuid)
  from public, anon, authenticated, service_role;

-- The queue list uses the same ownership predicate as the summary count.
create or replace function public.get_my_handoff_queue(
  target_location_id uuid default null,
  target_filter text default 'all_active',
  target_limit integer default 60
)
returns table (
  conversation_id uuid,
  location_id uuid,
  channel_type text,
  contact_name text,
  contact_phone text,
  ai_mode text,
  conversation_assigned_to_me boolean,
  conversation_is_assigned boolean,
  conversation_assigned_name text,
  handoff_id uuid,
  handoff_is_active boolean,
  handoff_status text,
  handoff_urgency text,
  handoff_reason text,
  handoff_assigned_to_me boolean,
  handoff_is_assigned boolean,
  handoff_assigned_name text,
  handoff_source text,
  handoff_call_status text,
  handoff_created_at timestamptz,
  handoff_first_acknowledged_at timestamptz,
  handoff_resolved_at timestamptz,
  customer_waiting boolean,
  waiting_since timestamptz,
  latest_body text,
  latest_at timestamptz,
  lead_status text,
  lead_urgency text,
  queue_priority integer
)
language sql stable security definer set search_path = '' as $$
with enriched as (
  select
    conversation.id as conversation_id,
    conversation.location_id,
    channel.channel_type,
    nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), '') as contact_name,
    contact.phone as contact_phone,
    conversation.ai_mode,
    conversation.assigned_user_id as conversation_assigned_user_id,
    queue_handoff.id as handoff_id,
    coalesce(queue_handoff.status in ('open', 'acknowledged'), false) as handoff_is_active,
    queue_handoff.status as handoff_status,
    queue_handoff.urgency as handoff_urgency,
    queue_handoff.reason as handoff_reason,
    queue_handoff.assigned_user_id as handoff_assigned_user_id,
    case when queue_handoff.id is null then null::text
      when queue_handoff.call_id is not null then 'voice' else 'message' end as handoff_source,
    source_call.status as handoff_call_status,
    queue_handoff.created_at as handoff_created_at,
    queue_handoff.first_acknowledged_at as handoff_first_acknowledged_at,
    queue_handoff.resolved_at as handoff_resolved_at,
    public.conversation_customer_waiting_since(conversation.organization_id, conversation.id) as waiting_since,
    latest.body as latest_body,
    coalesce(latest.created_at, conversation.last_message_at, conversation.created_at) as latest_at,
    lead_row.status as lead_status,
    lead_row.urgency as lead_urgency
  from public.conversations conversation
  join public.channels channel
    on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  left join public.contacts contact
    on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  left join lateral (
    -- The active episode when one exists, otherwise the most recently resolved episode so the
    -- conversation can still show its history without ever presenting resolved work as active.
    select handoff.*
    from public.handoffs handoff
    where handoff.conversation_id = conversation.id and handoff.mode = 'customer'
    order by
      case when handoff.status in ('open', 'acknowledged') then 0 else 1 end asc,
      case when handoff.status in ('open', 'acknowledged') then handoff.created_at end asc,
      handoff.resolved_at desc nulls last,
      handoff.created_at desc
    limit 1
  ) queue_handoff on true
  left join public.calls source_call
    on source_call.organization_id = conversation.organization_id and source_call.id = queue_handoff.call_id
  left join lateral (
    select message.body, message.created_at
    from public.messages message
    where message.organization_id = conversation.organization_id and message.conversation_id = conversation.id
    order by message.created_at desc, message.id desc
    limit 1
  ) latest on true
  left join lateral (
    select candidate.status, candidate.urgency
    from public.leads candidate
    where candidate.organization_id = conversation.organization_id
      and candidate.conversation_id = conversation.id
      and candidate.status in ('new', 'qualified', 'converted')
    order by
      case candidate.status when 'new' then 3 when 'qualified' then 2 else 1 end desc,
      coalesce(candidate.converted_at, candidate.qualified_at, candidate.created_at) desc,
      candidate.id desc
    limit 1
  ) lead_row on true
  where conversation.mode = 'customer'
    and public.has_location_access(conversation.organization_id, conversation.location_id)
    and (target_location_id is null or conversation.location_id = target_location_id)
),
ranked as (
  select
    enriched.*,
    (enriched.waiting_since is not null
      and (enriched.handoff_is_active or enriched.ai_mode = 'human')) as customer_waiting
  from enriched
),
prioritized as (
  select
    ranked.*,
    case
      when ranked.handoff_is_active and ranked.handoff_urgency = 'urgent' and ranked.customer_waiting then 1
      when ranked.handoff_is_active and ranked.handoff_urgency = 'urgent' then 2
      when ranked.handoff_is_active and ranked.customer_waiting then 3
      when ranked.handoff_is_active then 4
      when ranked.ai_mode = 'human' and ranked.customer_waiting then 5
      else 6
    end as queue_priority,
    case
      when ranked.handoff_is_active then coalesce(ranked.waiting_since, ranked.handoff_created_at)
      when ranked.ai_mode = 'human' and ranked.customer_waiting then ranked.waiting_since
    end as attention_at
  from ranked
)
select
  prioritized.conversation_id,
  prioritized.location_id,
  prioritized.channel_type,
  prioritized.contact_name,
  prioritized.contact_phone,
  prioritized.ai_mode,
  coalesce(prioritized.conversation_assigned_user_id = auth.uid(), false),
  prioritized.conversation_assigned_user_id is not null,
  public.handoff_operator_display_name(prioritized.conversation_assigned_user_id),
  prioritized.handoff_id,
  prioritized.handoff_is_active,
  prioritized.handoff_status,
  prioritized.handoff_urgency,
  prioritized.handoff_reason,
  coalesce(prioritized.handoff_assigned_user_id = auth.uid(), false),
  prioritized.handoff_assigned_user_id is not null,
  public.handoff_operator_display_name(prioritized.handoff_assigned_user_id),
  prioritized.handoff_source,
  prioritized.handoff_call_status,
  prioritized.handoff_created_at,
  prioritized.handoff_first_acknowledged_at,
  prioritized.handoff_resolved_at,
  prioritized.customer_waiting,
  prioritized.waiting_since,
  prioritized.latest_body,
  prioritized.latest_at,
  prioritized.lead_status,
  prioritized.lead_urgency,
  prioritized.queue_priority
from prioritized
where case coalesce(target_filter, 'all_active')
    when 'urgent' then prioritized.handoff_is_active and prioritized.handoff_urgency = 'urgent'
    when 'needs_attention' then prioritized.handoff_is_active
      or (prioritized.ai_mode = 'human' and prioritized.customer_waiting)
    when 'mine' then public.handoff_queue_row_is_mine(
        prioritized.conversation_assigned_user_id,
        prioritized.handoff_assigned_user_id,
        prioritized.handoff_is_active,
        auth.uid()
      )
    when 'resolved' then prioritized.handoff_id is not null and not prioritized.handoff_is_active
    else true
  end
order by
  case when coalesce(target_filter, 'all_active') = 'resolved' then 1 else prioritized.queue_priority end asc,
  case when coalesce(target_filter, 'all_active') = 'resolved' then null::timestamptz else prioritized.attention_at end asc nulls last,
  case when coalesce(target_filter, 'all_active') = 'resolved' then prioritized.handoff_resolved_at end desc nulls last,
  prioritized.latest_at desc,
  prioritized.conversation_id asc
limit least(greatest(coalesce(target_limit, 60), 1), 200);
$$;

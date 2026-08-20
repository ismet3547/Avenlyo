-- Phase 13 follow-up: bound "customer waiting" to the current human episode, and make a staff
-- ownership acquisition auditable even when no handoff covers it.
--
-- Waiting used to be derived from every customer turn since the latest human reply, which meant a
-- conversation that had never received a human reply was scanned back to the beginning of time.  A
-- three-week-old question that automation already answered would surface today as the moment the
-- customer started waiting.  Waiting is a property of a human-attention episode, so the episode now
-- has a durable anchor and the derivation starts there.

alter table public.conversations
  add column human_attention_started_at timestamptz;

-- An automation-owned conversation has no open human episode.
alter table public.conversations
  add constraint conversations_human_attention_state_check check (
    ai_mode = 'human' or human_attention_started_at is null
  );

create index conversations_human_attention_idx
  on public.conversations (organization_id, human_attention_started_at)
  where human_attention_started_at is not null;

-- Legacy normalization.  An episode that is already open gets the turn that caused it: the trusted
-- source message of its active handoff, then that handoff's own escalation time.  Conversations
-- that are human-owned for another reason fall back to their most recent escalation, then to the
-- latest customer turn that exists, and finally to their own last update.  The oldest message in
-- the transcript is deliberately never used.  No message is synthesised and no provider call state
-- is touched.
update public.conversations conversation
set human_attention_started_at = coalesce(
  (
    select coalesce(source_message.created_at, handoff.created_at)
    from public.handoffs handoff
    left join public.messages source_message
      on source_message.organization_id = handoff.organization_id
      and source_message.id = handoff.source_message_id
    where handoff.organization_id = conversation.organization_id
      and handoff.conversation_id = conversation.id
      and handoff.mode = 'customer'
    order by
      case when handoff.status in ('open', 'acknowledged') then 0 else 1 end asc,
      handoff.created_at desc
    limit 1
  ),
  (
    select max(inbound.created_at)
    from public.messages inbound
    where inbound.organization_id = conversation.organization_id
      and inbound.conversation_id = conversation.id
      and inbound.direction = 'inbound'
      and inbound.author_type = 'customer'
  ),
  conversation.updated_at
)
where conversation.ai_mode = 'human'
  and conversation.human_attention_started_at is null;

-- The episode anchor is ownership state, so a browser session cannot write it directly either.
create or replace function public.enforce_conversation_ownership_authority()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and (
    new.ai_mode is distinct from old.ai_mode
    or new.assigned_user_id is distinct from old.assigned_user_id
    or new.human_attention_started_at is distinct from old.human_attention_started_at
  ) then
    raise exception using errcode = '42501', message = 'Conversation ownership is not directly writable';
  end if;
  return new;
end;
$$;

drop trigger conversations_enforce_ownership_authority on public.conversations;
create trigger conversations_enforce_ownership_authority
before update of ai_mode, assigned_user_id, human_attention_started_at on public.conversations
for each row execute function public.enforce_conversation_ownership_authority();

-- The turn a manual takeover should treat as the start of waiting: the latest customer turn that
-- already exists, never the oldest one in the transcript.
create function public.latest_customer_turn_at(
  target_organization_id uuid,
  target_conversation_id uuid
)
returns timestamptz language sql stable set search_path = '' as $$
  select max(inbound.created_at)
  from public.messages inbound
  where inbound.organization_id = target_organization_id
    and inbound.conversation_id = target_conversation_id
    and inbound.direction = 'inbound'
    and inbound.author_type = 'customer';
$$;

-- Pausing automation opens the episode and stamps its anchor.  An episode that is already open is
-- never re-anchored, so claim, release, resolve, and human reply all stay inside the same episode.
drop function public.pause_conversation_automation(uuid, uuid, text);
create function public.pause_conversation_automation(
  target_conversation_id uuid,
  target_actor_user_id uuid,
  target_trigger text,
  target_attention_anchor timestamptz
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

  update public.conversations
  set ai_mode = 'human',
      human_attention_started_at = coalesce(target_attention_anchor, now()),
      updated_at = now()
  where organization_id = conversation_row.organization_id and id = conversation_row.id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (conversation_row.organization_id, conversation_row.location_id, target_actor_user_id,
    'conversation.human_takeover', 'conversation', conversation_row.id,
    jsonb_build_object('transition', 'ai_to_human', 'trigger', target_trigger));
  return true;
end;
$$;

-- Staff ownership acquisition that no handoff covers.  Pausing automation and taking the
-- conversation are one operation and one audit, and a replay by the same owner writes nothing.
create function public.acquire_conversation_ownership(
  target_conversation_id uuid,
  target_user_id uuid,
  target_trigger text,
  target_attention_anchor timestamptz
)
returns text language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype; paused boolean; assigning boolean; transition text;
begin
  if target_trigger not in ('staff', 'human_reply') then
    raise exception using errcode = '22023', message = 'Conversation ownership trigger is invalid';
  end if;
  select * into conversation_row from public.conversations
  where id = target_conversation_id for update;
  if conversation_row.id is null then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;

  paused := conversation_row.ai_mode <> 'human';
  assigning := conversation_row.assigned_user_id is distinct from target_user_id;
  if not paused and not assigning then
    return null;
  end if;

  update public.conversations
  set ai_mode = 'human',
      assigned_user_id = target_user_id,
      human_attention_started_at = case
        when paused then coalesce(target_attention_anchor, now())
        else conversation_row.human_attention_started_at
      end,
      updated_at = now()
  where organization_id = conversation_row.organization_id and id = conversation_row.id;

  transition := case when paused then 'ai_to_human_owned' else 'unassigned_to_human_owner' end;
  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (conversation_row.organization_id, conversation_row.location_id, target_user_id,
    'conversation.human_takeover', 'conversation', conversation_row.id,
    jsonb_build_object('transition', transition, 'trigger', target_trigger));
  return transition;
end;
$$;

-- Waiting belongs to the current episode.  Its floor is the episode anchor, raised by the latest
-- human reply inside that episode; the anchor itself is inclusive so the very turn that triggered
-- the escalation counts as waiting.  Automated and system messages never clear a waiting customer.
create or replace function public.conversation_customer_waiting_since(
  target_organization_id uuid,
  target_conversation_id uuid
)
returns timestamptz language sql stable set search_path = '' as $$
  with boundary as (
    select
      conversation.human_attention_started_at as anchor,
      (
        select max(human_reply.created_at)
        from public.messages human_reply
        where human_reply.organization_id = target_organization_id
          and human_reply.conversation_id = target_conversation_id
          and human_reply.direction = 'outbound'
          and human_reply.author_type = 'human'
          and human_reply.created_at >= conversation.human_attention_started_at
      ) as replied_at
    from public.conversations conversation
    where conversation.organization_id = target_organization_id
      and conversation.id = target_conversation_id
      and conversation.human_attention_started_at is not null
  )
  select min(inbound.created_at)
  from boundary
  join public.messages inbound
    on inbound.organization_id = target_organization_id
    and inbound.conversation_id = target_conversation_id
    and inbound.direction = 'inbound'
    and inbound.author_type = 'customer'
    and case
      when boundary.replied_at is null then inbound.created_at >= boundary.anchor
      else inbound.created_at > boundary.replied_at
    end;
$$;

-- Resuming automation closes the episode: a later escalation opens a new one with its own anchor,
-- so turns from the finished episode can never become waiting work again.
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

  update public.conversations
  set ai_mode = 'ai', assigned_user_id = null, human_attention_started_at = null, updated_at = now()
  where organization_id = conversation_row.organization_id and id = conversation_row.id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (conversation_row.organization_id, conversation_row.location_id, auth.uid(),
    'conversation.ai_resumed', 'conversation', conversation_row.id,
    jsonb_build_object('transition', 'human_to_ai'));

  return query select 'resumed', conversation_row.id, 'ai'::text, null::text;
end;
$$;

-- Every caller of the pause helper now supplies the episode anchor explicitly.
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
  attention_anchor timestamptz;
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

  -- The episode starts at the customer turn that triggered it. Voice has no text source, so it
  -- anchors on the escalation itself rather than on unrelated conversation history.
  attention_anchor := coalesce(
    (
      select source_message.created_at from public.messages source_message
      where source_message.organization_id = target_organization_id
        and source_message.id = target_source_message_id
    ),
    now()
  );

  select * into existing from public.handoffs
  where organization_id = target_organization_id and idempotency_key = target_idempotency_key;
  if existing.id is not null then
    if existing.status in ('open', 'acknowledged') then
      perform public.pause_conversation_automation(conversation_row.id, null, 'handoff', attention_anchor);
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
    perform public.pause_conversation_automation(conversation_row.id, null, 'handoff', attention_anchor);
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
  perform public.pause_conversation_automation(conversation_row.id, null, 'handoff', attention_anchor);

  return query select persisted_id, true, false;
end;
$$;

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
  attention_anchor timestamptz;
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

  -- Only used if this claim is somehow the first thing to pause automation; an episode that is
  -- already open is never re-anchored.
  attention_anchor := coalesce(
    (
      select source_message.created_at from public.messages source_message
      where source_message.organization_id = handoff_row.organization_id
        and source_message.id = handoff_row.source_message_id
    ),
    handoff_row.created_at
  );

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
    perform public.pause_conversation_automation(conversation_row.id, null, 'handoff', attention_anchor);
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

  perform public.pause_conversation_automation(conversation_row.id, null, 'handoff', attention_anchor);
  update public.conversations set assigned_user_id = target_user_id, updated_at = now()
  where organization_id = handoff_row.organization_id and id = handoff_row.conversation_id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (handoff_row.organization_id, handoff_row.location_id, target_user_id, 'handoff.claimed', 'handoff',
    handoff_row.id, jsonb_build_object('transition', 'open_to_acknowledged', 'urgency', handoff_row.urgency));

  return query select 'claimed', handoff_row.id, handoff_row.conversation_id,
    handoff_row.status, handoff_row.urgency, handoff_row.assigned_user_id, handoff_row.first_acknowledged_at;
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

  -- Taking over an old automation-owned conversation anchors on the latest customer turn that
  -- already exists, never on turns automation already answered.
  perform public.acquire_conversation_ownership(
    conversation_row.id,
    auth.uid(),
    'staff',
    public.latest_customer_turn_at(conversation_row.organization_id, conversation_row.id)
  );

  return query select 'taken_over', conversation_row.id, null::uuid,
    public.handoff_operator_display_name(auth.uid());
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

  -- When an active handoff was just claimed this is a no-op, so claiming is never audited twice.
  perform public.acquire_conversation_ownership(
    conversation_row.id,
    auth.uid(),
    'human_reply',
    public.latest_customer_turn_at(conversation_row.organization_id, conversation_row.id)
  );
  update public.conversations set last_message_at = now(), updated_at = now()
  where id = conversation_row.id;

  return query select 'sent', saved_message_id, channel_row.channel_type,
    public.handoff_operator_display_name(auth.uid());
end;
$$;

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
  if target_handoff_requested then perform public.pause_conversation_automation(conversation_row.id, null, 'handoff', inbound.created_at); end if;
  update public.conversations set last_message_at = now(), updated_at = now() where id = conversation_row.id;
  return query select saved_message_id, true;
end;
$$;

-- The episode helpers are shared implementation, not a callable boundary for any role.
revoke all on function
  public.latest_customer_turn_at(uuid, uuid),
  public.pause_conversation_automation(uuid, uuid, text, timestamptz),
  public.acquire_conversation_ownership(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

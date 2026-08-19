-- Phase 13: human handoff operations and the operator inbox.
--
-- Phase 0-12 already persist durable handoffs.  Phase 13 makes them operational: at most one
-- active handoff per customer conversation, atomic staff ownership, and an explicit separation
-- between resolving the human episode and resuming AI.  Handoff mutation moves entirely behind
-- narrow SECURITY DEFINER RPCs; authenticated clients keep read access only.
--
-- The existing public.handoffs table is reused.  Voice source identity keeps its Phase 4
-- handoffs.call_id column rather than gaining a second competing "source call" column; text
-- source identity is the new handoffs.source_message_id.

alter table public.handoffs
  add column source_message_id uuid,
  add column assigned_at timestamptz,
  add column first_acknowledged_at timestamptz,
  add column resolved_at timestamptz,
  add column resolved_by_user_id uuid,
  add column last_escalated_at timestamptz;

-- Source binding must resolve inside the same tenant, location, and conversation.  The parent
-- keys below make that a database constraint rather than an application convention.
alter table public.messages
  add constraint messages_organization_location_conversation_id_key
  unique (organization_id, location_id, conversation_id, id);
alter table public.calls
  add constraint calls_organization_location_conversation_id_key
  unique (organization_id, location_id, conversation_id, id);

alter table public.handoffs
  add constraint handoffs_source_message_fk
    foreign key (organization_id, location_id, conversation_id, source_message_id)
    references public.messages (organization_id, location_id, conversation_id, id),
  add constraint handoffs_source_call_fk
    foreign key (organization_id, location_id, conversation_id, call_id)
    references public.calls (organization_id, location_id, conversation_id, id),
  add constraint handoffs_resolved_by_member_fk
    foreign key (organization_id, resolved_by_user_id)
    references public.organization_members (organization_id, user_id);

create index handoffs_location_active_idx
  on public.handoffs (location_id, urgency, created_at)
  where mode = 'customer' and status in ('open', 'acknowledged');
create index handoffs_assigned_user_idx
  on public.handoffs (assigned_user_id, status)
  where assigned_user_id is not null;
create index handoffs_conversation_history_idx
  on public.handoffs (conversation_id, created_at desc);

-- Legacy normalization, step 1: give already-terminal or already-acknowledged rows the Phase 13
-- timestamps their state implies.  Nothing is deleted and no attribution is invented.
update public.handoffs set resolved_at = updated_at where status = 'resolved' and resolved_at is null;
update public.handoffs set assigned_at = updated_at where assigned_user_id is not null and assigned_at is null;
update public.handoffs set first_acknowledged_at = updated_at
  where status = 'acknowledged' and first_acknowledged_at is null;
-- An acknowledged handoff with no owner is not operable by anyone.  It returns to the open queue
-- while keeping its first acknowledgement, which is exactly how Phase 13 release behaves.
update public.handoffs set status = 'open' where status = 'acknowledged' and assigned_user_id is null;

-- Legacy normalization, step 2: Phase 0-12 created one handoff per triggering turn or tool call,
-- so a customer conversation could hold several unresolved rows.  The oldest active handoff is the
-- canonical episode.  Any urgent signal among its siblings is carried onto it first so that
-- de-duplication can never silently downgrade urgent work.
update public.handoffs canonical
set urgency = 'urgent', last_escalated_at = now(), updated_at = now()
where canonical.urgency = 'normal'
  and canonical.mode = 'customer'
  and canonical.status in ('open', 'acknowledged')
  and exists (
    select 1 from public.handoffs urgent_sibling
    where urgent_sibling.conversation_id = canonical.conversation_id
      and urgent_sibling.mode = 'customer'
      and urgent_sibling.status in ('open', 'acknowledged')
      and urgent_sibling.urgency = 'urgent'
  )
  and canonical.id = (
    select oldest.id from public.handoffs oldest
    where oldest.conversation_id = canonical.conversation_id
      and oldest.mode = 'customer'
      and oldest.status in ('open', 'acknowledged')
    order by oldest.created_at asc, oldest.id asc
    limit 1
  );

-- Legacy normalization, step 3: resolve the superseded duplicates with a safe audit reason.  The
-- rows and their timestamps survive as history; only their operational state changes.
with superseded as (
  update public.handoffs duplicate
  set status = 'resolved', resolved_at = now(), updated_at = now()
  where duplicate.mode = 'customer'
    and duplicate.status in ('open', 'acknowledged')
    and duplicate.id <> (
      select oldest.id from public.handoffs oldest
      where oldest.conversation_id = duplicate.conversation_id
        and oldest.mode = 'customer'
        and oldest.status in ('open', 'acknowledged')
      order by oldest.created_at asc, oldest.id asc
      limit 1
    )
  returning duplicate.id, duplicate.organization_id, duplicate.location_id
)
insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
select superseded.organization_id, superseded.location_id, 'handoff.resolved', 'handoff', superseded.id,
  jsonb_build_object('transition', 'superseded_by_migration')
from superseded;

alter table public.handoffs
  add constraint handoffs_assignment_state_check check (
    (assigned_user_id is null and assigned_at is null)
    or (assigned_user_id is not null and assigned_at is not null)
  ),
  add constraint handoffs_acknowledged_state_check check (
    status <> 'acknowledged'
    or (assigned_user_id is not null and first_acknowledged_at is not null)
  ),
  add constraint handoffs_resolution_state_check check (
    (status = 'resolved' and resolved_at is not null)
    or (status <> 'resolved' and resolved_at is null and resolved_by_user_id is null)
  );

-- One active handoff per customer conversation, enforced by the database rather than by callers.
-- Test-mode agent handoffs stay outside the production operator queue and outside this rule.
create unique index handoffs_one_active_customer_conversation_key
  on public.handoffs (conversation_id)
  where mode = 'customer' and status in ('open', 'acknowledged');

-- Urgency is monotonic.  Trusted backend policy may escalate normal -> urgent; nothing may
-- downgrade urgent work, and the operator UI has no path that tries.
create function public.enforce_handoff_urgency_monotonicity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.urgency = 'urgent' and new.urgency = 'normal' then
    raise exception using errcode = '22023', message = 'Handoff urgency cannot be downgraded';
  end if;
  return new;
end;
$$;

create trigger handoffs_enforce_urgency_monotonicity
before update of urgency on public.handoffs
for each row execute function public.enforce_handoff_urgency_monotonicity();

-- Tenant, location, and conversation scope for the two source bindings.  The composite foreign
-- keys above cover rows with a location; this trigger closes the MATCH SIMPLE gap that a null
-- location would otherwise open, and also keeps the bindings immutable after creation.
create function public.enforce_handoff_source_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.location_id is distinct from old.location_id
    or new.conversation_id is distinct from old.conversation_id
    or new.source_message_id is distinct from old.source_message_id
    or new.call_id is distinct from old.call_id
  ) then
    raise exception using errcode = '22023', message = 'Handoff source identity is immutable';
  end if;
  if new.source_message_id is not null and not exists (
    select 1 from public.messages source_message
    where source_message.id = new.source_message_id
      and source_message.organization_id = new.organization_id
      and source_message.conversation_id = new.conversation_id
      and source_message.location_id is not distinct from new.location_id
  ) then
    raise exception using errcode = '23503', message = 'Handoff source message is out of scope';
  end if;
  if new.call_id is not null and not exists (
    select 1 from public.calls source_call
    where source_call.id = new.call_id
      and source_call.organization_id = new.organization_id
      and source_call.conversation_id = new.conversation_id
      and source_call.location_id is not distinct from new.location_id
  ) then
    raise exception using errcode = '23503', message = 'Handoff source call is out of scope';
  end if;
  return new;
end;
$$;

create trigger handoffs_enforce_source_scope
before insert or update of organization_id, location_id, conversation_id, source_message_id, call_id
on public.handoffs
for each row execute function public.enforce_handoff_source_scope();

-- Conversation ownership and automation mode are operational authority, not client state.  A
-- browser session may still read conversations, but only a security-definer RPC (whose owner is
-- not the "authenticated" role) can move ai_mode or assigned_user_id.
create function public.enforce_conversation_ownership_authority()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and (
    new.ai_mode is distinct from old.ai_mode
    or new.assigned_user_id is distinct from old.assigned_user_id
  ) then
    raise exception using errcode = '42501', message = 'Conversation ownership is not directly writable';
  end if;
  return new;
end;
$$;

create trigger conversations_enforce_ownership_authority
before update of ai_mode, assigned_user_id on public.conversations
for each row execute function public.enforce_conversation_ownership_authority();

-- Handoff state is RPC-only.  Reads stay location-scoped through the Phase 0 select policy so the
-- operator queue and history remain directly queryable, but no role keeps a broad write grant:
-- every durable transition goes through a narrow security-definer function owned by postgres.
drop policy handoffs_insert_member on public.handoffs;
drop policy handoffs_update_member on public.handoffs;
drop policy handoffs_delete_admin on public.handoffs;
revoke insert, update, delete on public.handoffs from anon, authenticated, service_role;

-- Staff identity shown to other staff is a display name only.  Emails, auth metadata, and user
-- identifiers never leave these read models.
create function public.handoff_operator_display_name(target_user_id uuid)
returns text language sql stable set search_path = '' as $$
  select coalesce(nullif(btrim(account.display_name), ''), 'Teammate')
  from public.users account
  where account.id = target_user_id;
$$;

-- Waiting state is derived from durable messages; Phase 13 adds no read/unread bookkeeping.
-- The result is the oldest customer turn that no human reply has answered yet, or null when the
-- customer is not waiting.  AI messages deliberately do not count as human handling.
create function public.conversation_customer_waiting_since(
  target_organization_id uuid,
  target_conversation_id uuid
)
returns timestamptz language sql stable set search_path = '' as $$
  select min(inbound.created_at)
  from public.messages inbound
  where inbound.organization_id = target_organization_id
    and inbound.conversation_id = target_conversation_id
    and inbound.direction = 'inbound'
    and inbound.author_type = 'customer'
    and inbound.created_at > coalesce(
      (
        select max(human_reply.created_at)
        from public.messages human_reply
        where human_reply.organization_id = target_organization_id
          and human_reply.conversation_id = target_conversation_id
          and human_reply.direction = 'outbound'
          and human_reply.author_type = 'human'
      ),
      '-infinity'::timestamptz
    );
$$;

-- The single durable creation path for customer handoffs.  Every AI, deterministic, and voice
-- caller funnels through it so one conversation can never hold two active episodes, a replayed
-- tool call cannot fork a second row, and a later urgent signal escalates the episode already in
-- the queue instead of creating a competing one.
create function public.persist_active_conversation_handoff(
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

  select * into conversation_row from public.conversations
  where organization_id = target_organization_id and id = target_conversation_id;
  if conversation_row.id is null or conversation_row.mode <> 'customer' then
    raise exception using errcode = '42501', message = 'Handoff conversation is not available';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('conversation-handoff:' || target_conversation_id::text, 0)
  );

  select * into existing from public.handoffs
  where organization_id = target_organization_id and idempotency_key = target_idempotency_key;
  if existing.id is not null then
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

  return query select persisted_id, true, false;
end;
$$;

-- Every customer handoff creation path now converges on the coalescing function above.
-- Deterministic media handling keeps its Phase 7 behaviour and gains source-message binding.
create or replace function public.bootstrap_inbound_sms(
  target_message_sid text,
  target_from_e164 text,
  target_to_e164 text,
  target_body text,
  target_media jsonb default '[]'::jsonb,
  target_provider_metadata jsonb default '{}'::jsonb
)
returns table (accepted boolean, is_duplicate boolean, message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, command text)
language plpgsql security definer set search_path = '' as $$
declare route public.phone_numbers%rowtype; channel_row public.channels%rowtype; contact_row public.contacts%rowtype;
declare conversation_row public.conversations%rowtype; saved_message_id uuid; normalized_body text; detected_command text := null; provider_opt_out text;
declare media_count integer; content_types jsonb; deterministic_id uuid;
begin
  perform public.require_messaging_service_role();
  if target_message_sid !~ '^SM[a-zA-Z0-9]{32}$' or target_from_e164 !~ E'^\\+[1-9][0-9]{7,14}$'
    or target_to_e164 !~ E'^\\+[1-9][0-9]{7,14}$' or char_length(coalesce(target_body, '')) > 2000
    or jsonb_typeof(target_media) <> 'array' or jsonb_typeof(target_provider_metadata) <> 'object' then
    raise exception using errcode = '22023', message = 'Inbound SMS payload is invalid';
  end if;
  select * into route from public.phone_numbers where phone_number = target_to_e164 and status = 'active' and sms_enabled;
  if route.id is null then return query select false, false, null::uuid, null::uuid, null::uuid, null::uuid, null::text; return; end if;
  if not public.consume_messaging_rate_limit('sms:' || route.id::text || ':' || target_from_e164, 30, 60) then
    return query select true, false, null::uuid, null::uuid, route.organization_id, route.location_id, 'rate_limited'::text; return;
  end if;
  normalized_body := lower(regexp_replace(btrim(coalesce(target_body, '')), '\\s+', ' ', 'g'));
  provider_opt_out := lower(btrim(coalesce(target_provider_metadata ->> 'opt_out_type', '')));
  if provider_opt_out in ('stop', 'start', 'help') then detected_command := provider_opt_out;
  elsif normalized_body in ('stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit') then detected_command := 'stop';
  elsif normalized_body in ('start', 'unstop') then detected_command := 'start';
  elsif normalized_body = 'help' then detected_command := 'help'; end if;
  select * into channel_row from public.channels channel where channel.organization_id = route.organization_id
    and channel.location_id = route.location_id and channel.channel_type = 'sms' and channel.status = 'active'
    order by channel.created_at asc limit 1;
  if channel_row.id is null then
    insert into public.channels (organization_id, location_id, channel_type, display_name, status, configuration)
    values (route.organization_id, route.location_id, 'sms', 'SMS', 'active', jsonb_build_object('phone_number_id', route.id)) returning * into channel_row;
  end if;
  select * into contact_row from public.contacts contact where contact.organization_id = route.organization_id
    and contact.location_id = route.location_id and contact.phone = target_from_e164;
  if contact_row.id is null then
    insert into public.contacts (organization_id, location_id, phone, metadata)
    values (route.organization_id, route.location_id, target_from_e164, jsonb_build_object('source', 'sms')) returning * into contact_row;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms-conversation:' || route.id::text || ':' || contact_row.id::text, 0));
  select * into conversation_row from public.conversations conversation where conversation.organization_id = route.organization_id
    and conversation.location_id = route.location_id and conversation.contact_id = contact_row.id and conversation.channel_id = channel_row.id
    and conversation.transport_phone_number_id = route.id and conversation.status = 'open' order by conversation.updated_at desc limit 1;
  if conversation_row.id is null then
    insert into public.conversations (organization_id, location_id, contact_id, channel_id, transport_phone_number_id, status, metadata)
    values (route.organization_id, route.location_id, contact_row.id, channel_row.id, route.id, 'open', jsonb_build_object('transport', 'sms')) returning * into conversation_row;
  end if;
  media_count := jsonb_array_length(target_media);
  select coalesce(jsonb_agg(distinct left(value ->> 'content_type', 120)), '[]'::jsonb) into content_types from jsonb_array_elements(target_media) value;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, external_id, metadata, source_channel, author_type, transport_sender_e164, sent_at)
  values (route.organization_id, route.location_id, conversation_row.id, contact_row.id, 'inbound',
    case when media_count > 0 and length(btrim(coalesce(target_body, ''))) = 0 then 'media' else 'text' end,
    nullif(btrim(target_body), ''), target_message_sid,
    jsonb_build_object('provider', 'twilio', 'has_media', media_count > 0, 'media_count', media_count, 'content_types', content_types,
      'provider_metadata', jsonb_strip_nulls(jsonb_build_object('opt_out_type', nullif(provider_opt_out, '')))),
    'sms', 'customer', target_from_e164, now())
  on conflict on constraint messages_organization_external_key do nothing returning id into saved_message_id;
  if saved_message_id is null then
    select message.id into saved_message_id from public.messages message where message.organization_id = route.organization_id and message.external_id = target_message_sid;
    return query select true, true, saved_message_id, conversation_row.id, route.organization_id, route.location_id, detected_command; return;
  end if;
  insert into public.messaging_contact_preferences (organization_id, location_id, contact_id, channel_type, sender_phone_number_id, status, opted_out_at, source_message_id)
  values (route.organization_id, route.location_id, contact_row.id, 'sms', route.id, case when detected_command = 'stop' then 'opted_out' else 'active' end,
    case when detected_command = 'stop' then now() else null end, saved_message_id)
  on conflict on constraint messaging_contact_preferences_route_key do update set
    status = case when detected_command = 'stop' then 'opted_out' when detected_command = 'start' then 'active' else public.messaging_contact_preferences.status end,
    opted_out_at = case when detected_command = 'stop' then now() when detected_command = 'start' then null else public.messaging_contact_preferences.opted_out_at end,
    source_message_id = excluded.source_message_id, updated_at = now();
  if detected_command is null and not (media_count > 0 and length(btrim(coalesce(target_body, ''))) = 0) then
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
    values (route.organization_id, route.location_id, conversation_row.id, saved_message_id, 'inbound_ai') on conflict do nothing;
  elsif detected_command is null and media_count > 0 then
    perform public.persist_active_conversation_handoff(
      route.organization_id, route.location_id, conversation_row.id,
      'Inbound SMS media cannot be processed automatically.', 'normal',
      'message:' || saved_message_id::text || ':media-unsupported', saved_message_id, null);
    update public.conversations set ai_mode = 'human', updated_at = now() where id = conversation_row.id;
    insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, in_reply_to_message_id, sent_at)
    values (route.organization_id, route.location_id, conversation_row.id, contact_row.id, 'outbound', 'text',
      'Thanks for your message. We cannot process media by text yet, so a team member will help.',
      jsonb_build_object('transport', 'sms', 'deterministic', 'media_unsupported'), 'sms', 'system', saved_message_id, now())
    returning id into deterministic_id;
    insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (route.organization_id, route.location_id, deterministic_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (route.organization_id, route.location_id, conversation_row.id, deterministic_id, 'outbound_delivery');
  end if;
  update public.conversations conversation set last_message_at = now(), updated_at = now() where conversation.organization_id = route.organization_id and conversation.id = conversation_row.id;
  return query select true, false, saved_message_id, conversation_row.id, route.organization_id, route.location_id, detected_command;
end;
$$;


-- Text handoffs bind the trusted inbound turn the runtime is currently processing.  The model
-- supplies only a reason and an urgency; identity is derived from durable state.
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
  update public.conversations set ai_mode = 'human', updated_at = now()
    where organization_id = inbound.organization_id and id = inbound.conversation_id;
  return query select outcome.handoff_id, outcome.created;
end;
$$;

-- Voice handoffs bind the exact current provider call.  Claiming one in the dashboard is
-- operational ownership only; the Direct SIP media path is untouched by Phase 13.
create or replace function public.request_inbound_voice_handoff(
  target_call_id text,
  target_tool_call_id text,
  target_reason text,
  target_urgency text default 'normal'
)
returns table (handoff_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare target_call public.calls%rowtype; outcome record;
begin
  perform public.require_voice_service_role();
  if target_urgency not in ('normal', 'urgent')
    or length(btrim(coalesce(target_reason, ''))) < 3 or length(target_reason) > 500
    or length(btrim(coalesce(target_tool_call_id, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Voice handoff is invalid';
  end if;
  select * into target_call from public.calls
  where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if target_call.id is null then
    raise exception using errcode = '42501', message = 'Voice call is not available';
  end if;
  select * into outcome from public.persist_active_conversation_handoff(
    target_call.organization_id, target_call.location_id, target_call.conversation_id,
    target_reason, target_urgency,
    'voice:' || target_call_id || ':' || btrim(target_tool_call_id),
    null, target_call.id
  );
  return query select outcome.handoff_id, outcome.created;
end;
$$;

-- One ownership transition shared by Claim, Take over, and Human reply.  A second assignment path
-- would be a second set of rules, so there is deliberately only this one.
create function public.apply_handoff_claim(target_handoff_id uuid, target_user_id uuid)
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
declare handoff_row public.handoffs%rowtype; conversation_row public.conversations%rowtype;
begin
  select * into handoff_row from public.handoffs where id = target_handoff_id for update;
  if handoff_row.id is null or handoff_row.mode <> 'customer' then
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
    if conversation_row.ai_mode <> 'human' or conversation_row.assigned_user_id is distinct from target_user_id then
      update public.conversations set ai_mode = 'human', assigned_user_id = target_user_id, updated_at = now()
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

  update public.conversations set ai_mode = 'human', assigned_user_id = target_user_id, updated_at = now()
  where organization_id = handoff_row.organization_id and id = handoff_row.conversation_id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (handoff_row.organization_id, handoff_row.location_id, target_user_id, 'handoff.claimed', 'handoff',
    handoff_row.id, jsonb_build_object('transition', 'open_to_acknowledged', 'urgency', handoff_row.urgency));

  return query select 'claimed', handoff_row.id, handoff_row.conversation_id,
    handoff_row.status, handoff_row.urgency, handoff_row.assigned_user_id, handoff_row.first_acknowledged_at;
end;
$$;

-- Authorization for an operational handoff mutation: current location write access, plus either
-- current ownership or an owner/admin acting for the location.
create function public.authorize_my_handoff_operation(
  target_handoff_id uuid,
  require_ownership boolean
)
returns public.handoffs
language plpgsql stable security definer set search_path = '' as $$
declare handoff_row public.handoffs%rowtype;
begin
  select * into handoff_row from public.handoffs where id = target_handoff_id;
  if handoff_row.id is null
    or handoff_row.mode <> 'customer'
    or not public.has_location_write_access(handoff_row.organization_id, handoff_row.location_id) then
    raise exception using errcode = '42501', message = 'Handoff is not available';
  end if;
  if require_ownership
    and handoff_row.assigned_user_id is distinct from auth.uid()
    and not public.is_organization_admin(handoff_row.organization_id) then
    raise exception using errcode = '42501', message = 'Handoff is owned by another teammate';
  end if;
  return handoff_row;
end;
$$;

create function public.claim_my_handoff(target_handoff_id uuid)
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
declare claim_result record;
begin
  perform public.authorize_my_handoff_operation(target_handoff_id, false);
  select * into claim_result from public.apply_handoff_claim(target_handoff_id, auth.uid());
  return query select claim_result.claim_outcome, claim_result.claimed_handoff_id,
    claim_result.claimed_conversation_id, claim_result.claimed_status, claim_result.claimed_urgency,
    coalesce(claim_result.owner_user_id = auth.uid(), false),
    public.handoff_operator_display_name(claim_result.owner_user_id),
    claim_result.claimed_acknowledged_at;
end;
$$;

-- Release returns the episode to the queue without erasing that it was once acknowledged, and
-- without handing the conversation back to automation.
create function public.release_my_handoff(target_handoff_id uuid)
returns table (outcome text, handoff_id uuid, conversation_id uuid, handoff_status text)
language plpgsql security definer set search_path = '' as $$
declare handoff_row public.handoffs%rowtype; released_user_id uuid; recovered boolean;
begin
  handoff_row := public.authorize_my_handoff_operation(target_handoff_id, false);
  -- Re-read under the row lock so a concurrent claim between authorization and mutation cannot be
  -- released by an operator who no longer owns the episode.
  select * into handoff_row from public.handoffs where id = target_handoff_id for update;
  if handoff_row.id is null then
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

-- Resolving ends the human escalation episode.  It deliberately does not resume AI: an operator
-- who has finished with a customer has not asked automation to take the conversation back.
create function public.resolve_my_handoff(target_handoff_id uuid)
returns table (outcome text, handoff_id uuid, conversation_id uuid, handoff_status text, ai_mode text)
language plpgsql security definer set search_path = '' as $$
declare handoff_row public.handoffs%rowtype; conversation_mode text;
begin
  handoff_row := public.authorize_my_handoff_operation(target_handoff_id, true);
  -- Re-read under the row lock so ownership cannot change between authorization and resolution.
  select * into handoff_row from public.handoffs where id = target_handoff_id for update;
  if handoff_row.id is null
    or (handoff_row.assigned_user_id is distinct from auth.uid()
      and not public.is_organization_admin(handoff_row.organization_id)) then
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

-- Manual takeover keeps exactly one assignment path.  When the conversation already has an active
-- handoff, taking over is claiming that handoff under the same ownership rules.
drop function public.take_over_my_conversation(uuid);
create function public.take_over_my_conversation(target_conversation_id uuid)
returns table (outcome text, conversation_id uuid, handoff_id uuid, assigned_display_name text)
language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype; active_handoff_id uuid; claim_result record;
begin
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

  if conversation_row.ai_mode <> 'human' or conversation_row.assigned_user_id is distinct from auth.uid() then
    update public.conversations set ai_mode = 'human', assigned_user_id = auth.uid(), updated_at = now()
    where organization_id = conversation_row.organization_id and id = conversation_row.id;
    insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
    values (conversation_row.organization_id, conversation_row.location_id, auth.uid(),
      'conversation.human_takeover', 'conversation', conversation_row.id,
      jsonb_build_object('transition', 'ai_to_human'));
  end if;

  return query select 'taken_over', conversation_row.id, null::uuid,
    public.handoff_operator_display_name(auth.uid());
end;
$$;

-- Resuming AI is a separate, explicit decision from resolving the handoff.  It is refused while an
-- escalation episode is still open, and it never synthesises a reply to an already-answered turn:
-- automation only becomes eligible again on the customer's next inbound message.
drop function public.resume_my_conversation_ai(uuid);
create function public.resume_my_conversation_ai(target_conversation_id uuid)
returns table (outcome text, conversation_id uuid, ai_mode text, assigned_display_name text)
language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype;
begin
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

-- Human reply keeps every Phase 7 transport invariant and gains ownership authority.  Claiming an
-- unowned active handoff and persisting the reply share one transaction, so ownership and the
-- durable message can never disagree after a crash.
drop function public.create_my_human_reply(uuid, text);
create function public.create_my_human_reply(target_conversation_id uuid, target_body text)
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
begin
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Reply is invalid';
  end if;
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

  update public.conversations
  set ai_mode = 'human', assigned_user_id = auth.uid(), last_message_at = now(), updated_at = now()
  where id = conversation_row.id;

  return query select 'sent', saved_message_id, channel_row.channel_type,
    public.handoff_operator_display_name(auth.uid());
end;
$$;

-- Automation must re-check ownership immediately before it persists, not only when the job was
-- queued.  A staff claim that lands mid-flight therefore wins.
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
  if target_handoff_requested then update public.conversations set ai_mode = 'human', updated_at = now() where id = conversation_row.id; end if;
  update public.conversations set last_message_at = now(), updated_at = now() where id = conversation_row.id;
  return query select saved_message_id, true;
end;
$$;

-- Provider-boundary suppression for a stale automated SMS after human ownership becomes
-- authoritative.  Delivery history that already reached Twilio is never rewritten.
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
begin
  perform public.require_messaging_service_role();

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

  -- An automated reply that has not yet crossed the provider boundary is suppressed once a person
  -- owns the conversation.  Anything already submitted keeps its provider truth untouched.
  if message.author_type = 'ai' and exists (
    select 1 from public.handoffs handoff
    where handoff.organization_id = message.organization_id
      and handoff.conversation_id = message.conversation_id
      and handoff.mode = 'customer' and handoff.status in ('open', 'acknowledged')
      and handoff.assigned_user_id is not null
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

-- The operator queue read model.  One request returns everything a row needs, so the inbox never
-- fans out per-conversation RPCs.  Test-mode agent conversations are excluded by construction.
create function public.get_my_handoff_queue(
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
    when 'mine' then (
        prioritized.handoff_is_active
        and prioritized.handoff_assigned_user_id = auth.uid()
      )
      or prioritized.conversation_assigned_user_id = auth.uid()
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

-- Compact operational counts for the current location.  These are unbounded counts over the same
-- predicates the queue uses, so a truncated page can never understate the work that exists.
create function public.get_my_handoff_queue_summary(target_location_id uuid default null)
returns table (needs_attention integer, urgent integer, assigned_to_me integer)
language sql stable security definer set search_path = '' as $$
  with scoped as (
    select
      conversation.organization_id,
      conversation.id as conversation_id,
      conversation.ai_mode,
      active_handoff.id as handoff_id,
      active_handoff.urgency,
      active_handoff.assigned_user_id
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
    count(*) filter (where scoped.handoff_id is not null and scoped.assigned_user_id = auth.uid())::integer
  from scoped;
$$;

-- Bounded episode history for the conversation detail pane: requested, acknowledged, resolved.
create function public.get_my_conversation_handoff_history(
  target_conversation_id uuid,
  target_limit integer default 10
)
returns table (
  handoff_id uuid,
  handoff_status text,
  handoff_urgency text,
  handoff_reason text,
  handoff_source text,
  requested_at timestamptz,
  first_acknowledged_at timestamptz,
  resolved_at timestamptz,
  assigned_display_name text,
  resolved_by_display_name text
)
language sql stable security definer set search_path = '' as $$
  select
    handoff.id,
    handoff.status,
    handoff.urgency,
    handoff.reason,
    (case when handoff.call_id is not null then 'voice' else 'message' end)::text,
    handoff.created_at,
    handoff.first_acknowledged_at,
    handoff.resolved_at,
    public.handoff_operator_display_name(handoff.assigned_user_id),
    public.handoff_operator_display_name(handoff.resolved_by_user_id)
  from public.handoffs handoff
  join public.conversations conversation
    on conversation.organization_id = handoff.organization_id and conversation.id = handoff.conversation_id
  where handoff.conversation_id = target_conversation_id
    and handoff.mode = 'customer'
    and conversation.mode = 'customer'
    and public.has_location_access(handoff.organization_id, handoff.location_id)
  order by handoff.created_at desc, handoff.id desc
  limit least(greatest(coalesce(target_limit, 10), 1), 20);
$$;

-- Helpers, trigger functions, and the coalescing core are not a callable boundary for anyone.  The
-- explicit grants below are the complete Phase 13 surface: authenticated staff RPCs for operator
-- actions and reads, and the existing service-role handoff request RPCs for trusted runtimes.
revoke all on function
  public.enforce_handoff_urgency_monotonicity(),
  public.enforce_handoff_source_scope(),
  public.enforce_conversation_ownership_authority(),
  public.handoff_operator_display_name(uuid),
  public.conversation_customer_waiting_since(uuid, uuid),
  public.persist_active_conversation_handoff(uuid, uuid, uuid, text, text, text, uuid, uuid),
  public.apply_handoff_claim(uuid, uuid),
  public.authorize_my_handoff_operation(uuid, boolean)
  from public, anon, authenticated, service_role;

revoke all on function
  public.claim_my_handoff(uuid),
  public.release_my_handoff(uuid),
  public.resolve_my_handoff(uuid),
  public.take_over_my_conversation(uuid),
  public.resume_my_conversation_ai(uuid),
  public.create_my_human_reply(uuid, text),
  public.get_my_handoff_queue(uuid, text, integer),
  public.get_my_handoff_queue_summary(uuid),
  public.get_my_conversation_handoff_history(uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function
  public.claim_my_handoff(uuid),
  public.release_my_handoff(uuid),
  public.resolve_my_handoff(uuid),
  public.take_over_my_conversation(uuid),
  public.resume_my_conversation_ai(uuid),
  public.create_my_human_reply(uuid, text),
  public.get_my_handoff_queue(uuid, text, integer),
  public.get_my_handoff_queue_summary(uuid),
  public.get_my_conversation_handoff_history(uuid, integer)
  to authenticated;

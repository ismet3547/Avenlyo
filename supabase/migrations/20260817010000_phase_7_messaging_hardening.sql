-- Phase 7 hardening.  This migration is deliberately additive: Phase 7's public transport
-- boundary remains Fastify -> service-role RPC, while SQL keeps tenant and durable-send state.

-- A reply may only point at an inbound message in the same conversation, not merely the same org.
alter table public.messages
  add constraint messages_organization_conversation_id_id_key unique (organization_id, conversation_id, id);
alter table public.messages drop constraint messages_reply_scope_fk;
alter table public.messages
  add constraint messages_reply_conversation_scope_fk
  foreign key (organization_id, conversation_id, in_reply_to_message_id)
  references public.messages (organization_id, conversation_id, id);

-- SMS preference identity is the real business route, not just a contact's org-wide phone value.
alter table public.messaging_contact_preferences
  add column location_id uuid,
  add column sender_phone_number_id uuid;
update public.messaging_contact_preferences preference
set location_id = message.location_id,
    sender_phone_number_id = conversation.transport_phone_number_id
from public.messages message
join public.conversations conversation
  on conversation.organization_id = message.organization_id
 and conversation.id = message.conversation_id
where message.organization_id = preference.organization_id
  and message.id = preference.source_message_id;
alter table public.messaging_contact_preferences
  alter column location_id set not null,
  alter column sender_phone_number_id set not null,
  add constraint messaging_contact_preferences_location_fk
    foreign key (organization_id, location_id) references public.locations (organization_id, id),
  add constraint messaging_contact_preferences_sender_fk
    foreign key (organization_id, sender_phone_number_id) references public.phone_numbers (organization_id, id);
alter table public.messaging_contact_preferences
  drop constraint messaging_contact_preferences_contact_channel_key,
  add constraint messaging_contact_preferences_route_key
    unique (organization_id, location_id, contact_id, channel_type, sender_phone_number_id);

-- Do not silently choose an arbitrary customer when the same number exists at two locations.
create unique index contacts_organization_location_phone_key
  on public.contacts (organization_id, location_id, phone)
  where phone is not null;

-- The one durable transition that permits a provider request is queued -> submitting.
alter table public.message_deliveries drop constraint message_deliveries_status_check;
alter table public.message_deliveries
  add constraint message_deliveries_status_check
  check (status in ('queued', 'submitting', 'sent', 'delivered', 'failed', 'undelivered', 'unknown', 'suppressed'));

-- Restore the Phase 3 test-mode boundary while retaining location-scoped operational inbox reads.
drop policy if exists messages_select_location_member on public.messages;
drop policy if exists conversations_select_location_member on public.conversations;
create policy conversations_select_location_member on public.conversations for select to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and (mode = 'customer' or public.is_organization_admin(organization_id))
  );
create policy messages_select_location_member on public.messages for select to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = messages.organization_id
        and conversation.id = messages.conversation_id
        and (conversation.mode = 'customer' or public.is_organization_admin(messages.organization_id))
    )
  );

-- Browser-origin configuration is HTTPS-only. Local development uses a TLS dev origin rather
-- than allowing a production database policy to bless HTTP localhost accidentally.
create or replace function public.normalized_web_chat_origin(target_origin text)
returns text language plpgsql immutable set search_path = '' as $$
declare normalized text := lower(regexp_replace(btrim(coalesce(target_origin, '')), '/+$', ''));
begin
  if normalized ~ '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$' then
    return normalized;
  end if;
  raise exception using errcode = '22023', message = 'Web chat origin is invalid';
end;
$$;

-- These are internal service-only RPCs.  Fastify supplies HTTP Origin and IP-derived rate scope.
drop function public.create_web_chat_session(uuid, text, text, text);
drop function public.append_web_chat_message(text, text, uuid, text, text);
drop function public.get_web_chat_messages(text, text, timestamptz);

create function public.create_web_chat_session(
  target_widget_public_key uuid,
  target_origin text,
  target_token_hash text,
  target_rate_scope text
)
returns table (session_id uuid, conversation_id uuid, welcome_message text)
language plpgsql security definer set search_path = '' as $$
declare widget public.web_chat_widgets%rowtype; normalized_origin text; channel_row public.channels%rowtype; session_row public.web_chat_sessions%rowtype;
begin
  perform public.require_messaging_service_role();
  if target_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode = '22023', message = 'Web chat session is invalid'; end if;
  normalized_origin := public.normalized_web_chat_origin(target_origin);
  if not public.consume_messaging_rate_limit('web-session:' || target_rate_scope, 10, 60) then
    raise exception using errcode = '42901', message = 'Too many web chat session requests'; end if;
  select * into widget from public.web_chat_widgets where public_key = target_widget_public_key and enabled;
  if widget.id is null or not exists (
    select 1 from jsonb_array_elements_text(widget.allowed_origins) allowed(origin)
    where public.normalized_web_chat_origin(allowed.origin) = normalized_origin
  ) then raise exception using errcode = '42501', message = 'Web chat widget is not available for this origin'; end if;
  select * into channel_row from public.channels
    where organization_id = widget.organization_id and id = widget.channel_id and channel_type = 'web' and status = 'active';
  if channel_row.id is null then raise exception using errcode = '42501', message = 'Web chat channel is not available'; end if;
  insert into public.conversations (organization_id, location_id, channel_id, status, metadata)
  values (widget.organization_id, widget.location_id, widget.channel_id, 'open', jsonb_build_object('transport', 'web_chat'))
  returning id into session_row.conversation_id;
  insert into public.web_chat_sessions (organization_id, location_id, widget_id, conversation_id, token_hash, origin, expires_at)
  values (widget.organization_id, widget.location_id, widget.id, session_row.conversation_id, target_token_hash, normalized_origin, now() + interval '24 hours')
  returning * into session_row;
  return query select session_row.id, session_row.conversation_id, widget.welcome_message;
end;
$$;

create function public.append_web_chat_message(
  target_token_hash text,
  target_client_message_id uuid,
  target_body text,
  target_rate_scope text
)
returns table (message_id uuid, conversation_id uuid, is_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare session_row public.web_chat_sessions%rowtype; saved_message_id uuid;
begin
  perform public.require_messaging_service_role();
  if target_token_hash !~ '^[0-9a-f]{64}$' or target_client_message_id is null
    or length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Web chat message is invalid'; end if;
  if not public.consume_messaging_rate_limit('web-message:' || target_rate_scope, 30, 60) then
    raise exception using errcode = '42901', message = 'Too many web chat messages'; end if;
  select * into session_row from public.web_chat_sessions
    where token_hash = target_token_hash and expires_at > now() for update;
  if session_row.id is null then raise exception using errcode = '42501', message = 'Web chat session is unavailable'; end if;
  select id into saved_message_id from public.messages
    where organization_id = session_row.organization_id and conversation_id = session_row.conversation_id and client_message_id = target_client_message_id;
  if saved_message_id is not null then return query select saved_message_id, session_row.conversation_id, true; return; end if;
  insert into public.messages (organization_id, location_id, conversation_id, direction, message_type, body, metadata, source_channel, author_type, client_message_id, sent_at)
  values (session_row.organization_id, session_row.location_id, session_row.conversation_id, 'inbound', 'text', btrim(target_body),
    jsonb_build_object('transport', 'web_chat'), 'web', 'customer', target_client_message_id, now()) returning id into saved_message_id;
  insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
  values (session_row.organization_id, session_row.location_id, session_row.conversation_id, saved_message_id, 'inbound_ai');
  update public.web_chat_sessions set last_active_at = now(), expires_at = now() + interval '24 hours', updated_at = now() where id = session_row.id;
  update public.conversations set last_message_at = now(), updated_at = now() where id = session_row.conversation_id;
  return query select saved_message_id, session_row.conversation_id, false;
end;
$$;

create function public.get_web_chat_messages(target_token_hash text, target_after timestamptz default null)
returns table (message_id uuid, direction text, author_type text, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare session_row public.web_chat_sessions%rowtype;
begin
  perform public.require_messaging_service_role();
  if target_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode = '22023', message = 'Web chat session is invalid'; end if;
  select * into session_row from public.web_chat_sessions where token_hash = target_token_hash and expires_at > now();
  if session_row.id is null then raise exception using errcode = '42501', message = 'Web chat session is unavailable'; end if;
  update public.web_chat_sessions set last_active_at = now(), expires_at = now() + interval '24 hours', updated_at = now() where id = session_row.id;
  return query select message.id, message.direction, message.author_type, message.body, message.created_at
    from public.messages message where message.organization_id = session_row.organization_id and message.conversation_id = session_row.conversation_id
      and (target_after is null or message.created_at > target_after) order by message.created_at asc, message.id asc limit 100;
end;
$$;

-- Provider opt-out metadata has priority.  The fallback intentionally does not treat YES as START.
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
    raise exception using errcode = '22023', message = 'Inbound SMS payload is invalid'; end if;
  select * into route from public.phone_numbers where phone_number = target_to_e164 and status = 'active' and sms_enabled;
  if route.id is null then return query select false, false, null::uuid, null::uuid, null::uuid, null::uuid, null::text; return; end if;
  if not public.consume_messaging_rate_limit('sms:' || route.id::text || ':' || target_from_e164, 30, 60) then
    return query select true, false, null::uuid, null::uuid, route.organization_id, route.location_id, 'rate_limited'::text; return; end if;
  normalized_body := lower(regexp_replace(btrim(coalesce(target_body, '')), '\s+', ' ', 'g'));
  provider_opt_out := lower(btrim(coalesce(target_provider_metadata ->> 'opt_out_type', '')));
  if provider_opt_out in ('stop', 'start', 'help') then detected_command := provider_opt_out;
  elsif normalized_body in ('stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit') then detected_command := 'stop';
  elsif normalized_body in ('start', 'unstop') then detected_command := 'start';
  elsif normalized_body = 'help' then detected_command := 'help'; end if;
  select * into channel_row from public.channels where organization_id = route.organization_id and location_id = route.location_id and channel_type = 'sms' and status = 'active' order by created_at asc limit 1;
  if channel_row.id is null then
    insert into public.channels (organization_id, location_id, channel_type, display_name, status, configuration)
    values (route.organization_id, route.location_id, 'sms', 'SMS', 'active', jsonb_build_object('phone_number_id', route.id)) returning * into channel_row;
  end if;
  select * into contact_row from public.contacts where organization_id = route.organization_id and location_id = route.location_id and phone = target_from_e164;
  if contact_row.id is null then
    insert into public.contacts (organization_id, location_id, phone, metadata)
    values (route.organization_id, route.location_id, target_from_e164, jsonb_build_object('source', 'sms')) returning * into contact_row;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms-conversation:' || route.id::text || ':' || contact_row.id::text, 0));
  select * into conversation_row from public.conversations where organization_id = route.organization_id and location_id = route.location_id
    and contact_id = contact_row.id and channel_id = channel_row.id and transport_phone_number_id = route.id and status = 'open' order by updated_at desc limit 1;
  if conversation_row.id is null then
    insert into public.conversations (organization_id, location_id, contact_id, channel_id, transport_phone_number_id, status, metadata)
    values (route.organization_id, route.location_id, contact_row.id, channel_row.id, route.id, 'open', jsonb_build_object('transport', 'sms')) returning * into conversation_row;
  end if;
  media_count := jsonb_array_length(target_media);
  select coalesce(jsonb_agg(distinct left(value ->> 'content_type', 120)), '[]'::jsonb) into content_types from jsonb_array_elements(target_media) value;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, external_id, metadata, source_channel, author_type, sent_at)
  values (route.organization_id, route.location_id, conversation_row.id, contact_row.id, 'inbound',
    case when media_count > 0 and length(btrim(coalesce(target_body, ''))) = 0 then 'media' else 'text' end,
    nullif(btrim(target_body), ''), target_message_sid,
    jsonb_build_object('provider', 'twilio', 'has_media', media_count > 0, 'media_count', media_count, 'content_types', content_types,
      'provider_metadata', jsonb_strip_nulls(jsonb_build_object('opt_out_type', nullif(provider_opt_out, '')))), 'sms', 'customer', now())
  on conflict (organization_id, external_id) do nothing returning id into saved_message_id;
  if saved_message_id is null then
    select id into saved_message_id from public.messages where organization_id = route.organization_id and external_id = target_message_sid;
    return query select true, true, saved_message_id, conversation_row.id, route.organization_id, route.location_id, detected_command; return;
  end if;
  insert into public.messaging_contact_preferences (organization_id, location_id, contact_id, channel_type, sender_phone_number_id, status, opted_out_at, source_message_id)
  values (route.organization_id, route.location_id, contact_row.id, 'sms', route.id, case when detected_command = 'stop' then 'opted_out' else 'active' end,
    case when detected_command = 'stop' then now() else null end, saved_message_id)
  on conflict (organization_id, location_id, contact_id, channel_type, sender_phone_number_id) do update set
    status = case when detected_command = 'stop' then 'opted_out' when detected_command = 'start' then 'active' else public.messaging_contact_preferences.status end,
    opted_out_at = case when detected_command = 'stop' then now() when detected_command = 'start' then null else public.messaging_contact_preferences.opted_out_at end,
    source_message_id = excluded.source_message_id, updated_at = now();
  if detected_command is null and not (media_count > 0 and length(btrim(coalesce(target_body, ''))) = 0) then
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
    values (route.organization_id, route.location_id, conversation_row.id, saved_message_id, 'inbound_ai') on conflict do nothing;
  elsif detected_command is null and media_count > 0 then
    insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, in_reply_to_message_id, sent_at)
    values (route.organization_id, route.location_id, conversation_row.id, contact_row.id, 'outbound', 'text',
      'Thanks for your message. We canâ€™t process media by text yet, so a team member will help.', jsonb_build_object('transport', 'sms', 'deterministic', 'media_unsupported'), 'sms', 'system', saved_message_id, now())
    returning id into deterministic_id;
    insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (route.organization_id, route.location_id, deterministic_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (route.organization_id, route.location_id, conversation_row.id, deterministic_id, 'outbound_delivery');
  end if;
  update public.conversations set last_message_at = now(), updated_at = now() where organization_id = route.organization_id and id = conversation_row.id;
  return query select true, false, saved_message_id, conversation_row.id, route.organization_id, route.location_id, detected_command;
end;
$$;

-- PostgreSQL cannot change a function's OUT row type with CREATE OR REPLACE.
-- This function is an internal RPC with no SQL dependants, so replace its contract explicitly.
drop function public.get_message_agent_context(uuid);
create function public.get_message_agent_context(target_message_id uuid)
returns table (message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, industry_id text, organization_name text, location_name text, location_timezone text, location_address jsonb, business_hours jsonb, business_phone text, website_url text, channel_type text, history jsonb)
language sql stable security definer set search_path = '' as $$
  select message.id, conversation.id, conversation.organization_id, conversation.location_id,
    organization.primary_industry_id, organization.name, location.name, location.timezone, location.address,
    location.business_hours, organization.business_phone, organization.website_url, channel.channel_type,
    coalesce((select jsonb_agg(jsonb_build_object('author_type', historic.author_type, 'body', historic.body) order by historic.created_at asc)
      from (select author_type, body, created_at from public.messages
        where organization_id = conversation.organization_id and conversation_id = conversation.id and body is not null
        order by created_at desc limit 16) historic), '[]'::jsonb)
  from public.messages message
  join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  join public.organizations organization on organization.id = conversation.organization_id
  join public.locations location on location.organization_id = conversation.organization_id and location.id = conversation.location_id
  where message.id = target_message_id and message.direction = 'inbound' and message.author_type = 'customer';
$$;

-- Authorize exactly one provider post while rechecking the current scoped opt-out and DID state.
create function public.claim_sms_delivery_submission(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql security definer set search_path = '' as $$
declare delivery public.message_deliveries%rowtype; message public.messages%rowtype; conversation public.conversations%rowtype; contact public.contacts%rowtype; phone public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into delivery from public.message_deliveries where message_id = target_message_id and provider = 'twilio' for update;
  if delivery.id is null or delivery.status <> 'queued' then return; end if;
  select * into message from public.messages where organization_id = delivery.organization_id and id = delivery.message_id;
  select * into conversation from public.conversations where organization_id = message.organization_id and id = message.conversation_id;
  select * into contact from public.contacts where organization_id = message.organization_id and id = conversation.contact_id;
  select * into phone from public.phone_numbers where organization_id = message.organization_id and id = conversation.transport_phone_number_id;
  if conversation.id is null or contact.id is null or phone.id is null or phone.status <> 'active' or not phone.sms_enabled
    or exists (select 1 from public.messaging_contact_preferences preference where preference.organization_id = message.organization_id
      and preference.location_id = conversation.location_id and preference.contact_id = conversation.contact_id and preference.channel_type = 'sms'
      and preference.sender_phone_number_id = phone.id and preference.status = 'opted_out') then
    update public.message_deliveries set status = 'suppressed', status_rank = 6, error_code = 'delivery_suppressed', updated_at = now() where id = delivery.id;
    return;
  end if;
  update public.message_deliveries set status = 'submitting', status_rank = 1, attempted_at = now(), updated_at = now() where id = delivery.id;
  return query select message.id, delivery.id, contact.phone, phone.phone_number, message.body, 'submitting'::text;
end;
$$;

create or replace function public.record_sms_delivery_submission(target_message_id uuid, target_provider_message_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if target_provider_message_id !~ '^SM[a-zA-Z0-9]{32}$' then raise exception using errcode = '22023', message = 'Provider message identifier is invalid'; end if;
  update public.message_deliveries set provider_message_id = target_provider_message_id, status = 'sent', status_rank = 2, sent_at = now(), updated_at = now()
    where message_id = target_message_id and provider = 'twilio' and status = 'submitting';
end;
$$;

create or replace function public.mark_sms_delivery_unknown(target_message_id uuid, target_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  update public.message_deliveries set status = 'unknown', status_rank = 6, error_code = left(nullif(btrim(target_error_code), ''), 120), updated_at = now()
    where message_id = target_message_id and provider = 'twilio' and status = 'submitting';
end;
$$;

create or replace function public.get_sms_delivery_execution_context(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  -- Legacy helper deliberately does not authorize a send. Workers must use claim_sms_delivery_submission.
  return;
end;
$$;

create or replace function public.claim_message_processing_jobs(target_worker_id text, target_limit integer default 5)
returns table (job_id uuid, job_kind text, message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 20 then raise exception using errcode = '22023', message = 'Worker claim is invalid'; end if;
  -- A crashed worker may have posted to Twilio after marking a delivery submitting. Never retry it.
  update public.message_deliveries delivery set status = 'unknown', status_rank = 6, error_code = 'stale_submission_unknown', updated_at = now()
  from public.message_processing_jobs job
  where job.message_id = delivery.message_id and job.job_kind = 'outbound_delivery' and job.status = 'processing'
    and job.claimed_at < now() - interval '5 minutes' and delivery.provider = 'twilio' and delivery.status = 'submitting';
  update public.message_processing_jobs job set status = 'completed', completed_at = now(), claimed_at = null, claimed_by = null, last_error_code = 'stale_submission_unknown', updated_at = now()
  from public.message_deliveries delivery
  where job.message_id = delivery.message_id and job.job_kind = 'outbound_delivery' and job.status = 'processing'
    and delivery.provider = 'twilio' and delivery.status = 'unknown' and delivery.error_code = 'stale_submission_unknown';
  update public.message_processing_jobs set status = 'queued', claimed_at = null, claimed_by = null, available_at = now(), updated_at = now()
    where status = 'processing' and claimed_at < now() - interval '5 minutes';
  return query with claimed as (
    select id from public.message_processing_jobs where status = 'queued' and available_at <= now() order by created_at asc for update skip locked limit target_limit
  ), updated as (
    update public.message_processing_jobs job set status = 'processing', attempts = attempts + 1, claimed_at = now(), claimed_by = btrim(target_worker_id), updated_at = now()
    from claimed where job.id = claimed.id returning job.*
  ) select id, job_kind, message_id, conversation_id, organization_id, location_id, attempts from updated;
end;
$$;

create or replace function public.record_twilio_message_status(target_provider_message_id text, target_status text, target_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare existing public.message_deliveries%rowtype; incoming_rank integer;
begin
  perform public.require_messaging_service_role();
  incoming_rank := case target_status when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 when 'failed' then 4 when 'undelivered' then 4 else null end;
  if target_provider_message_id !~ '^SM[a-zA-Z0-9]{32}$' or incoming_rank is null then raise exception using errcode = '22023', message = 'Twilio status payload is invalid'; end if;
  select * into existing from public.message_deliveries where provider = 'twilio' and provider_message_id = target_provider_message_id for update;
  if existing.id is null or existing.status in ('delivered', 'failed', 'undelivered', 'unknown', 'suppressed') then return; end if;
  if incoming_rank < existing.status_rank then return; end if;
  update public.message_deliveries set status = case when target_status = 'sending' then 'submitting' else target_status end, status_rank = incoming_rank,
    error_code = coalesce(left(nullif(btrim(target_error_code), ''), 120), error_code),
    delivered_at = case when target_status = 'delivered' then now() else delivered_at end, updated_at = now() where id = existing.id;
end;
$$;

-- Phone conversations have no text transport. Reject manipulated browser requests rather than inventing web chat.
create or replace function public.create_my_human_reply(target_conversation_id uuid, target_body text)
returns table (message_id uuid, source_channel text)
language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype; channel_row public.channels%rowtype; saved_message_id uuid; contact_opted_out boolean;
begin
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then raise exception using errcode = '22023', message = 'Reply is invalid'; end if;
  select * into conversation_row from public.conversations where id = target_conversation_id;
  if conversation_row.id is null or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then raise exception using errcode = '42501', message = 'Conversation is not available'; end if;
  select * into channel_row from public.channels where organization_id = conversation_row.organization_id and id = conversation_row.channel_id;
  if channel_row.channel_type not in ('sms', 'web') then raise exception using errcode = '22023', message = 'Text reply is not supported for this conversation'; end if;
  select exists(select 1 from public.messaging_contact_preferences preference where preference.organization_id = conversation_row.organization_id and preference.location_id = conversation_row.location_id and preference.contact_id = conversation_row.contact_id and preference.channel_type = 'sms' and preference.sender_phone_number_id = conversation_row.transport_phone_number_id and preference.status = 'opted_out') into contact_opted_out;
  if channel_row.channel_type = 'sms' and contact_opted_out then raise exception using errcode = '42501', message = 'SMS contact has opted out'; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_by_user_id, sent_at)
  values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, conversation_row.contact_id, 'outbound', 'text', btrim(target_body), jsonb_build_object('transport', channel_row.channel_type), channel_row.channel_type, 'human', auth.uid(), now()) returning id into saved_message_id;
  if channel_row.channel_type = 'sms' then
    insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, saved_message_id, 'outbound_delivery');
  else
    insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, status_rank, sent_at) values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'web_chat', 'sent', 2, now());
  end if;
  update public.conversations set ai_mode = 'human', assigned_user_id = auth.uid(), last_message_at = now(), updated_at = now() where id = conversation_row.id;
  return query select saved_message_id, channel_row.channel_type;
end;
$$;

create or replace function public.get_my_inbox_conversations(target_location_id uuid default null)
returns table (conversation_id uuid, location_id uuid, channel_type text, contact_name text, contact_phone text, latest_body text, latest_at timestamptz, ai_mode text, handoff_open boolean)
language sql stable security definer set search_path = '' as $$
  select conversation.id, conversation.location_id, channel.channel_type,
    nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), contact.phone,
    latest.body, coalesce(latest.created_at, conversation.last_message_at, conversation.created_at), conversation.ai_mode,
    exists(select 1 from public.handoffs handoff where handoff.organization_id = conversation.organization_id and handoff.conversation_id = conversation.id and handoff.status in ('open','acknowledged'))
  from public.conversations conversation
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  left join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  left join lateral (select body, created_at from public.messages where organization_id = conversation.organization_id and conversation_id = conversation.id order by created_at desc limit 1) latest on true
  where public.has_location_access(conversation.organization_id, conversation.location_id)
    and (conversation.mode = 'customer' or public.is_organization_admin(conversation.organization_id))
    and (target_location_id is null or conversation.location_id = target_location_id)
  order by coalesce(latest.created_at, conversation.last_message_at, conversation.created_at) desc;
$$;

create or replace function public.get_my_inbox_messages(target_conversation_id uuid)
returns table (message_id uuid, direction text, author_type text, body text, source_channel text, delivery_status text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select message.id, message.direction, message.author_type, message.body, message.source_channel, delivery.status, message.created_at
  from public.messages message
  join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  left join public.message_deliveries delivery on delivery.organization_id = message.organization_id and delivery.message_id = message.id
  where message.conversation_id = target_conversation_id
    and public.has_location_access(conversation.organization_id, conversation.location_id)
    and (conversation.mode = 'customer' or public.is_organization_admin(conversation.organization_id))
  order by message.created_at asc, message.id asc;
$$;

-- Channel-neutral trusted scheduling context and state-machine wrappers.
create function public.get_conversation_scheduling_context(target_conversation_id uuid)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, trusted_transport_phone_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer, channel_type text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select conversation.organization_id, conversation.location_id, conversation.id, conversation.contact_id,
    case when channel.channel_type = 'sms' then contact.phone else null end,
    nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), integration.id, integration.provider,
    location.timezone, location.business_hours, settings.minimum_lead_minutes, channel.channel_type
  from public.conversations conversation
  join public.locations location on location.organization_id = conversation.organization_id and location.id = conversation.location_id
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  join public.location_scheduling_settings settings on settings.organization_id = conversation.organization_id and settings.location_id = conversation.location_id
  join public.integrations integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id and integration.status = 'connected'
  left join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  where conversation.id = target_conversation_id and conversation.mode = 'customer';
end;
$$;

create function public.create_conversation_booking_candidates(target_conversation_id uuid, available_slots jsonb)
returns table (candidate_id uuid, appointment_type_name text, resource_name text, starts_at timestamptz, ends_at timestamptz, timezone text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare context record;
begin
  perform public.require_scheduling_service_role(); select * into context from public.get_conversation_scheduling_context(target_conversation_id);
  if context.integration_id is null or jsonb_typeof(available_slots) <> 'array' or jsonb_array_length(available_slots) not between 1 and 5 then raise exception using errcode = '22023', message = 'Availability slots are invalid'; end if;
  return query with supplied as (select entry.appointment_type_uid, entry.resource_uid, entry.starts_at, entry.ends_at from jsonb_to_recordset(available_slots) as entry(appointment_type_uid text, resource_uid text, starts_at timestamptz, ends_at timestamptz)), inserted as (
    insert into public.booking_candidates (organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
    select context.organization_id, context.location_id, context.conversation_id, context.integration_id, appointment_type.id, resource.id, supplied.starts_at, supplied.ends_at, context.timezone, now() + interval '10 minutes'
    from supplied join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = context.organization_id and appointment_type.integration_id = context.integration_id and appointment_type.external_uid = supplied.appointment_type_uid and appointment_type.active and appointment_type.bookable
    join public.scheduling_resources resource on resource.organization_id = context.organization_id and resource.integration_id = context.integration_id and resource.external_uid = supplied.resource_uid and resource.active and resource.bookable
    left join public.scheduling_appointment_type_resources mapping on mapping.organization_id = context.organization_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = resource.id
    where supplied.ends_at > supplied.starts_at and supplied.starts_at between now() and now() + interval '14 days' and (context.provider = 'ezyvet' or mapping.appointment_type_id is not null)
    returning id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
  select inserted.id, appointment_type.name, resource.name, inserted.starts_at, inserted.ends_at, inserted.timezone, inserted.expires_at from inserted join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = context.organization_id and appointment_type.id = inserted.appointment_type_id join public.scheduling_resources resource on resource.organization_id = context.organization_id and resource.id = inserted.resource_id;
  if not found then raise exception using errcode = '22023', message = 'No trusted availability slots were supplied'; end if;
end;
$$;

create function public.prepare_conversation_scheduling_booking_intent(target_conversation_id uuid, target_candidate_id uuid, resolved_contact_uid text, resolved_subject_uid text, resolved_subject_name text, trusted_contact_id uuid)
returns table (booking_intent_id uuid, appointment_type_name text, starts_at timestamptz, timezone text, status text)
language plpgsql security definer set search_path = '' as $$
declare context record; candidate public.booking_candidates%rowtype; existing public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role(); select * into context from public.get_conversation_scheduling_context(target_conversation_id);
  if context.integration_id is null then raise exception using errcode = '42501', message = 'Bookable scheduling integration is not available'; end if;
  if context.provider = 'ezyvet' and (context.trusted_transport_phone_e164 is null or length(btrim(coalesce(resolved_contact_uid, ''))) = 0 or length(btrim(coalesce(resolved_subject_uid, ''))) = 0 or length(btrim(coalesce(resolved_subject_name, ''))) not between 1 and 80) then raise exception using errcode = '22023', message = 'Resolved ezyVet booking identity is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-candidate:' || target_candidate_id::text, 0));
  select * into candidate from public.booking_candidates where id = target_candidate_id and organization_id = context.organization_id and location_id = context.location_id and conversation_id = context.conversation_id and integration_id = context.integration_id;
  if candidate.id is null or candidate.status <> 'offered' or candidate.expires_at <= now() then raise exception using errcode = '42501', message = 'Booking candidate is not available'; end if;
  select * into existing from public.booking_intents where organization_id = candidate.organization_id and candidate_id = candidate.id;
  if existing.id is not null then return query select existing.id, appointment_type.name, candidate.starts_at, candidate.timezone, existing.status from public.scheduling_appointment_types appointment_type where appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id; return; end if;
  insert into public.booking_intents (organization_id, location_id, conversation_id, integration_id, candidate_id, contact_id, external_contact_uid, external_subject_uid, subject_name)
  values (candidate.organization_id, candidate.location_id, candidate.conversation_id, candidate.integration_id, candidate.id, coalesce(trusted_contact_id, context.contact_id), nullif(btrim(coalesce(resolved_contact_uid, '')), ''), nullif(btrim(coalesce(resolved_subject_uid, '')), ''), nullif(btrim(coalesce(resolved_subject_name, '')), '')) returning id into existing.id;
  update public.booking_candidates set status = 'consumed', updated_at = now() where id = candidate.id;
  return query select existing.id, appointment_type.name, candidate.starts_at, candidate.timezone, existing.status from public.scheduling_appointment_types appointment_type where appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id;
end;
$$;

create or replace function public.claim_conversation_scheduling_booking_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_booking_intent_id uuid, target_tool_call_id text)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; inbound public.messages%rowtype; candidate public.booking_candidates%rowtype; write_eligible boolean;
begin
  perform public.require_scheduling_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) = 0 or length(target_tool_call_id) > 200 then raise exception using errcode = '22023', message = 'Booking tool call is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents where id = target_booking_intent_id and conversation_id = target_conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'booking') then return query select case when intent.status = 'booking' then 'booking_recovery' else intent.status end, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  select * into candidate from public.booking_candidates where id = intent.candidate_id and organization_id = intent.organization_id and integration_id = intent.integration_id;
  if candidate.id is null or candidate.expires_at <= now() then update public.booking_intents set status = 'expired', updated_at = now() where id = intent.id; return query select 'expired'::text, intent.id, null::uuid; return; end if;
  select exists(select 1 from public.location_scheduling_settings settings join public.integrations integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id
    join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
    join public.scheduling_resources resource on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id and resource.integration_id = intent.integration_id
    where settings.organization_id = intent.organization_id and settings.location_id = intent.location_id and settings.active_integration_id = intent.integration_id and integration.status = 'connected' and appointment_type.active and appointment_type.bookable and resource.active and resource.bookable
      and (integration.provider = 'ezyvet' or exists(select 1 from public.scheduling_appointment_type_resources mapping where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = resource.id))) into write_eligible;
  if not write_eligible then update public.booking_intents set failure_category = 'configuration_changed', updated_at = now() where id = intent.id; return query select 'configuration_changed'::text, intent.id, null::uuid; return; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and organization_id = intent.organization_id and location_id = intent.location_id and conversation_id = intent.conversation_id and direction = 'inbound' and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= intent.created_at or not public.is_explicit_booking_confirmation(inbound.body) then return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  update public.booking_intents set status = 'booking', booking_tool_call_id = target_tool_call_id, confirmed_message_id = inbound.id, failure_category = null, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound.id;
end;
$$;

-- Voice must pass the exact transcript which triggered this tool call; an older YES cannot be reused.
create or replace function public.claim_voice_scheduling_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text, target_inbound_message_id uuid)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare call_context record;
begin
  perform public.require_scheduling_service_role();
  select organization_id, location_id, conversation_id into call_context from public.calls where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if call_context.conversation_id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  return query select * from public.claim_conversation_scheduling_booking_intent(call_context.conversation_id, target_inbound_message_id, target_booking_intent_id, target_tool_call_id);
end;
$$;

create function public.get_scheduling_booking_execution_context(target_booking_intent_id uuid)
returns table (booking_intent_id uuid, organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, integration_id uuid, provider text, external_contact_uid text, external_subject_uid text, subject_name text, trusted_phone_e164 text, customer_display_name text, appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, resource_uid text, resource_name text, starts_at timestamptz, ends_at timestamptz, timezone text, business_hours jsonb, minimum_lead_minutes integer, provider_appointment_id text, provider_booking_status text, intent_status text, current_write_eligible boolean)
language sql stable security definer set search_path = '' as $$
  select * from public.get_voice_booking_execution_context(target_booking_intent_id);
$$;
create function public.record_scheduling_booking_provider_success(target_booking_intent_id uuid, target_external_appointment_id text, target_provider_status text)
returns void language plpgsql security definer set search_path = '' as $$ begin perform public.require_scheduling_service_role(); perform public.record_voice_booking_provider_success(target_booking_intent_id, target_external_appointment_id, target_provider_status); end; $$;
create function public.complete_scheduling_booking_intent(target_booking_intent_id uuid)
returns table (appointment_id uuid, is_existing boolean) language plpgsql security definer set search_path = '' as $$ begin perform public.require_scheduling_service_role(); return query select * from public.complete_voice_booking_intent(target_booking_intent_id); end; $$;
create function public.fail_scheduling_booking_intent(target_booking_intent_id uuid, target_status text, target_error_category text)
returns void language plpgsql security definer set search_path = '' as $$ begin perform public.require_scheduling_service_role(); perform public.fail_voice_booking_intent(target_booking_intent_id, target_status, target_error_category); end; $$;

-- Preserve the original 3-argument voice function for recovery callers. It intentionally has no
-- current transcript ID, so fresh writes can never claim confirmation through this overload.
create or replace function public.claim_voice_scheduling_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare call_context record;
begin
  perform public.require_scheduling_service_role();
  select conversation_id into call_context from public.calls
    where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if call_context.conversation_id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  return query select * from public.claim_conversation_scheduling_booking_intent(
    call_context.conversation_id, null::uuid, target_booking_intent_id, target_tool_call_id
  );
end;
$$;

create function public.get_voice_transcript_message_id(target_call_id text, target_external_item_id text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare target_conversation_id uuid;
begin
  perform public.require_voice_service_role();
  select conversation_id into target_conversation_id from public.calls where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if target_conversation_id is null then raise exception using errcode = '42501', message = 'Voice call is not available'; end if;
  return (select id from public.messages where conversation_id = target_conversation_id and external_id = 'voice:' || target_call_id || ':' || target_external_item_id);
end;
$$;

-- Owner/admin configuration uses Fastify's authenticated route plus a trusted capability check.
create function public.set_sms_phone_number_enabled(target_phone_number_id uuid, target_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare number_row public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into number_row from public.phone_numbers where id = target_phone_number_id for update;
  if number_row.id is null then raise exception using errcode = '42501', message = 'Phone number is unavailable'; end if;
  update public.phone_numbers set sms_enabled = target_enabled, updated_at = now() where id = number_row.id;
end;
$$;

create function public.set_sms_phone_number_enabled_for_user(target_user_id uuid, target_phone_number_id uuid, target_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare number_row public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into number_row from public.phone_numbers where id = target_phone_number_id for update;
  if number_row.id is null or not exists (
    select 1 from public.organization_members member
    where member.organization_id = number_row.organization_id and member.user_id = target_user_id and member.role in ('owner', 'admin')
  ) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  update public.phone_numbers set sms_enabled = target_enabled, updated_at = now() where id = number_row.id;
end;
$$;

create function public.get_sms_phone_number_for_user(target_user_id uuid, target_phone_number_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare number_row public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into number_row from public.phone_numbers where id = target_phone_number_id;
  if number_row.id is null or not exists (
    select 1 from public.organization_members member
    where member.organization_id = number_row.organization_id and member.user_id = target_user_id and member.role in ('owner', 'admin')
  ) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  return number_row.phone_number;
end;
$$;

revoke all on function public.create_web_chat_session(uuid, text, text, text), public.append_web_chat_message(text, uuid, text, text), public.get_web_chat_messages(text, timestamptz) from public, anon, authenticated;
revoke all on function public.get_message_agent_context(uuid) from public, anon, authenticated;
revoke all on function public.claim_sms_delivery_submission(uuid), public.get_conversation_scheduling_context(uuid), public.create_conversation_booking_candidates(uuid, jsonb), public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid), public.get_scheduling_booking_execution_context(uuid), public.record_scheduling_booking_provider_success(uuid, text, text), public.complete_scheduling_booking_intent(uuid), public.fail_scheduling_booking_intent(uuid, text, text), public.set_sms_phone_number_enabled(uuid, boolean) from public, anon, authenticated;
revoke all on function public.mark_sms_delivery_sending(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_sms_phone_number_enabled_for_user(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.get_sms_phone_number_for_user(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_voice_scheduling_booking_intent(text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.get_voice_transcript_message_id(text, text) from public, anon, authenticated;
grant execute on function public.create_web_chat_session(uuid, text, text, text), public.append_web_chat_message(text, uuid, text, text), public.get_web_chat_messages(text, timestamptz), public.claim_sms_delivery_submission(uuid), public.get_conversation_scheduling_context(uuid), public.create_conversation_booking_candidates(uuid, jsonb), public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid), public.claim_voice_scheduling_booking_intent(text, uuid, text, uuid), public.get_scheduling_booking_execution_context(uuid), public.record_scheduling_booking_provider_success(uuid, text, text), public.complete_scheduling_booking_intent(uuid), public.fail_scheduling_booking_intent(uuid, text, text), public.set_sms_phone_number_enabled(uuid, boolean) to service_role;
grant execute on function public.get_message_agent_context(uuid) to service_role;
grant execute on function public.set_sms_phone_number_enabled_for_user(uuid, uuid, boolean) to service_role;
grant execute on function public.get_sms_phone_number_for_user(uuid, uuid) to service_role;
grant execute on function public.get_voice_transcript_message_id(text, text) to service_role;

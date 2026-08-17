-- Phase 7 follow-up: transport identity must be immutable, handoff acknowledgements must be
-- bounded to their triggering turn, and delivery state must follow explicit transitions.

alter table public.messages add column transport_sender_e164 text;
alter table public.messages add constraint messages_transport_sender_e164_check
  check (transport_sender_e164 is null or transport_sender_e164 ~ E'^\\+[1-9][0-9]{7,14}$');

alter table public.calls add column transport_caller_e164 text;
alter table public.calls add constraint calls_transport_caller_e164_check
  check (transport_caller_e164 is null or transport_caller_e164 ~ E'^\\+[1-9][0-9]{7,14}$');

alter table public.booking_intents add column trusted_transport_phone_e164 text;
alter table public.booking_intents add constraint booking_intents_trusted_transport_phone_e164_check
  check (trusted_transport_phone_e164 is null or trusted_transport_phone_e164 ~ E'^\\+[1-9][0-9]{7,14}$');

create function public.enforce_message_transport_sender_e164()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.transport_sender_e164 is not null and new.transport_sender_e164 !~ E'^\\+[1-9][0-9]{7,14}$' then
    raise exception using errcode = '22023', message = 'Transport sender identity is invalid';
  end if;
  if new.transport_sender_e164 is not null
    and (new.direction <> 'inbound' or new.source_channel <> 'sms' or new.author_type <> 'customer') then
    raise exception using errcode = '22023', message = 'Transport sender identity is only valid for inbound SMS';
  end if;
  if tg_op = 'UPDATE' and new.transport_sender_e164 is distinct from old.transport_sender_e164 then
    raise exception using errcode = '22023', message = 'Transport sender identity is immutable';
  end if;
  return new;
end;
$$;

create trigger messages_enforce_transport_sender_e164
before insert or update on public.messages
for each row execute function public.enforce_message_transport_sender_e164();

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
    insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, idempotency_key)
    values (route.organization_id, route.location_id, conversation_row.id,
      'Inbound SMS media cannot be processed automatically.', 'customer', 'normal',
      'message:' || saved_message_id::text || ':media-unsupported') on conflict do nothing;
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

create function public.enforce_call_transport_caller_e164()
returns trigger language plpgsql set search_path = '' as $$
declare trusted_caller text := nullif(current_setting('avenlyo.trusted_voice_caller_e164', true), '');
begin
  if tg_op = 'INSERT' and new.transport_caller_e164 is null and trusted_caller ~ E'^\\+[1-9][0-9]{7,14}$' then
    new.transport_caller_e164 := trusted_caller;
  end if;
  if new.transport_caller_e164 is not null and new.transport_caller_e164 !~ E'^\\+[1-9][0-9]{7,14}$' then
    raise exception using errcode = '22023', message = 'Transport caller identity is invalid';
  end if;
  if tg_op = 'UPDATE' and new.transport_caller_e164 is distinct from old.transport_caller_e164 then
    raise exception using errcode = '22023', message = 'Transport caller identity is immutable';
  end if;
  return new;
end;
$$;

create trigger calls_enforce_transport_caller_e164
before insert or update on public.calls
for each row execute function public.enforce_call_transport_caller_e164();

create function public.enforce_booking_intent_transport_phone()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.trusted_transport_phone_e164 is not null and new.trusted_transport_phone_e164 !~ E'^\\+[1-9][0-9]{7,14}$' then
    raise exception using errcode = '22023', message = 'Trusted booking phone is invalid';
  end if;
  if tg_op = 'UPDATE' and new.trusted_transport_phone_e164 is distinct from old.trusted_transport_phone_e164 then
    raise exception using errcode = '22023', message = 'Trusted booking phone is immutable';
  end if;
  return new;
end;
$$;

create trigger booking_intents_enforce_transport_phone
before insert or update on public.booking_intents
for each row execute function public.enforce_booking_intent_transport_phone();

-- Preserve the caller identity that the verified voice ingress received before older bootstrap
-- logic looks up or creates a mutable contact. The legacy implementation remains inaccessible.
alter function public.bootstrap_inbound_voice_call(text, text, text, text, text, text)
  rename to bootstrap_inbound_voice_call_legacy;

create function public.bootstrap_inbound_voice_call(
  target_event_id text,
  target_event_type text,
  target_external_call_id text,
  target_sip_call_id text,
  target_dialed_e164 text,
  target_caller_e164 text default null
)
returns table (
  is_duplicate boolean, accepted boolean, call_record_id uuid, conversation_id uuid, contact_id uuid,
  organization_id uuid, location_id uuid, phone_number_id uuid, primary_industry_id text,
  organization_name text, business_phone text, website_url text, location_name text,
  location_timezone text, location_address jsonb, business_hours jsonb, voice text,
  transfer_enabled boolean, provider_transfer_enabled boolean, transfer_target_e164 text
)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_voice_service_role();
  perform set_config(
    'avenlyo.trusted_voice_caller_e164',
    case when target_caller_e164 ~ E'^\\+[1-9][0-9]{7,14}$' then target_caller_e164 else '' end,
    true
  );
  return query select * from public.bootstrap_inbound_voice_call_legacy(
    target_event_id, target_event_type, target_external_call_id, target_sip_call_id,
    target_dialed_e164, target_caller_e164
  );
end;
$$;

revoke all on function public.bootstrap_inbound_voice_call_legacy(text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.bootstrap_inbound_voice_call(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_inbound_voice_call(text, text, text, text, text, text)
  to service_role;

create or replace function public.get_voice_scheduling_context(target_call_id text)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, caller_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select call.organization_id, call.location_id, call.conversation_id, call.contact_id,
    call.transport_caller_e164, nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''),
    integration.id, integration.provider, location.timezone, location.business_hours, settings.minimum_lead_minutes
  from public.calls as call
  join public.locations as location on location.organization_id = call.organization_id and location.id = call.location_id
  join public.location_scheduling_settings as settings on settings.organization_id = call.organization_id and settings.location_id = call.location_id
  join public.integrations as integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id and integration.status = 'connected'
  left join public.contacts as contact on contact.organization_id = call.organization_id and contact.id = call.contact_id
  where call.provider = 'openai-realtime-sip' and call.external_call_id = target_call_id;
end;
$$;

-- A one-argument context remains for candidate discovery, but never reads a mutable contact
-- phone. The two-argument form binds SMS identity to the exact triggering inbound message.
create or replace function public.get_conversation_scheduling_context(target_conversation_id uuid)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, trusted_transport_phone_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer, channel_type text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select conversation.organization_id, conversation.location_id, conversation.id, conversation.contact_id,
    null::text, nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), integration.id, integration.provider,
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

create function public.get_conversation_scheduling_context(target_conversation_id uuid, target_inbound_message_id uuid)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, trusted_transport_phone_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer, channel_type text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query
  select conversation.organization_id, conversation.location_id, conversation.id, conversation.contact_id,
    case
      when channel.channel_type = 'sms' then inbound.transport_sender_e164
      when channel.channel_type = 'phone' then voice_call.transport_caller_e164
      else null
    end,
    nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), integration.id, integration.provider,
    location.timezone, location.business_hours, settings.minimum_lead_minutes, channel.channel_type
  from public.conversations conversation
  join public.locations location on location.organization_id = conversation.organization_id and location.id = conversation.location_id
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  join public.location_scheduling_settings settings on settings.organization_id = conversation.organization_id and settings.location_id = conversation.location_id
  join public.integrations integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id and integration.status = 'connected'
  left join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  left join public.messages inbound on inbound.organization_id = conversation.organization_id
    and inbound.conversation_id = conversation.id and inbound.id = target_inbound_message_id
    and inbound.direction = 'inbound' and inbound.author_type = 'customer' and inbound.source_channel = 'sms'
  left join lateral (
    select call.transport_caller_e164
    from public.calls call
    where call.organization_id = conversation.organization_id and call.conversation_id = conversation.id
      and call.direction = 'inbound' and call.provider = 'openai-realtime-sip'
    order by call.created_at desc, call.id desc limit 1
  ) voice_call on channel.channel_type = 'phone'
  where conversation.id = target_conversation_id and conversation.mode = 'customer';
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
language plpgsql security definer set search_path = '' as $$
declare context record; candidate public.booking_candidates%rowtype; existing public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role();
  select * into context from public.get_conversation_scheduling_context(target_conversation_id, target_inbound_message_id);
  if context.integration_id is null then raise exception using errcode = '42501', message = 'Bookable scheduling integration is not available'; end if;
  if context.provider = 'ezyvet' and (context.trusted_transport_phone_e164 is null
    or length(btrim(coalesce(resolved_contact_uid, ''))) = 0
    or length(btrim(coalesce(resolved_subject_uid, ''))) = 0
    or length(btrim(coalesce(resolved_subject_name, ''))) not between 1 and 80) then
    raise exception using errcode = '22023', message = 'Resolved ezyVet booking identity is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-candidate:' || target_candidate_id::text, 0));
  select * into candidate from public.booking_candidates where id = target_candidate_id
    and organization_id = context.organization_id and location_id = context.location_id
    and conversation_id = context.conversation_id and integration_id = context.integration_id;
  if candidate.id is null or candidate.status <> 'offered' or candidate.expires_at <= now() then
    raise exception using errcode = '42501', message = 'Booking candidate is not available';
  end if;
  select * into existing from public.booking_intents where organization_id = candidate.organization_id and candidate_id = candidate.id;
  if existing.id is not null then
    return query select existing.id, appointment_type.name, candidate.starts_at, candidate.timezone, existing.status
      from public.scheduling_appointment_types appointment_type
      where appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id;
    return;
  end if;
  insert into public.booking_intents (
    organization_id, location_id, conversation_id, integration_id, candidate_id, contact_id,
    external_contact_uid, external_subject_uid, subject_name, trusted_transport_phone_e164
  ) values (
    candidate.organization_id, candidate.location_id, candidate.conversation_id, candidate.integration_id,
    candidate.id, coalesce(trusted_contact_id, context.contact_id), nullif(btrim(coalesce(resolved_contact_uid, '')), ''),
    nullif(btrim(coalesce(resolved_subject_uid, '')), ''), nullif(btrim(coalesce(resolved_subject_name, '')), ''),
    context.trusted_transport_phone_e164
  ) returning id into existing.id;
  update public.booking_candidates set status = 'consumed', updated_at = now() where id = candidate.id;
  return query select existing.id, appointment_type.name, candidate.starts_at, candidate.timezone, existing.status
    from public.scheduling_appointment_types appointment_type
    where appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id;
end;
$$;

create or replace function public.get_voice_booking_execution_context(target_booking_intent_id uuid)
returns table (booking_intent_id uuid, organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, integration_id uuid, provider text, external_contact_uid text, external_subject_uid text, subject_name text, trusted_phone_e164 text, customer_display_name text, appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, resource_uid text, resource_name text, starts_at timestamptz, ends_at timestamptz, timezone text, business_hours jsonb, minimum_lead_minutes integer, provider_appointment_id text, provider_booking_status text, intent_status text, current_write_eligible boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select intent.id, intent.organization_id, intent.location_id, intent.conversation_id, intent.contact_id,
    intent.integration_id, integration.provider, intent.external_contact_uid, intent.external_subject_uid, intent.subject_name,
    intent.trusted_transport_phone_e164, nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), appointment_type.external_uid,
    appointment_type.name, appointment_type.default_duration_minutes, resource.external_uid, resource.name, candidate.starts_at,
    candidate.ends_at, candidate.timezone, location.business_hours, coalesce(settings.minimum_lead_minutes, 60),
    intent.provider_appointment_id, intent.provider_booking_status, intent.status,
    coalesce((intent.status = 'booking' and integration.status = 'connected' and settings.active_integration_id = intent.integration_id
      and appointment_type.active and appointment_type.bookable and resource.active and resource.bookable
      and (integration.provider = 'ezyvet' or exists (
        select 1 from public.scheduling_appointment_type_resources mapping
        where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id
          and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id
          and mapping.resource_id = resource.id
      ))), false)
  from public.booking_intents intent
  join public.booking_candidates candidate on candidate.organization_id = intent.organization_id and candidate.id = intent.candidate_id and candidate.integration_id = intent.integration_id
  join public.integrations integration on integration.organization_id = intent.organization_id and integration.id = intent.integration_id
  join public.locations location on location.organization_id = intent.organization_id and location.id = intent.location_id
  left join public.location_scheduling_settings settings on settings.organization_id = intent.organization_id and settings.location_id = intent.location_id
  join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
  join public.scheduling_resources resource on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id and resource.integration_id = intent.integration_id
  left join public.contacts contact on contact.organization_id = intent.organization_id and contact.id = intent.contact_id
  where intent.id = target_booking_intent_id and intent.status in ('booking', 'provider_success_pending_persistence');
end;
$$;

-- Delivery states deliberately model truth, not a monotonic rank. A REST SID proves only that
-- Twilio accepted the submission; later callbacks may advance it through the valid graph.
alter table public.message_deliveries drop constraint message_deliveries_status_check;
alter table public.message_deliveries drop column status_rank;
alter table public.message_deliveries add constraint message_deliveries_status_check
  check (status in ('queued', 'submitting', 'submitted', 'sent', 'delivered', 'failed', 'undelivered', 'unknown', 'suppressed'));

create function public.normalized_twilio_delivery_status(target_status text)
returns text language plpgsql immutable set search_path = '' as $$
declare normalized text := lower(btrim(coalesce(target_status, '')));
begin
  if normalized in ('queued', 'accepted', 'sending') then return 'submitted'; end if;
  if normalized in ('sent', 'delivered', 'failed', 'undelivered') then return normalized; end if;
  return null;
end;
$$;

create function public.can_transition_message_delivery(current_status text, next_status text)
returns boolean language sql immutable set search_path = '' as $$
  select current_status = next_status or (current_status = 'queued' and next_status in ('submitting', 'submitted', 'sent', 'delivered', 'failed', 'undelivered', 'suppressed'))
    or (current_status = 'submitting' and next_status in ('submitted', 'sent', 'delivered', 'failed', 'undelivered', 'unknown'))
    or (current_status = 'submitted' and next_status in ('sent', 'delivered', 'failed', 'undelivered'))
    or (current_status = 'sent' and next_status in ('delivered', 'undelivered'));
$$;

create or replace function public.claim_sms_delivery_submission(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql security definer set search_path = '' as $$
declare delivery public.message_deliveries%rowtype; message public.messages%rowtype; conversation public.conversations%rowtype; phone public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into delivery from public.message_deliveries as message_delivery
    where message_delivery.message_id = target_message_id and message_delivery.provider = 'twilio' for update;
  if delivery.id is null or delivery.status <> 'queued' then return; end if;
  select * into message from public.messages where id = delivery.message_id;
  select * into conversation from public.conversations where organization_id = message.organization_id and id = message.conversation_id;
  select * into phone from public.phone_numbers where organization_id = message.organization_id and id = conversation.transport_phone_number_id;
  if conversation.id is null or phone.id is null or phone.status <> 'active' or not phone.sms_enabled
    or exists (select 1 from public.messaging_contact_preferences preference
      where preference.organization_id = message.organization_id and preference.location_id = conversation.location_id
        and preference.contact_id = conversation.contact_id and preference.channel_type = 'sms'
        and preference.sender_phone_number_id = phone.id and preference.status = 'opted_out') then
    update public.message_deliveries as message_delivery set status = 'suppressed', error_code = 'delivery_suppressed', updated_at = now()
      where message_delivery.id = delivery.id;
    return;
  end if;
  if message.body is null or conversation.contact_id is null then
    update public.message_deliveries as message_delivery set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
      where message_delivery.id = delivery.id;
    return;
  end if;
  -- Replies travel only to the immutable triggering transport identity, never a later contact edit.
  select inbound.transport_sender_e164 into to_e164
  from public.messages inbound
  where inbound.organization_id = message.organization_id and inbound.conversation_id = message.conversation_id
    and inbound.id = message.in_reply_to_message_id and inbound.direction = 'inbound'
    and inbound.source_channel = 'sms' and inbound.author_type = 'customer';
  if to_e164 is null then
    update public.message_deliveries as message_delivery set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
      where message_delivery.id = delivery.id;
    return;
  end if;
  update public.message_deliveries as message_delivery set status = 'submitting', attempted_at = now(), updated_at = now()
    where message_delivery.id = delivery.id;
  return query select message.id, delivery.id, to_e164, phone.phone_number, message.body, 'submitting'::text;
end;
$$;

create or replace function public.get_sms_delivery_execution_context(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language sql stable security definer set search_path = '' as $$
  select message.id, delivery.id, inbound.transport_sender_e164, phone.phone_number, message.body, delivery.status
  from public.messages message
  join public.message_deliveries delivery on delivery.organization_id = message.organization_id and delivery.message_id = message.id
  join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  join public.phone_numbers phone on phone.organization_id = conversation.organization_id and phone.id = conversation.transport_phone_number_id
  join public.messages inbound on inbound.organization_id = message.organization_id and inbound.conversation_id = message.conversation_id
    and inbound.id = message.in_reply_to_message_id and inbound.direction = 'inbound'
    and inbound.source_channel = 'sms' and inbound.author_type = 'customer'
  where message.id = target_message_id and message.direction = 'outbound' and message.source_channel = 'sms'
    and delivery.provider = 'twilio' and delivery.status in ('queued', 'submitting');
$$;

drop function public.record_sms_delivery_submission(uuid, text);
create function public.record_sms_delivery_submission(target_message_id uuid, target_provider_message_id text, target_provider_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare next_status text := public.normalized_twilio_delivery_status(target_provider_status);
begin
  perform public.require_messaging_service_role();
  if target_provider_message_id !~ '^SM[a-zA-Z0-9]{32}$' or next_status is null then
    raise exception using errcode = '22023', message = 'Twilio submission is invalid';
  end if;
  update public.message_deliveries set provider_message_id = target_provider_message_id, status = next_status,
    sent_at = case when next_status in ('sent', 'delivered') then now() else sent_at end,
    delivered_at = case when next_status = 'delivered' then now() else delivered_at end, updated_at = now()
  where message_id = target_message_id and provider = 'twilio' and status = 'submitting';
end;
$$;

create or replace function public.mark_sms_delivery_unknown(target_message_id uuid, target_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  update public.message_deliveries set status = 'unknown', error_code = left(nullif(btrim(target_error_code), ''), 120), updated_at = now()
    where message_id = target_message_id and provider = 'twilio' and status = 'submitting';
end;
$$;

create or replace function public.claim_message_processing_jobs(target_worker_id text, target_limit integer default 5)
returns table (job_id uuid, job_kind text, message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Worker claim is invalid';
  end if;
  update public.message_deliveries delivery set status = 'unknown', error_code = 'stale_submission_unknown', updated_at = now()
  from public.message_processing_jobs job
  where job.message_id = delivery.message_id and job.job_kind = 'outbound_delivery' and job.status = 'processing'
    and job.claimed_at < now() - interval '5 minutes' and delivery.provider = 'twilio' and delivery.status = 'submitting';
  update public.message_processing_jobs job set status = 'completed', completed_at = now(), claimed_at = null, claimed_by = null,
    last_error_code = 'stale_submission_unknown', updated_at = now()
  where job.status = 'processing' and job.claimed_at < now() - interval '5 minutes'
    and job.job_kind = 'outbound_delivery' and exists (
      select 1 from public.message_deliveries delivery
      where delivery.message_id = job.message_id and delivery.provider = 'twilio' and delivery.status = 'unknown'
    );
  update public.message_processing_jobs set status = 'queued', claimed_at = null, claimed_by = null, available_at = now(), updated_at = now()
    where status = 'processing' and claimed_at < now() - interval '5 minutes';
  return query
  with claimed as (
    select job.id from public.message_processing_jobs as job where job.status = 'queued' and job.available_at <= now()
    order by job.created_at asc for update skip locked limit target_limit
  ), updated as (
    update public.message_processing_jobs job set status = 'processing', attempts = job.attempts + 1, claimed_at = now(),
      claimed_by = btrim(target_worker_id), updated_at = now() from claimed where job.id = claimed.id returning job.*
  ) select updated.id, updated.job_kind, updated.message_id, updated.conversation_id, updated.organization_id,
      updated.location_id, updated.attempts from updated;
end;
$$;

create or replace function public.record_twilio_message_status(target_provider_message_id text, target_status text, target_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare existing public.message_deliveries%rowtype; next_status text := public.normalized_twilio_delivery_status(target_status);
begin
  perform public.require_messaging_service_role();
  if target_provider_message_id !~ '^SM[a-zA-Z0-9]{32}$' or next_status is null then
    raise exception using errcode = '22023', message = 'Twilio status payload is invalid';
  end if;
  select * into existing from public.message_deliveries where provider = 'twilio' and provider_message_id = target_provider_message_id for update;
  if existing.id is null or not public.can_transition_message_delivery(existing.status, next_status) then return; end if;
  update public.message_deliveries set status = next_status,
    error_code = coalesce(left(nullif(btrim(target_error_code), ''), 120), error_code),
    sent_at = case when next_status in ('sent', 'delivered') then coalesce(sent_at, now()) else sent_at end,
    delivered_at = case when next_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
    updated_at = now() where id = existing.id;
end;
$$;

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
  select exists(select 1 from public.messaging_contact_preferences preference where preference.organization_id = conversation_row.organization_id
    and preference.location_id = conversation_row.location_id and preference.contact_id = conversation_row.contact_id
    and preference.channel_type = 'sms' and preference.sender_phone_number_id = conversation_row.transport_phone_number_id
    and preference.status = 'opted_out') into contact_opted_out;
  if channel_row.channel_type = 'sms' and contact_opted_out then raise exception using errcode = '42501', message = 'SMS contact has opted out'; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_by_user_id, sent_at)
  values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, conversation_row.contact_id, 'outbound', 'text', btrim(target_body),
    jsonb_build_object('transport', channel_row.channel_type), channel_row.channel_type, 'human', auth.uid(), now()) returning id into saved_message_id;
  if channel_row.channel_type = 'sms' then
    insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, saved_message_id, 'outbound_delivery');
  else
    insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, sent_at) values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'web_chat', 'sent', now());
  end if;
  update public.conversations set ai_mode = 'human', assigned_user_id = auth.uid(), last_message_at = now(), updated_at = now() where id = conversation_row.id;
  return query select saved_message_id, channel_row.channel_type;
end;
$$;

create or replace function public.request_message_handoff(target_inbound_message_id uuid, target_tool_call_id text, target_reason text, target_urgency text default 'normal')
returns table (handoff_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; existing_id uuid; idempotency text; was_created boolean := false;
begin
  perform public.require_messaging_service_role();
  if target_urgency not in ('normal', 'urgent') or length(btrim(coalesce(target_reason, ''))) not between 3 and 500
    or length(btrim(coalesce(target_tool_call_id, ''))) = 0 then raise exception using errcode = '22023', message = 'Message handoff is invalid'; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and direction = 'inbound';
  if inbound.id is null then raise exception using errcode = '42501', message = 'Inbound message is unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message-handoff:' || inbound.id::text, 0));
  idempotency := 'message:' || inbound.id::text || ':' || target_tool_call_id;
  select id into existing_id from public.handoffs where organization_id = inbound.organization_id and idempotency_key = idempotency;
  if existing_id is null then
    insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, idempotency_key)
    values (inbound.organization_id, inbound.location_id, inbound.conversation_id, btrim(target_reason), 'customer', target_urgency, idempotency)
    returning id into existing_id;
    was_created := true;
  end if;
  update public.conversations set ai_mode = 'human', updated_at = now()
    where organization_id = inbound.organization_id and id = inbound.conversation_id;
  return query select existing_id, was_created;
end;
$$;

create or replace function public.persist_ai_message_reply(target_inbound_message_id uuid, target_body text, target_handoff_requested boolean default false)
returns table (message_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; conversation_row public.conversations%rowtype; channel_row public.channels%rowtype; saved_message_id uuid; opted_out boolean; has_turn_handoff boolean;
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then raise exception using errcode = '22023', message = 'Assistant reply is invalid'; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and direction = 'inbound';
  if inbound.id is null then raise exception using errcode = '42501', message = 'Inbound message is unavailable'; end if;
  select * into conversation_row from public.conversations where organization_id = inbound.organization_id and id = inbound.conversation_id for update;
  select exists(select 1 from public.handoffs handoff where handoff.organization_id = inbound.organization_id
    and handoff.conversation_id = inbound.conversation_id and handoff.idempotency_key like ('message:' || inbound.id::text || ':%')) into has_turn_handoff;
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

-- Keep all public APIs service-only and remove the obsolete, contact-derived preparation path.
revoke all on function public.bootstrap_inbound_sms(text, text, text, text, jsonb, jsonb),
  public.get_conversation_scheduling_context(uuid, uuid),
  public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid, uuid),
  public.record_sms_delivery_submission(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.bootstrap_inbound_sms(text, text, text, text, jsonb, jsonb),
  public.get_conversation_scheduling_context(uuid, uuid),
  public.prepare_conversation_scheduling_booking_intent(uuid, uuid, text, text, text, uuid, uuid),
  public.record_sms_delivery_submission(uuid, text, text)
  to service_role;

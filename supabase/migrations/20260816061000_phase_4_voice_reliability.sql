-- Phase 4 reliability hardening. Keep provider-call replay and handoff deduplication durable.

create or replace function public.bootstrap_inbound_voice_call(
  target_event_id text,
  target_event_type text,
  target_external_call_id text,
  target_sip_call_id text,
  target_dialed_e164 text,
  target_caller_e164 text default null
)
returns table (
  is_duplicate boolean,
  accepted boolean,
  call_record_id uuid,
  conversation_id uuid,
  contact_id uuid,
  organization_id uuid,
  location_id uuid,
  phone_number_id uuid,
  primary_industry_id text,
  organization_name text,
  business_phone text,
  website_url text,
  location_name text,
  location_timezone text,
  location_address jsonb,
  business_hours jsonb,
  voice text,
  transfer_enabled boolean,
  provider_transfer_enabled boolean,
  transfer_target_e164 text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  route record;
  existing_event public.voice_webhook_events%rowtype;
  existing_call public.calls%rowtype;
  routed_contact_id uuid;
  routed_channel_id uuid;
  routed_conversation_id uuid;
  routed_call_id uuid;
begin
  perform public.require_voice_service_role();
  if length(btrim(coalesce(target_event_id, ''))) = 0
    or target_event_type <> 'realtime.call.incoming'
    or length(btrim(coalesce(target_external_call_id, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Incoming voice webhook is invalid';
  end if;

  -- The provider call identity serializes all of its webhook deliveries. This check precedes
  -- insertion because event_type + external_call_id is intentionally unique.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_external_call_id, 0)
  );
  select * into existing_event
  from public.voice_webhook_events
  where event_id = target_event_id;
  if existing_event.event_id is not null then
    return query select true, false, existing_event.call_id, null::uuid, null::uuid,
      existing_event.organization_id, existing_event.location_id, null::uuid, null::text,
      null::text, null::text, null::text, null::text, null::text, null::jsonb, null::jsonb,
      null::text, false, false, null::text;
    return;
  end if;

  select * into existing_event
  from public.voice_webhook_events
  where event_type = target_event_type and external_call_id = target_external_call_id;
  if existing_event.event_id is not null then
    return query select true, false, existing_event.call_id, null::uuid, null::uuid,
      existing_event.organization_id, existing_event.location_id, null::uuid, null::text,
      null::text, null::text, null::text, null::text, null::text, null::jsonb, null::jsonb,
      null::text, false, false, null::text;
    return;
  end if;

  insert into public.voice_webhook_events (event_id, event_type, external_call_id)
  values (target_event_id, target_event_type, target_external_call_id)
  on conflict do nothing;
  if not found then
    return query select true, false, null::uuid, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::jsonb, null::jsonb, null::text, false, false, null::text;
    return;
  end if;

  if target_dialed_e164 is null or target_dialed_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    update public.voice_webhook_events set status = 'rejected', processed_at = now()
    where event_id = target_event_id;
    return query select false, false, null::uuid, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::jsonb, null::jsonb, null::text, false, false, null::text;
    return;
  end if;

  select
    number.id as phone_number_id,
    number.organization_id,
    number.location_id,
    configuration.enabled,
    configuration.voice,
    configuration.transfer_enabled,
    configuration.provider_transfer_enabled,
    configuration.transfer_target_e164,
    organization.primary_industry_id,
    organization.name as organization_name,
    organization.business_phone,
    organization.website_url,
    location.name as location_name,
    location.timezone as location_timezone,
    location.address as location_address,
    location.business_hours
  into route
  from public.phone_numbers as number
  join public.voice_configurations as configuration
    on configuration.organization_id = number.organization_id
    and configuration.location_id = number.location_id
  join public.organizations as organization on organization.id = number.organization_id
  join public.locations as location
    on location.organization_id = number.organization_id and location.id = number.location_id
  where number.provider = 'twilio'
    and number.status = 'active'
    and number.phone_number = target_dialed_e164
    and configuration.enabled
    and organization.primary_industry_id in ('veterinary', 'auto-repair', 'medspa');
  if route.phone_number_id is null then
    update public.voice_webhook_events set status = 'rejected', processed_at = now()
    where event_id = target_event_id;
    return query select false, false, null::uuid, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::jsonb, null::jsonb, null::text, false, false, null::text;
    return;
  end if;

  select * into existing_call from public.calls
  where provider = 'openai-realtime-sip' and external_call_id = target_external_call_id;
  if existing_call.id is not null then
    update public.voice_webhook_events set
      organization_id = existing_call.organization_id,
      location_id = existing_call.location_id,
      call_id = existing_call.id,
      status = 'processed',
      processed_at = now()
    where event_id = target_event_id;
    return query select true, false, existing_call.id, existing_call.conversation_id,
      existing_call.contact_id, route.organization_id, route.location_id, route.phone_number_id,
      route.primary_industry_id, route.organization_name, route.business_phone, route.website_url,
      route.location_name, route.location_timezone, route.location_address, route.business_hours,
      route.voice, route.transfer_enabled, route.provider_transfer_enabled, route.transfer_target_e164;
    return;
  end if;

  if target_caller_e164 is not null and target_caller_e164 ~ '^\+[1-9][0-9]{7,14}$' then
    select contact.id into routed_contact_id from public.contacts as contact
    where contact.organization_id = route.organization_id
      and contact.phone = target_caller_e164
      and (contact.location_id = route.location_id or contact.location_id is null)
    order by (contact.location_id = route.location_id) desc, contact.created_at asc
    limit 1;
    if routed_contact_id is null then
      insert into public.contacts (organization_id, location_id, phone, metadata)
      values (route.organization_id, route.location_id, target_caller_e164,
        jsonb_build_object('source', 'inbound_voice'))
      returning id into routed_contact_id;
    end if;
  end if;

  select channel.id into routed_channel_id from public.channels as channel
  where channel.organization_id = route.organization_id
    and channel.location_id = route.location_id
    and channel.channel_type = 'phone'
    and channel.configuration ->> 'phone_number_id' = route.phone_number_id::text
  order by channel.created_at asc limit 1;
  if routed_channel_id is null then
    insert into public.channels (organization_id, location_id, channel_type, display_name, status,
      configuration)
    values (route.organization_id, route.location_id, 'phone', 'Inbound voice', 'active',
      jsonb_build_object('phone_number_id', route.phone_number_id, 'provider', 'twilio'))
    returning id into routed_channel_id;
  end if;

  insert into public.conversations (
    organization_id, location_id, contact_id, channel_id, status, mode, metadata, last_message_at
  ) values (
    route.organization_id, route.location_id, routed_contact_id, routed_channel_id, 'open',
    'customer', jsonb_build_object('channel', 'voice', 'provider', 'openai-realtime-sip'), now()
  ) returning id into routed_conversation_id;
  insert into public.calls (
    organization_id, location_id, conversation_id, contact_id, phone_number_id, direction, status,
    provider, external_call_id, sip_call_id, started_at, metadata
  ) values (
    route.organization_id, route.location_id, routed_conversation_id, routed_contact_id,
    route.phone_number_id, 'inbound', 'ringing', 'openai-realtime-sip', target_external_call_id,
    nullif(btrim(coalesce(target_sip_call_id, '')), ''), now(),
    jsonb_build_object('source', 'inbound_voice')
  ) returning id into routed_call_id;
  update public.voice_webhook_events set
    organization_id = route.organization_id,
    location_id = route.location_id,
    call_id = routed_call_id,
    status = 'bootstrapped'
  where event_id = target_event_id;
  return query select false, true, routed_call_id, routed_conversation_id, routed_contact_id,
    route.organization_id, route.location_id, route.phone_number_id, route.primary_industry_id,
    route.organization_name, route.business_phone, route.website_url, route.location_name,
    route.location_timezone, route.location_address, route.business_hours, route.voice,
    route.transfer_enabled, route.provider_transfer_enabled, route.transfer_target_e164;
end;
$$;

create or replace function public.request_inbound_voice_handoff(
  target_call_id text,
  target_tool_call_id text,
  target_reason text,
  target_urgency text default 'normal'
)
returns table (handoff_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_call public.calls%rowtype;
  existing_id uuid;
  idempotency text;
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

  -- Transcript safety, model tools, and transfer pre-handoffs converge on one durable
  -- customer handoff for a call. The advisory lock makes that invariant race-safe.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('voice-handoff:' || target_call.id::text, 0)
  );
  idempotency := 'voice:' || target_call_id || ':' || target_tool_call_id;
  select id into existing_id from public.handoffs
  where organization_id = target_call.organization_id and idempotency_key = idempotency;
  if existing_id is not null then
    return query select existing_id, false;
    return;
  end if;
  select id into existing_id from public.handoffs
  where organization_id = target_call.organization_id
    and call_id = target_call.id
    and mode = 'customer'
  order by created_at asc
  limit 1;
  if existing_id is not null then
    return query select existing_id, false;
    return;
  end if;

  insert into public.handoffs (
    organization_id, location_id, conversation_id, call_id, reason, mode, urgency, idempotency_key
  ) values (
    target_call.organization_id, target_call.location_id, target_call.conversation_id, target_call.id,
    btrim(target_reason), 'customer', target_urgency, idempotency
  ) returning id into existing_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (target_call.organization_id, target_call.location_id, 'voice.handoff.requested', 'handoff',
    existing_id, jsonb_build_object('provider', 'openai-realtime-sip', 'urgency', target_urgency));
  return query select existing_id, true;
end;
$$;

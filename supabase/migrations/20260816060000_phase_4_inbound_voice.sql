-- Phase 4: trusted inbound voice routing for OpenAI Realtime SIP. These primitives are additive;
-- service-role RPCs own unauthenticated provider work while dashboard configuration remains admin-only.

alter table public.phone_numbers
  add column provider text not null default 'twilio'
    check (provider in ('twilio')),
  add constraint phone_numbers_e164_check
    check (phone_number ~ '^\+[1-9][0-9]{7,14}$');

create unique index phone_numbers_provider_e164_key
  on public.phone_numbers (provider, phone_number);

alter table public.calls
  add column provider text,
  add column external_call_id text,
  add column sip_call_id text,
  add column answered_at timestamptz,
  add column end_reason text;

alter table public.calls drop constraint if exists calls_status_check;
alter table public.calls
  add constraint calls_status_check
    check (status in ('initiated', 'ringing', 'in_progress', 'transferred', 'completed', 'failed', 'rejected')),
  add constraint calls_provider_check
    check (provider is null or provider in ('openai-realtime-sip')),
  add constraint calls_end_reason_check
    check (end_reason is null or end_reason in (
      'caller_hangup', 'hard_duration_limit', 'idle_timeout', 'provider_error',
      'sideband_closed', 'transfer', 'unknown'
    ));

create unique index calls_provider_external_call_id_key
  on public.calls (provider, external_call_id)
  where external_call_id is not null;

create table public.voice_configurations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  ai_agent_id uuid,
  enabled boolean not null default false,
  voice text not null default 'marin'
    check (voice in ('alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar')),
  transfer_enabled boolean not null default false,
  provider_transfer_enabled boolean not null default false,
  transfer_target_e164 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voice_configurations_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint voice_configurations_agent_fk
    foreign key (organization_id, ai_agent_id)
    references public.ai_agents (organization_id, id),
  constraint voice_configurations_target_check
    check (
      (not transfer_enabled and transfer_target_e164 is null)
      or (transfer_enabled and transfer_target_e164 ~ '^\+[1-9][0-9]{7,14}$')
    ),
  constraint voice_configurations_organization_location_key unique (organization_id, location_id),
  constraint voice_configurations_organization_id_id_key unique (organization_id, id)
);

create trigger set_voice_configurations_updated_at
  before update on public.voice_configurations
  for each row execute procedure public.set_updated_at();

create table public.voice_webhook_events (
  event_id text primary key,
  event_type text not null check (event_type = 'realtime.call.incoming'),
  external_call_id text not null,
  organization_id uuid references public.organizations (id) on delete set null,
  location_id uuid,
  call_id uuid,
  status text not null default 'received'
    check (status in ('received', 'bootstrapped', 'processed', 'rejected', 'failed', 'ignored')),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voice_webhook_events_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint voice_webhook_events_call_fk
    foreign key (organization_id, call_id)
    references public.calls (organization_id, id)
);

create trigger set_voice_webhook_events_updated_at
  before update on public.voice_webhook_events
  for each row execute procedure public.set_updated_at();

create unique index voice_webhook_events_provider_call_type_key
  on public.voice_webhook_events (event_type, external_call_id);

alter table public.handoffs
  add column call_id uuid,
  add constraint handoffs_call_fk
    foreign key (organization_id, call_id)
    references public.calls (organization_id, id);

create index calls_voice_recent_idx on public.calls (organization_id, location_id, started_at desc)
  where provider = 'openai-realtime-sip';
create index voice_webhook_events_call_id_idx on public.voice_webhook_events (call_id);

alter table public.voice_configurations enable row level security;
alter table public.voice_webhook_events enable row level security;
revoke all on public.voice_configurations, public.voice_webhook_events from anon, authenticated;
grant select on public.voice_configurations to authenticated;

create policy voice_configurations_select_admin on public.voice_configurations
  for select to authenticated
  using (public.is_organization_admin(organization_id));

-- Provider DID ownership is operations-controlled. Dashboard users can read the assigned number,
-- but cannot claim/reassign it through direct table writes.
revoke insert, update, delete on public.phone_numbers from authenticated;

-- Existing operational-call policies remain available for non-provider future work, but a browser
-- must never manufacture or transition a provider-backed voice call. Its lifecycle is service-only.
drop policy calls_insert_member on public.calls;
drop policy calls_update_member on public.calls;
create policy calls_insert_member on public.calls
  for insert to authenticated
  with check (
    public.has_location_write_access(organization_id, location_id)
    and provider is null and external_call_id is null and sip_call_id is null
  );
create policy calls_update_member on public.calls
  for update to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and provider is null and external_call_id is null and sip_call_id is null
  )
  with check (
    public.has_location_write_access(organization_id, location_id)
    and provider is null and external_call_id is null and sip_call_id is null
  );

create function public.require_voice_service_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Voice backend access is required';
  end if;
end;
$$;

create function public.assign_voice_phone_number(
  target_organization_id uuid,
  target_location_id uuid,
  target_phone_number text,
  target_label text default null
)
returns table (phone_number_id uuid, phone_number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.phone_numbers%rowtype;
begin
  perform public.require_voice_service_role();
  if target_phone_number !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using errcode = '22023', message = 'Phone number must be canonical E.164';
  end if;
  if not exists (
    select 1 from public.locations
    where id = target_location_id and organization_id = target_organization_id
  ) then
    raise exception using errcode = '23503', message = 'Location does not belong to organization';
  end if;
  select * into existing from public.phone_numbers
  where provider = 'twilio' and phone_number = target_phone_number;
  if existing.id is not null then
    if existing.organization_id = target_organization_id and existing.location_id = target_location_id then
      return query select existing.id, existing.phone_number;
      return;
    end if;
    raise exception using errcode = '23505', message = 'Phone number is already assigned';
  end if;
  return query
  insert into public.phone_numbers (
    organization_id, location_id, phone_number, label, provider, status
  ) values (
    target_organization_id, target_location_id, target_phone_number,
    nullif(btrim(coalesce(target_label, '')), ''), 'twilio', 'active'
  ) returning id, phone_numbers.phone_number;
end;
$$;

create function public.upsert_my_voice_configuration(
  target_location_id uuid,
  target_enabled boolean,
  target_voice text,
  target_transfer_enabled boolean,
  target_transfer_target_e164 text
)
returns table (
  configuration_id uuid,
  enabled boolean,
  voice text,
  transfer_enabled boolean,
  transfer_target_e164 text,
  provider_transfer_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  select location.organization_id into workspace_id
  from public.locations as location
  where location.id = target_location_id
    and public.is_organization_admin(location.organization_id);
  if workspace_id is null then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;
  if target_voice not in ('alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar') then
    raise exception using errcode = '22023', message = 'Voice is invalid';
  end if;
  if target_transfer_enabled and target_transfer_target_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using errcode = '22023', message = 'Configured transfer is invalid';
  end if;
  return query
  insert into public.voice_configurations (
    organization_id, location_id, enabled, voice, transfer_enabled,
    transfer_target_e164, provider_transfer_enabled
  ) values (
    workspace_id, target_location_id, target_enabled, target_voice, target_transfer_enabled,
    case when target_transfer_enabled then target_transfer_target_e164 else null end, false
  )
  on conflict (organization_id, location_id) do update set
    enabled = excluded.enabled,
    voice = excluded.voice,
    transfer_enabled = excluded.transfer_enabled,
    transfer_target_e164 = excluded.transfer_target_e164
  returning id, voice_configurations.enabled, voice_configurations.voice,
    voice_configurations.transfer_enabled, voice_configurations.transfer_target_e164,
    voice_configurations.provider_transfer_enabled;
end;
$$;

-- Operations, not dashboard users, attest that the attached Twilio trunk can accept SIP REFER.
create function public.set_voice_provider_transfer_capability(
  target_organization_id uuid,
  target_location_id uuid,
  target_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_voice_service_role();
  update public.voice_configurations set provider_transfer_enabled = target_enabled
  where organization_id = target_organization_id and location_id = target_location_id;
  if not found then
    raise exception using errcode = '23503', message = 'Voice configuration is not available for location';
  end if;
end;
$$;

create function public.get_my_voice_configuration(target_location_id uuid)
returns table (
  configuration_id uuid,
  enabled boolean,
  voice text,
  transfer_enabled boolean,
  transfer_target_e164 text,
  provider_transfer_enabled boolean,
  assigned_phone_number text,
  realtime_model_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    configuration.id,
    coalesce(configuration.enabled, false),
    coalesce(configuration.voice, 'marin'),
    coalesce(configuration.transfer_enabled, false),
    configuration.transfer_target_e164,
    coalesce(configuration.provider_transfer_enabled, false),
    (
      select number.phone_number from public.phone_numbers as number
      where number.organization_id = location.organization_id
        and number.location_id = location.id
        and number.provider = 'twilio' and number.status = 'active'
      order by number.created_at asc limit 1
    ),
    case
      when configuration.id is null then 'not_configured'
      when configuration.enabled then 'configured'
      else 'disabled'
    end
  from public.locations as location
  left join public.voice_configurations as configuration
    on configuration.organization_id = location.organization_id and configuration.location_id = location.id
  where location.id = target_location_id
    and public.is_organization_admin(location.organization_id);
$$;

create function public.get_my_recent_voice_calls(target_location_id uuid)
returns table (
  call_id uuid,
  caller_phone text,
  status text,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  handoff_requested boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    call.id,
    contact.phone,
    call.status,
    call.started_at,
    call.answered_at,
    call.ended_at,
    call.end_reason,
    exists (
      select 1 from public.handoffs as handoff
      where handoff.organization_id = call.organization_id and handoff.call_id = call.id
    )
  from public.calls as call
  left join public.contacts as contact
    on contact.organization_id = call.organization_id and contact.id = call.contact_id
  where call.location_id = target_location_id
    and call.provider = 'openai-realtime-sip'
    and public.is_organization_admin(call.organization_id)
  order by call.started_at desc nulls last, call.created_at desc
  limit 25;
$$;

create function public.bootstrap_inbound_voice_call(
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
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_external_call_id, 0)
  );
  select * into existing_event from public.voice_webhook_events where event_id = target_event_id;
  if existing_event.event_id is not null then
    return query
    select true, false, existing_event.call_id, call.conversation_id, call.contact_id,
      existing_event.organization_id, existing_event.location_id, call.phone_number_id,
      null::text, null::text, null::text, null::text, null::text, null::text, null::jsonb,
      null::jsonb, null::text, false, false, null::text
    from public.calls as call
    where call.organization_id = existing_event.organization_id and call.id = existing_event.call_id;
    return;
  end if;
  insert into public.voice_webhook_events (event_id, event_type, external_call_id)
  values (target_event_id, target_event_type, target_external_call_id);
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
      values (route.organization_id, route.location_id, target_caller_e164, jsonb_build_object('source', 'inbound_voice'))
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
    insert into public.channels (organization_id, location_id, channel_type, display_name, status, configuration)
    values (route.organization_id, route.location_id, 'phone', 'Inbound voice', 'active',
      jsonb_build_object('phone_number_id', route.phone_number_id, 'provider', 'twilio'))
    returning id into routed_channel_id;
  end if;
  insert into public.conversations (
    organization_id, location_id, contact_id, channel_id, status, mode, metadata, last_message_at
  ) values (
    route.organization_id, route.location_id, routed_contact_id, routed_channel_id, 'open', 'customer',
    jsonb_build_object('channel', 'voice', 'provider', 'openai-realtime-sip'), now()
  ) returning id into routed_conversation_id;
  insert into public.calls (
    organization_id, location_id, conversation_id, contact_id, phone_number_id, direction, status,
    provider, external_call_id, sip_call_id, started_at, metadata
  ) values (
    route.organization_id, route.location_id, routed_conversation_id, routed_contact_id,
    route.phone_number_id, 'inbound', 'ringing', 'openai-realtime-sip', target_external_call_id,
    nullif(btrim(coalesce(target_sip_call_id, '')), ''), now(), jsonb_build_object('source', 'inbound_voice')
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

create function public.mark_inbound_voice_call_active(target_call_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_voice_service_role();
  update public.calls set status = 'in_progress', answered_at = coalesce(answered_at, now())
  where provider = 'openai-realtime-sip' and external_call_id = target_call_id and status in ('ringing', 'initiated');
  update public.voice_webhook_events set status = 'processed', processed_at = now()
  where external_call_id = target_call_id and event_type = 'realtime.call.incoming';
end;
$$;

create function public.finalize_inbound_voice_call(
  target_call_id text,
  target_status text,
  target_end_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_voice_service_role();
  if target_status not in ('transferred', 'completed', 'failed', 'rejected')
    or target_end_reason not in ('caller_hangup', 'hard_duration_limit', 'idle_timeout', 'provider_error', 'sideband_closed', 'transfer', 'unknown') then
    raise exception using errcode = '22023', message = 'Voice finalization is invalid';
  end if;
  update public.calls set status = target_status, end_reason = target_end_reason, ended_at = coalesce(ended_at, now())
  where provider = 'openai-realtime-sip' and external_call_id = target_call_id
    and status not in ('transferred', 'completed', 'failed', 'rejected');
  update public.voice_webhook_events set
    status = case when target_status = 'failed' then 'failed' else 'processed' end,
    processed_at = now()
  where external_call_id = target_call_id and event_type = 'realtime.call.incoming';
end;
$$;

create function public.record_inbound_voice_transcript(
  target_call_id text,
  target_external_item_id text,
  target_direction text,
  target_body text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_call public.calls%rowtype;
  inserted_count integer := 0;
begin
  perform public.require_voice_service_role();
  if target_direction not in ('inbound', 'outbound')
    or length(btrim(coalesce(target_body, ''))) = 0 or length(target_body) > 16000
    or length(btrim(coalesce(target_external_item_id, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Voice transcript is invalid';
  end if;
  select * into target_call from public.calls
  where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if target_call.id is null then
    raise exception using errcode = '42501', message = 'Voice call is not available';
  end if;
  insert into public.messages (
    organization_id, location_id, conversation_id, contact_id, direction, message_type, body,
    external_id, metadata, sent_at
  ) values (
    target_call.organization_id, target_call.location_id, target_call.conversation_id,
    target_call.contact_id, target_direction, 'voice_transcript', btrim(target_body),
    'voice:' || target_call_id || ':' || target_external_item_id,
    jsonb_build_object('provider', 'openai-realtime-sip', 'mode', 'customer'), now()
  ) on conflict (organization_id, external_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count > 0 then
    update public.conversations set last_message_at = now()
    where organization_id = target_call.organization_id and id = target_call.conversation_id;
  end if;
  return inserted_count > 0;
end;
$$;

create function public.request_inbound_voice_handoff(
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
  idempotency := 'voice:' || target_call_id || ':' || target_tool_call_id;
  select id into existing_id from public.handoffs
  where organization_id = target_call.organization_id and idempotency_key = idempotency;
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
  values (target_call.organization_id, target_call.location_id, 'voice.handoff.requested', 'handoff', existing_id,
    jsonb_build_object('provider', 'openai-realtime-sip', 'urgency', target_urgency));
  return query select existing_id, true;
end;
$$;

create function public.record_inbound_voice_tool_execution(
  target_call_id text,
  target_tool_call_id text,
  target_tool_name text,
  target_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare target_call public.calls%rowtype;
begin
  perform public.require_voice_service_role();
  if target_tool_name not in ('search_business_knowledge', 'request_human_help', 'transfer_call')
    or target_status not in ('succeeded', 'failed', 'rejected') then
    raise exception using errcode = '22023', message = 'Voice tool execution is invalid';
  end if;
  select * into target_call from public.calls
  where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if target_call.id is null then
    raise exception using errcode = '42501', message = 'Voice call is not available';
  end if;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (target_call.organization_id, target_call.location_id, 'voice.tool.executed', 'call', target_call.id,
    jsonb_build_object('tool_call_id', target_tool_call_id, 'tool_name', target_tool_name, 'status', target_status));
end;
$$;

create function public.match_inbound_voice_knowledge(
  target_organization_id uuid,
  target_location_id uuid,
  query_embedding_text text,
  requested_match_count integer default 5
)
returns table (
  chunk_id uuid,
  document_id uuid,
  title text,
  source_url text,
  content text,
  similarity double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare query_embedding extensions.vector(1536);
begin
  perform public.require_voice_service_role();
  if requested_match_count < 1 or requested_match_count > 5 then
    raise exception using errcode = '22023', message = 'Match count is invalid';
  end if;
  if not exists (select 1 from public.locations where organization_id = target_organization_id and id = target_location_id) then
    raise exception using errcode = '23503', message = 'Location does not belong to organization';
  end if;
  query_embedding := query_embedding_text::extensions.vector;
  if extensions.vector_dims(query_embedding) <> 1536 then
    raise exception using errcode = '22023', message = 'Query embedding dimensions are invalid';
  end if;
  return query
  select chunk.id, document.id, document.title, document.canonical_url, chunk.content,
    1 - (chunk.embedding OPERATOR(extensions.<=>) query_embedding)
  from public.knowledge_chunks as chunk
  join public.knowledge_documents as document
    on document.organization_id = chunk.organization_id and document.id = chunk.document_id
  where chunk.organization_id = target_organization_id
    and document.status = 'ready'
    and chunk.embedding is not null
    and (chunk.location_id = target_location_id or chunk.location_id is null)
  order by chunk.embedding OPERATOR(extensions.<=>) query_embedding
  limit requested_match_count;
end;
$$;

revoke all on function public.require_voice_service_role() from public;
revoke all on function public.assign_voice_phone_number(uuid, uuid, text, text) from public;
revoke all on function public.bootstrap_inbound_voice_call(text, text, text, text, text, text) from public;
revoke all on function public.mark_inbound_voice_call_active(text) from public;
revoke all on function public.finalize_inbound_voice_call(text, text, text) from public;
revoke all on function public.record_inbound_voice_transcript(text, text, text, text) from public;
revoke all on function public.request_inbound_voice_handoff(text, text, text, text) from public;
revoke all on function public.record_inbound_voice_tool_execution(text, text, text, text) from public;
revoke all on function public.match_inbound_voice_knowledge(uuid, uuid, text, integer) from public;
revoke all on function public.upsert_my_voice_configuration(uuid, boolean, text, boolean, text) from public;
revoke all on function public.set_voice_provider_transfer_capability(uuid, uuid, boolean) from public;
revoke all on function public.get_my_voice_configuration(uuid) from public;
revoke all on function public.get_my_recent_voice_calls(uuid) from public;

grant execute on function public.upsert_my_voice_configuration(uuid, boolean, text, boolean, text) to authenticated;
grant execute on function public.get_my_voice_configuration(uuid) to authenticated;
grant execute on function public.get_my_recent_voice_calls(uuid) to authenticated;
grant execute on function public.assign_voice_phone_number(uuid, uuid, text, text) to service_role;
grant execute on function public.bootstrap_inbound_voice_call(text, text, text, text, text, text) to service_role;
grant execute on function public.mark_inbound_voice_call_active(text) to service_role;
grant execute on function public.finalize_inbound_voice_call(text, text, text) to service_role;
grant execute on function public.record_inbound_voice_transcript(text, text, text, text) to service_role;
grant execute on function public.request_inbound_voice_handoff(text, text, text, text) to service_role;
grant execute on function public.record_inbound_voice_tool_execution(text, text, text, text) to service_role;
grant execute on function public.match_inbound_voice_knowledge(uuid, uuid, text, integer) to service_role;
grant execute on function public.set_voice_provider_transfer_capability(uuid, uuid, boolean) to service_role;

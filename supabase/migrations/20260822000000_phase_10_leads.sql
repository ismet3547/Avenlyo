-- Phase 10: immutable lead-capture boundaries, location-scoped views, and booking conversion.
-- No client role can create, mutate, or convert a lead directly.

alter table public.leads
  add column if not exists service_category text,
  add column if not exists urgency text not null default 'unknown',
  add column if not exists customer_goal text,
  add column if not exists qualification_reason text,
  add column if not exists last_captured_message_id uuid,
  add column if not exists qualified_at timestamptz,
  add column if not exists converted_at timestamptz,
  add column if not exists conversion_appointment_id uuid,
  add column if not exists source_channel text;

alter table public.leads drop constraint if exists leads_urgency_check;
alter table public.leads add constraint leads_urgency_check
  check (urgency in ('routine', 'soon', 'urgent', 'unknown'));
alter table public.leads drop constraint if exists leads_customer_goal_check;
alter table public.leads add constraint leads_customer_goal_check
  check (customer_goal is null or customer_goal in ('appointment', 'estimate', 'information', 'service'));
alter table public.leads drop constraint if exists leads_source_channel_check;
alter table public.leads add constraint leads_source_channel_check
  check (source_channel is null or source_channel in ('voice', 'sms', 'web'));
alter table public.leads drop constraint if exists leads_last_captured_message_fk;
alter table public.leads add constraint leads_last_captured_message_fk
  foreign key (organization_id, last_captured_message_id)
  references public.messages (organization_id, id);
alter table public.leads drop constraint if exists leads_conversion_appointment_fk;
alter table public.leads add constraint leads_conversion_appointment_fk
  foreign key (organization_id, conversion_appointment_id)
  references public.appointments (organization_id, id);

create unique index if not exists leads_one_active_conversation_idx
  on public.leads (organization_id, conversation_id)
  where conversation_id is not null and status in ('new', 'qualified');
create unique index if not exists leads_conversion_appointment_idx
  on public.leads (organization_id, conversion_appointment_id)
  where conversion_appointment_id is not null;
create index if not exists leads_location_status_created_at_idx
  on public.leads (organization_id, location_id, status, created_at desc);

create table if not exists public.lead_capture_tool_calls (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  conversation_id uuid not null,
  inbound_message_id uuid not null,
  tool_call_id text not null,
  lead_id uuid not null,
  result_state text not null check (result_state in ('needs_human', 'needs_more_information', 'needs_clarification', 'qualified')),
  missing_fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint lead_capture_tool_calls_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint lead_capture_tool_calls_conversation_fk foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint lead_capture_tool_calls_message_fk foreign key (organization_id, inbound_message_id)
    references public.messages (organization_id, id) on delete cascade,
  constraint lead_capture_tool_calls_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete cascade,
  constraint lead_capture_tool_calls_key unique (organization_id, conversation_id, inbound_message_id, tool_call_id)
);

revoke all on table public.lead_capture_tool_calls from public, anon, authenticated, service_role;
revoke all on table public.leads from public, anon, authenticated, service_role;
grant select on table public.leads to authenticated;
drop policy if exists leads_select_member on public.leads;
drop policy if exists leads_insert_member on public.leads;
drop policy if exists leads_update_member on public.leads;
drop policy if exists leads_delete_admin on public.leads;
create policy leads_select_location_member on public.leads
  for select to authenticated using (public.has_location_access(organization_id, location_id));

create or replace function public.require_lead_capture_service_role()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Lead capture service access is required';
  end if;
end;
$$;

create function public.capture_conversation_lead(
  target_inbound_message_id uuid,
  target_tool_call_id text,
  target_service_category text,
  target_urgency text,
  target_customer_goal text,
  target_customer_name text,
  target_details jsonb,
  target_qualification text,
  target_voice_call_id text default null
)
returns table (state text, missing_fields jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  inbound public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  channel_row public.channels%rowtype;
  active_lead public.leads%rowtype;
  saved_lead public.leads%rowtype;
  incoming_details jsonb := coalesce(target_details, '{}'::jsonb);
  merged_details jsonb;
  existing_value text;
  detail_key text;
  detail_value text;
  conflicts text[] := array[]::text[];
  missing text[] := array[]::text[];
  result_state text;
  changed boolean := false;
  created boolean := false;
begin
  perform public.require_lead_capture_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) not between 1 and 200
    or target_urgency not in ('routine', 'soon', 'urgent', 'unknown')
    or target_customer_goal is not null and target_customer_goal not in ('appointment', 'estimate', 'information', 'service')
    or target_qualification not in ('needs_human', 'needs_more_information', 'qualified')
    or jsonb_typeof(incoming_details) <> 'object'
    or (select count(*) from jsonb_object_keys(incoming_details)) > 12
    or exists (select 1 from jsonb_each_text(incoming_details) item where item.key !~ '^[a-z][a-z0-9_]{0,63}$' or length(btrim(item.value)) not between 1 and 500)
    or target_service_category is not null and length(btrim(target_service_category)) not between 1 and 80
    or target_customer_name is not null and length(btrim(target_customer_name)) not between 1 and 120
  then raise exception using errcode = '22023', message = 'Lead capture is invalid'; end if;

  select message.* into inbound
  from public.messages message
  join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  where message.id = target_inbound_message_id
    and message.direction = 'inbound' and message.author_type = 'customer'
    and conversation.ai_mode = 'ai';
  if inbound.id is null then
    raise exception using errcode = '42501', message = 'Current customer turn is not available';
  end if;
  select * into conversation_row from public.conversations
  where organization_id = inbound.organization_id and id = inbound.conversation_id and location_id is not distinct from inbound.location_id;
  select * into channel_row from public.channels
  where organization_id = conversation_row.organization_id and id = conversation_row.channel_id;
  if conversation_row.id is null or channel_row.id is null then
    raise exception using errcode = '42501', message = 'Current customer turn is not available';
  end if;
  if (channel_row.channel_type = 'sms' and (inbound.source_channel <> 'sms' or inbound.transport_sender_e164 is null))
    or (channel_row.channel_type = 'phone' and (
      inbound.source_channel <> 'voice' or target_voice_call_id is null
      or inbound.external_id is distinct from 'voice:' || target_voice_call_id || ':' || split_part(inbound.external_id, ':', 3)
      or not exists (select 1 from public.calls call where call.organization_id = conversation_row.organization_id
        and call.location_id is not distinct from conversation_row.location_id
        and call.conversation_id = conversation_row.id and call.external_call_id = target_voice_call_id
        and call.transport_caller_e164 is not null)
    ))
    or (channel_row.channel_type = 'web' and inbound.source_channel <> 'web')
    or channel_row.channel_type not in ('sms', 'phone', 'web')
  then raise exception using errcode = '42501', message = 'Trusted customer transport is unavailable'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lead-capture:' || conversation_row.id::text, 0));
  select lead.* into saved_lead from public.leads lead
  join public.lead_capture_tool_calls capture on capture.organization_id = lead.organization_id and capture.lead_id = lead.id
  where capture.organization_id = conversation_row.organization_id and capture.conversation_id = conversation_row.id
    and capture.inbound_message_id = inbound.id and capture.tool_call_id = target_tool_call_id;
  if saved_lead.id is not null then
    return query select capture.result_state, capture.missing_fields from public.lead_capture_tool_calls capture
      where capture.organization_id = conversation_row.organization_id and capture.conversation_id = conversation_row.id
        and capture.inbound_message_id = inbound.id and capture.tool_call_id = target_tool_call_id;
    return;
  end if;

  if target_customer_name is not null then
    incoming_details := incoming_details || jsonb_build_object('customer_name', btrim(target_customer_name));
  end if;
  select * into active_lead from public.leads
  where organization_id = conversation_row.organization_id and conversation_id = conversation_row.id
    and status in ('new', 'qualified') for update;

  if active_lead.id is not null then
    if target_service_category is not null and active_lead.service_category is not null
      and active_lead.service_category <> btrim(target_service_category) then conflicts := array_append(conflicts, 'service_category'); end if;
    if target_customer_goal is not null and active_lead.customer_goal is not null
      and active_lead.customer_goal <> target_customer_goal then conflicts := array_append(conflicts, 'customer_goal'); end if;
    for detail_key, detail_value in select key, value from jsonb_each_text(incoming_details) loop
      existing_value := active_lead.details ->> detail_key;
      if existing_value is not null and existing_value <> detail_value then conflicts := array_append(conflicts, detail_key); end if;
    end loop;
  end if;

  if coalesce(array_length(conflicts, 1), 0) > 0 then
    result_state := 'needs_clarification';
    missing := conflicts;
    saved_lead := active_lead;
  elsif active_lead.id is null then
    insert into public.leads (
      organization_id, location_id, contact_id, conversation_id, status, source, source_channel,
      service_category, urgency, customer_goal, qualification_reason, qualified_at,
      last_captured_message_id, details
    ) values (
      conversation_row.organization_id, conversation_row.location_id, conversation_row.contact_id,
      conversation_row.id,
      case when target_qualification = 'qualified' then 'qualified' else 'new' end,
      case channel_row.channel_type when 'phone' then 'voice' else channel_row.channel_type end,
      case channel_row.channel_type when 'phone' then 'voice' else channel_row.channel_type end,
      nullif(btrim(target_service_category), ''), target_urgency, target_customer_goal, target_qualification,
      case when target_qualification = 'qualified' then now() else null end, inbound.id, incoming_details
    ) returning * into saved_lead;
    created := true;
    changed := true;
  else
    merged_details := active_lead.details;
    for detail_key, detail_value in select key, value from jsonb_each_text(incoming_details) loop
      if merged_details ->> detail_key is null then merged_details := merged_details || jsonb_build_object(detail_key, detail_value); changed := true; end if;
    end loop;
    update public.leads set
      service_category = coalesce(active_lead.service_category, nullif(btrim(target_service_category), '')),
      customer_goal = coalesce(active_lead.customer_goal, target_customer_goal),
      urgency = case when active_lead.urgency = 'unknown' then target_urgency else active_lead.urgency end,
      details = merged_details,
      last_captured_message_id = inbound.id,
      qualification_reason = case when active_lead.status = 'new' then target_qualification else active_lead.qualification_reason end,
      status = case when active_lead.status = 'new' and target_qualification = 'qualified' then 'qualified' else active_lead.status end,
      qualified_at = case when active_lead.status = 'new' and target_qualification = 'qualified' then now() else active_lead.qualified_at end,
      updated_at = now()
    where id = active_lead.id and organization_id = active_lead.organization_id
    returning * into saved_lead;
    changed := changed or active_lead.service_category is null and target_service_category is not null
      or active_lead.customer_goal is null and target_customer_goal is not null
      or active_lead.urgency = 'unknown' and target_urgency <> 'unknown'
      or active_lead.status = 'new' and target_qualification = 'qualified';
  end if;

  if target_qualification = 'needs_human' then result_state := 'needs_human';
  elsif saved_lead.status = 'qualified' then result_state := 'qualified';
  else
    result_state := 'needs_more_information';
    if saved_lead.service_category is null then missing := array_append(missing, 'service_category'); end if;
    if saved_lead.customer_goal is null then missing := array_append(missing, 'customer_goal'); end if;
  end if;

  insert into public.lead_capture_tool_calls (organization_id, location_id, conversation_id, inbound_message_id, tool_call_id, lead_id, result_state, missing_fields)
  values (saved_lead.organization_id, saved_lead.location_id, conversation_row.id, inbound.id, target_tool_call_id, saved_lead.id, result_state, to_jsonb(missing));
  if created then
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (saved_lead.organization_id, saved_lead.location_id, 'lead.created', 'lead', saved_lead.id,
      jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency));
  elsif changed then
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (saved_lead.organization_id, saved_lead.location_id,
      case when saved_lead.status = 'qualified' and active_lead.status = 'new' then 'lead.qualified' else 'lead.updated' end,
      'lead', saved_lead.id, jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency));
  end if;
  return query select result_state, to_jsonb(missing);
end;
$$;

create function public.convert_booking_lead(target_booking_intent_id uuid, target_appointment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; appointment public.appointments%rowtype; active_lead public.leads%rowtype; source_value text;
begin
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  select * into appointment from public.appointments where id = target_appointment_id and organization_id = intent.organization_id;
  if intent.id is null or appointment.id is null or appointment.conversation_id is distinct from intent.conversation_id
    or appointment.location_id is distinct from intent.location_id then raise exception using errcode = '22023', message = 'Booking conversion context is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lead-conversion:' || intent.conversation_id::text, 0));
  select * into active_lead from public.leads where organization_id = intent.organization_id and conversation_id = intent.conversation_id
    and status in ('new', 'qualified') for update;
  if active_lead.id is not null then
    update public.leads set status = 'converted', converted_at = coalesce(converted_at, now()), conversion_appointment_id = target_appointment_id,
      updated_at = now() where id = active_lead.id and status in ('new', 'qualified');
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (intent.organization_id, intent.location_id, 'lead.converted', 'lead', active_lead.id, jsonb_build_object('provider', appointment.provider));
    return;
  end if;
  if exists (select 1 from public.leads where organization_id = intent.organization_id and conversion_appointment_id = target_appointment_id) then return; end if;
  if exists (select 1 from public.messages message where message.organization_id = intent.organization_id and message.conversation_id = intent.conversation_id
      and message.direction = 'inbound' and message.author_type = 'customer' and message.source_channel in ('voice','sms','web')) then
    select case channel.channel_type when 'phone' then 'voice' else channel.channel_type end into source_value
      from public.conversations conversation join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
      where conversation.organization_id = intent.organization_id and conversation.id = intent.conversation_id;
    insert into public.leads (organization_id, location_id, contact_id, conversation_id, status, source, source_channel, urgency, converted_at, conversion_appointment_id, details)
    values (intent.organization_id, intent.location_id, intent.contact_id, intent.conversation_id, 'converted', source_value, source_value, 'unknown', now(), target_appointment_id, '{}'::jsonb)
    returning * into active_lead;
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (intent.organization_id, intent.location_id, 'lead.converted', 'lead', active_lead.id, jsonb_build_object('provider', appointment.provider));
  end if;
end;
$$;

create or replace function public.complete_scheduling_booking_intent(target_booking_intent_id uuid)
returns table (appointment_id uuid, is_existing boolean) language plpgsql security definer set search_path = '' as $$
declare result record;
begin
  perform public.require_scheduling_service_role();
  select * into result from public.complete_voice_booking_intent(target_booking_intent_id);
  update public.appointments appointment set trusted_sms_recipient_e164 = intent.trusted_transport_phone_e164,
    status = case when appointment.status = 'requested' then 'confirmed' else appointment.status end,
    updated_at = now()
    from public.booking_intents intent where appointment.id = result.appointment_id and intent.organization_id = appointment.organization_id and intent.id = target_booking_intent_id
      and appointment.trusted_sms_recipient_e164 is null;
  perform public.convert_booking_lead(target_booking_intent_id, result.appointment_id);
  perform public.refresh_appointment_reminders_internal(result.appointment_id);
  return query select result.appointment_id, result.is_existing;
end;
$$;

create function public.get_my_leads(target_location_id uuid default null, target_status text default null, target_source_channel text default null, target_urgency text default null)
returns table (lead_id uuid, location_id uuid, status text, source_channel text, service_category text, urgency text, customer_goal text, qualification_reason text, qualified_at timestamptz, converted_at timestamptz, created_at timestamptz, customer_name text)
language sql stable security definer set search_path = '' as $$
  select lead.id, lead.location_id, lead.status, lead.source_channel, lead.service_category, lead.urgency, lead.customer_goal,
    lead.qualification_reason, lead.qualified_at, lead.converted_at, lead.created_at, lead.details ->> 'customer_name'
  from public.leads lead
  where public.has_location_access(lead.organization_id, lead.location_id)
    and (target_location_id is null or lead.location_id = target_location_id)
    and (target_status is null or lead.status = target_status)
    and (target_source_channel is null or lead.source_channel = target_source_channel)
    and (target_urgency is null or lead.urgency = target_urgency)
  order by lead.created_at desc;
$$;

create function public.get_my_lead_detail(target_lead_id uuid)
returns table (lead_id uuid, location_id uuid, status text, source_channel text, service_category text, urgency text, customer_goal text, qualification_reason text, details jsonb, qualified_at timestamptz, converted_at timestamptz, conversion_appointment_id uuid, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select lead.id, lead.location_id, lead.status, lead.source_channel, lead.service_category, lead.urgency, lead.customer_goal,
    lead.qualification_reason, lead.details, lead.qualified_at, lead.converted_at, lead.conversion_appointment_id, lead.created_at, lead.updated_at
  from public.leads lead where lead.id = target_lead_id and public.has_location_access(lead.organization_id, lead.location_id);
$$;

create function public.get_my_inbox_lead_indicators(target_location_id uuid default null)
returns table (conversation_id uuid, lead_status text, service_category text, urgency text)
language sql stable security definer set search_path = '' as $$
  select lead.conversation_id, lead.status, lead.service_category, lead.urgency
  from public.leads lead where lead.conversation_id is not null and lead.status in ('new','qualified')
    and public.has_location_access(lead.organization_id, lead.location_id)
    and (target_location_id is null or lead.location_id = target_location_id);
$$;

create or replace function public.record_inbound_voice_tool_execution(
  target_call_id text, target_tool_call_id text, target_tool_name text, target_status text
) returns void language plpgsql security definer set search_path = '' as $$
declare target_call public.calls%rowtype;
begin
  perform public.require_voice_service_role();
  if target_tool_name not in ('search_business_knowledge', 'request_human_help', 'transfer_call', 'capture_lead', 'get_available_appointments', 'prepare_appointment_booking', 'book_appointment', 'get_upcoming_appointments', 'get_reschedule_options', 'prepare_appointment_reschedule', 'prepare_appointment_cancellation', 'reschedule_appointment', 'cancel_appointment')
    or target_status not in ('failed','rejected','succeeded') then raise exception using errcode = '22023', message = 'Voice tool audit is invalid'; end if;
  select * into target_call from public.calls where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if target_call.id is null then raise exception using errcode = '42501', message = 'Voice call is not available'; end if;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (target_call.organization_id, target_call.location_id, 'voice.tool.executed', 'call', target_call.id,
    jsonb_build_object('tool', target_tool_name, 'status', target_status));
end;
$$;

-- Final voice transcripts are customer or assistant messages on the immutable exact call key.
-- The original Phase 4 function predates unified message authorship, so this additive replacement
-- makes the Phase 10 trusted-turn constraint executable for voice capture.
create or replace function public.record_inbound_voice_transcript(
  target_call_id text, target_external_item_id text, target_direction text, target_body text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare target_call public.calls%rowtype; inserted_count integer := 0;
begin
  perform public.require_voice_service_role();
  if target_direction not in ('inbound', 'outbound') or length(btrim(coalesce(target_body, ''))) not between 1 and 16000
    or length(btrim(coalesce(target_external_item_id, ''))) = 0 then raise exception using errcode = '22023', message = 'Voice transcript is invalid'; end if;
  select * into target_call from public.calls where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if target_call.id is null then raise exception using errcode = '42501', message = 'Voice call is not available'; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, external_id, metadata, source_channel, author_type, sent_at)
  values (target_call.organization_id, target_call.location_id, target_call.conversation_id, target_call.contact_id, target_direction, 'voice_transcript', btrim(target_body),
    'voice:' || target_call_id || ':' || target_external_item_id, jsonb_build_object('provider', 'openai-realtime-sip', 'mode', 'customer'),
    'voice', case when target_direction = 'inbound' then 'customer' else 'ai' end, now())
  on conflict (organization_id, external_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count > 0 then update public.conversations set last_message_at = now() where organization_id = target_call.organization_id and id = target_call.conversation_id; end if;
  return inserted_count > 0;
end;
$$;

revoke all on function public.require_lead_capture_service_role(), public.capture_conversation_lead(uuid, text, text, text, text, text, jsonb, text, text), public.convert_booking_lead(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.capture_conversation_lead(uuid, text, text, text, text, text, jsonb, text, text) to service_role;
revoke all on function public.get_my_leads(uuid, text, text, text), public.get_my_lead_detail(uuid), public.get_my_inbox_lead_indicators(uuid) from public, anon;
grant execute on function public.get_my_leads(uuid, text, text, text), public.get_my_lead_detail(uuid), public.get_my_inbox_lead_indicators(uuid) to authenticated;

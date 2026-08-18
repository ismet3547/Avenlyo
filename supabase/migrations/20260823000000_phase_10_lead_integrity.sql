-- Phase 10 follow-up: lead references and lifecycle transitions are location-safe as well as tenant-safe.
-- This migration is additive so the approved capture boundary remains service-role only.

alter table public.contacts
  add constraint contacts_organization_location_id_id_key unique (organization_id, location_id, id);
alter table public.conversations
  add constraint conversations_organization_location_id_id_key unique (organization_id, location_id, id);
alter table public.leads
  add constraint leads_organization_location_id_id_key unique (organization_id, location_id, id),
  add constraint leads_organization_location_conversation_id_id_key unique (organization_id, location_id, conversation_id, id),
  add constraint leads_location_required_for_reference_check check (
    (contact_id is null or location_id is not null)
    and (conversation_id is null or location_id is not null)
    and (last_captured_message_id is null or location_id is not null)
    and (conversion_appointment_id is null or location_id is not null)
  );
alter table public.messages
  add constraint messages_organization_location_conversation_id_id_key
    unique (organization_id, location_id, conversation_id, id);

alter table public.leads
  drop constraint if exists leads_contact_fk,
  drop constraint if exists leads_conversation_fk,
  drop constraint if exists leads_last_captured_message_fk,
  drop constraint if exists leads_conversion_appointment_fk,
  add constraint leads_contact_location_fk
    foreign key (organization_id, location_id, contact_id)
    references public.contacts (organization_id, location_id, id),
  add constraint leads_conversation_location_fk
    foreign key (organization_id, location_id, conversation_id)
    references public.conversations (organization_id, location_id, id),
  add constraint leads_last_captured_message_location_fk
    foreign key (organization_id, location_id, last_captured_message_id)
    references public.messages (organization_id, location_id, id),
  add constraint leads_conversion_appointment_location_fk
    foreign key (organization_id, location_id, conversion_appointment_id)
    references public.appointments (organization_id, location_id, id);

alter table public.lead_capture_tool_calls
  alter column location_id set not null,
  drop constraint if exists lead_capture_tool_calls_conversation_fk,
  drop constraint if exists lead_capture_tool_calls_message_fk,
  drop constraint if exists lead_capture_tool_calls_lead_fk,
  add constraint lead_capture_tool_calls_conversation_location_fk
    foreign key (organization_id, location_id, conversation_id)
    references public.conversations (organization_id, location_id, id) on delete cascade,
  add constraint lead_capture_tool_calls_message_location_fk
    foreign key (organization_id, location_id, conversation_id, inbound_message_id)
    references public.messages (organization_id, location_id, conversation_id, id) on delete cascade,
  add constraint lead_capture_tool_calls_lead_location_fk
    foreign key (organization_id, location_id, conversation_id, lead_id)
    references public.leads (organization_id, location_id, conversation_id, id) on delete cascade;

create or replace function public.capture_conversation_lead(
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
  urgency_changed boolean := false;
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
  join public.conversations conversation on conversation.organization_id = message.organization_id
    and conversation.location_id is not distinct from message.location_id
    and conversation.id = message.conversation_id
  where message.id = target_inbound_message_id
    and message.direction = 'inbound' and message.author_type = 'customer'
    and conversation.ai_mode = 'ai';
  if inbound.id is null then raise exception using errcode = '42501', message = 'Current customer turn is not available'; end if;

  select * into conversation_row from public.conversations
  where organization_id = inbound.organization_id and id = inbound.conversation_id
    and location_id is not distinct from inbound.location_id;
  select * into channel_row from public.channels
  where organization_id = conversation_row.organization_id and id = conversation_row.channel_id
    and location_id is not distinct from conversation_row.location_id;
  if conversation_row.id is null or channel_row.id is null then
    raise exception using errcode = '42501', message = 'Current customer turn is not available';
  end if;

  if (channel_row.channel_type = 'sms' and (inbound.source_channel <> 'sms' or inbound.transport_sender_e164 is null))
    or (channel_row.channel_type = 'phone' and (
      inbound.source_channel <> 'voice' or target_voice_call_id is null
      or inbound.external_id is distinct from 'voice:' || target_voice_call_id || ':' || split_part(inbound.external_id, ':', 3)
      or not exists (
        select 1 from public.calls call
        where call.provider = 'openai-realtime-sip'
          and call.organization_id = conversation_row.organization_id
          and call.location_id is not distinct from conversation_row.location_id
          and call.conversation_id = conversation_row.id
          and call.external_call_id = target_voice_call_id
      )
    ))
    or (channel_row.channel_type = 'web' and inbound.source_channel <> 'web')
    or channel_row.channel_type not in ('sms', 'phone', 'web')
  then raise exception using errcode = '42501', message = 'Trusted customer transport is unavailable'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lead-capture:' || conversation_row.id::text, 0));
  select lead.* into saved_lead
  from public.leads lead
  join public.lead_capture_tool_calls capture on capture.organization_id = lead.organization_id
    and capture.location_id = lead.location_id and capture.lead_id = lead.id
  where capture.organization_id = conversation_row.organization_id and capture.location_id = conversation_row.location_id
    and capture.conversation_id = conversation_row.id and capture.inbound_message_id = inbound.id
    and capture.tool_call_id = target_tool_call_id;
  if saved_lead.id is not null then
    return query select capture.result_state, capture.missing_fields
    from public.lead_capture_tool_calls capture
    where capture.organization_id = conversation_row.organization_id and capture.location_id = conversation_row.location_id
      and capture.conversation_id = conversation_row.id and capture.inbound_message_id = inbound.id
      and capture.tool_call_id = target_tool_call_id;
    return;
  end if;

  if target_customer_name is not null then
    incoming_details := incoming_details || jsonb_build_object('customer_name', btrim(target_customer_name));
  end if;
  select * into active_lead from public.leads
  where organization_id = conversation_row.organization_id and location_id = conversation_row.location_id
    and conversation_id = conversation_row.id and status in ('new', 'qualified') for update;

  if active_lead.id is not null then
    if target_service_category is not null and active_lead.service_category is not null
      and active_lead.service_category <> btrim(target_service_category) then
      conflicts := array_append(conflicts, 'service_category');
    end if;
    if target_customer_goal is not null and active_lead.customer_goal is not null
      and active_lead.customer_goal <> target_customer_goal then
      conflicts := array_append(conflicts, 'customer_goal');
    end if;
    for detail_key, detail_value in select key, value from jsonb_each_text(incoming_details) loop
      existing_value := active_lead.details ->> detail_key;
      if existing_value is not null and existing_value <> detail_value then
        conflicts := array_append(conflicts, detail_key);
      end if;
    end loop;
  end if;

  if active_lead.id is not null then
    urgency_changed := case target_urgency when 'urgent' then 3 when 'soon' then 2 when 'routine' then 1 else 0 end
      > case active_lead.urgency when 'urgent' then 3 when 'soon' then 2 when 'routine' then 1 else 0 end;
  end if;

  if coalesce(array_length(conflicts, 1), 0) > 0 then
    -- A contradiction never replaces durable facts.  A separate urgent fact may only upgrade.
    if urgency_changed then
      update public.leads set urgency = target_urgency, updated_at = now()
      where id = active_lead.id and organization_id = active_lead.organization_id
      returning * into saved_lead;
      changed := true;
    else
      saved_lead := active_lead;
    end if;
    result_state := 'needs_clarification';
    missing := conflicts;
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
      if merged_details ->> detail_key is null then
        merged_details := merged_details || jsonb_build_object(detail_key, detail_value);
        changed := true;
      end if;
    end loop;
    update public.leads set
      service_category = coalesce(active_lead.service_category, nullif(btrim(target_service_category), '')),
      customer_goal = coalesce(active_lead.customer_goal, target_customer_goal),
      urgency = case when urgency_changed then target_urgency else active_lead.urgency end,
      details = merged_details,
      last_captured_message_id = inbound.id,
      qualification_reason = case when active_lead.status = 'new' then target_qualification else active_lead.qualification_reason end,
      status = case when active_lead.status = 'new' and target_qualification = 'qualified' then 'qualified' else active_lead.status end,
      qualified_at = case when active_lead.status = 'new' and target_qualification = 'qualified' then now() else active_lead.qualified_at end,
      updated_at = now()
    where id = active_lead.id and organization_id = active_lead.organization_id
    returning * into saved_lead;
    changed := changed
      or (active_lead.service_category is null and target_service_category is not null)
      or (active_lead.customer_goal is null and target_customer_goal is not null)
      or urgency_changed
      or (active_lead.status = 'new' and target_qualification = 'qualified');
  end if;

  -- Conflict is deliberately the first result-state decision, even for an already-qualified lead.
  if coalesce(array_length(conflicts, 1), 0) > 0 then
    result_state := 'needs_clarification';
  elsif target_qualification = 'needs_human' then
    result_state := 'needs_human';
  elsif saved_lead.status = 'qualified' then
    result_state := 'qualified';
  else
    result_state := 'needs_more_information';
    if saved_lead.service_category is null then missing := array_append(missing, 'service_category'); end if;
    if saved_lead.customer_goal is null then missing := array_append(missing, 'customer_goal'); end if;
  end if;

  insert into public.lead_capture_tool_calls (
    organization_id, location_id, conversation_id, inbound_message_id, tool_call_id, lead_id, result_state, missing_fields
  ) values (
    saved_lead.organization_id, saved_lead.location_id, conversation_row.id, inbound.id, target_tool_call_id,
    saved_lead.id, result_state, to_jsonb(missing)
  );

  if created then
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (saved_lead.organization_id, saved_lead.location_id, 'lead.created', 'lead', saved_lead.id,
      jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency));
    if saved_lead.status = 'qualified' then
      insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (saved_lead.organization_id, saved_lead.location_id, 'lead.qualified', 'lead', saved_lead.id,
        jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency));
    end if;
  elsif changed then
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (
      saved_lead.organization_id, saved_lead.location_id,
      case when saved_lead.status = 'qualified' and active_lead.status = 'new' then 'lead.qualified' else 'lead.updated' end,
      'lead', saved_lead.id, jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency)
    );
  end if;
  return query select result_state, to_jsonb(missing);
end;
$$;

create or replace function public.convert_booking_lead(target_booking_intent_id uuid, target_appointment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  intent public.booking_intents%rowtype;
  appointment public.appointments%rowtype;
  active_lead public.leads%rowtype;
  source_value text;
begin
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  select * into appointment from public.appointments
  where id = target_appointment_id and organization_id = intent.organization_id;
  if intent.id is null or appointment.id is null
    or intent.status <> 'completed' or intent.completed_at is null
    or appointment.status <> 'confirmed'
    or appointment.organization_id <> intent.organization_id
    or appointment.location_id is distinct from intent.location_id
    or appointment.conversation_id is distinct from intent.conversation_id
    or appointment.booking_intent_id is distinct from intent.id
  then raise exception using errcode = '22023', message = 'Booking conversion context is invalid'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lead-conversion:' || intent.conversation_id::text, 0));
  select * into active_lead from public.leads
  where organization_id = intent.organization_id and location_id = intent.location_id
    and conversation_id = intent.conversation_id and status in ('new', 'qualified') for update;
  if active_lead.id is not null then
    update public.leads set status = 'converted', converted_at = coalesce(converted_at, now()),
      conversion_appointment_id = target_appointment_id, updated_at = now()
    where id = active_lead.id and status in ('new', 'qualified');
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (intent.organization_id, intent.location_id, 'lead.converted', 'lead', active_lead.id,
      jsonb_build_object('source_channel', active_lead.source_channel));
    return;
  end if;
  if exists (
    select 1 from public.leads
    where organization_id = intent.organization_id and location_id = intent.location_id
      and conversion_appointment_id = target_appointment_id
  ) then return; end if;

  if exists (
    select 1 from public.messages message
    where message.organization_id = intent.organization_id and message.location_id = intent.location_id
      and message.conversation_id = intent.conversation_id and message.direction = 'inbound'
      and message.author_type = 'customer' and message.source_channel in ('voice', 'sms', 'web')
  ) then
    select case channel.channel_type when 'phone' then 'voice' else channel.channel_type end into source_value
    from public.conversations conversation
    join public.channels channel on channel.organization_id = conversation.organization_id
      and channel.location_id is not distinct from conversation.location_id and channel.id = conversation.channel_id
    where conversation.organization_id = intent.organization_id and conversation.location_id = intent.location_id
      and conversation.id = intent.conversation_id;
    insert into public.leads (
      organization_id, location_id, contact_id, conversation_id, status, source, source_channel, urgency,
      converted_at, conversion_appointment_id, details
    ) values (
      intent.organization_id, intent.location_id, intent.contact_id, intent.conversation_id, 'converted',
      source_value, source_value, 'unknown', now(), target_appointment_id, '{}'::jsonb
    ) returning * into active_lead;
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (intent.organization_id, intent.location_id, 'lead.created', 'lead', active_lead.id,
      jsonb_build_object('source_channel', active_lead.source_channel, 'urgency', active_lead.urgency));
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (intent.organization_id, intent.location_id, 'lead.converted', 'lead', active_lead.id,
      jsonb_build_object('source_channel', active_lead.source_channel));
  end if;
end;
$$;

create or replace function public.get_my_lead_detail(target_lead_id uuid)
returns table (
  lead_id uuid, location_id uuid, conversation_id uuid, status text, source_channel text,
  service_category text, urgency text, customer_goal text, qualification_reason text, details jsonb,
  qualified_at timestamptz, converted_at timestamptz, conversion_appointment_id uuid,
  conversion_appointment_starts_at timestamptz, conversion_appointment_status text,
  location_timezone text, created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select lead.id, lead.location_id, lead.conversation_id, lead.status, lead.source_channel,
    lead.service_category, lead.urgency, lead.customer_goal, lead.qualification_reason, lead.details,
    lead.qualified_at, lead.converted_at, lead.conversion_appointment_id,
    appointment.starts_at, appointment.status, location.timezone, lead.created_at, lead.updated_at
  from public.leads lead
  join public.locations location on location.organization_id = lead.organization_id and location.id = lead.location_id
  left join public.appointments appointment on appointment.organization_id = lead.organization_id
    and appointment.location_id = lead.location_id and appointment.id = lead.conversion_appointment_id
  where lead.id = target_lead_id and public.has_location_access(lead.organization_id, lead.location_id);
$$;

create or replace function public.get_my_inbox_lead_indicators(target_location_id uuid default null)
returns table (conversation_id uuid, lead_status text, service_category text, urgency text)
language sql stable security definer set search_path = '' as $$
  select distinct on (lead.conversation_id)
    lead.conversation_id, lead.status, lead.service_category, lead.urgency
  from public.leads lead
  where lead.conversation_id is not null
    and lead.status in ('new', 'qualified', 'converted')
    and public.has_location_access(lead.organization_id, lead.location_id)
    and (target_location_id is null or lead.location_id = target_location_id)
  order by lead.conversation_id,
    case lead.status when 'new' then 3 when 'qualified' then 2 when 'converted' then 1 else 0 end desc,
    coalesce(lead.converted_at, lead.qualified_at, lead.created_at) desc,
    lead.id desc;
$$;

revoke all on function public.capture_conversation_lead(uuid, text, text, text, text, text, jsonb, text, text), public.convert_booking_lead(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.capture_conversation_lead(uuid, text, text, text, text, text, jsonb, text, text) to service_role;

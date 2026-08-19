-- Phase 11 follow-up hardening: the database remains the only authority that can
-- cross the provider send boundary. Internal helpers are intentionally not callable
-- by browser roles; public RPCs below are the narrow owner/admin or worker surface.

alter table public.lead_followup_settings
  add column automation_acknowledged_sender_phone_number_id uuid;

update public.lead_followup_settings
  set automation_acknowledged_sender_phone_number_id = sender_phone_number_id
  where lead_followup_enabled
    and automation_acknowledged_at is not null
    and automation_acknowledged_by is not null
    and sender_phone_number_id is not null;

alter table public.lead_followup_settings
  add constraint lead_followup_settings_ack_sender_fk
    foreign key (organization_id, location_id, automation_acknowledged_sender_phone_number_id)
    references public.phone_numbers (organization_id, location_id, id);
alter table public.lead_followup_settings
  drop constraint lead_followup_settings_ack_check;
alter table public.lead_followup_settings
  add constraint lead_followup_settings_ack_check check (
    (lead_followup_enabled = false)
    or (
      sender_phone_number_id is not null
      and automation_acknowledged_at is not null
      and automation_acknowledged_by is not null
      and automation_acknowledged_sender_phone_number_id = sender_phone_number_id
    )
  );

create or replace function public.lead_followup_settings_sender_is_current(
  target_organization_id uuid,
  target_location_id uuid,
  target_sender_phone_number_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.lead_followup_settings settings
    join public.phone_numbers sender
      on sender.organization_id = settings.organization_id
      and sender.location_id = settings.location_id
      and sender.id = settings.sender_phone_number_id
    where settings.organization_id = target_organization_id
      and settings.location_id = target_location_id
      and settings.lead_followup_enabled
      and settings.sender_phone_number_id = target_sender_phone_number_id
      and settings.automation_acknowledged_sender_phone_number_id = target_sender_phone_number_id
      and settings.automation_acknowledged_at is not null
      and settings.automation_acknowledged_by is not null
      and sender.status = 'active'
      and sender.sms_enabled
  );
$$;

-- A suppression can only alter a job that has not crossed queued -> submitting.
-- Once a provider attempt may have happened, delivery truth remains authoritative.
create function public.suppress_lead_followup_job(target_job_id uuid, target_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.lead_followup_jobs%rowtype; delivery public.message_deliveries%rowtype;
begin
  if nullif(btrim(coalesce(target_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Follow-up suppression reason is required';
  end if;
  select * into job from public.lead_followup_jobs where id = target_job_id for update;
  if job.id is null or job.status not in ('scheduled', 'processing', 'delivery_pending') then return false; end if;
  if job.delivery_id is null then
    update public.lead_followup_jobs set status = 'skipped', skip_reason = left(btrim(target_reason), 120),
      claimed_at = null, claimed_by = null, updated_at = now() where id = job.id;
    return true;
  end if;
  select * into delivery from public.message_deliveries where id = job.delivery_id for update;
  if delivery.id is null then
    update public.lead_followup_jobs set status = 'skipped', skip_reason = left(btrim(target_reason), 120),
      claimed_at = null, claimed_by = null, updated_at = now() where id = job.id;
    return true;
  end if;
  if delivery.status <> 'queued' then return false; end if;
  update public.message_deliveries set status = 'suppressed', error_code = left(btrim(target_reason), 120),
    updated_at = now() where id = delivery.id and status = 'queued';
  return found;
end;
$$;

create function public.suppress_lead_followups_for_location(
  target_organization_id uuid,
  target_location_id uuid,
  target_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare job_id uuid;
begin
  for job_id in
    select id from public.lead_followup_jobs
    where organization_id = target_organization_id and location_id = target_location_id
      and status in ('scheduled', 'processing', 'delivery_pending')
  loop
    perform public.suppress_lead_followup_job(job_id, target_reason);
  end loop;
end;
$$;

create function public.suppress_lead_followups_for_lead(
  target_organization_id uuid,
  target_lead_id uuid,
  target_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare job_id uuid;
begin
  for job_id in
    select id from public.lead_followup_jobs
    where organization_id = target_organization_id and lead_id = target_lead_id
      and status in ('scheduled', 'processing', 'delivery_pending')
  loop
    perform public.suppress_lead_followup_job(job_id, target_reason);
  end loop;
end;
$$;

create or replace function public.suppress_lead_followups_for_conversation(
  target_organization_id uuid,
  target_location_id uuid,
  target_conversation_id uuid,
  target_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare job_id uuid;
begin
  for job_id in
    select id from public.lead_followup_jobs
    where organization_id = target_organization_id
      and location_id = target_location_id
      and conversation_id = target_conversation_id
      and status in ('scheduled', 'processing', 'delivery_pending')
  loop
    perform public.suppress_lead_followup_job(job_id, target_reason);
  end loop;
end;
$$;

create function public.suppress_lead_followups_for_route(
  target_organization_id uuid,
  target_location_id uuid,
  target_sender_phone_number_id uuid,
  target_recipient_e164 text,
  target_reason text
)
returns void language plpgsql security definer set search_path = '' as $$
declare job_id uuid;
begin
  for job_id in
    select id from public.lead_followup_jobs
    where organization_id = target_organization_id
      and location_id = target_location_id
      and sender_phone_number_id = target_sender_phone_number_id
      and recipient_e164 = target_recipient_e164
      and status in ('scheduled', 'processing', 'delivery_pending')
  loop
    perform public.suppress_lead_followup_job(job_id, target_reason);
  end loop;
end;
$$;

create or replace function public.suppress_stale_lead_followups()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status not in ('new', 'qualified') or new.urgency = 'urgent' or new.qualification_reason = 'needs_human' then
    perform public.suppress_lead_followups_for_lead(new.organization_id, new.id, 'lead_ineligible');
  end if;
  return new;
end;
$$;

create or replace function public.suppress_lead_followups_on_reply()
returns trigger language plpgsql security definer set search_path = '' as $$
declare normalized_body text; job_id uuid; reason text;
begin
  normalized_body := lower(regexp_replace(btrim(coalesce(new.body, '')), '\\s+', ' ', 'g'));
  if new.author_type = 'human' then
    reason := 'human_reply';
  elsif new.direction = 'inbound' and new.author_type = 'customer' and new.source_channel = 'sms'
    and normalized_body not in ('start', 'unstop', 'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit') then
    reason := 'customer_replied';
  else
    return new;
  end if;
  for job_id in
    select job.id from public.lead_followup_jobs job
    join public.messages trigger_message
      on trigger_message.organization_id = job.organization_id
      and trigger_message.location_id = job.location_id
      and trigger_message.id = job.trigger_message_id
    where job.organization_id = new.organization_id
      and job.location_id = new.location_id
      and job.conversation_id = new.conversation_id
      and job.status in ('scheduled', 'processing', 'delivery_pending')
      and new.created_at > trigger_message.created_at
  loop
    perform public.suppress_lead_followup_job(job_id, reason);
  end loop;
  return new;
end;
$$;

-- Phase 7 commits canonical SMS preference state after writing the inbound message.
-- Follow-up consent therefore follows that state transition rather than the earlier message trigger.
drop trigger if exists messages_sync_sms_followup_consent on public.messages;
create function public.sync_sms_followup_consent_from_preference()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source_message public.messages%rowtype; command text; consent public.sms_consents%rowtype;
begin
  if new.channel_type <> 'sms' or new.sender_phone_number_id is null or new.source_message_id is null then return new; end if;
  select * into source_message from public.messages
    where organization_id = new.organization_id and location_id = new.location_id and id = new.source_message_id
      and contact_id = new.contact_id and direction = 'inbound' and source_channel = 'sms' and author_type = 'customer';
  if source_message.id is null or source_message.transport_sender_e164 is null then return new; end if;
  command := lower(coalesce(source_message.metadata -> 'provider_metadata' ->> 'opt_out_type', ''));
  if command not in ('start', 'stop') then
    command := case lower(regexp_replace(btrim(coalesce(source_message.body, '')), '\\s+', ' ', 'g'))
      when 'start' then 'start' when 'unstop' then 'start'
      when 'stop' then 'stop' when 'stopall' then 'stop' when 'unsubscribe' then 'stop'
      when 'cancel' then 'stop' when 'end' then 'stop' when 'quit' then 'stop' else null end;
  end if;
  if command = 'start' and new.status = 'active' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'sms-followup-consent:' || new.organization_id::text || ':' || new.sender_phone_number_id::text || ':' || source_message.transport_sender_e164, 0));
    insert into public.sms_consents as current_consent
      (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose, status, source_type, source_message_id, granted_at)
    values (new.organization_id, new.location_id, new.sender_phone_number_id, source_message.transport_sender_e164,
      'lead_followup', 'active', 'sms_start', source_message.id, now())
    on conflict (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose) do update set
      status = 'active', source_type = 'sms_start', source_message_id = excluded.source_message_id,
      source_call_id = null, granted_at = now(), revoked_at = null, updated_at = now()
    returning * into consent;
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (consent.organization_id, consent.location_id, 'sms.consent.granted', 'sms_consent', consent.id,
      jsonb_build_object('channel', 'sms', 'purpose', 'lead_followup'));
  elsif command = 'stop' and new.status = 'opted_out' then
    update public.sms_consents set status = 'revoked', revoked_at = now(), source_message_id = source_message.id,
      updated_at = now()
    where organization_id = new.organization_id and location_id = new.location_id
      and sender_phone_number_id = new.sender_phone_number_id and recipient_e164 = source_message.transport_sender_e164
      and purpose = 'lead_followup' and status = 'active';
    perform public.suppress_lead_followups_for_route(new.organization_id, new.location_id, new.sender_phone_number_id,
      source_message.transport_sender_e164, 'opted_out');
  end if;
  return new;
end;
$$;
create trigger messaging_contact_preferences_sync_sms_followup_consent
after insert or update of status, source_message_id on public.messaging_contact_preferences
for each row execute function public.sync_sms_followup_consent_from_preference();

create or replace function public.lead_followup_eligible(target_lead_id uuid)
returns table (consent_id uuid, sender_phone_number_id uuid, sender_e164 text, recipient_e164 text, trigger_message_id uuid, scheduled_for timestamptz, reason text)
language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads%rowtype; conversation_row public.conversations%rowtype;
  consent public.sms_consents%rowtype; sender public.phone_numbers%rowtype; location public.locations%rowtype; candidate_time timestamptz;
begin
  select * into lead_row from public.leads where id = target_lead_id;
  if lead_row.id is null or lead_row.location_id is null or lead_row.status not in ('new','qualified') or lead_row.urgency = 'urgent'
    or lead_row.qualification_reason = 'needs_human' then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'lead_ineligible'; return;
  end if;
  select * into conversation_row from public.conversations where organization_id = lead_row.organization_id
    and location_id = lead_row.location_id and id = lead_row.conversation_id;
  if conversation_row.id is null or conversation_row.status <> 'open' or conversation_row.ai_mode <> 'ai'
    or exists (select 1 from public.handoffs h where h.organization_id = lead_row.organization_id and h.conversation_id = conversation_row.id and h.status in ('open','acknowledged'))
    or exists (select 1 from public.appointments a where a.organization_id = lead_row.organization_id and a.location_id = lead_row.location_id and a.conversation_id = conversation_row.id and a.status = 'confirmed')
    or exists (select 1 from public.booking_intents b where b.organization_id = lead_row.organization_id and b.location_id = lead_row.location_id and b.conversation_id = conversation_row.id and b.status in ('awaiting_confirmation','booking','provider_success_pending_persistence','provider_state_unknown'))
    or exists (select 1 from public.appointment_change_intents ci where ci.organization_id = lead_row.organization_id and ci.location_id = lead_row.location_id and ci.conversation_id = conversation_row.id and ci.status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown','handoff_required')) then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'conversation_ineligible'; return;
  end if;
  select sender.* into sender from public.lead_followup_settings settings
    join public.phone_numbers sender on sender.organization_id = settings.organization_id and sender.location_id = settings.location_id
      and sender.id = settings.sender_phone_number_id
    where settings.organization_id = lead_row.organization_id and settings.location_id = lead_row.location_id
      and public.lead_followup_settings_sender_is_current(settings.organization_id, settings.location_id, settings.sender_phone_number_id);
  if sender.id is null or sender.phone_number !~ E'^\\+[1-9][0-9]{7,14}$' then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'settings_disabled'; return;
  end if;
  select consent_row.* into consent from public.sms_consents consent_row
    left join public.messages consent_message on consent_message.organization_id = consent_row.organization_id
      and consent_message.location_id = consent_row.location_id and consent_message.id = consent_row.source_message_id
    left join public.calls consent_call on consent_call.organization_id = consent_row.organization_id
      and consent_call.location_id = consent_row.location_id and consent_call.id = consent_row.source_call_id
    where consent_row.organization_id = lead_row.organization_id and consent_row.location_id = lead_row.location_id
      and consent_row.sender_phone_number_id = sender.id and consent_row.purpose = 'lead_followup' and consent_row.status = 'active'
      and (consent_message.conversation_id = lead_row.conversation_id or consent_call.conversation_id = lead_row.conversation_id)
    order by consent_row.granted_at desc limit 1;
  if consent.id is null then return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'consent_unavailable'; return; end if;
  if exists (select 1 from public.messaging_contact_preferences preference
    join public.messages route_message on route_message.organization_id = preference.organization_id and route_message.location_id = preference.location_id
      and route_message.contact_id = preference.contact_id and route_message.transport_sender_e164 = consent.recipient_e164
    where preference.organization_id = lead_row.organization_id and preference.location_id = lead_row.location_id
      and preference.sender_phone_number_id = sender.id and preference.channel_type = 'sms' and preference.status = 'opted_out') then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'opted_out'; return;
  end if;
  select * into location from public.locations where organization_id = lead_row.organization_id and id = lead_row.location_id;
  candidate_time := public.lead_followup_next_allowed_time(now() + make_interval(mins => (select delay_minutes from public.lead_followup_settings where organization_id = lead_row.organization_id and location_id = lead_row.location_id)), location.timezone,
    (select quiet_hours_start from public.lead_followup_settings where organization_id = lead_row.organization_id and location_id = lead_row.location_id),
    (select quiet_hours_end from public.lead_followup_settings where organization_id = lead_row.organization_id and location_id = lead_row.location_id),
    location.business_hours, (select business_hours_only from public.lead_followup_settings where organization_id = lead_row.organization_id and location_id = lead_row.location_id));
  if candidate_time is null then return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'no_allowed_window'; return; end if;
  if not exists (select 1 from public.messages trigger_message where trigger_message.organization_id = lead_row.organization_id
    and trigger_message.location_id = lead_row.location_id and trigger_message.id = lead_row.last_captured_message_id
    and trigger_message.conversation_id = lead_row.conversation_id and trigger_message.direction = 'inbound' and trigger_message.author_type = 'customer') then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'trigger_unavailable'; return;
  end if;
  return query select consent.id, sender.id, sender.phone_number, consent.recipient_e164, lead_row.last_captured_message_id, candidate_time, null::text;
end;
$$;

create or replace function public.try_materialize_lead_followup(target_lead_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads%rowtype; eligible record;
begin
  select * into lead_row from public.leads where id = target_lead_id for update;
  if lead_row.id is null or exists (select 1 from public.lead_followup_jobs where organization_id = lead_row.organization_id and lead_id = lead_row.id) then return; end if;
  select * into eligible from public.lead_followup_eligible(lead_row.id);
  if eligible.reason is not null or eligible.trigger_message_id is null then return; end if;
  if exists (
    select 1 from public.lead_followup_jobs existing_job
    join public.message_deliveries delivery on delivery.organization_id = existing_job.organization_id and delivery.location_id = existing_job.location_id and delivery.id = existing_job.delivery_id
    where existing_job.organization_id = lead_row.organization_id and existing_job.location_id = lead_row.location_id
      and existing_job.sender_phone_number_id = eligible.sender_phone_number_id and existing_job.recipient_e164 = eligible.recipient_e164
      and delivery.status in ('submitting','submitted','sent','delivered','unknown')
      and coalesce(delivery.attempted_at, delivery.updated_at, delivery.created_at) > now() - interval '24 hours'
  ) then
    insert into public.lead_followup_jobs (organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, status, skip_reason)
    values (lead_row.organization_id, lead_row.location_id, lead_row.id, lead_row.conversation_id, eligible.consent_id, eligible.sender_phone_number_id, eligible.sender_e164, eligible.recipient_e164, eligible.trigger_message_id, 'skipped', 'frequency_cap');
  else
    insert into public.lead_followup_jobs (organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, scheduled_for)
    values (lead_row.organization_id, lead_row.location_id, lead_row.id, lead_row.conversation_id, eligible.consent_id, eligible.sender_phone_number_id, eligible.sender_e164, eligible.recipient_e164, eligible.trigger_message_id, eligible.scheduled_for);
  end if;
end;
$$;

create or replace function public.prepare_voice_sms_followup_consent(target_call_id text, target_prepared_message_id uuid)
returns table (consent_intent_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare call_row public.calls%rowtype; sender public.phone_numbers%rowtype; message_row public.messages%rowtype; intent public.voice_sms_followup_consent_intents%rowtype;
begin
  perform public.require_voice_service_role();
  select * into call_row from public.calls where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if call_row.id is null or call_row.status <> 'in_progress' or call_row.transport_caller_e164 is null or call_row.location_id is null then
    raise exception using errcode = '42501', message = 'Voice follow-up consent is unavailable';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('voice-followup-consent:' || call_row.id::text || ':lead_followup', 0));
  select * into sender from public.phone_numbers where organization_id = call_row.organization_id and location_id = call_row.location_id
    and id = call_row.phone_number_id and status = 'active' and sms_enabled;
  select * into message_row from public.messages where organization_id = call_row.organization_id and location_id = call_row.location_id
    and id = target_prepared_message_id and conversation_id = call_row.conversation_id and direction = 'inbound' and source_channel = 'voice' and author_type = 'customer';
  if sender.id is null or message_row.id is null
    or not public.lead_followup_settings_sender_is_current(call_row.organization_id, call_row.location_id, call_row.phone_number_id) then
    raise exception using errcode = '42501', message = 'Voice follow-up consent is unavailable';
  end if;
  update public.voice_sms_followup_consent_intents pending set status = 'expired', updated_at = now()
    where pending.organization_id = call_row.organization_id and pending.call_id = call_row.id and pending.purpose = 'lead_followup'
      and pending.status = 'awaiting_confirmation' and pending.expires_at <= now();
  select * into intent from public.voice_sms_followup_consent_intents pending where pending.organization_id = call_row.organization_id
    and pending.call_id = call_row.id and pending.purpose = 'lead_followup' and pending.status = 'awaiting_confirmation' and pending.expires_at > now();
  if intent.id is null then
    insert into public.voice_sms_followup_consent_intents (organization_id, location_id, conversation_id, call_id, sender_phone_number_id, recipient_e164, purpose, prepared_message_id, expires_at)
    values (call_row.organization_id, call_row.location_id, call_row.conversation_id, call_row.id, sender.id, call_row.transport_caller_e164, 'lead_followup', message_row.id, now() + interval '10 minutes') returning * into intent;
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (intent.organization_id, intent.location_id, 'sms.consent.prepared', 'sms_consent_intent', intent.id, jsonb_build_object('channel','voice','purpose','lead_followup'));
  end if;
  return query select intent.id, intent.expires_at;
end;
$$;

create or replace function public.create_lead_followup_message(target_job_id uuid)
returns table (message_id uuid) language plpgsql security definer set search_path = '' as $$
declare job public.lead_followup_jobs%rowtype; lead_row public.leads%rowtype; conversation_row public.conversations%rowtype;
  consent public.sms_consents%rowtype; sender public.phone_numbers%rowtype; organization_row public.organizations%rowtype;
  category_label text; body_text text; saved_message_id uuid; saved_delivery_id uuid;
begin
  perform public.require_messaging_service_role();
  select * into job from public.lead_followup_jobs where id = target_job_id for update;
  if job.id is null or job.status <> 'processing' or job.message_id is not null then return; end if;
  if not public.lead_followup_settings_sender_is_current(job.organization_id, job.location_id, job.sender_phone_number_id) then
    perform public.suppress_lead_followup_job(job.id, 'settings_changed'); return;
  end if;
  select * into lead_row from public.leads where organization_id = job.organization_id and location_id = job.location_id and id = job.lead_id;
  select * into conversation_row from public.conversations where organization_id = job.organization_id and location_id = job.location_id and id = job.conversation_id;
  select * into consent from public.sms_consents where organization_id = job.organization_id and location_id = job.location_id and id = job.consent_id
    and status = 'active' and sender_phone_number_id = job.sender_phone_number_id and recipient_e164 = job.recipient_e164 and purpose = 'lead_followup';
  select * into sender from public.phone_numbers where organization_id = job.organization_id and location_id = job.location_id and id = job.sender_phone_number_id and status = 'active' and sms_enabled;
  if lead_row.id is null or lead_row.status not in ('new','qualified') or lead_row.urgency = 'urgent' or lead_row.qualification_reason = 'needs_human'
    or conversation_row.id is null or conversation_row.status <> 'open' or conversation_row.ai_mode <> 'ai' or consent.id is null or sender.id is null or sender.phone_number <> job.sender_e164
    or exists(select 1 from public.handoffs h where h.organization_id = job.organization_id and h.conversation_id = job.conversation_id and h.status in ('open','acknowledged'))
    or exists(select 1 from public.appointments a where a.organization_id = job.organization_id and a.location_id = job.location_id and a.conversation_id = job.conversation_id and a.status = 'confirmed')
    or exists(select 1 from public.booking_intents b where b.organization_id = job.organization_id and b.location_id = job.location_id and b.conversation_id = job.conversation_id and b.status in ('awaiting_confirmation','booking','provider_success_pending_persistence','provider_state_unknown'))
    or exists(select 1 from public.appointment_change_intents ci where ci.organization_id = job.organization_id and ci.location_id = job.location_id and ci.conversation_id = job.conversation_id and ci.status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown','handoff_required'))
    or exists(select 1 from public.messaging_contact_preferences preference join public.messages route_message on route_message.organization_id = preference.organization_id and route_message.location_id = preference.location_id and route_message.contact_id = preference.contact_id and route_message.transport_sender_e164 = job.recipient_e164 where preference.organization_id = job.organization_id and preference.location_id = job.location_id and preference.sender_phone_number_id = job.sender_phone_number_id and preference.channel_type = 'sms' and preference.status = 'opted_out')
    or exists(select 1 from public.messages message where message.organization_id = job.organization_id and message.location_id = job.location_id and message.conversation_id = job.conversation_id and message.created_at > (select created_at from public.messages where organization_id = job.organization_id and location_id = job.location_id and id = job.trigger_message_id) and (message.author_type in ('customer','human') or (message.source_channel = 'sms' and message.author_type in ('ai','system')))) then
    perform public.suppress_lead_followup_job(job.id, 'stale_or_ineligible'); return;
  end if;
  select * into organization_row from public.organizations where id = job.organization_id;
  category_label := nullif(regexp_replace(initcap(replace(btrim(coalesce(lead_row.service_category, '')), '_', ' ')), '\\s+', ' ', 'g'), '');
  body_text := left('Hi, this is ' || coalesce(nullif(btrim(organization_row.name), ''), 'our team') || '. Just checking whether you would still like help with '
    || coalesce(category_label, 'your request') || '. Reply here and we can help. Reply STOP to opt out.', 480);
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_at)
  values (job.organization_id, job.location_id, job.conversation_id, conversation_row.contact_id, 'outbound', 'text', body_text,
    jsonb_build_object('transport','sms','kind','lead_followup'), 'sms', 'system', now()) returning id into saved_message_id;
  insert into public.message_deliveries (organization_id, location_id, message_id, provider)
    values (job.organization_id, job.location_id, saved_message_id, 'twilio') returning id into saved_delivery_id;
  update public.lead_followup_jobs set message_id = saved_message_id, delivery_id = saved_delivery_id, status = 'delivery_pending',
    claimed_at = null, claimed_by = null, updated_at = now() where id = job.id;
  return query select saved_message_id;
end;
$$;

create function public.recover_stale_lead_followup_submissions(target_limit integer default 25)
returns integer language plpgsql security definer set search_path = '' as $$
declare recovered integer;
begin
  perform public.require_messaging_service_role();
  if target_limit not between 1 and 100 then raise exception using errcode = '22023', message = 'Follow-up recovery limit is invalid'; end if;
  with stale as (
    select delivery.id from public.message_deliveries delivery
    join public.lead_followup_jobs job on job.organization_id = delivery.organization_id and job.location_id = delivery.location_id and job.delivery_id = delivery.id
    where delivery.provider = 'twilio' and delivery.status = 'submitting' and delivery.attempted_at <= now() - interval '5 minutes'
    order by delivery.attempted_at asc, delivery.id asc for update of delivery skip locked limit target_limit
  ), recovered_rows as (
    update public.message_deliveries delivery set status = 'unknown', error_code = 'stale_lead_followup_submission_unknown', updated_at = now()
    from stale where delivery.id = stale.id and delivery.status = 'submitting' returning delivery.id
  ) select count(*) into recovered from recovered_rows;
  return recovered;
end;
$$;

create or replace function public.claim_lead_followup_jobs(target_worker_id text, target_limit integer default 10)
returns table (job_id uuid, message_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id,''))) not between 1 and 160 or target_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'Follow-up claim is invalid';
  end if;
  perform public.recover_stale_lead_followup_submissions(least(target_limit, 50));
  return query with claimed as (
    select job.id from public.lead_followup_jobs job
    where (job.status = 'scheduled' and job.scheduled_for <= now())
      or job.status = 'delivery_pending'
      or (job.status = 'processing' and job.claimed_at <= now() - interval '5 minutes')
    order by coalesce(job.scheduled_for, job.created_at), job.created_at for update skip locked limit target_limit
  ), updated as (
    update public.lead_followup_jobs job set status = 'processing', claimed_at = now(), claimed_by = btrim(target_worker_id), updated_at = now()
    from claimed where job.id = claimed.id returning job.id, job.message_id
  ) select updated.id, updated.message_id from updated;
end;
$$;

create or replace function public.claim_lead_followup_delivery(target_job_id uuid)
returns table (message_id uuid, to_e164 text, from_e164 text, body text)
language plpgsql security definer set search_path = '' as $$
declare job public.lead_followup_jobs%rowtype; delivery public.message_deliveries%rowtype; lead_row public.leads%rowtype;
  conversation_row public.conversations%rowtype; consent public.sms_consents%rowtype; sender public.phone_numbers%rowtype; message_row public.messages%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into job from public.lead_followup_jobs where id = target_job_id for update;
  if job.id is null or job.status not in ('processing','delivery_pending') or job.message_id is null or job.delivery_id is null then return; end if;
  select * into delivery from public.message_deliveries where id = job.delivery_id for update;
  select * into lead_row from public.leads where id = job.lead_id;
  select * into conversation_row from public.conversations where id = job.conversation_id;
  select * into consent from public.sms_consents where id = job.consent_id and status = 'active' and recipient_e164 = job.recipient_e164 and sender_phone_number_id = job.sender_phone_number_id;
  select * into sender from public.phone_numbers where id = job.sender_phone_number_id and status = 'active' and sms_enabled;
  select * into message_row from public.messages where id = job.message_id;
  if delivery.id is null or delivery.status <> 'queued' or not public.lead_followup_settings_sender_is_current(job.organization_id, job.location_id, job.sender_phone_number_id)
    or lead_row.id is null or lead_row.status not in ('new','qualified') or lead_row.urgency = 'urgent' or lead_row.qualification_reason = 'needs_human'
    or conversation_row.id is null or conversation_row.status <> 'open' or conversation_row.ai_mode <> 'ai' or consent.id is null or sender.id is null or sender.phone_number <> job.sender_e164
    or exists(select 1 from public.handoffs h where h.organization_id = job.organization_id and h.conversation_id = job.conversation_id and h.status in ('open','acknowledged'))
    or exists(select 1 from public.appointments a where a.organization_id = job.organization_id and a.location_id = job.location_id and a.conversation_id = job.conversation_id and a.status = 'confirmed')
    or exists(select 1 from public.booking_intents b where b.organization_id = job.organization_id and b.location_id = job.location_id and b.conversation_id = job.conversation_id and b.status in ('awaiting_confirmation','booking','provider_success_pending_persistence','provider_state_unknown'))
    or exists(select 1 from public.appointment_change_intents ci where ci.organization_id = job.organization_id and ci.location_id = job.location_id and ci.conversation_id = job.conversation_id and ci.status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown','handoff_required'))
    or exists(select 1 from public.messaging_contact_preferences preference join public.messages route_message on route_message.organization_id = preference.organization_id and route_message.location_id = preference.location_id and route_message.contact_id = preference.contact_id and route_message.transport_sender_e164 = job.recipient_e164 where preference.organization_id = job.organization_id and preference.location_id = job.location_id and preference.sender_phone_number_id = job.sender_phone_number_id and preference.channel_type = 'sms' and preference.status = 'opted_out')
    or exists(select 1 from public.messages message where message.organization_id = job.organization_id and message.location_id = job.location_id and message.conversation_id = job.conversation_id and message.created_at > message_row.created_at and message.author_type in ('customer','human')) then
    perform public.suppress_lead_followup_job(job.id, 'lead_followup_ineligible'); return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'lead-followup-frequency:' || job.organization_id::text || ':' || job.location_id::text || ':' || job.sender_phone_number_id::text || ':' || job.recipient_e164, 0));
  if exists (
    select 1 from public.lead_followup_jobs existing_job
    join public.message_deliveries existing_delivery on existing_delivery.organization_id = existing_job.organization_id
      and existing_delivery.location_id = existing_job.location_id and existing_delivery.id = existing_job.delivery_id
    where existing_job.organization_id = job.organization_id and existing_job.location_id = job.location_id
      and existing_job.sender_phone_number_id = job.sender_phone_number_id and existing_job.recipient_e164 = job.recipient_e164
      and existing_job.id <> job.id and existing_delivery.status in ('submitting','submitted','sent','delivered','unknown')
      and coalesce(existing_delivery.attempted_at, existing_delivery.updated_at, existing_delivery.created_at) > now() - interval '24 hours'
  ) then
    perform public.suppress_lead_followup_job(job.id, 'frequency_cap'); return;
  end if;
  update public.message_deliveries set status = 'submitting', attempted_at = now(), updated_at = now() where id = delivery.id and status = 'queued';
  if not found then return; end if;
  return query select message_row.id, job.recipient_e164, job.sender_e164, message_row.body;
end;
$$;

create or replace function public.sync_lead_followup_delivery_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  update public.lead_followup_jobs set
    status = case
      when new.status in ('submitted','sent','delivered') then 'sent'
      when new.status = 'suppressed' then 'skipped'
      when new.status in ('failed','undelivered','unknown') then 'failed'
      else status
    end,
    skip_reason = case when new.status = 'suppressed' then coalesce(new.error_code, 'delivery_suppressed') else skip_reason end,
    failure_reason = case when new.status in ('failed','undelivered','unknown') then coalesce(new.error_code, 'delivery_failed') else failure_reason end,
    claimed_at = null, claimed_by = null, updated_at = now()
  where organization_id = new.organization_id and location_id = new.location_id and delivery_id = new.id
    and status in ('processing','delivery_pending','sent');
  return new;
end;
$$;

create or replace function public.lead_followup_audit_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_action text;
begin
  event_action := case
    when tg_op = 'INSERT' and new.status = 'scheduled' then 'lead.followup.scheduled'
    when tg_op = 'INSERT' and new.status = 'skipped' then 'lead.followup.skipped'
    when tg_op = 'UPDATE' and new.status = 'sent' and old.status is distinct from new.status then 'lead.followup.sent'
    when tg_op = 'UPDATE' and new.status = 'skipped' and old.status is distinct from new.status then 'lead.followup.skipped'
    when tg_op = 'UPDATE' and new.status = 'failed' and old.status is distinct from new.status then 'lead.followup.failed'
    else null end;
  if event_action is not null then
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (new.organization_id, new.location_id, event_action, 'lead_followup', new.id,
      jsonb_strip_nulls(jsonb_build_object('followup_type','lead_followup','reason',coalesce(new.skip_reason,new.failure_reason))));
  end if;
  return new;
end;
$$;

drop function public.get_my_lead_followup_settings(uuid);
create function public.get_my_lead_followup_settings(target_location_id uuid)
returns table (
  lead_followup_enabled boolean,
  delay_minutes integer,
  quiet_hours_start time,
  quiet_hours_end time,
  business_hours_only boolean,
  sender_available boolean,
  sender_phone_number_id uuid,
  sender_e164 text,
  automation_acknowledged_at timestamptz,
  automation_acknowledged_sender_phone_number_id uuid
)
language sql security definer set search_path = '' as $$
  select coalesce(settings.lead_followup_enabled, false), coalesce(settings.delay_minutes, 240),
    coalesce(settings.quiet_hours_start, time '20:00'), coalesce(settings.quiet_hours_end, time '08:00'),
    coalesce(settings.business_hours_only, true),
    exists (select 1 from public.phone_numbers candidate where candidate.organization_id = location.organization_id
      and candidate.location_id = location.id and candidate.status = 'active' and candidate.sms_enabled),
    settings.sender_phone_number_id, selected.phone_number, settings.automation_acknowledged_at,
    settings.automation_acknowledged_sender_phone_number_id
  from public.locations location
  left join public.lead_followup_settings settings on settings.organization_id = location.organization_id and settings.location_id = location.id
  left join public.phone_numbers selected on selected.organization_id = location.organization_id and selected.location_id = location.id and selected.id = settings.sender_phone_number_id
  where location.id = target_location_id and public.is_organization_admin(location.organization_id);
$$;

create function public.get_my_lead_followup_sender_options(target_location_id uuid)
returns table (phone_number_id uuid, phone_number text)
language sql security definer set search_path = '' as $$
  select sender.id, sender.phone_number
  from public.locations location
  join public.phone_numbers sender on sender.organization_id = location.organization_id and sender.location_id = location.id
  where location.id = target_location_id and public.is_organization_admin(location.organization_id)
    and sender.status = 'active' and sender.sms_enabled
  order by sender.created_at asc, sender.id asc;
$$;

drop function public.upsert_my_lead_followup_settings(uuid, boolean, integer, time, time, boolean, boolean);
create function public.upsert_my_lead_followup_settings(
  target_location_id uuid,
  target_enabled boolean,
  target_delay_minutes integer,
  target_quiet_hours_start time,
  target_quiet_hours_end time,
  target_business_hours_only boolean,
  target_sender_phone_number_id uuid,
  target_acknowledge_sender boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare location_row public.locations%rowtype; sender public.phone_numbers%rowtype; previous public.lead_followup_settings%rowtype; settings_id uuid;
begin
  select * into location_row from public.locations where id = target_location_id;
  if location_row.id is null or not public.is_organization_admin(location_row.organization_id) then
    raise exception using errcode = '42501', message = 'Follow-up settings are unavailable';
  end if;
  if target_delay_minutes not between 15 and 10080 or target_quiet_hours_start = target_quiet_hours_end then
    raise exception using errcode = '22023', message = 'Follow-up settings are invalid';
  end if;
  if target_sender_phone_number_id is not null then
    select * into sender from public.phone_numbers where organization_id = location_row.organization_id and location_id = location_row.id
      and id = target_sender_phone_number_id and status = 'active' and sms_enabled;
    if sender.id is null then raise exception using errcode = '42501', message = 'Selected SMS sender is unavailable'; end if;
  end if;
  if target_enabled and (sender.id is null or not target_acknowledge_sender) then
    raise exception using errcode = '42501', message = 'Sender acknowledgement is required';
  end if;
  select * into previous from public.lead_followup_settings
    where organization_id = location_row.organization_id and location_id = location_row.id for update;
  if previous.id is not null and (not target_enabled or previous.sender_phone_number_id is distinct from target_sender_phone_number_id) then
    perform public.suppress_lead_followups_for_location(location_row.organization_id, location_row.id,
      case when not target_enabled then 'settings_disabled' else 'sender_changed' end);
  end if;
  insert into public.lead_followup_settings as settings
    (organization_id, location_id, lead_followup_enabled, delay_minutes, quiet_hours_start, quiet_hours_end, business_hours_only,
      sender_phone_number_id, automation_acknowledged_at, automation_acknowledged_by, automation_acknowledged_sender_phone_number_id)
  values (location_row.organization_id, location_row.id, target_enabled, target_delay_minutes, target_quiet_hours_start,
    target_quiet_hours_end, target_business_hours_only, sender.id,
    case when target_enabled and previous.sender_phone_number_id is not distinct from sender.id
      and previous.automation_acknowledged_sender_phone_number_id = sender.id then previous.automation_acknowledged_at
      when target_enabled then now() else null end,
    case when target_enabled and previous.sender_phone_number_id is not distinct from sender.id
      and previous.automation_acknowledged_sender_phone_number_id = sender.id then previous.automation_acknowledged_by
      when target_enabled then auth.uid() else null end,
    case when target_enabled then sender.id else null end)
  on conflict (organization_id, location_id) do update set
    lead_followup_enabled = excluded.lead_followup_enabled,
    delay_minutes = excluded.delay_minutes,
    quiet_hours_start = excluded.quiet_hours_start,
    quiet_hours_end = excluded.quiet_hours_end,
    business_hours_only = excluded.business_hours_only,
    sender_phone_number_id = excluded.sender_phone_number_id,
    automation_acknowledged_at = excluded.automation_acknowledged_at,
    automation_acknowledged_by = excluded.automation_acknowledged_by,
    automation_acknowledged_sender_phone_number_id = excluded.automation_acknowledged_sender_phone_number_id,
    updated_at = now()
  returning id into settings_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (location_row.organization_id, location_row.id, 'followup.settings.updated', 'lead_followup_settings', settings_id,
    jsonb_build_object('followup_type', 'lead_followup', 'sender_phone_number_id', sender.id));
end;
$$;

drop policy if exists lead_followup_settings_select_member on public.lead_followup_settings;
create policy lead_followup_settings_select_admin on public.lead_followup_settings for select to authenticated
  using (public.is_organization_admin(organization_id));

-- SECURITY DEFINER trigger and helper functions are never a client boundary.
revoke all on function
  public.enforce_lead_followup_job_snapshot(),
  public.is_explicit_sms_followup_confirmation(text),
  public.lead_followup_next_allowed_time(timestamptz, text, time, time, jsonb, boolean),
  public.lead_followup_settings_sender_is_current(uuid, uuid, uuid),
  public.lead_followup_eligible(uuid),
  public.try_materialize_lead_followup(uuid),
  public.lead_followup_materialize_trigger(),
  public.suppress_lead_followup_job(uuid, text),
  public.suppress_lead_followups_for_location(uuid, uuid, text),
  public.suppress_lead_followups_for_lead(uuid, uuid, text),
  public.suppress_lead_followups_for_conversation(uuid, uuid, uuid, text),
  public.suppress_lead_followups_for_route(uuid, uuid, uuid, text, text),
  public.suppress_stale_lead_followups(),
  public.suppress_lead_followups_on_conversation_change(),
  public.suppress_lead_followups_on_handoff(),
  public.suppress_lead_followups_on_confirmed_appointment(),
  public.sms_consent_materialize_trigger(),
  public.sync_sms_followup_consent_from_inbound(),
  public.sync_sms_followup_consent_from_preference(),
  public.suppress_lead_followups_on_reply(),
  public.sync_lead_followup_delivery_status(),
  public.lead_followup_audit_trigger(),
  public.recover_stale_lead_followup_submissions(integer),
  public.prepare_voice_sms_followup_consent(text, uuid),
  public.confirm_voice_sms_followup_consent(text, uuid, uuid),
  public.claim_lead_followup_jobs(text, integer),
  public.create_lead_followup_message(uuid),
  public.claim_lead_followup_delivery(uuid),
  public.get_my_lead_followup_settings(uuid),
  public.get_my_lead_followup_sender_options(uuid),
  public.get_my_lead_followup(uuid),
  public.upsert_my_lead_followup_settings(uuid, boolean, integer, time, time, boolean, uuid, boolean)
from public, anon, authenticated, service_role;

grant execute on function public.get_my_lead_followup_settings(uuid), public.get_my_lead_followup_sender_options(uuid),
  public.get_my_lead_followup(uuid), public.upsert_my_lead_followup_settings(uuid, boolean, integer, time, time, boolean, uuid, boolean)
to authenticated;
grant execute on function public.prepare_voice_sms_followup_consent(text, uuid), public.confirm_voice_sms_followup_consent(text, uuid, uuid),
  public.claim_lead_followup_jobs(text, integer), public.create_lead_followup_message(uuid), public.claim_lead_followup_delivery(uuid),
  public.recover_stale_lead_followup_submissions(integer)
to service_role;

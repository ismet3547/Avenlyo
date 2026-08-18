-- Phase 11: consent-aware, single transactional lead follow-ups. This deliberately reuses the
-- existing trusted Voice/SMS ingress and Twilio delivery state machine; browser clients never
-- create consent, jobs, recipients, senders, or delivery state directly.

alter table public.phone_numbers
  add constraint phone_numbers_organization_location_id_key unique (organization_id, location_id, id);
alter table public.calls
  add constraint calls_organization_location_id_key unique (organization_id, location_id, id);
alter table public.message_deliveries
  add constraint message_deliveries_organization_location_id_key unique (organization_id, location_id, id);

create table public.sms_consents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  sender_phone_number_id uuid not null,
  recipient_e164 text not null check (recipient_e164 ~ E'^\\+[1-9][0-9]{7,14}$'),
  purpose text not null check (purpose in ('lead_followup')),
  status text not null check (status in ('active', 'revoked')),
  source_type text not null check (source_type in ('voice_explicit', 'sms_start')),
  source_message_id uuid,
  source_call_id uuid,
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_consents_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint sms_consents_sender_route_fk foreign key (organization_id, location_id, sender_phone_number_id)
    references public.phone_numbers (organization_id, location_id, id),
  constraint sms_consents_source_message_fk foreign key (organization_id, location_id, source_message_id)
    references public.messages (organization_id, location_id, id),
  constraint sms_consents_source_call_fk foreign key (organization_id, location_id, source_call_id)
    references public.calls (organization_id, location_id, id),
  constraint sms_consents_route_purpose_key unique (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose),
  constraint sms_consents_source_check check (
    (source_type = 'voice_explicit' and source_call_id is not null and source_message_id is not null)
    or (source_type = 'sms_start' and source_message_id is not null and source_call_id is null)
  ),
  constraint sms_consents_status_time_check check (
    (status = 'active' and granted_at is not null and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);
create index sms_consents_active_route_idx
  on public.sms_consents (organization_id, location_id, sender_phone_number_id, recipient_e164)
  where status = 'active' and purpose = 'lead_followup';

create table public.voice_sms_followup_consent_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  call_id uuid not null,
  sender_phone_number_id uuid not null,
  recipient_e164 text not null check (recipient_e164 ~ E'^\\+[1-9][0-9]{7,14}$'),
  purpose text not null check (purpose = 'lead_followup'),
  status text not null default 'awaiting_confirmation'
    check (status in ('awaiting_confirmation', 'completed', 'declined', 'expired')),
  prepared_message_id uuid not null,
  confirmed_message_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voice_sms_consent_intents_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint voice_sms_consent_intents_conversation_fk foreign key (organization_id, location_id, conversation_id)
    references public.conversations (organization_id, location_id, id) on delete cascade,
  constraint voice_sms_consent_intents_call_fk foreign key (organization_id, location_id, call_id)
    references public.calls (organization_id, location_id, id) on delete cascade,
  constraint voice_sms_consent_intents_sender_fk foreign key (organization_id, location_id, sender_phone_number_id)
    references public.phone_numbers (organization_id, location_id, id),
  constraint voice_sms_consent_intents_prepared_message_fk foreign key (organization_id, location_id, prepared_message_id)
    references public.messages (organization_id, location_id, id),
  constraint voice_sms_consent_intents_confirmed_message_fk foreign key (organization_id, location_id, confirmed_message_id)
    references public.messages (organization_id, location_id, id),
  constraint voice_sms_consent_intents_completed_check check (
    (status = 'completed' and confirmed_message_id is not null) or status <> 'completed'
  )
);
create unique index voice_sms_consent_intents_one_active_call_purpose
  on public.voice_sms_followup_consent_intents (organization_id, call_id, purpose)
  where status = 'awaiting_confirmation';

create table public.lead_followup_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  lead_followup_enabled boolean not null default false,
  delay_minutes integer not null default 240 check (delay_minutes between 15 and 10080),
  quiet_hours_start time not null default time '20:00',
  quiet_hours_end time not null default time '08:00',
  business_hours_only boolean not null default true,
  sender_phone_number_id uuid,
  automation_acknowledged_at timestamptz,
  automation_acknowledged_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_followup_settings_location_key unique (organization_id, location_id),
  constraint lead_followup_settings_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint lead_followup_settings_sender_fk foreign key (organization_id, location_id, sender_phone_number_id)
    references public.phone_numbers (organization_id, location_id, id),
  constraint lead_followup_settings_ack_member_fk foreign key (organization_id, automation_acknowledged_by)
    references public.organization_members (organization_id, user_id),
  constraint lead_followup_settings_quiet_hours_check check (quiet_hours_start <> quiet_hours_end),
  constraint lead_followup_settings_ack_check check (
    (lead_followup_enabled = false)
    or (sender_phone_number_id is not null and automation_acknowledged_at is not null and automation_acknowledged_by is not null)
  )
);

create table public.lead_followup_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  lead_id uuid not null,
  conversation_id uuid not null,
  consent_id uuid not null,
  sender_phone_number_id uuid not null,
  sender_e164 text not null check (sender_e164 ~ E'^\\+[1-9][0-9]{7,14}$'),
  recipient_e164 text not null check (recipient_e164 ~ E'^\\+[1-9][0-9]{7,14}$'),
  trigger_message_id uuid not null,
  scheduled_for timestamptz,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'processing', 'delivery_pending', 'sent', 'skipped', 'failed')),
  message_id uuid,
  delivery_id uuid,
  skip_reason text,
  failure_reason text,
  claimed_at timestamptz,
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_followup_jobs_lead_key unique (organization_id, lead_id),
  constraint lead_followup_jobs_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint lead_followup_jobs_lead_fk foreign key (organization_id, location_id, lead_id)
    references public.leads (organization_id, location_id, id) on delete cascade,
  constraint lead_followup_jobs_conversation_fk foreign key (organization_id, location_id, conversation_id)
    references public.conversations (organization_id, location_id, id) on delete cascade,
  constraint lead_followup_jobs_consent_fk foreign key (organization_id, location_id, consent_id)
    references public.sms_consents (organization_id, location_id, id),
  constraint lead_followup_jobs_sender_fk foreign key (organization_id, location_id, sender_phone_number_id)
    references public.phone_numbers (organization_id, location_id, id),
  constraint lead_followup_jobs_trigger_fk foreign key (organization_id, location_id, trigger_message_id)
    references public.messages (organization_id, location_id, id),
  constraint lead_followup_jobs_message_fk foreign key (organization_id, location_id, message_id)
    references public.messages (organization_id, location_id, id),
  constraint lead_followup_jobs_delivery_fk foreign key (organization_id, location_id, delivery_id)
    references public.message_deliveries (organization_id, location_id, id),
  constraint lead_followup_jobs_schedule_check check (
    (status = 'scheduled' and scheduled_for is not null) or status <> 'scheduled'
  )
);
create index lead_followup_jobs_claim_idx on public.lead_followup_jobs (scheduled_for, created_at)
  where status = 'scheduled';
create index lead_followup_jobs_delivery_idx on public.lead_followup_jobs (updated_at)
  where status = 'delivery_pending';

create trigger set_sms_consents_updated_at before update on public.sms_consents
  for each row execute procedure public.set_updated_at();
create trigger set_voice_sms_followup_consent_intents_updated_at before update on public.voice_sms_followup_consent_intents
  for each row execute procedure public.set_updated_at();
create trigger set_lead_followup_settings_updated_at before update on public.lead_followup_settings
  for each row execute procedure public.set_updated_at();
create trigger set_lead_followup_jobs_updated_at before update on public.lead_followup_jobs
  for each row execute procedure public.set_updated_at();

create function public.enforce_lead_followup_job_snapshot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.organization_id is distinct from old.organization_id
    or new.location_id is distinct from old.location_id
    or new.lead_id is distinct from old.lead_id
    or new.conversation_id is distinct from old.conversation_id
    or new.consent_id is distinct from old.consent_id
    or new.sender_phone_number_id is distinct from old.sender_phone_number_id
    or new.sender_e164 is distinct from old.sender_e164
    or new.recipient_e164 is distinct from old.recipient_e164
    or new.trigger_message_id is distinct from old.trigger_message_id then
    raise exception using errcode = '42501', message = 'Lead follow-up snapshots are immutable';
  end if;
  return new;
end;
$$;
create trigger lead_followup_jobs_enforce_snapshot before update on public.lead_followup_jobs
  for each row execute function public.enforce_lead_followup_job_snapshot();

create function public.is_explicit_sms_followup_confirmation(target_body text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(target_body, '')), '\\s+', ' ', 'g')) in
    ('yes', 'yes please', 'sure', 'okay', 'you can text me', 'send me a text', 'yes you can');
$$;

create function public.lead_followup_next_allowed_time(
  target_time timestamptz,
  target_timezone text,
  quiet_start time,
  quiet_end time,
  target_business_hours jsonb,
  enforce_business_hours boolean
)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare candidate timestamp without time zone; candidate_at timestamptz; day_hours jsonb; permitted boolean; attempts integer := 0;
begin
  -- Follow-ups are never moved earlier. Minute precision keeps the bounded search deterministic.
  candidate := date_trunc('minute', target_time at time zone target_timezone);
  if candidate < (target_time at time zone target_timezone) then candidate := candidate + interval '1 minute'; end if;
  while attempts < 20160 loop
    day_hours := target_business_hours -> lower(to_char(candidate::date, 'FMDay'));
    permitted := not ((quiet_start < quiet_end and candidate::time >= quiet_start and candidate::time < quiet_end)
      or (quiet_start > quiet_end and (candidate::time >= quiet_start or candidate::time < quiet_end)));
    if enforce_business_hours then
      permitted := permitted and coalesce((day_hours ->> 'closed')::boolean, true) = false
        and candidate::time >= (day_hours ->> 'open')::time and candidate::time < (day_hours ->> 'close')::time;
    end if;
    if permitted then
      candidate_at := candidate at time zone target_timezone;
      if candidate_at at time zone target_timezone = candidate and candidate_at >= target_time then return candidate_at; end if;
    end if;
    candidate := candidate + interval '1 minute';
    attempts := attempts + 1;
  end loop;
  return null;
end;
$$;

create function public.lead_followup_eligible(target_lead_id uuid)
returns table (consent_id uuid, sender_phone_number_id uuid, sender_e164 text, recipient_e164 text, trigger_message_id uuid, scheduled_for timestamptz, reason text)
language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads%rowtype; conversation_row public.conversations%rowtype; settings public.lead_followup_settings%rowtype;
  consent public.sms_consents%rowtype; sender public.phone_numbers%rowtype; location public.locations%rowtype; candidate_time timestamptz;
begin
  select * into lead_row from public.leads where id = target_lead_id;
  if lead_row.id is null or lead_row.location_id is null or lead_row.status not in ('new','qualified') or lead_row.urgency = 'urgent'
    or lead_row.qualification_reason = 'needs_human' then return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'lead_ineligible'; return; end if;
  select * into conversation_row from public.conversations where organization_id = lead_row.organization_id and location_id = lead_row.location_id and id = lead_row.conversation_id;
  if conversation_row.id is null or conversation_row.status <> 'open' or conversation_row.ai_mode <> 'ai'
    or exists (select 1 from public.handoffs h where h.organization_id = lead_row.organization_id and h.conversation_id = conversation_row.id and h.status in ('open','acknowledged'))
    or exists (select 1 from public.appointments a where a.organization_id = lead_row.organization_id and a.location_id = lead_row.location_id and a.conversation_id = conversation_row.id and a.status = 'confirmed')
    or exists (select 1 from public.booking_intents b where b.organization_id = lead_row.organization_id and b.location_id = lead_row.location_id and b.conversation_id = conversation_row.id and b.status in ('prepared','booking','provider_success_pending_persistence','provider_state_unknown'))
    or exists (select 1 from public.appointment_change_intents ci where ci.organization_id = lead_row.organization_id and ci.location_id = lead_row.location_id and ci.conversation_id = conversation_row.id and ci.status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown','handoff_required'))
  then return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'conversation_ineligible'; return; end if;
  select * into settings from public.lead_followup_settings where organization_id = lead_row.organization_id and location_id = lead_row.location_id;
  if settings.id is null or not settings.lead_followup_enabled or settings.sender_phone_number_id is null or settings.automation_acknowledged_at is null then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'settings_disabled'; return;
  end if;
  select * into sender from public.phone_numbers where organization_id = lead_row.organization_id and location_id = lead_row.location_id and id = settings.sender_phone_number_id and status = 'active' and sms_enabled;
  if sender.id is null or sender.phone_number !~ E'^\\+[1-9][0-9]{7,14}$' then return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'sender_unavailable'; return; end if;
  select consent_row.* into consent from public.sms_consents consent_row
    left join public.messages consent_message on consent_message.organization_id = consent_row.organization_id
      and consent_message.location_id = consent_row.location_id and consent_message.id = consent_row.source_message_id
    left join public.calls consent_call on consent_call.organization_id = consent_row.organization_id
      and consent_call.location_id = consent_row.location_id and consent_call.id = consent_row.source_call_id
  where consent_row.organization_id = lead_row.organization_id and consent_row.location_id = lead_row.location_id
    and consent_row.sender_phone_number_id = sender.id and consent_row.purpose = 'lead_followup' and consent_row.status = 'active'
    and (
      consent_message.conversation_id = lead_row.conversation_id
      or consent_call.conversation_id = lead_row.conversation_id
    )
    order by granted_at desc limit 1;
  if consent.id is null then return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'consent_unavailable'; return; end if;
  if exists (select 1 from public.messaging_contact_preferences p join public.messages route_message
    on route_message.organization_id = p.organization_id and route_message.location_id = p.location_id
      and route_message.contact_id = p.contact_id and route_message.transport_sender_e164 = consent.recipient_e164
    where p.organization_id = lead_row.organization_id and p.location_id = lead_row.location_id
      and p.sender_phone_number_id = sender.id and p.channel_type = 'sms' and p.status = 'opted_out') then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'opted_out'; return;
  end if;
  select * into location from public.locations where organization_id = lead_row.organization_id and id = lead_row.location_id;
  candidate_time := public.lead_followup_next_allowed_time(now() + make_interval(mins => settings.delay_minutes), location.timezone, settings.quiet_hours_start, settings.quiet_hours_end, location.business_hours, settings.business_hours_only);
  if candidate_time is null then return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'no_allowed_window'; return; end if;
  if not exists (select 1 from public.messages trigger_message
    where trigger_message.organization_id = lead_row.organization_id and trigger_message.location_id = lead_row.location_id
      and trigger_message.id = lead_row.last_captured_message_id and trigger_message.conversation_id = lead_row.conversation_id
      and trigger_message.direction = 'inbound' and trigger_message.author_type = 'customer') then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'trigger_unavailable'; return;
  end if;
  return query select consent.id, sender.id, sender.phone_number, consent.recipient_e164, lead_row.last_captured_message_id, candidate_time, null::text;
end;
$$;

create function public.try_materialize_lead_followup(target_lead_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads%rowtype; eligible record;
begin
  select * into lead_row from public.leads where id = target_lead_id for update;
  if lead_row.id is null or exists(select 1 from public.lead_followup_jobs where organization_id = lead_row.organization_id and lead_id = lead_row.id) then return; end if;
  select * into eligible from public.lead_followup_eligible(lead_row.id);
  if eligible.reason is not null then return; end if;
  if eligible.trigger_message_id is null then return; end if;
  if exists (select 1 from public.lead_followup_jobs j join public.messages m on m.organization_id = j.organization_id and m.id = j.message_id
    where j.organization_id = lead_row.organization_id and j.sender_phone_number_id = eligible.sender_phone_number_id and j.recipient_e164 = eligible.recipient_e164
      and j.status = 'sent' and m.created_at > now() - interval '24 hours') then
    insert into public.lead_followup_jobs (organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, status, skip_reason)
    values (lead_row.organization_id, lead_row.location_id, lead_row.id, lead_row.conversation_id, eligible.consent_id, eligible.sender_phone_number_id, eligible.sender_e164, eligible.recipient_e164, eligible.trigger_message_id, 'skipped', 'frequency_cap');
  else
    insert into public.lead_followup_jobs (organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, scheduled_for)
    values (lead_row.organization_id, lead_row.location_id, lead_row.id, lead_row.conversation_id, eligible.consent_id, eligible.sender_phone_number_id, eligible.sender_e164, eligible.recipient_e164, eligible.trigger_message_id, eligible.scheduled_for);
  end if;
end;
$$;

create function public.lead_followup_materialize_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('new','qualified') and new.location_id is not null then perform public.try_materialize_lead_followup(new.id); end if;
  return new;
end;
$$;
create trigger leads_materialize_followup after insert or update of status, urgency, qualification_reason, last_captured_message_id on public.leads
  for each row execute function public.lead_followup_materialize_trigger();

create function public.suppress_stale_lead_followups()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status not in ('new','qualified') or new.urgency = 'urgent' or new.qualification_reason = 'needs_human' then
    update public.lead_followup_jobs
      set status = 'skipped', skip_reason = 'lead_ineligible', claimed_at = null, claimed_by = null, updated_at = now()
      where organization_id = new.organization_id and lead_id = new.id
        and status in ('scheduled','processing','delivery_pending');
    update public.message_deliveries delivery
      set status = 'suppressed', error_code = 'lead_ineligible', updated_at = now()
      from public.lead_followup_jobs job
      where job.organization_id = delivery.organization_id and job.location_id = delivery.location_id
        and job.delivery_id = delivery.id and job.organization_id = new.organization_id and job.lead_id = new.id
        and delivery.status = 'queued';
  end if;
  return new;
end;
$$;
create trigger leads_suppress_stale_followup after update of status, urgency, qualification_reason on public.leads
  for each row execute function public.suppress_stale_lead_followups();

create function public.suppress_lead_followups_for_conversation(target_organization_id uuid, target_location_id uuid, target_conversation_id uuid, target_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.lead_followup_jobs
    set status = 'skipped', skip_reason = target_reason, claimed_at = null, claimed_by = null, updated_at = now()
    where organization_id = target_organization_id and location_id = target_location_id and conversation_id = target_conversation_id
      and status in ('scheduled','processing','delivery_pending');
  update public.message_deliveries delivery
    set status = 'suppressed', error_code = target_reason, updated_at = now()
    from public.lead_followup_jobs job
    where job.organization_id = delivery.organization_id and job.location_id = delivery.location_id
      and job.delivery_id = delivery.id and job.organization_id = target_organization_id and job.location_id = target_location_id
      and job.conversation_id = target_conversation_id and delivery.status = 'queued';
end;
$$;

create function public.suppress_lead_followups_on_conversation_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'open' or new.ai_mode <> 'ai' then
    perform public.suppress_lead_followups_for_conversation(new.organization_id, new.location_id, new.id, 'human_or_closed_conversation');
  end if;
  return new;
end;
$$;
create trigger conversations_suppress_stale_followup after update of status, ai_mode on public.conversations
  for each row execute function public.suppress_lead_followups_on_conversation_change();

create function public.suppress_lead_followups_on_handoff()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('open','acknowledged') then
    perform public.suppress_lead_followups_for_conversation(new.organization_id, new.location_id, new.conversation_id, 'human_handoff');
  end if;
  return new;
end;
$$;
create trigger handoffs_suppress_stale_followup after insert or update of status on public.handoffs
  for each row execute function public.suppress_lead_followups_on_handoff();

create function public.suppress_lead_followups_on_confirmed_appointment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'confirmed' and new.conversation_id is not null then
    perform public.suppress_lead_followups_for_conversation(new.organization_id, new.location_id, new.conversation_id, 'appointment_confirmed');
  end if;
  return new;
end;
$$;
create trigger appointments_suppress_stale_followup after insert or update of status on public.appointments
  for each row execute function public.suppress_lead_followups_on_confirmed_appointment();

create function public.sms_consent_materialize_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare lead_row public.leads%rowtype;
begin
  if new.status = 'active' and new.purpose = 'lead_followup' then
    for lead_row in select lead.* from public.leads lead
      left join public.messages source_message on source_message.organization_id = new.organization_id and source_message.location_id = new.location_id and source_message.id = new.source_message_id
      left join public.calls source_call on source_call.organization_id = new.organization_id and source_call.location_id = new.location_id and source_call.id = new.source_call_id
      where lead.organization_id = new.organization_id and lead.location_id = new.location_id and lead.status in ('new','qualified')
        and (lead.conversation_id = source_message.conversation_id or lead.conversation_id = source_call.conversation_id) loop
      perform public.try_materialize_lead_followup(lead_row.id);
    end loop;
  end if;
  return new;
end;
$$;
create trigger sms_consents_materialize_followup after insert or update of status on public.sms_consents
  for each row execute function public.sms_consent_materialize_trigger();

create function public.sync_sms_followup_consent_from_inbound()
returns trigger language plpgsql security definer set search_path = '' as $$
declare sender_id uuid; command text; preference public.messaging_contact_preferences%rowtype;
begin
  if new.direction <> 'inbound' or new.source_channel <> 'sms' or new.author_type <> 'customer' or new.transport_sender_e164 is null then return new; end if;
  select transport_phone_number_id into sender_id from public.conversations where organization_id = new.organization_id and location_id = new.location_id and id = new.conversation_id;
  command := lower(coalesce(new.metadata -> 'provider_metadata' ->> 'opt_out_type', ''));
  if command not in ('start','stop') then
    command := case lower(regexp_replace(btrim(coalesce(new.body, '')), '\\s+', ' ', 'g')) when 'start' then 'start' when 'unstop' then 'start'
      when 'stop' then 'stop' when 'stopall' then 'stop' when 'unsubscribe' then 'stop' when 'cancel' then 'stop' when 'end' then 'stop' when 'quit' then 'stop' else null end;
  end if;
  if sender_id is null or command is null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms-followup-consent:' || new.organization_id::text || ':' || sender_id::text || ':' || new.transport_sender_e164, 0));
  if command = 'start' then
    insert into public.sms_consents as consent (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose, status, source_type, source_message_id, granted_at)
    values (new.organization_id, new.location_id, sender_id, new.transport_sender_e164, 'lead_followup', 'active', 'sms_start', new.id, now())
    on conflict (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose) do update set
      status = 'active', source_type = 'sms_start', source_message_id = excluded.source_message_id, source_call_id = null, granted_at = now(), revoked_at = null, updated_at = now();
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      select organization_id, location_id, 'sms.consent.granted', 'sms_consent', id,
        jsonb_build_object('channel','sms','purpose','lead_followup')
      from public.sms_consents where organization_id = new.organization_id and location_id = new.location_id
        and sender_phone_number_id = sender_id and recipient_e164 = new.transport_sender_e164 and purpose = 'lead_followup';
  else
    update public.sms_consents set status = 'revoked', revoked_at = now(), source_message_id = new.id, updated_at = now()
      where organization_id = new.organization_id and location_id = new.location_id and sender_phone_number_id = sender_id and recipient_e164 = new.transport_sender_e164 and purpose = 'lead_followup' and status = 'active';
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      select organization_id, location_id, 'sms.consent.revoked', 'sms_consent', id,
        jsonb_build_object('channel','sms','purpose','lead_followup')
      from public.sms_consents where organization_id = new.organization_id and location_id = new.location_id
        and sender_phone_number_id = sender_id and recipient_e164 = new.transport_sender_e164 and purpose = 'lead_followup' and status = 'revoked';
    update public.lead_followup_jobs set status = 'skipped', skip_reason = 'opted_out', claimed_at = null, claimed_by = null, updated_at = now()
      where organization_id = new.organization_id and location_id = new.location_id and sender_phone_number_id = sender_id and recipient_e164 = new.transport_sender_e164 and status in ('scheduled','processing','delivery_pending');
    update public.message_deliveries d set status = 'suppressed', error_code = 'opted_out', updated_at = now()
      from public.lead_followup_jobs j where j.organization_id = d.organization_id and j.location_id = d.location_id and j.delivery_id = d.id
        and j.organization_id = new.organization_id and j.location_id = new.location_id and j.sender_phone_number_id = sender_id and j.recipient_e164 = new.transport_sender_e164 and d.status = 'queued';
  end if;
  return new;
end;
$$;
create trigger messages_sync_sms_followup_consent after insert on public.messages
  for each row execute function public.sync_sms_followup_consent_from_inbound();

create function public.suppress_lead_followups_on_reply()
returns trigger language plpgsql security definer set search_path = '' as $$
declare normalized_body text;
begin
  normalized_body := lower(regexp_replace(btrim(coalesce(new.body, '')), '\s+', ' ', 'g'));
  if new.author_type = 'human'
    or (new.direction = 'inbound' and new.author_type = 'customer' and new.source_channel = 'sms'
      and normalized_body not in ('start', 'unstop')) then
    update public.lead_followup_jobs job
      set status = 'skipped', skip_reason = case when new.author_type = 'human' then 'human_reply' else 'customer_replied' end,
        claimed_at = null, claimed_by = null, updated_at = now()
      where job.organization_id = new.organization_id and job.location_id = new.location_id and job.conversation_id = new.conversation_id
        and job.status in ('scheduled','processing','delivery_pending')
        and exists (select 1 from public.messages trigger_message where trigger_message.organization_id = job.organization_id
          and trigger_message.location_id = job.location_id and trigger_message.id = job.trigger_message_id
          and new.created_at > trigger_message.created_at);
    update public.message_deliveries delivery
      set status = 'suppressed', error_code = case when new.author_type = 'human' then 'human_reply' else 'customer_replied' end, updated_at = now()
      from public.lead_followup_jobs job
      where job.organization_id = delivery.organization_id and job.location_id = delivery.location_id and job.delivery_id = delivery.id
        and job.organization_id = new.organization_id and job.location_id = new.location_id and job.conversation_id = new.conversation_id
        and delivery.status = 'queued';
  end if;
  return new;
end;
$$;
create trigger messages_suppress_stale_followup after insert on public.messages
  for each row execute function public.suppress_lead_followups_on_reply();

create function public.prepare_voice_sms_followup_consent(target_call_id text, target_prepared_message_id uuid)
returns table (consent_intent_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare call_row public.calls%rowtype; sender public.phone_numbers%rowtype; message_row public.messages%rowtype; intent public.voice_sms_followup_consent_intents%rowtype;
begin
  perform public.require_voice_service_role();
  select * into call_row from public.calls where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  if call_row.id is null or call_row.status <> 'in_progress' or call_row.transport_caller_e164 is null or call_row.location_id is null then raise exception using errcode = '42501', message = 'Voice follow-up consent is unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('voice-followup-consent:' || call_row.id::text || ':lead_followup', 0));
  select * into sender from public.phone_numbers where organization_id = call_row.organization_id and location_id = call_row.location_id and id = call_row.phone_number_id and status = 'active' and sms_enabled;
  select * into message_row from public.messages where organization_id = call_row.organization_id and location_id = call_row.location_id and id = target_prepared_message_id and conversation_id = call_row.conversation_id and direction = 'inbound' and source_channel = 'voice' and author_type = 'customer';
  if sender.id is null or message_row.id is null then raise exception using errcode = '42501', message = 'Voice follow-up consent is unavailable'; end if;
  update public.voice_sms_followup_consent_intents set status = 'expired', updated_at = now() where organization_id = call_row.organization_id and call_id = call_row.id and purpose = 'lead_followup' and status = 'awaiting_confirmation' and expires_at <= now();
  select * into intent from public.voice_sms_followup_consent_intents where organization_id = call_row.organization_id and call_id = call_row.id and purpose = 'lead_followup' and status = 'awaiting_confirmation' and expires_at > now();
  if intent.id is null then
    insert into public.voice_sms_followup_consent_intents (organization_id, location_id, conversation_id, call_id, sender_phone_number_id, recipient_e164, purpose, prepared_message_id, expires_at)
    values (call_row.organization_id, call_row.location_id, call_row.conversation_id, call_row.id, sender.id, call_row.transport_caller_e164, 'lead_followup', message_row.id, now() + interval '10 minutes') returning * into intent;
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (intent.organization_id, intent.location_id, 'sms.consent.prepared', 'sms_consent_intent', intent.id, jsonb_build_object('channel','voice','purpose','lead_followup'));
  end if;
  return query select intent.id, intent.expires_at;
end;
$$;

create function public.confirm_voice_sms_followup_consent(target_call_id text, target_consent_intent_id uuid, target_confirmed_message_id uuid)
returns table (granted boolean, consent_id uuid)
language plpgsql security definer set search_path = '' as $$
declare call_row public.calls%rowtype; intent public.voice_sms_followup_consent_intents%rowtype; confirmation public.messages%rowtype; consent public.sms_consents%rowtype;
begin
  perform public.require_voice_service_role();
  select * into call_row from public.calls where provider = 'openai-realtime-sip' and external_call_id = target_call_id;
  select * into intent from public.voice_sms_followup_consent_intents where id = target_consent_intent_id for update;
  if call_row.id is null or call_row.status <> 'in_progress' or intent.id is null or intent.organization_id <> call_row.organization_id or intent.location_id <> call_row.location_id or intent.call_id <> call_row.id or intent.conversation_id <> call_row.conversation_id then raise exception using errcode = '42501', message = 'Voice consent intent is unavailable'; end if;
  if intent.status = 'completed' then select * into consent from public.sms_consents where organization_id = intent.organization_id and location_id = intent.location_id and source_call_id = intent.call_id and source_message_id = intent.confirmed_message_id and purpose = 'lead_followup'; return query select true, consent.id; return; end if;
  if intent.status <> 'awaiting_confirmation' or intent.expires_at <= now() then update public.voice_sms_followup_consent_intents set status = 'expired', updated_at = now() where id = intent.id and status = 'awaiting_confirmation'; return query select false, null::uuid; return; end if;
  select * into confirmation from public.messages where organization_id = intent.organization_id and location_id = intent.location_id and id = target_confirmed_message_id and conversation_id = intent.conversation_id and direction = 'inbound' and source_channel = 'voice' and author_type = 'customer';
  if confirmation.id is null or confirmation.created_at <= intent.created_at then raise exception using errcode = '42501', message = 'Voice consent confirmation is unavailable'; end if;
  if not public.is_explicit_sms_followup_confirmation(confirmation.body) then update public.voice_sms_followup_consent_intents set status = 'declined', confirmed_message_id = confirmation.id, updated_at = now() where id = intent.id; return query select false, null::uuid; return; end if;
  insert into public.sms_consents as current_consent (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose, status, source_type, source_message_id, source_call_id, granted_at)
  values (intent.organization_id, intent.location_id, intent.sender_phone_number_id, intent.recipient_e164, 'lead_followup', 'active', 'voice_explicit', confirmation.id, intent.call_id, now())
  on conflict (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose) do update set status = 'active', source_type = 'voice_explicit', source_message_id = excluded.source_message_id, source_call_id = excluded.source_call_id, granted_at = now(), revoked_at = null, updated_at = now()
  returning * into consent;
  update public.voice_sms_followup_consent_intents set status = 'completed', confirmed_message_id = confirmation.id, updated_at = now() where id = intent.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (consent.organization_id, consent.location_id, 'sms.consent.granted', 'sms_consent', consent.id, jsonb_build_object('channel','voice','purpose','lead_followup'));
  return query select true, consent.id;
end;
$$;

create function public.claim_lead_followup_jobs(target_worker_id text, target_limit integer default 10)
returns table (job_id uuid, message_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id,''))) not between 1 and 160 or target_limit not between 1 and 50 then raise exception using errcode = '22023', message = 'Follow-up claim is invalid'; end if;
  return query with claimed as (
    select j.id from public.lead_followup_jobs j where (j.status = 'scheduled' and j.scheduled_for <= now())
      or j.status = 'delivery_pending'
      or (j.status = 'processing' and j.claimed_at <= now() - interval '5 minutes')
    order by coalesce(j.scheduled_for, j.created_at), j.created_at for update skip locked limit target_limit
  ), updated as (
    update public.lead_followup_jobs j set status = 'processing', claimed_at = now(), claimed_by = btrim(target_worker_id), updated_at = now()
    from claimed where j.id = claimed.id returning j.id, j.message_id
  ) select updated.id, updated.message_id from updated;
end;
$$;

create function public.create_lead_followup_message(target_job_id uuid)
returns table (message_id uuid) language plpgsql security definer set search_path = '' as $$
declare job public.lead_followup_jobs%rowtype; lead_row public.leads%rowtype; conversation_row public.conversations%rowtype; consent public.sms_consents%rowtype; sender public.phone_numbers%rowtype; location public.locations%rowtype; body_text text; saved_message_id uuid; saved_delivery_id uuid;
begin
  perform public.require_messaging_service_role();
  select * into job from public.lead_followup_jobs where id = target_job_id for update;
  if job.id is null or job.status <> 'processing' or job.message_id is not null then return; end if;
  select * into lead_row from public.leads where organization_id = job.organization_id and location_id = job.location_id and id = job.lead_id;
  select * into conversation_row from public.conversations where organization_id = job.organization_id and location_id = job.location_id and id = job.conversation_id;
  select * into consent from public.sms_consents where organization_id = job.organization_id and location_id = job.location_id and id = job.consent_id and status = 'active' and sender_phone_number_id = job.sender_phone_number_id and recipient_e164 = job.recipient_e164 and purpose = 'lead_followup';
  select * into sender from public.phone_numbers where organization_id = job.organization_id and location_id = job.location_id and id = job.sender_phone_number_id and status = 'active' and sms_enabled;
  if lead_row.id is null or lead_row.status not in ('new','qualified') or lead_row.urgency = 'urgent' or lead_row.qualification_reason = 'needs_human' or conversation_row.id is null or conversation_row.status <> 'open' or conversation_row.ai_mode <> 'ai' or consent.id is null or sender.id is null or sender.phone_number <> job.sender_e164
    or exists(select 1 from public.handoffs h where h.organization_id = job.organization_id and h.conversation_id = job.conversation_id and h.status in ('open','acknowledged'))
    or exists(select 1 from public.appointments a where a.organization_id = job.organization_id and a.location_id = job.location_id and a.conversation_id = job.conversation_id and a.status = 'confirmed')
    or exists(select 1 from public.booking_intents b where b.organization_id = job.organization_id and b.location_id = job.location_id and b.conversation_id = job.conversation_id and b.status in ('awaiting_confirmation','booking','provider_success_pending_persistence','provider_state_unknown'))
    or exists(select 1 from public.appointment_change_intents ci where ci.organization_id = job.organization_id and ci.location_id = job.location_id and ci.conversation_id = job.conversation_id and ci.status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown','handoff_required'))
    or exists(select 1 from public.messaging_contact_preferences p join public.messages route_message on route_message.organization_id = p.organization_id and route_message.location_id = p.location_id and route_message.contact_id = p.contact_id and route_message.transport_sender_e164 = job.recipient_e164 where p.organization_id = job.organization_id and p.location_id = job.location_id and p.sender_phone_number_id = job.sender_phone_number_id and p.channel_type = 'sms' and p.status = 'opted_out')
    or exists(select 1 from public.messages m where m.organization_id = job.organization_id and m.location_id = job.location_id and m.conversation_id = job.conversation_id and m.created_at > (select created_at from public.messages where organization_id = job.organization_id and location_id = job.location_id and id = job.trigger_message_id) and (m.author_type in ('customer','human') or (m.source_channel = 'sms' and m.author_type in ('ai','system'))))
  then update public.lead_followup_jobs set status = 'skipped', skip_reason = 'stale_or_ineligible', claimed_at = null, claimed_by = null, updated_at = now() where id = job.id; return; end if;
  select * into location from public.locations where organization_id = job.organization_id and id = job.location_id;
  body_text := left('Hi, this is ' || location.name || '. Just checking if you would still like help with ' || coalesce(nullif(lead_row.service_category,''), 'your request') || '. Reply here and we can help. Reply STOP to opt out.', 480);
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_at)
  values (job.organization_id, job.location_id, job.conversation_id, conversation_row.contact_id, 'outbound', 'text', body_text, jsonb_build_object('transport','sms','kind','lead_followup'), 'sms', 'system', now()) returning id into saved_message_id;
  insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (job.organization_id, job.location_id, saved_message_id, 'twilio') returning id into saved_delivery_id;
  update public.lead_followup_jobs set message_id = saved_message_id, delivery_id = saved_delivery_id, status = 'delivery_pending', claimed_at = null, claimed_by = null, updated_at = now() where id = job.id;
  return query select saved_message_id;
end;
$$;

create function public.claim_lead_followup_delivery(target_job_id uuid)
returns table (message_id uuid, to_e164 text, from_e164 text, body text) language plpgsql security definer set search_path = '' as $$
declare job public.lead_followup_jobs%rowtype; delivery public.message_deliveries%rowtype; lead_row public.leads%rowtype; conversation_row public.conversations%rowtype; consent public.sms_consents%rowtype; sender public.phone_numbers%rowtype; message_row public.messages%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into job from public.lead_followup_jobs where id = target_job_id for update;
  if job.id is null or job.status not in ('processing','delivery_pending') or job.message_id is null or job.delivery_id is null then return; end if;
  select * into delivery from public.message_deliveries where id = job.delivery_id for update;
  select * into lead_row from public.leads where id = job.lead_id; select * into conversation_row from public.conversations where id = job.conversation_id;
  select * into consent from public.sms_consents where id = job.consent_id and status = 'active' and recipient_e164 = job.recipient_e164 and sender_phone_number_id = job.sender_phone_number_id;
  select * into sender from public.phone_numbers where id = job.sender_phone_number_id and status = 'active' and sms_enabled;
  select * into message_row from public.messages where id = job.message_id;
  if delivery.id is null or delivery.status <> 'queued' or lead_row.id is null or lead_row.status not in ('new','qualified') or lead_row.urgency = 'urgent' or lead_row.qualification_reason = 'needs_human' or conversation_row.id is null or conversation_row.status <> 'open' or conversation_row.ai_mode <> 'ai' or consent.id is null or sender.id is null or sender.phone_number <> job.sender_e164
    or exists(select 1 from public.handoffs h where h.organization_id = job.organization_id and h.conversation_id = job.conversation_id and h.status in ('open','acknowledged'))
    or exists(select 1 from public.appointments a where a.organization_id = job.organization_id and a.location_id = job.location_id and a.conversation_id = job.conversation_id and a.status = 'confirmed')
    or exists(select 1 from public.booking_intents b where b.organization_id = job.organization_id and b.location_id = job.location_id and b.conversation_id = job.conversation_id and b.status in ('awaiting_confirmation','booking','provider_success_pending_persistence','provider_state_unknown'))
    or exists(select 1 from public.appointment_change_intents ci where ci.organization_id = job.organization_id and ci.location_id = job.location_id and ci.conversation_id = job.conversation_id and ci.status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown','handoff_required'))
    or exists(select 1 from public.messaging_contact_preferences p join public.messages route_message on route_message.organization_id = p.organization_id and route_message.location_id = p.location_id and route_message.contact_id = p.contact_id and route_message.transport_sender_e164 = job.recipient_e164 where p.organization_id = job.organization_id and p.location_id = job.location_id and p.sender_phone_number_id = job.sender_phone_number_id and p.channel_type = 'sms' and p.status = 'opted_out')
    or exists(select 1 from public.messages m where m.organization_id = job.organization_id and m.location_id = job.location_id and m.conversation_id = job.conversation_id and m.created_at > message_row.created_at and m.author_type in ('customer','human'))
  then update public.message_deliveries set status = 'suppressed', error_code = 'lead_followup_ineligible', updated_at = now() where id = delivery.id; return; end if;
  update public.message_deliveries set status = 'submitting', attempted_at = now(), updated_at = now() where id = delivery.id;
  return query select message_row.id, job.recipient_e164, job.sender_e164, message_row.body;
end;
$$;

create function public.sync_lead_followup_delivery_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare action_name text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  update public.lead_followup_jobs set
    status = case when new.status in ('sent','delivered') then 'sent' when new.status = 'suppressed' then 'skipped' when new.status in ('failed','undelivered','unknown') then 'failed' else status end,
    skip_reason = case when new.status = 'suppressed' then coalesce(new.error_code,'delivery_suppressed') else skip_reason end,
    failure_reason = case when new.status in ('failed','undelivered','unknown') then coalesce(new.error_code,'delivery_failed') else failure_reason end,
    claimed_at = null, claimed_by = null, updated_at = now()
  where organization_id = new.organization_id and delivery_id = new.id and status in ('processing','delivery_pending','sent');
  return new;
end;
$$;
create trigger message_deliveries_sync_lead_followup after insert or update of status on public.message_deliveries
  for each row execute function public.sync_lead_followup_delivery_status();

create function public.lead_followup_audit_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare event_action text;
begin
  event_action := case when tg_op = 'INSERT' and new.status = 'scheduled' then 'lead.followup.scheduled'
    when tg_op = 'UPDATE' and new.status = 'sent' and old.status is distinct from new.status then 'lead.followup.sent'
    when tg_op = 'UPDATE' and new.status = 'skipped' and old.status is distinct from new.status then 'lead.followup.skipped'
    when tg_op = 'UPDATE' and new.status = 'failed' and old.status is distinct from new.status then 'lead.followup.failed' else null end;
  if event_action is not null then insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (new.organization_id, new.location_id, event_action, 'lead_followup', new.id, jsonb_strip_nulls(jsonb_build_object('followup_type','lead_followup','reason',coalesce(new.skip_reason,new.failure_reason)))); end if;
  return new;
end;
$$;
create trigger lead_followup_jobs_audit after insert or update of status on public.lead_followup_jobs
  for each row execute function public.lead_followup_audit_trigger();

create function public.get_my_lead_followup_settings(target_location_id uuid)
returns table (lead_followup_enabled boolean, delay_minutes integer, quiet_hours_start time, quiet_hours_end time, business_hours_only boolean, sender_available boolean, automation_acknowledged_at timestamptz)
language sql security definer set search_path = '' as $$
  select coalesce(s.lead_followup_enabled,false), coalesce(s.delay_minutes,240), coalesce(s.quiet_hours_start,time '20:00'), coalesce(s.quiet_hours_end,time '08:00'), coalesce(s.business_hours_only,true),
    exists(select 1 from public.phone_numbers p where p.organization_id = l.organization_id and p.location_id = l.id and p.status = 'active' and p.sms_enabled), s.automation_acknowledged_at
  from public.locations l left join public.lead_followup_settings s on s.organization_id = l.organization_id and s.location_id = l.id
  where l.id = target_location_id and public.has_location_access(l.organization_id,l.id);
$$;

create function public.get_my_lead_followup(target_lead_id uuid)
returns table (status text, scheduled_for timestamptz, skip_reason text, failure_reason text)
language sql security definer set search_path = '' as $$
  select coalesce(job.status,
      case when lead.source_channel = 'web' or lead.status not in ('new','qualified') or lead.urgency = 'urgent' or lead.qualification_reason = 'needs_human'
        then 'not_eligible' else 'awaiting_consent' end),
    job.scheduled_for, job.skip_reason, job.failure_reason
  from public.leads lead
  left join public.lead_followup_jobs job on job.organization_id = lead.organization_id and job.lead_id = lead.id
  where lead.id = target_lead_id and public.has_location_access(lead.organization_id, lead.location_id);
$$;

create function public.upsert_my_lead_followup_settings(target_location_id uuid, target_enabled boolean, target_delay_minutes integer, target_quiet_hours_start time, target_quiet_hours_end time, target_business_hours_only boolean, target_acknowledge_sender boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare location_row public.locations%rowtype; sender public.phone_numbers%rowtype; settings_id uuid;
begin
  if not public.is_organization_admin((select organization_id from public.locations where id = target_location_id)) then raise exception using errcode = '42501', message = 'Follow-up settings are unavailable'; end if;
  if target_delay_minutes not between 15 and 10080 or target_quiet_hours_start = target_quiet_hours_end then raise exception using errcode = '22023', message = 'Follow-up settings are invalid'; end if;
  select * into location_row from public.locations where id = target_location_id;
  select * into sender from public.phone_numbers where organization_id = location_row.organization_id and location_id = location_row.id and status = 'active' and sms_enabled order by created_at limit 1;
  if target_enabled and (sender.id is null or not target_acknowledge_sender) then raise exception using errcode = '42501', message = 'Sender acknowledgement is required'; end if;
  insert into public.lead_followup_settings as s (organization_id,location_id,lead_followup_enabled,delay_minutes,quiet_hours_start,quiet_hours_end,business_hours_only,sender_phone_number_id,automation_acknowledged_at,automation_acknowledged_by)
  values (location_row.organization_id,location_row.id,target_enabled,target_delay_minutes,target_quiet_hours_start,target_quiet_hours_end,target_business_hours_only,sender.id,case when target_enabled then now() else null end,case when target_enabled then auth.uid() else null end)
  on conflict (organization_id,location_id) do update set lead_followup_enabled=excluded.lead_followup_enabled,delay_minutes=excluded.delay_minutes,quiet_hours_start=excluded.quiet_hours_start,quiet_hours_end=excluded.quiet_hours_end,business_hours_only=excluded.business_hours_only,sender_phone_number_id=excluded.sender_phone_number_id,automation_acknowledged_at=case when excluded.lead_followup_enabled then coalesce(public.lead_followup_settings.automation_acknowledged_at,excluded.automation_acknowledged_at) else null end,automation_acknowledged_by=case when excluded.lead_followup_enabled then coalesce(public.lead_followup_settings.automation_acknowledged_by,excluded.automation_acknowledged_by) else null end,updated_at=now() returning id into settings_id;
  insert into public.action_logs (organization_id,location_id,action,entity_type,entity_id,details) values (location_row.organization_id,location_row.id,'followup.settings.updated','lead_followup_settings',settings_id,jsonb_build_object('followup_type','lead_followup'));
end;
$$;

alter table public.sms_consents enable row level security;
alter table public.voice_sms_followup_consent_intents enable row level security;
alter table public.lead_followup_settings enable row level security;
alter table public.lead_followup_jobs enable row level security;
create policy sms_consents_select_member on public.sms_consents for select to authenticated using (public.has_location_access(organization_id,location_id));
create policy lead_followup_settings_select_member on public.lead_followup_settings for select to authenticated using (public.has_location_access(organization_id,location_id));
create policy lead_followup_jobs_select_member on public.lead_followup_jobs for select to authenticated using (public.has_location_access(organization_id,location_id));

revoke all on table public.sms_consents, public.voice_sms_followup_consent_intents, public.lead_followup_settings, public.lead_followup_jobs from public, anon, authenticated, service_role;
revoke all on function public.is_explicit_sms_followup_confirmation(text), public.lead_followup_next_allowed_time(timestamptz,text,time,time,jsonb,boolean), public.lead_followup_eligible(uuid), public.try_materialize_lead_followup(uuid), public.prepare_voice_sms_followup_consent(text,uuid), public.confirm_voice_sms_followup_consent(text,uuid,uuid), public.claim_lead_followup_jobs(text,integer), public.create_lead_followup_message(uuid), public.claim_lead_followup_delivery(uuid), public.get_my_lead_followup_settings(uuid), public.get_my_lead_followup(uuid), public.upsert_my_lead_followup_settings(uuid,boolean,integer,time,time,boolean,boolean) from public, anon, authenticated, service_role;
grant select on public.sms_consents, public.lead_followup_settings, public.lead_followup_jobs to authenticated;
grant execute on function public.get_my_lead_followup_settings(uuid), public.get_my_lead_followup(uuid), public.upsert_my_lead_followup_settings(uuid,boolean,integer,time,time,boolean,boolean) to authenticated;
grant execute on function public.prepare_voice_sms_followup_consent(text,uuid), public.confirm_voice_sms_followup_consent(text,uuid,uuid), public.claim_lead_followup_jobs(text,integer), public.create_lead_followup_message(uuid), public.claim_lead_followup_delivery(uuid) to service_role;

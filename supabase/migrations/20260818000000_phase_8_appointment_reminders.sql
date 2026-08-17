-- Phase 8: deterministic, transactional appointment SMS reminders. No AI or provider mutations.

alter table public.appointments
  add column trusted_sms_recipient_e164 text,
  add constraint appointments_trusted_sms_recipient_e164_check
    check (trusted_sms_recipient_e164 is null or trusted_sms_recipient_e164 ~ E'^\\+[1-9][0-9]{7,14}$');

alter table public.appointments
  add constraint appointments_organization_location_id_key unique (organization_id, location_id, id);

create table public.appointment_reminder_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  sms_enabled boolean not null default false,
  reminder_24h_enabled boolean not null default true,
  reminder_2h_enabled boolean not null default true,
  quiet_hours_start time not null default time '20:00',
  quiet_hours_end time not null default time '08:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_reminder_settings_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint appointment_reminder_settings_location_key unique (organization_id, location_id),
  constraint appointment_reminder_settings_quiet_hours_check check (quiet_hours_start <> quiet_hours_end)
);

create table public.appointment_reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  appointment_id uuid not null,
  reminder_type text not null check (reminder_type in ('appointment_24h', 'appointment_2h')),
  scheduled_for timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'processing', 'sent', 'skipped', 'failed')),
  message_id uuid,
  attempt_count integer not null default 0 check (attempt_count >= 0 and attempt_count <= 10),
  claimed_at timestamptz,
  claimed_by text,
  last_error_code text,
  trusted_sms_recipient_e164 text,
  revalidation_status text not null default 'pending' check (revalidation_status in ('pending', 'confirmed', 'provider_not_confirmed', 'provider_unavailable', 'not_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_reminders_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint appointment_reminders_appointment_fk foreign key (organization_id, location_id, appointment_id)
    references public.appointments (organization_id, location_id, id) on delete cascade,
  constraint appointment_reminders_organization_id_id_key unique (organization_id, id),
  constraint appointment_reminders_organization_location_id_key unique (organization_id, location_id, id),
  constraint appointment_reminders_appointment_type_key unique (appointment_id, reminder_type),
  constraint appointment_reminders_trusted_sms_recipient_e164_check check
    (trusted_sms_recipient_e164 is null or trusted_sms_recipient_e164 ~ E'^\\+[1-9][0-9]{7,14}$')
);

alter table public.messages add column appointment_reminder_id uuid;
alter table public.messages add constraint messages_organization_location_id_id_key unique (organization_id, location_id, id);
alter table public.messages add constraint messages_appointment_reminder_fk foreign key (organization_id, location_id, appointment_reminder_id)
  references public.appointment_reminders (organization_id, location_id, id) on delete set null;
alter table public.appointment_reminders add constraint appointment_reminders_message_fk foreign key (organization_id, location_id, message_id)
  references public.messages (organization_id, location_id, id) on delete set null;
create unique index appointment_reminders_message_key on public.appointment_reminders (message_id) where message_id is not null;
create unique index messages_appointment_reminder_key on public.messages (appointment_reminder_id) where appointment_reminder_id is not null;
create index appointment_reminders_due_idx on public.appointment_reminders (scheduled_for) where status = 'scheduled';

alter table public.appointment_reminder_settings enable row level security;
alter table public.appointment_reminders enable row level security;
create policy appointment_reminder_settings_select_admin on public.appointment_reminder_settings for select to authenticated
  using (public.is_organization_admin(organization_id));
create policy appointment_reminders_select_location_member on public.appointment_reminders for select to authenticated
  using (public.has_location_access(organization_id, location_id));
revoke all on table public.appointment_reminder_settings, public.appointment_reminders from anon, authenticated, service_role;
grant select on public.appointment_reminder_settings, public.appointment_reminders to authenticated;

create function public.reminder_local_time(target_time timestamptz, target_timezone text, quiet_start time, quiet_end time)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare local_time timestamp; allowed_local timestamp;
begin
  local_time := target_time at time zone target_timezone;
  if (quiet_start < quiet_end and local_time::time >= quiet_start and local_time::time < quiet_end)
    or (quiet_start > quiet_end and (local_time::time >= quiet_start or local_time::time < quiet_end)) then
    if quiet_start < quiet_end then
      allowed_local := local_time::date + quiet_end;
    elsif local_time::time >= quiet_start then
      allowed_local := (local_time::date + 1) + quiet_end;
    else
      allowed_local := local_time::date + quiet_end;
    end if;
    return allowed_local at time zone target_timezone;
  end if;
  return target_time;
end;
$$;

create function public.refresh_appointment_reminders_internal(target_appointment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; settings_row public.appointment_reminder_settings%rowtype; location_row public.locations%rowtype;
  reminder_time timestamptz;
begin
  select * into appointment_row from public.appointments where id = target_appointment_id for update;
  if appointment_row.id is null then return; end if;
  select * into settings_row from public.appointment_reminder_settings where organization_id = appointment_row.organization_id and location_id = appointment_row.location_id;
  if appointment_row.status <> 'confirmed' or appointment_row.starts_at <= now() then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_not_active', updated_at = now()
      where appointment_id = appointment_row.id and status in ('scheduled', 'processing');
    return;
  end if;
  if settings_row.id is null or not settings_row.sms_enabled or appointment_row.starts_at > now() + interval '30 days' then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'sms_disabled', claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = appointment_row.id and status in ('scheduled', 'processing');
    return;
  end if;
  select * into location_row from public.locations where organization_id = appointment_row.organization_id and id = appointment_row.location_id;
  if settings_row.reminder_24h_enabled then
    reminder_time := public.reminder_local_time(appointment_row.starts_at - interval '24 hours', location_row.timezone, settings_row.quiet_hours_start, settings_row.quiet_hours_end);
    if reminder_time < appointment_row.starts_at then
      insert into public.appointment_reminders (organization_id, location_id, appointment_id, reminder_type, scheduled_for, trusted_sms_recipient_e164)
      values (appointment_row.organization_id, appointment_row.location_id, appointment_row.id, 'appointment_24h', reminder_time, appointment_row.trusted_sms_recipient_e164)
      on conflict (appointment_id, reminder_type) do update set scheduled_for = excluded.scheduled_for,
        trusted_sms_recipient_e164 = excluded.trusted_sms_recipient_e164,
        status = case when public.appointment_reminders.status = 'scheduled' or (public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code = 'sms_disabled') then 'scheduled' else public.appointment_reminders.status end,
        last_error_code = case when public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code = 'sms_disabled' then null else public.appointment_reminders.last_error_code end,
        updated_at = now();
    end if;
  else
    update public.appointment_reminders set status = 'skipped', last_error_code = 'sms_disabled', updated_at = now()
      where appointment_id = appointment_row.id and reminder_type = 'appointment_24h' and status in ('scheduled', 'processing');
  end if;
  if settings_row.reminder_2h_enabled then
    reminder_time := public.reminder_local_time(appointment_row.starts_at - interval '2 hours', location_row.timezone, settings_row.quiet_hours_start, settings_row.quiet_hours_end);
    if reminder_time < appointment_row.starts_at then
      insert into public.appointment_reminders (organization_id, location_id, appointment_id, reminder_type, scheduled_for, trusted_sms_recipient_e164)
      values (appointment_row.organization_id, appointment_row.location_id, appointment_row.id, 'appointment_2h', reminder_time, appointment_row.trusted_sms_recipient_e164)
      on conflict (appointment_id, reminder_type) do update set scheduled_for = excluded.scheduled_for,
        trusted_sms_recipient_e164 = excluded.trusted_sms_recipient_e164,
        status = case when public.appointment_reminders.status = 'scheduled' or (public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code = 'sms_disabled') then 'scheduled' else public.appointment_reminders.status end,
        last_error_code = case when public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code = 'sms_disabled' then null else public.appointment_reminders.last_error_code end,
        updated_at = now();
    end if;
  else
    update public.appointment_reminders set status = 'skipped', last_error_code = 'sms_disabled', updated_at = now()
      where appointment_id = appointment_row.id and reminder_type = 'appointment_2h' and status in ('scheduled', 'processing');
  end if;
end;
$$;

create function public.appointment_reminders_refresh_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_appointment_reminders_internal(new.id);
  return new;
end;
$$;
create trigger appointments_refresh_reminders after insert or update of status, starts_at, trusted_sms_recipient_e164 on public.appointments
for each row execute function public.appointment_reminders_refresh_trigger();

create function public.refresh_appointment_reminders(target_appointment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  perform public.refresh_appointment_reminders_internal(target_appointment_id);
end;
$$;

create function public.get_my_appointment_reminder_settings(target_location_id uuid)
returns table (sms_enabled boolean, reminder_24h_enabled boolean, reminder_2h_enabled boolean, quiet_hours_start time, quiet_hours_end time, sms_sender_available boolean, timezone text)
language sql stable security definer set search_path = '' as $$
  select coalesce(settings.sms_enabled, false), coalesce(settings.reminder_24h_enabled, true), coalesce(settings.reminder_2h_enabled, true),
    coalesce(settings.quiet_hours_start, time '20:00'), coalesce(settings.quiet_hours_end, time '08:00'),
    exists(select 1 from public.phone_numbers phone where phone.organization_id = location.organization_id and phone.location_id = location.id and phone.status = 'active' and phone.sms_enabled), location.timezone
  from public.locations location left join public.appointment_reminder_settings settings on settings.organization_id = location.organization_id and settings.location_id = location.id
  where location.id = target_location_id and public.is_organization_admin(location.organization_id);
$$;

create function public.get_my_appointment_reminders(target_location_id uuid)
returns table (appointment_id uuid, reminder_type text, scheduled_for timestamptz, status text, last_error_code text, message_id uuid)
language sql stable security definer set search_path = '' as $$
  select reminder.appointment_id, reminder.reminder_type, reminder.scheduled_for, reminder.status,
    reminder.last_error_code, reminder.message_id
  from public.appointment_reminders reminder
  where reminder.location_id = target_location_id
    and public.has_location_access(reminder.organization_id, reminder.location_id)
  order by reminder.scheduled_for asc, reminder.reminder_type asc;
$$;

create function public.upsert_my_appointment_reminder_settings(target_location_id uuid, target_sms_enabled boolean, target_24h_enabled boolean, target_2h_enabled boolean, target_quiet_hours_start time default time '20:00', target_quiet_hours_end time default time '08:00')
returns void language plpgsql security definer set search_path = '' as $$
declare location_row public.locations%rowtype; appointment_row record;
begin
  select * into location_row from public.locations where id = target_location_id;
  if location_row.id is null or not public.is_organization_admin(location_row.organization_id) or target_quiet_hours_start = target_quiet_hours_end then
    raise exception using errcode = '42501', message = 'Reminder settings are unavailable';
  end if;
  insert into public.appointment_reminder_settings (organization_id, location_id, sms_enabled, reminder_24h_enabled, reminder_2h_enabled, quiet_hours_start, quiet_hours_end)
  values (location_row.organization_id, location_row.id, target_sms_enabled, target_24h_enabled, target_2h_enabled, target_quiet_hours_start, target_quiet_hours_end)
  on conflict (organization_id, location_id) do update set sms_enabled = excluded.sms_enabled, reminder_24h_enabled = excluded.reminder_24h_enabled,
    reminder_2h_enabled = excluded.reminder_2h_enabled, quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end, updated_at = now();
  for appointment_row in select id from public.appointments where organization_id = location_row.organization_id and location_id = location_row.id and starts_at between now() and now() + interval '30 days' loop
    perform public.refresh_appointment_reminders_internal(appointment_row.id);
  end loop;
end;
$$;

create function public.claim_due_appointment_reminders(target_worker_id text, target_limit integer default 4)
returns table (reminder_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 20 then raise exception using errcode = '22023', message = 'Reminder claim is invalid'; end if;
  update public.appointment_reminders set status = case when message_id is not null then 'sent' when attempt_count >= 10 then 'failed' else 'scheduled' end, claimed_at = null, claimed_by = null,
    last_error_code = case when message_id is not null then last_error_code when attempt_count >= 10 then 'max_attempts_exhausted' else 'stale_claim_recovered' end, updated_at = now()
    where status = 'processing' and claimed_at < now() - interval '5 minutes';
  update public.appointment_reminders set status = 'failed', last_error_code = 'max_attempts_exhausted', updated_at = now()
    where status = 'scheduled' and attempt_count >= 10;
  return query with due as (
    select reminder.id from public.appointment_reminders reminder where reminder.status = 'scheduled' and reminder.attempt_count < 10 and reminder.scheduled_for <= now()
      order by reminder.scheduled_for asc for update skip locked limit target_limit
  ), claimed as (
    update public.appointment_reminders reminder set status = 'processing', attempt_count = reminder.attempt_count + 1, claimed_at = now(), claimed_by = btrim(target_worker_id), updated_at = now()
      from due where reminder.id = due.id returning reminder.id
  ) select claimed.id from claimed;
end;
$$;

create function public.get_appointment_reminder_execution_context(target_reminder_id uuid)
returns table (reminder_id uuid, appointment_id uuid, organization_id uuid, location_id uuid, provider text, integration_id uuid, integration_status text, external_appointment_id text, booking_intent_id uuid, starts_at timestamptz, ends_at timestamptz, timezone text, provider_resource_key text, appointment_type_key text, external_contact_uid text, external_subject_uid text, trusted_sms_recipient_e164 text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  return query
    select reminder.id, appointment.id, appointment.organization_id, appointment.location_id, appointment.provider, appointment.integration_id,
      integration.status, appointment.external_appointment_id, appointment.booking_intent_id, appointment.starts_at, appointment.ends_at, location.timezone,
      resource.external_uid, appointment_type.external_uid, appointment.external_contact_uid, appointment.external_subject_uid, reminder.trusted_sms_recipient_e164
    from public.appointment_reminders reminder join public.appointments appointment on appointment.organization_id = reminder.organization_id and appointment.location_id = reminder.location_id and appointment.id = reminder.appointment_id
    join public.locations location on location.organization_id = appointment.organization_id and location.id = appointment.location_id
    left join public.integrations integration on integration.organization_id = appointment.organization_id and integration.location_id = appointment.location_id and integration.id = appointment.integration_id
    left join public.booking_candidates candidate on candidate.organization_id = appointment.organization_id and candidate.id = (select intent.candidate_id from public.booking_intents intent where intent.organization_id = appointment.organization_id and intent.id = appointment.booking_intent_id)
    left join public.scheduling_resources resource on resource.organization_id = appointment.organization_id and resource.id = candidate.resource_id
    left join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = appointment.organization_id and appointment_type.id = candidate.appointment_type_id
    where reminder.id = target_reminder_id and reminder.status = 'processing';
end;
$$;

create function public.record_appointment_reminder_revalidation(target_reminder_id uuid, target_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if target_outcome in ('confirmed', 'not_required') then update public.appointment_reminders set revalidation_status = target_outcome, updated_at = now() where id = target_reminder_id and status = 'processing';
  elsif target_outcome in ('provider_not_confirmed', 'provider_unavailable') then update public.appointment_reminders set status = 'skipped', revalidation_status = target_outcome, last_error_code = target_outcome, claimed_at = null, claimed_by = null, updated_at = now() where id = target_reminder_id and status = 'processing';
  else raise exception using errcode = '22023', message = 'Reminder revalidation outcome is invalid'; end if;
end;
$$;

create function public.create_appointment_reminder_message(target_reminder_id uuid)
returns table (message_id uuid) language plpgsql security definer set search_path = '' as $$
declare reminder public.appointment_reminders%rowtype; appointment public.appointments%rowtype; settings public.appointment_reminder_settings%rowtype;
  location public.locations%rowtype; phone public.phone_numbers%rowtype; channel public.channels%rowtype; contact public.contacts%rowtype; conversation public.conversations%rowtype; saved_message_id uuid;
  lower_window timestamptz; upper_window timestamptz;
begin
  perform public.require_messaging_service_role();
  select * into reminder from public.appointment_reminders where id = target_reminder_id for update;
  if reminder.id is null or reminder.status <> 'processing' then return; end if;
  if reminder.message_id is not null then return query select reminder.message_id; return; end if;
  select * into appointment from public.appointments where organization_id = reminder.organization_id and location_id = reminder.location_id and id = reminder.appointment_id;
  select * into settings from public.appointment_reminder_settings where organization_id = reminder.organization_id and location_id = reminder.location_id;
  if appointment.id is null or appointment.status <> 'confirmed' or appointment.starts_at <= now() then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_not_active', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return;
  end if;
  if settings.id is null or not settings.sms_enabled then update public.appointment_reminders set status = 'skipped', last_error_code = 'sms_disabled', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  if reminder.reminder_type = 'appointment_24h' then lower_window := appointment.starts_at - interval '26 hours'; upper_window := appointment.starts_at - interval '18 hours'; else lower_window := appointment.starts_at - interval '150 minutes'; upper_window := appointment.starts_at - interval '75 minutes'; end if;
  if now() < lower_window then update public.appointment_reminders set status = 'scheduled', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  if now() > upper_window then update public.appointment_reminders set status = 'skipped', last_error_code = 'outside_send_window', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  if reminder.trusted_sms_recipient_e164 is null then update public.appointment_reminders set status = 'skipped', last_error_code = 'no_trusted_recipient', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  select * into location from public.locations where organization_id = reminder.organization_id and id = reminder.location_id;
  select * into phone from public.phone_numbers where organization_id = reminder.organization_id and location_id = reminder.location_id and status = 'active' and sms_enabled order by created_at asc limit 1;
  if phone.id is null then update public.appointment_reminders set status = 'skipped', last_error_code = 'no_sms_sender', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  select * into contact from public.contacts where organization_id = reminder.organization_id and location_id = reminder.location_id and phone = reminder.trusted_sms_recipient_e164 limit 1;
  if contact.id is null then insert into public.contacts (organization_id, location_id, phone, metadata) values (reminder.organization_id, reminder.location_id, reminder.trusted_sms_recipient_e164, jsonb_build_object('source', 'appointment_reminder')) returning * into contact; end if;
  if exists(select 1 from public.messaging_contact_preferences pref where pref.organization_id = reminder.organization_id and pref.location_id = reminder.location_id and pref.contact_id = contact.id and pref.channel_type = 'sms' and pref.sender_phone_number_id = phone.id and pref.status = 'opted_out') then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'opted_out', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return;
  end if;
  select * into channel from public.channels where organization_id = reminder.organization_id and location_id = reminder.location_id and channel_type = 'sms' and status = 'active' limit 1;
  if channel.id is null then insert into public.channels (organization_id, location_id, channel_type, display_name, status, configuration) values (reminder.organization_id, reminder.location_id, 'sms', 'SMS', 'active', jsonb_build_object('phone_number_id', phone.id)) returning * into channel; end if;
  select c.* into conversation from public.conversations c join public.messages inbound on inbound.organization_id = c.organization_id and inbound.conversation_id = c.id
    where c.organization_id = reminder.organization_id and c.location_id = reminder.location_id and c.transport_phone_number_id = phone.id and c.status = 'open'
      and inbound.direction = 'inbound' and inbound.source_channel = 'sms' and inbound.author_type = 'customer' and inbound.transport_sender_e164 = reminder.trusted_sms_recipient_e164
    order by c.updated_at desc limit 1;
  if conversation.id is null then insert into public.conversations (organization_id, location_id, contact_id, channel_id, transport_phone_number_id, mode, status, metadata) values (reminder.organization_id, reminder.location_id, contact.id, channel.id, phone.id, 'customer', 'open', jsonb_build_object('transport', 'sms', 'source', 'appointment_reminder')) returning * into conversation; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, appointment_reminder_id, sent_at)
  values (reminder.organization_id, reminder.location_id, conversation.id, contact.id, 'outbound', 'text',
    'Reminder from ' || location.name || ': you have an appointment ' || to_char(appointment.starts_at at time zone location.timezone, 'FMDay, FMMonth FMDD at FMHH12:MI AM') || '. Reply here if you need help.',
    jsonb_build_object('transport', 'sms', 'kind', 'appointment_reminder'), 'sms', 'system', reminder.id, now()) returning id into saved_message_id;
  insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (reminder.organization_id, reminder.location_id, saved_message_id, 'twilio');
  insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (reminder.organization_id, reminder.location_id, conversation.id, saved_message_id, 'outbound_delivery');
  update public.appointment_reminders set status = 'sent', message_id = saved_message_id, claimed_at = null, claimed_by = null, last_error_code = null, updated_at = now() where id = reminder.id;
  return query select saved_message_id;
end;
$$;

-- Appointment reminders are the only SMS system messages that may use their immutable appointment snapshot rather than an inbound reply reference.
create or replace function public.claim_sms_delivery_submission(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql security definer set search_path = '' as $$
declare delivery public.message_deliveries%rowtype; message public.messages%rowtype; conversation public.conversations%rowtype; phone public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into delivery from public.message_deliveries d where d.message_id = target_message_id and d.provider = 'twilio' for update;
  if delivery.id is null or delivery.status <> 'queued' then return; end if;
  select * into message from public.messages where id = delivery.message_id;
  select * into conversation from public.conversations where organization_id = message.organization_id and id = message.conversation_id;
  select * into phone from public.phone_numbers where organization_id = message.organization_id and id = conversation.transport_phone_number_id;
  if conversation.id is null or phone.id is null or phone.status <> 'active' or not phone.sms_enabled or exists(select 1 from public.messaging_contact_preferences pref where pref.organization_id = message.organization_id and pref.location_id = conversation.location_id and pref.contact_id = conversation.contact_id and pref.channel_type = 'sms' and pref.sender_phone_number_id = phone.id and pref.status = 'opted_out') then
    update public.message_deliveries set status = 'suppressed', error_code = 'delivery_suppressed', updated_at = now() where id = delivery.id; return;
  end if;
  if message.appointment_reminder_id is not null then
    select reminder.trusted_sms_recipient_e164 into to_e164 from public.appointment_reminders reminder where reminder.organization_id = message.organization_id and reminder.location_id = message.location_id and reminder.id = message.appointment_reminder_id and reminder.message_id = message.id and reminder.status = 'sent';
  else
    select inbound.transport_sender_e164 into to_e164 from public.messages inbound where inbound.organization_id = message.organization_id and inbound.conversation_id = message.conversation_id and inbound.id = message.in_reply_to_message_id and inbound.direction = 'inbound' and inbound.source_channel = 'sms' and inbound.author_type = 'customer';
  end if;
  if message.body is null or to_e164 is null then update public.message_deliveries set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now() where id = delivery.id; return; end if;
  update public.message_deliveries set status = 'submitting', attempted_at = now(), updated_at = now() where id = delivery.id;
  return query select message.id, delivery.id, to_e164, phone.phone_number, message.body, 'submitting'::text;
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
  perform public.refresh_appointment_reminders_internal(result.appointment_id);
  return query select result.appointment_id, result.is_existing;
end;
$$;

revoke all on function public.refresh_appointment_reminders(uuid), public.claim_due_appointment_reminders(text, integer), public.get_appointment_reminder_execution_context(uuid), public.record_appointment_reminder_revalidation(uuid, text), public.create_appointment_reminder_message(uuid) from public, anon, authenticated;
grant execute on function public.refresh_appointment_reminders(uuid), public.claim_due_appointment_reminders(text, integer), public.get_appointment_reminder_execution_context(uuid), public.record_appointment_reminder_revalidation(uuid, text), public.create_appointment_reminder_message(uuid) to service_role;
revoke all on function public.refresh_appointment_reminders_internal(uuid), public.appointment_reminders_refresh_trigger() from public, anon, authenticated, service_role;
revoke all on function public.get_my_appointment_reminder_settings(uuid), public.get_my_appointment_reminders(uuid), public.upsert_my_appointment_reminder_settings(uuid, boolean, boolean, boolean, time, time) from public, anon;
grant execute on function public.get_my_appointment_reminder_settings(uuid), public.get_my_appointment_reminders(uuid), public.upsert_my_appointment_reminder_settings(uuid, boolean, boolean, boolean, time, time) to authenticated;

-- Phase 8 reliability hardening. This migration is intentionally additive: Phase 8's
-- original reminder schema remains immutable while rollout, timing, and delivery truth are fixed.

create function public.normalize_completed_booking_appointments_internal()
returns integer language plpgsql security definer set search_path = '' as $$
declare affected_count integer;
begin
  -- The migration and any privileged replay of this narrow normalizer must not create reminders.
  perform pg_catalog.set_config('app.suppress_reminder_refresh', 'true', true);
  update public.appointments appointment
  set status = case when appointment.status = 'requested' then 'confirmed' else appointment.status end,
    trusted_sms_recipient_e164 = case
      when appointment.trusted_sms_recipient_e164 is null then intent.trusted_transport_phone_e164
      else appointment.trusted_sms_recipient_e164
    end,
    updated_at = now()
  from public.booking_intents intent
  where appointment.organization_id = intent.organization_id
    and appointment.booking_intent_id = intent.id
    and intent.status = 'completed'
    and appointment.external_appointment_id is not null
    and appointment.provider_status in ('confirmed', 'unconfirmed')
    and (appointment.status = 'requested'
      or (appointment.trusted_sms_recipient_e164 is null and intent.trusted_transport_phone_e164 is not null));
  get diagnostics affected_count = row_count;
  perform pg_catalog.set_config('app.suppress_reminder_refresh', 'false', true);
  return affected_count;
end;
$$;

-- The old trigger is intentionally disabled only for the migration-time legacy normalization.
-- Settings remain disabled by default and no migration update may enqueue an SMS reminder.
alter table public.appointments disable trigger appointments_refresh_reminders;
select public.normalize_completed_booking_appointments_internal();
alter table public.appointments enable trigger appointments_refresh_reminders;

alter table public.appointment_reminder_settings
  add column schedule_version bigint not null default 1;
alter table public.appointment_reminders
  add column schedule_version bigint not null default 0;
alter table public.appointment_reminders drop constraint appointment_reminders_status_check;
alter table public.appointment_reminders add constraint appointment_reminders_status_check
  check (status in ('scheduled', 'processing', 'delivery_pending', 'sent', 'skipped', 'failed'));
create index appointments_reminder_reconciliation_idx
  on public.appointments (starts_at, id) where status = 'confirmed';

create function public.enforce_appointment_trusted_sms_recipient()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
    and old.trusted_sms_recipient_e164 is not null
    and new.trusted_sms_recipient_e164 is distinct from old.trusted_sms_recipient_e164 then
    raise exception using errcode = '22023', message = 'Trusted appointment SMS recipient is immutable';
  end if;
  return new;
end;
$$;

create trigger appointments_trusted_sms_recipient_immutable
before update of trusted_sms_recipient_e164 on public.appointments
for each row execute function public.enforce_appointment_trusted_sms_recipient();

create function public.enforce_appointment_reminder_trusted_sms_recipient()
returns trigger language plpgsql security definer set search_path = '' as $$
declare appointment_recipient text;
begin
  if tg_op = 'UPDATE'
    and old.trusted_sms_recipient_e164 is not null
    and new.trusted_sms_recipient_e164 is distinct from old.trusted_sms_recipient_e164 then
    raise exception using errcode = '22023', message = 'Trusted reminder SMS recipient is immutable';
  end if;
  if new.trusted_sms_recipient_e164 is not null
    and (tg_op = 'INSERT' or old.trusted_sms_recipient_e164 is null) then
    select appointment.trusted_sms_recipient_e164 into appointment_recipient
    from public.appointments appointment
    where appointment.organization_id = new.organization_id
      and appointment.location_id = new.location_id
      and appointment.id = new.appointment_id;
    if appointment_recipient is distinct from new.trusted_sms_recipient_e164 then
      raise exception using errcode = '22023', message = 'Reminder recipient must match the immutable appointment recipient';
    end if;
  end if;
  return new;
end;
$$;

create trigger appointment_reminders_trusted_sms_recipient_immutable
before insert or update of trusted_sms_recipient_e164 on public.appointment_reminders
for each row execute function public.enforce_appointment_reminder_trusted_sms_recipient();

-- Quiet hours never move a transactional reminder later. For a fall-back ambiguous local
-- boundary PostgreSQL resolves to standard time (the later UTC occurrence); if that instant is
-- not actually earlier than the nominal instant, the reminder is not scheduled. A spring-forward
-- nonexistent boundary similarly returns NULL instead of being shifted forward by PostgreSQL.
create or replace function public.reminder_local_time(target_time timestamptz, target_timezone text, quiet_start time, quiet_end time)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare local_time timestamp without time zone; candidate_local timestamp without time zone; candidate_time timestamptz;
begin
  local_time := target_time at time zone target_timezone;
  if not ((quiet_start < quiet_end and local_time::time >= quiet_start and local_time::time < quiet_end)
    or (quiet_start > quiet_end and (local_time::time >= quiet_start or local_time::time < quiet_end))) then
    return target_time;
  end if;
  if quiet_start < quiet_end or local_time::time >= quiet_start then
    candidate_local := local_time::date + quiet_start - interval '1 microsecond';
  else
    candidate_local := (local_time::date - 1) + quiet_start - interval '1 microsecond';
  end if;
  candidate_time := candidate_local at time zone target_timezone;
  if candidate_time at time zone target_timezone is distinct from candidate_local
    or candidate_time >= target_time then
    return null;
  end if;
  return candidate_time;
end;
$$;

create function public.is_appointment_reminder_send_time(target_reminder_type text, target_time timestamptz, appointment_starts_at timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select target_time is not null and case target_reminder_type
    when 'appointment_24h' then target_time between appointment_starts_at - interval '26 hours' and appointment_starts_at - interval '18 hours'
    when 'appointment_2h' then target_time between appointment_starts_at - interval '150 minutes' and appointment_starts_at - interval '75 minutes'
    else false
  end;
$$;

create function public.appointment_reminder_audit_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare action_name text; reason text;
begin
  if tg_op = 'INSERT' and new.status = 'scheduled' then
    action_name := 'appointment.reminder.scheduled';
  elsif tg_op = 'UPDATE' and new.status = 'scheduled'
    and (old.status is distinct from new.status or old.scheduled_for is distinct from new.scheduled_for) then
    action_name := 'appointment.reminder.scheduled';
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    action_name := case new.status
      when 'sent' then 'appointment.reminder.sent'
      when 'skipped' then 'appointment.reminder.skipped'
      when 'failed' then 'appointment.reminder.failed'
      else null
    end;
  end if;
  if action_name is null then return new; end if;
  reason := left(coalesce(new.last_error_code, case when new.status = 'sent' then 'delivery_confirmed' else null end), 120);
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (new.organization_id, new.location_id, action_name, 'appointment_reminder', new.id,
    jsonb_strip_nulls(jsonb_build_object('reminder_type', new.reminder_type, 'reason', reason)));
  return new;
end;
$$;

create trigger appointment_reminders_audit
after insert or update of status, scheduled_for on public.appointment_reminders
for each row execute function public.appointment_reminder_audit_trigger();

create function public.sync_appointment_reminder_delivery_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare reminder_id uuid;
begin
  if new.provider <> 'twilio' or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return new;
  end if;
  select message.appointment_reminder_id into reminder_id
  from public.messages message
  where message.organization_id = new.organization_id and message.id = new.message_id;
  if reminder_id is null then return new; end if;
  if new.status in ('queued', 'submitting', 'submitted') then
    update public.appointment_reminders reminder set status = 'delivery_pending', claimed_at = null, claimed_by = null,
      last_error_code = null, updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id
      and reminder.status in ('processing', 'delivery_pending');
  elsif new.status in ('sent', 'delivered') then
    update public.appointment_reminders reminder set status = 'sent', claimed_at = null, claimed_by = null,
      last_error_code = null, updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id and reminder.status <> 'sent';
  elsif new.status = 'suppressed' then
    update public.appointment_reminders reminder set status = 'skipped', claimed_at = null, claimed_by = null,
      last_error_code = 'delivery_suppressed', updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id and reminder.status <> 'sent';
  elsif new.status in ('failed', 'undelivered') then
    update public.appointment_reminders reminder set status = 'failed', claimed_at = null, claimed_by = null,
      last_error_code = 'delivery_failed', updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id and reminder.status <> 'sent';
  elsif new.status = 'unknown' then
    update public.appointment_reminders reminder set status = 'failed', claimed_at = null, claimed_by = null,
      last_error_code = 'delivery_unknown', updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id and reminder.status <> 'sent';
  end if;
  return new;
end;
$$;

create trigger message_deliveries_sync_appointment_reminder
after insert or update of status on public.message_deliveries
for each row execute function public.sync_appointment_reminder_delivery_status();

create or replace function public.refresh_appointment_reminders_internal(target_appointment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; settings_row public.appointment_reminder_settings%rowtype; location_row public.locations%rowtype;
  schedule record; nominal_time timestamptz; reminder_time timestamptz;
begin
  select * into appointment_row from public.appointments where id = target_appointment_id for update;
  if appointment_row.id is null then return; end if;
  select * into settings_row from public.appointment_reminder_settings
  where organization_id = appointment_row.organization_id and location_id = appointment_row.location_id;
  if appointment_row.status <> 'confirmed' or appointment_row.starts_at <= now() then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_not_active', claimed_at = null, claimed_by = null, updated_at = now()
    where appointment_id = appointment_row.id and status in ('scheduled', 'processing');
    return;
  end if;
  if settings_row.id is null or not settings_row.sms_enabled or appointment_row.starts_at > now() + interval '30 days' then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'sms_disabled', claimed_at = null, claimed_by = null, updated_at = now()
    where appointment_id = appointment_row.id and status in ('scheduled', 'processing');
    return;
  end if;
  if appointment_row.trusted_sms_recipient_e164 is null then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'no_trusted_recipient', claimed_at = null, claimed_by = null, updated_at = now()
    where appointment_id = appointment_row.id and status in ('scheduled', 'processing');
    return;
  end if;
  select * into location_row from public.locations where organization_id = appointment_row.organization_id and id = appointment_row.location_id;
  for schedule in select * from (values
    ('appointment_24h'::text, interval '24 hours', settings_row.reminder_24h_enabled),
    ('appointment_2h'::text, interval '2 hours', settings_row.reminder_2h_enabled)
  ) as configured(reminder_type, lead_time, is_enabled)
  loop
    if not schedule.is_enabled then
      update public.appointment_reminders set status = 'skipped', last_error_code = 'reminder_disabled', claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = appointment_row.id and reminder_type = schedule.reminder_type and status in ('scheduled', 'processing');
      continue;
    end if;
    nominal_time := appointment_row.starts_at - schedule.lead_time;
    reminder_time := public.reminder_local_time(nominal_time, location_row.timezone, settings_row.quiet_hours_start, settings_row.quiet_hours_end);
    if not public.is_appointment_reminder_send_time(schedule.reminder_type, reminder_time, appointment_row.starts_at) then
      update public.appointment_reminders set status = 'skipped', last_error_code = 'quiet_hours_outside_send_window', claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = appointment_row.id and reminder_type = schedule.reminder_type and status in ('scheduled', 'processing');
      continue;
    end if;
    insert into public.appointment_reminders (organization_id, location_id, appointment_id, reminder_type, scheduled_for, trusted_sms_recipient_e164, schedule_version)
    values (appointment_row.organization_id, appointment_row.location_id, appointment_row.id, schedule.reminder_type, reminder_time,
      appointment_row.trusted_sms_recipient_e164, settings_row.schedule_version)
    on conflict (appointment_id, reminder_type) do update set
      scheduled_for = excluded.scheduled_for,
      trusted_sms_recipient_e164 = coalesce(public.appointment_reminders.trusted_sms_recipient_e164, excluded.trusted_sms_recipient_e164),
      schedule_version = excluded.schedule_version,
      status = case when public.appointment_reminders.status = 'scheduled'
        or (public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code in ('sms_disabled', 'reminder_disabled', 'quiet_hours_outside_send_window', 'no_trusted_recipient'))
        then 'scheduled' else public.appointment_reminders.status end,
      revalidation_status = case when public.appointment_reminders.status = 'scheduled'
        or (public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code in ('sms_disabled', 'reminder_disabled', 'quiet_hours_outside_send_window', 'no_trusted_recipient'))
        then 'pending' else public.appointment_reminders.revalidation_status end,
      claimed_at = case when public.appointment_reminders.status = 'scheduled' then null else public.appointment_reminders.claimed_at end,
      claimed_by = case when public.appointment_reminders.status = 'scheduled' then null else public.appointment_reminders.claimed_by end,
      last_error_code = case when public.appointment_reminders.status = 'scheduled'
        or (public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code in ('sms_disabled', 'reminder_disabled', 'quiet_hours_outside_send_window', 'no_trusted_recipient'))
        then null else public.appointment_reminders.last_error_code end,
      updated_at = now()
    where public.appointment_reminders.message_id is null
      and (public.appointment_reminders.status = 'scheduled'
        or (public.appointment_reminders.status = 'skipped' and public.appointment_reminders.last_error_code in ('sms_disabled', 'reminder_disabled', 'quiet_hours_outside_send_window', 'no_trusted_recipient')));
  end loop;
end;
$$;

create or replace function public.appointment_reminders_refresh_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('app.suppress_reminder_refresh', true) = 'true' then return new; end if;
  perform public.refresh_appointment_reminders_internal(new.id);
  return new;
end;
$$;

create or replace function public.upsert_my_appointment_reminder_settings(target_location_id uuid, target_sms_enabled boolean, target_24h_enabled boolean, target_2h_enabled boolean, target_quiet_hours_start time default time '20:00', target_quiet_hours_end time default time '08:00')
returns void language plpgsql security definer set search_path = '' as $$
declare location_row public.locations%rowtype; settings_id uuid;
begin
  select * into location_row from public.locations where id = target_location_id;
  if location_row.id is null or not public.is_organization_admin(location_row.organization_id) or target_quiet_hours_start = target_quiet_hours_end then
    raise exception using errcode = '42501', message = 'Reminder settings are unavailable';
  end if;
  if target_sms_enabled and not exists (
    select 1 from public.phone_numbers sender where sender.organization_id = location_row.organization_id
      and sender.location_id = location_row.id and sender.status = 'active' and sender.sms_enabled
  ) then
    raise exception using errcode = '22023', message = 'An active SMS sender is required before reminders can be enabled';
  end if;
  insert into public.appointment_reminder_settings as settings (organization_id, location_id, sms_enabled, reminder_24h_enabled, reminder_2h_enabled, quiet_hours_start, quiet_hours_end)
  values (location_row.organization_id, location_row.id, target_sms_enabled, target_24h_enabled, target_2h_enabled, target_quiet_hours_start, target_quiet_hours_end)
  on conflict (organization_id, location_id) do update set
    sms_enabled = excluded.sms_enabled,
    reminder_24h_enabled = excluded.reminder_24h_enabled,
    reminder_2h_enabled = excluded.reminder_2h_enabled,
    quiet_hours_start = excluded.quiet_hours_start,
    quiet_hours_end = excluded.quiet_hours_end,
    schedule_version = case when (settings.sms_enabled, settings.reminder_24h_enabled, settings.reminder_2h_enabled, settings.quiet_hours_start, settings.quiet_hours_end)
      is distinct from (excluded.sms_enabled, excluded.reminder_24h_enabled, excluded.reminder_2h_enabled, excluded.quiet_hours_start, excluded.quiet_hours_end)
      then settings.schedule_version + 1 else settings.schedule_version end,
    updated_at = now()
  returning id into settings_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (location_row.organization_id, location_row.id, 'reminder.settings.updated', 'appointment_reminder_settings', settings_id,
    jsonb_build_object('sms_enabled', target_sms_enabled, 'reminder_24h_enabled', target_24h_enabled, 'reminder_2h_enabled', target_2h_enabled));
end;
$$;

create or replace function public.claim_due_appointment_reminders(target_worker_id text, target_limit integer default 4)
returns table (reminder_id uuid) language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Reminder claim is invalid';
  end if;
  update public.appointment_reminders set status = case when message_id is not null then 'delivery_pending' when attempt_count >= 10 then 'failed' else 'scheduled' end,
    claimed_at = null, claimed_by = null,
    last_error_code = case when message_id is not null then last_error_code when attempt_count >= 10 then 'max_attempts_exhausted' else 'stale_claim_recovered' end,
    revalidation_status = case when message_id is not null then revalidation_status else 'pending' end, updated_at = now()
  where status = 'processing' and claimed_at < now() - interval '5 minutes';
  update public.appointment_reminders set status = 'failed', last_error_code = 'max_attempts_exhausted', updated_at = now()
  where status = 'scheduled' and attempt_count >= 10;
  return query with due as (
    select reminder.id from public.appointment_reminders reminder
    where reminder.status = 'scheduled' and reminder.attempt_count < 10 and reminder.scheduled_for <= now()
    order by reminder.scheduled_for asc for update skip locked limit target_limit
  ), claimed as (
    update public.appointment_reminders reminder set status = 'processing', attempt_count = reminder.attempt_count + 1,
      claimed_at = now(), claimed_by = btrim(target_worker_id), revalidation_status = 'pending', updated_at = now()
    from due where reminder.id = due.id returning reminder.id
  ) select claimed.id from claimed;
end;
$$;

create or replace function public.record_appointment_reminder_revalidation(target_reminder_id uuid, target_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
declare reminder public.appointment_reminders%rowtype; appointment public.appointments%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into reminder from public.appointment_reminders where id = target_reminder_id for update;
  if reminder.id is null or reminder.status <> 'processing' then return; end if;
  select * into appointment from public.appointments where organization_id = reminder.organization_id and id = reminder.appointment_id;
  if target_outcome = 'not_required'
    and (appointment.provider is not null or appointment.integration_id is not null or appointment.external_appointment_id is not null) then
    raise exception using errcode = '22023', message = 'Provider-backed reminders require confirmed revalidation';
  end if;
  if target_outcome in ('confirmed', 'not_required') then
    update public.appointment_reminders set revalidation_status = target_outcome, updated_at = now() where id = reminder.id;
  elsif target_outcome in ('provider_not_confirmed', 'provider_unavailable') then
    update public.appointment_reminders set status = 'skipped', revalidation_status = target_outcome, last_error_code = target_outcome,
      claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id;
  else
    raise exception using errcode = '22023', message = 'Reminder revalidation outcome is invalid';
  end if;
end;
$$;

create or replace function public.create_appointment_reminder_message(target_reminder_id uuid)
returns table (message_id uuid) language plpgsql security definer set search_path = '' as $$
declare reminder public.appointment_reminders%rowtype; appointment public.appointments%rowtype; settings public.appointment_reminder_settings%rowtype;
  location public.locations%rowtype; sender_phone public.phone_numbers%rowtype; channel public.channels%rowtype; contact public.contacts%rowtype; conversation public.conversations%rowtype; saved_message_id uuid;
  lower_window timestamptz; upper_window timestamptz; reminder_enabled boolean;
begin
  perform public.require_messaging_service_role();
  select * into reminder from public.appointment_reminders where id = target_reminder_id for update;
  if reminder.id is null or reminder.status <> 'processing' then return; end if;
  select * into appointment from public.appointments where organization_id = reminder.organization_id and location_id = reminder.location_id and id = reminder.appointment_id;
  select * into settings from public.appointment_reminder_settings where organization_id = reminder.organization_id and location_id = reminder.location_id;
  if reminder.revalidation_status not in ('confirmed', 'not_required')
    or (reminder.revalidation_status = 'not_required' and (appointment.provider is not null or appointment.integration_id is not null or appointment.external_appointment_id is not null)) then
    raise exception using errcode = '42501', message = 'Reminder has not passed required revalidation';
  end if;
  if appointment.id is null or appointment.status <> 'confirmed' or appointment.starts_at <= now() then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_not_active', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id;
    return;
  end if;
  reminder_enabled := case reminder.reminder_type when 'appointment_24h' then settings.reminder_24h_enabled when 'appointment_2h' then settings.reminder_2h_enabled else false end;
  if settings.id is null or not settings.sms_enabled or not reminder_enabled then
    update public.appointment_reminders set status = 'skipped', last_error_code = case when settings.id is null or not settings.sms_enabled then 'sms_disabled' else 'reminder_disabled' end,
      claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id;
    return;
  end if;
  if reminder.reminder_type = 'appointment_24h' then lower_window := appointment.starts_at - interval '26 hours'; upper_window := appointment.starts_at - interval '18 hours'; else lower_window := appointment.starts_at - interval '150 minutes'; upper_window := appointment.starts_at - interval '75 minutes'; end if;
  if now() < lower_window then update public.appointment_reminders set status = 'scheduled', claimed_at = null, claimed_by = null, revalidation_status = 'pending', updated_at = now() where id = reminder.id; return; end if;
  if now() > upper_window then update public.appointment_reminders set status = 'skipped', last_error_code = 'outside_send_window', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  if reminder.trusted_sms_recipient_e164 is null then update public.appointment_reminders set status = 'skipped', last_error_code = 'no_trusted_recipient', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  select * into location from public.locations where organization_id = reminder.organization_id and id = reminder.location_id;
  select * into sender_phone from public.phone_numbers where organization_id = reminder.organization_id and location_id = reminder.location_id and status = 'active' and sms_enabled order by created_at asc limit 1;
  if sender_phone.id is null then update public.appointment_reminders set status = 'skipped', last_error_code = 'no_sms_sender', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return; end if;
  select * into contact from public.contacts existing_contact where existing_contact.organization_id = reminder.organization_id and existing_contact.location_id = reminder.location_id and existing_contact.phone = reminder.trusted_sms_recipient_e164 limit 1;
  if contact.id is null then insert into public.contacts (organization_id, location_id, phone, metadata) values (reminder.organization_id, reminder.location_id, reminder.trusted_sms_recipient_e164, jsonb_build_object('source', 'appointment_reminder')) returning * into contact; end if;
  if exists(select 1 from public.messaging_contact_preferences pref where pref.organization_id = reminder.organization_id and pref.location_id = reminder.location_id and pref.contact_id = contact.id and pref.channel_type = 'sms' and pref.sender_phone_number_id = sender_phone.id and pref.status = 'opted_out') then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'opted_out', claimed_at = null, claimed_by = null, updated_at = now() where id = reminder.id; return;
  end if;
  select * into channel from public.channels where organization_id = reminder.organization_id and location_id = reminder.location_id and channel_type = 'sms' and status = 'active' limit 1;
  if channel.id is null then insert into public.channels (organization_id, location_id, channel_type, display_name, status, configuration) values (reminder.organization_id, reminder.location_id, 'sms', 'SMS', 'active', jsonb_build_object('phone_number_id', sender_phone.id)) returning * into channel; end if;
  select c.* into conversation from public.conversations c join public.messages inbound on inbound.organization_id = c.organization_id and inbound.conversation_id = c.id
    where c.organization_id = reminder.organization_id and c.location_id = reminder.location_id and c.transport_phone_number_id = sender_phone.id and c.status = 'open'
      and inbound.direction = 'inbound' and inbound.source_channel = 'sms' and inbound.author_type = 'customer' and inbound.transport_sender_e164 = reminder.trusted_sms_recipient_e164
    order by c.updated_at desc limit 1;
  if conversation.id is null then insert into public.conversations (organization_id, location_id, contact_id, channel_id, transport_phone_number_id, mode, status, metadata) values (reminder.organization_id, reminder.location_id, contact.id, channel.id, sender_phone.id, 'customer', 'open', jsonb_build_object('transport', 'sms', 'source', 'appointment_reminder')) returning * into conversation; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, appointment_reminder_id, sent_at)
  values (reminder.organization_id, reminder.location_id, conversation.id, contact.id, 'outbound', 'text',
    'Reminder from ' || location.name || ': you have an appointment ' || to_char(appointment.starts_at at time zone location.timezone, 'FMDay, FMMonth FMDD at FMHH12:MI AM') || '. Reply here if you need help.',
    jsonb_build_object('transport', 'sms', 'kind', 'appointment_reminder'), 'sms', 'system', reminder.id, now()) returning id into saved_message_id;
  insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (reminder.organization_id, reminder.location_id, saved_message_id, 'twilio');
  insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (reminder.organization_id, reminder.location_id, conversation.id, saved_message_id, 'outbound_delivery');
  update public.appointment_reminders set message_id = saved_message_id, status = 'delivery_pending', claimed_at = null, claimed_by = null, last_error_code = null, updated_at = now() where id = reminder.id;
  return query select saved_message_id;
end;
$$;

-- Reminder delivery uses the existing Phase 7 state machine. The additional checks only suppress
-- an unsubmitted reminder after cancellation or configuration disablement; no blind resend exists.
create or replace function public.claim_sms_delivery_submission(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql security definer set search_path = '' as $$
declare delivery public.message_deliveries%rowtype; message public.messages%rowtype; conversation public.conversations%rowtype; phone public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into delivery from public.message_deliveries as message_delivery where message_delivery.message_id = target_message_id and message_delivery.provider = 'twilio' for update;
  if delivery.id is null or delivery.status <> 'queued' then return; end if;
  select * into message from public.messages where id = delivery.message_id;
  if message.appointment_reminder_id is not null and not exists (
    select 1 from public.appointment_reminders reminder
    join public.appointments appointment on appointment.organization_id = reminder.organization_id and appointment.location_id = reminder.location_id and appointment.id = reminder.appointment_id
    join public.appointment_reminder_settings settings on settings.organization_id = reminder.organization_id and settings.location_id = reminder.location_id
    where reminder.organization_id = message.organization_id and reminder.location_id = message.location_id and reminder.id = message.appointment_reminder_id
      and appointment.status = 'confirmed' and appointment.starts_at > now() and settings.sms_enabled
  ) then
    update public.message_deliveries set status = 'suppressed', error_code = 'appointment_reminder_ineligible', updated_at = now() where id = delivery.id;
    return;
  end if;
  select * into conversation from public.conversations where organization_id = message.organization_id and id = message.conversation_id;
  select * into phone from public.phone_numbers where organization_id = message.organization_id and id = conversation.transport_phone_number_id;
  if conversation.id is null or phone.id is null or phone.status <> 'active' or not phone.sms_enabled or exists(select 1 from public.messaging_contact_preferences pref where pref.organization_id = message.organization_id and pref.location_id = conversation.location_id and pref.contact_id = conversation.contact_id and pref.channel_type = 'sms' and pref.sender_phone_number_id = phone.id and pref.status = 'opted_out') then
    update public.message_deliveries set status = 'suppressed', error_code = 'delivery_suppressed', updated_at = now() where id = delivery.id;
    return;
  end if;
  if message.body is null then update public.message_deliveries set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now() where id = delivery.id; return; end if;
  if message.appointment_reminder_id is not null then
    select reminder.trusted_sms_recipient_e164 into to_e164 from public.appointment_reminders reminder where reminder.organization_id = message.organization_id and reminder.location_id = message.location_id and reminder.id = message.appointment_reminder_id and reminder.message_id = message.id and reminder.status = 'delivery_pending';
  else
    select inbound.transport_sender_e164 into to_e164 from public.messages inbound where inbound.organization_id = message.organization_id and inbound.conversation_id = message.conversation_id and inbound.id = message.in_reply_to_message_id and inbound.direction = 'inbound' and inbound.source_channel = 'sms' and inbound.author_type = 'customer';
  end if;
  if to_e164 is null then update public.message_deliveries set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now() where id = delivery.id; return; end if;
  update public.message_deliveries set status = 'submitting', attempted_at = now(), updated_at = now() where id = delivery.id;
  return query select message.id, delivery.id, to_e164, phone.phone_number, message.body, 'submitting'::text;
end;
$$;

create function public.reconcile_appointment_reminder_schedules(target_limit integer default 50)
returns table (appointment_id uuid) language plpgsql security definer set search_path = '' as $$
declare candidate record;
begin
  perform public.require_messaging_service_role();
  if target_limit not between 1 and 100 then raise exception using errcode = '22023', message = 'Reminder reconciliation limit is invalid'; end if;
  for candidate in
    with candidates as (
      select appointment.id
      from public.appointments appointment
      join public.appointment_reminder_settings settings on settings.organization_id = appointment.organization_id and settings.location_id = appointment.location_id
      where appointment.status = 'confirmed' and appointment.starts_at > now() and appointment.starts_at <= now() + interval '30 days'
        and (
          (not settings.sms_enabled and exists (select 1 from public.appointment_reminders reminder where reminder.appointment_id = appointment.id and reminder.status in ('scheduled', 'processing')))
          or (settings.sms_enabled and settings.reminder_24h_enabled and not exists (select 1 from public.appointment_reminders reminder where reminder.appointment_id = appointment.id and reminder.reminder_type = 'appointment_24h'))
          or (settings.sms_enabled and settings.reminder_2h_enabled and not exists (select 1 from public.appointment_reminders reminder where reminder.appointment_id = appointment.id and reminder.reminder_type = 'appointment_2h'))
          or exists (select 1 from public.appointment_reminders reminder where reminder.appointment_id = appointment.id and reminder.status in ('scheduled', 'skipped') and reminder.schedule_version is distinct from settings.schedule_version)
          or (not settings.reminder_24h_enabled and exists (select 1 from public.appointment_reminders reminder where reminder.appointment_id = appointment.id and reminder.reminder_type = 'appointment_24h' and reminder.status in ('scheduled', 'processing')))
          or (not settings.reminder_2h_enabled and exists (select 1 from public.appointment_reminders reminder where reminder.appointment_id = appointment.id and reminder.reminder_type = 'appointment_2h' and reminder.status in ('scheduled', 'processing')))
        )
      order by appointment.starts_at asc
      for update of appointment skip locked
      limit target_limit
    ) select id from candidates
  loop
    perform public.refresh_appointment_reminders_internal(candidate.id);
    appointment_id := candidate.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.normalize_completed_booking_appointments_internal(), public.enforce_appointment_trusted_sms_recipient(), public.enforce_appointment_reminder_trusted_sms_recipient(), public.appointment_reminder_audit_trigger(), public.sync_appointment_reminder_delivery_status(), public.is_appointment_reminder_send_time(text, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reconcile_appointment_reminder_schedules(integer) from public, anon, authenticated;
grant execute on function public.reconcile_appointment_reminder_schedules(integer) to service_role;

-- Phase 8 finalization: delivery truth, bounded reconciliation progress, and last-moment SMS policy checks.
-- This migration deliberately reuses the Phase 7 delivery state machine and never grants direct table access.

create or replace function public.sync_appointment_reminder_delivery_status()
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
    update public.appointment_reminders reminder
    set status = 'delivery_pending', claimed_at = null, claimed_by = null, last_error_code = null, updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id
      and reminder.status in ('processing', 'delivery_pending');
  elsif new.status in ('sent', 'delivered') then
    -- A failed or suppressed reminder is never reopened into success. A delivered delivery is terminal
    -- in the Phase 7 graph, so a later failure callback cannot reach this branch legitimately.
    update public.appointment_reminders reminder
    set status = 'sent', claimed_at = null, claimed_by = null, last_error_code = null, updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id
      and reminder.status in ('processing', 'delivery_pending');
  elsif new.status = 'suppressed' then
    update public.appointment_reminders reminder
    set status = 'skipped', claimed_at = null, claimed_by = null, last_error_code = 'delivery_suppressed', updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id
      and reminder.status in ('processing', 'delivery_pending');
  elsif new.status in ('failed', 'undelivered') then
    -- Phase 7 allows sent -> undelivered. The reminder projection must follow that source of truth.
    update public.appointment_reminders reminder
    set status = 'failed', claimed_at = null, claimed_by = null, last_error_code = 'delivery_failed', updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id
      and reminder.status in ('processing', 'delivery_pending', 'sent');
  elsif new.status = 'unknown' then
    update public.appointment_reminders reminder
    set status = 'failed', claimed_at = null, claimed_by = null, last_error_code = 'delivery_unknown', updated_at = now()
    where reminder.organization_id = new.organization_id and reminder.id = reminder_id
      and reminder.status in ('processing', 'delivery_pending', 'sent');
  end if;

  return new;
end;
$$;

-- Reminder delivery uses the existing Phase 7 single-send authorization. These extra checks run while
-- the queued delivery row is locked, immediately before queued -> submitting, to suppress stale policy
-- snapshots rather than transmit a message with obsolete appointment information.
create or replace function public.claim_sms_delivery_submission(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql security definer set search_path = '' as $$
declare
  delivery public.message_deliveries%rowtype;
  message public.messages%rowtype;
  conversation public.conversations%rowtype;
  phone public.phone_numbers%rowtype;
  reminder public.appointment_reminders%rowtype;
  appointment public.appointments%rowtype;
  settings public.appointment_reminder_settings%rowtype;
  location public.locations%rowtype;
  reminder_enabled boolean;
  expected_scheduled_for timestamptz;
  nominal_scheduled_for timestamptz;
begin
  perform public.require_messaging_service_role();

  select * into delivery
  from public.message_deliveries as message_delivery
  where message_delivery.message_id = target_message_id and message_delivery.provider = 'twilio'
  for update;
  if delivery.id is null or delivery.status <> 'queued' then return; end if;

  select * into message from public.messages where id = delivery.message_id;

  if message.appointment_reminder_id is not null then
    select * into reminder
    from public.appointment_reminders reminder_row
    where reminder_row.organization_id = message.organization_id
      and reminder_row.location_id = message.location_id
      and reminder_row.id = message.appointment_reminder_id
      and reminder_row.message_id = message.id
      and reminder_row.status = 'delivery_pending'
    for share;

    select * into appointment
    from public.appointments appointment_row
    where appointment_row.organization_id = message.organization_id
      and appointment_row.location_id = message.location_id
      and appointment_row.id = reminder.appointment_id
    for share;

    select * into settings
    from public.appointment_reminder_settings settings_row
    where settings_row.organization_id = message.organization_id
      and settings_row.location_id = message.location_id
    for share;

    select * into location
    from public.locations location_row
    where location_row.organization_id = message.organization_id and location_row.id = message.location_id
    for share;

    reminder_enabled := case reminder.reminder_type
      when 'appointment_24h' then settings.reminder_24h_enabled
      when 'appointment_2h' then settings.reminder_2h_enabled
      else false
    end;
    nominal_scheduled_for := appointment.starts_at - case reminder.reminder_type
      when 'appointment_24h' then interval '24 hours'
      when 'appointment_2h' then interval '2 hours'
      else null
    end;
    expected_scheduled_for := public.reminder_local_time(
      nominal_scheduled_for,
      location.timezone,
      settings.quiet_hours_start,
      settings.quiet_hours_end
    );

    if reminder.id is null
      or appointment.id is null
      or appointment.status <> 'confirmed'
      or appointment.starts_at <= now()
      or settings.id is null
      or not settings.sms_enabled
      or not reminder_enabled
      or reminder.schedule_version is distinct from settings.schedule_version
      or expected_scheduled_for is null
      or not public.is_appointment_reminder_send_time(reminder.reminder_type, expected_scheduled_for, appointment.starts_at)
      or expected_scheduled_for is distinct from reminder.scheduled_for
    then
      update public.message_deliveries
      set status = 'suppressed', error_code = 'appointment_reminder_ineligible', updated_at = now()
      where id = delivery.id;
      return;
    end if;
  end if;

  select * into conversation
  from public.conversations
  where organization_id = message.organization_id and id = message.conversation_id;
  select * into phone
  from public.phone_numbers
  where organization_id = message.organization_id and id = conversation.transport_phone_number_id;

  if conversation.id is null or phone.id is null or phone.status <> 'active' or not phone.sms_enabled
    or exists (
      select 1 from public.messaging_contact_preferences preference
      where preference.organization_id = message.organization_id
        and preference.location_id = conversation.location_id
        and preference.contact_id = conversation.contact_id
        and preference.channel_type = 'sms'
        and preference.sender_phone_number_id = phone.id
        and preference.status = 'opted_out'
    )
  then
    update public.message_deliveries
    set status = 'suppressed', error_code = 'delivery_suppressed', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  if message.body is null then
    update public.message_deliveries
    set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  if message.appointment_reminder_id is not null then
    select reminder_row.trusted_sms_recipient_e164 into to_e164
    from public.appointment_reminders reminder_row
    where reminder_row.organization_id = message.organization_id
      and reminder_row.location_id = message.location_id
      and reminder_row.id = message.appointment_reminder_id
      and reminder_row.message_id = message.id
      and reminder_row.status = 'delivery_pending';
  else
    select inbound.transport_sender_e164 into to_e164
    from public.messages inbound
    where inbound.organization_id = message.organization_id
      and inbound.conversation_id = message.conversation_id
      and inbound.id = message.in_reply_to_message_id
      and inbound.direction = 'inbound'
      and inbound.source_channel = 'sms'
      and inbound.author_type = 'customer';
  end if;

  if to_e164 is null then
    update public.message_deliveries
    set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  update public.message_deliveries
  set status = 'submitting', attempted_at = now(), updated_at = now()
  where id = delivery.id;

  return query
  select message.id, delivery.id, to_e164, phone.phone_number, message.body, 'submitting'::text;
end;
$$;

create or replace function public.reconcile_appointment_reminder_schedules(target_limit integer default 50)
returns table (appointment_id uuid) language plpgsql security definer set search_path = '' as $$
declare candidate record;
begin
  perform public.require_messaging_service_role();
  if target_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Reminder reconciliation limit is invalid';
  end if;

  for candidate in
    with candidates as (
      select appointment.id
      from public.appointments appointment
      join public.appointment_reminder_settings settings
        on settings.organization_id = appointment.organization_id and settings.location_id = appointment.location_id
      where appointment.status = 'confirmed'
        and appointment.starts_at > now()
        and appointment.starts_at <= now() + interval '30 days'
        and (
          (not settings.sms_enabled and exists (
            select 1 from public.appointment_reminders reminder
            where reminder.appointment_id = appointment.id and reminder.status in ('scheduled', 'processing')
          ))
          or (settings.sms_enabled and settings.reminder_24h_enabled and not exists (
            select 1 from public.appointment_reminders reminder
            where reminder.appointment_id = appointment.id and reminder.reminder_type = 'appointment_24h'
          ))
          or (settings.sms_enabled and settings.reminder_2h_enabled and not exists (
            select 1 from public.appointment_reminders reminder
            where reminder.appointment_id = appointment.id and reminder.reminder_type = 'appointment_2h'
          ))
          -- Only recoverable configuration skips consume the bounded stale-settings work queue.
          -- Provider, delivery, opt-out, and elapsed-window outcomes remain terminal and cannot starve it.
          or exists (
            select 1 from public.appointment_reminders reminder
            where reminder.appointment_id = appointment.id
              and reminder.schedule_version is distinct from settings.schedule_version
              and (
                reminder.status = 'scheduled'
                or (
                  reminder.status = 'skipped'
                  and reminder.last_error_code in (
                    'sms_disabled',
                    'reminder_disabled',
                    'quiet_hours_outside_send_window',
                    'no_trusted_recipient'
                  )
                )
              )
          )
          or (not settings.reminder_24h_enabled and exists (
            select 1 from public.appointment_reminders reminder
            where reminder.appointment_id = appointment.id
              and reminder.reminder_type = 'appointment_24h'
              and reminder.status in ('scheduled', 'processing')
          ))
          or (not settings.reminder_2h_enabled and exists (
            select 1 from public.appointment_reminders reminder
            where reminder.appointment_id = appointment.id
              and reminder.reminder_type = 'appointment_2h'
              and reminder.status in ('scheduled', 'processing')
          ))
        )
      order by appointment.starts_at asc
      for update of appointment skip locked
      limit target_limit
    )
    select id from candidates
  loop
    perform public.refresh_appointment_reminders_internal(candidate.id);
    appointment_id := candidate.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.sync_appointment_reminder_delivery_status() from public, anon, authenticated, service_role;

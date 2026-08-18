-- Phase 9 final consistency: lifecycle writes must retain the prepared provider identity and
-- historical sent reminders must never be rewritten by a later appointment mutation.

alter table public.appointment_change_intents
  add column if not exists original_external_appointment_id text;

update public.appointment_change_intents intent
set original_external_appointment_id = appointment.external_appointment_id
from public.appointments appointment
where appointment.organization_id = intent.organization_id
  and appointment.id = intent.appointment_id
  and intent.original_external_appointment_id is null;

alter table public.appointment_change_intents
  add constraint appointment_change_intents_original_external_appointment_id_check
  check (nullif(btrim(original_external_appointment_id), '') is not null) not valid;

-- A sent reminder is immutable delivery history. Allow one current actionable reminder per type
-- while retaining historical sent/failed/skipped rows for the same appointment and reminder type.
alter table public.appointment_reminders
  drop constraint if exists appointment_reminders_appointment_type_key;

create unique index appointment_reminders_one_actionable_type_key
  on public.appointment_reminders (appointment_id, reminder_type)
  where status in ('scheduled', 'processing', 'delivery_pending');

create or replace function public.refresh_appointment_reminders_internal(target_appointment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; settings_row public.appointment_reminder_settings%rowtype; location_row public.locations%rowtype;
  schedule record; nominal_time timestamptz; reminder_time timestamptz; reopened_count integer;
begin
  select * into appointment_row from public.appointments where id = target_appointment_id for update;
  if appointment_row.id is null then return; end if;
  select * into settings_row from public.appointment_reminder_settings
  where organization_id = appointment_row.organization_id and location_id = appointment_row.location_id;
  if appointment_row.status <> 'confirmed' or appointment_row.starts_at <= now() then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_not_active', claimed_at = null, claimed_by = null, updated_at = now()
    where appointment_id = appointment_row.id and status in ('scheduled', 'processing', 'delivery_pending');
    return;
  end if;
  if settings_row.id is null or not settings_row.sms_enabled or appointment_row.starts_at > now() + interval '30 days' then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'sms_disabled', claimed_at = null, claimed_by = null, updated_at = now()
    where appointment_id = appointment_row.id and status in ('scheduled', 'processing', 'delivery_pending');
    return;
  end if;
  if appointment_row.trusted_sms_recipient_e164 is null then
    update public.appointment_reminders set status = 'skipped', last_error_code = 'no_trusted_recipient', claimed_at = null, claimed_by = null, updated_at = now()
    where appointment_id = appointment_row.id and status in ('scheduled', 'processing', 'delivery_pending');
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
      where appointment_id = appointment_row.id and reminder_type = schedule.reminder_type
        and status in ('scheduled', 'processing', 'delivery_pending');
      continue;
    end if;
    nominal_time := appointment_row.starts_at - schedule.lead_time;
    reminder_time := public.reminder_local_time(nominal_time, location_row.timezone, settings_row.quiet_hours_start, settings_row.quiet_hours_end);
    if not public.is_appointment_reminder_send_time(schedule.reminder_type, reminder_time, appointment_row.starts_at) then
      update public.appointment_reminders set status = 'skipped', last_error_code = 'quiet_hours_outside_send_window', claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = appointment_row.id and reminder_type = schedule.reminder_type
        and status in ('scheduled', 'processing', 'delivery_pending');
      continue;
    end if;

    -- Refresh the current unsent schedule, or reopen a non-materialized policy-recoverable
    -- skip. A sent or materialized reminder stays historical, and a fresh schedule is inserted
    -- instead.
    update public.appointment_reminders set
      scheduled_for = reminder_time,
      trusted_sms_recipient_e164 = coalesce(trusted_sms_recipient_e164, appointment_row.trusted_sms_recipient_e164),
      schedule_version = settings_row.schedule_version,
      status = 'scheduled', revalidation_status = 'pending', claimed_at = null, claimed_by = null,
      last_error_code = null, updated_at = now()
    where id = (
      select reminder.id from public.appointment_reminders reminder
      where reminder.appointment_id = appointment_row.id and reminder.reminder_type = schedule.reminder_type
        and reminder.message_id is null
        and (
          reminder.status = 'scheduled'
          or (
            reminder.status = 'skipped'
            and reminder.last_error_code in ('sms_disabled', 'reminder_disabled', 'quiet_hours_outside_send_window', 'no_trusted_recipient')
          )
        )
      order by reminder.created_at desc limit 1 for update
    );
    get diagnostics reopened_count = row_count;
    if reopened_count = 0 and not exists (
      select 1 from public.appointment_reminders reminder
      where reminder.appointment_id = appointment_row.id and reminder.reminder_type = schedule.reminder_type
        and reminder.status in ('scheduled', 'processing', 'delivery_pending')
    ) then
      insert into public.appointment_reminders (organization_id, location_id, appointment_id, reminder_type, scheduled_for, trusted_sms_recipient_e164, schedule_version)
      values (appointment_row.organization_id, appointment_row.location_id, appointment_row.id, schedule.reminder_type,
        reminder_time, appointment_row.trusted_sms_recipient_e164, settings_row.schedule_version);
    end if;
  end loop;
end;
$$;

-- The visible appointment references issued to a voice model must be authorized by the current
-- exact call, not by any historic call that happened to share the conversation.
drop function if exists public.create_conversation_appointment_management_targets(uuid, uuid);
create function public.create_conversation_appointment_management_targets(
  target_conversation_id uuid,
  target_inbound_message_id uuid,
  target_trusted_caller_e164 text default null
)
returns table (appointment_reference uuid, title text, starts_at timestamptz, ends_at timestamptz, timezone text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; conversation_row public.conversations%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  select * into inbound from public.messages where id = target_inbound_message_id and conversation_id = target_conversation_id
    and direction = 'inbound' and author_type = 'customer';
  select * into conversation_row from public.conversations where id = target_conversation_id;
  if inbound.id is null or conversation_row.id is null then raise exception using errcode = '42501', message = 'Trusted customer context is required'; end if;
  return query with eligible as (
    select appointment.id, appointment.title, appointment.starts_at, appointment.ends_at, location.timezone
    from public.appointments appointment
    join public.locations location on location.organization_id = appointment.organization_id and location.id = appointment.location_id
    left join public.booking_intents booking on booking.organization_id = appointment.organization_id and booking.id = appointment.booking_intent_id
    left join public.channels channel on channel.organization_id = conversation_row.organization_id and channel.id = conversation_row.channel_id
    where appointment.organization_id = conversation_row.organization_id and appointment.location_id = conversation_row.location_id
      and appointment.status = 'confirmed' and appointment.starts_at > now() and appointment.integration_id is not null
      and ((channel.channel_type = 'web' and appointment.conversation_id = conversation_row.id)
        or (channel.channel_type = 'sms' and inbound.transport_sender_e164 is not null and inbound.transport_sender_e164 = coalesce(appointment.trusted_sms_recipient_e164, booking.trusted_transport_phone_e164))
        or (channel.channel_type = 'phone' and target_trusted_caller_e164 is not null
          and target_trusted_caller_e164 = coalesce(appointment.trusted_sms_recipient_e164, booking.trusted_transport_phone_e164)))
  ), saved as (
    insert into public.appointment_management_targets (organization_id, location_id, conversation_id, appointment_id, inbound_message_id, expires_at)
    select conversation_row.organization_id, conversation_row.location_id, conversation_row.id, eligible.id, inbound.id, now() + interval '10 minutes' from eligible
    on conflict (organization_id, conversation_id, appointment_id, inbound_message_id) do update set expires_at = excluded.expires_at, updated_at = now()
    returning id, appointment_id, expires_at
  )
  select saved.id, eligible.title, eligible.starts_at, eligible.ends_at, eligible.timezone, saved.expires_at from saved join eligible on eligible.id = saved.appointment_id;
end;
$$;

drop function if exists public.get_voice_appointment_lifecycle_turn(text, uuid);
create function public.get_voice_appointment_lifecycle_turn(target_call_id text, target_inbound_message_id uuid)
returns table (conversation_id uuid, inbound_message_id uuid, trusted_caller_e164 text)
language sql stable security definer set search_path = '' as $$
  select call.conversation_id, message.id, call.transport_caller_e164
  from public.calls call
  join public.messages message on message.organization_id = call.organization_id and message.location_id = call.location_id
    and message.conversation_id = call.conversation_id and message.id = target_inbound_message_id
  where call.provider = 'openai-realtime-sip' and call.external_call_id = target_call_id
    and call.transport_caller_e164 is not null
    and message.direction = 'inbound' and message.author_type = 'customer' and message.source_channel in ('phone', 'voice');
$$;

-- Fresh writes require the appointment to still be exactly the snapshot the customer/staff
-- confirmed. Recovery deliberately uses the immutable intent identity instead.
create or replace function public.claim_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_change_intent_id uuid, target_tool_call_id text)
returns table (state text, change_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype; inbound public.messages%rowtype; eligible boolean;
begin
  perform public.require_appointment_lifecycle_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) not between 1 and 200 then raise exception using errcode = '22023', message = 'Appointment change tool call is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change:' || target_change_intent_id::text, 0));
  select * into intent from public.appointment_change_intents where id = target_change_intent_id and conversation_id = target_conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Appointment change intent is not available'; end if;
  if intent.status in ('completed','provider_success_pending_persistence','provider_state_unknown','executing','handoff_required') then return query select case when intent.status = 'executing' then 'recovery' else intent.status end, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' or intent.expires_at <= now() then update public.appointment_change_intents set status = 'expired', updated_at = now() where id = intent.id and status = 'awaiting_confirmation'; return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and organization_id = intent.organization_id and location_id = intent.location_id and conversation_id = intent.conversation_id and direction = 'inbound' and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= intent.created_at or not public.is_explicit_appointment_change_confirmation(intent.operation, inbound.body) then return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  select exists(
    select 1 from public.appointments appointment
    join public.integrations integration on integration.organization_id = appointment.organization_id and integration.location_id = appointment.location_id and integration.id = appointment.integration_id
    join public.location_scheduling_settings settings on settings.organization_id = appointment.organization_id and settings.location_id = appointment.location_id and settings.active_integration_id = appointment.integration_id
    join public.booking_intents booking on booking.organization_id = appointment.organization_id and booking.id = intent.booking_intent_id
    join public.booking_candidates original_candidate on original_candidate.organization_id = booking.organization_id and original_candidate.id = booking.candidate_id
    join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = appointment.organization_id and appointment_type.id = original_candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
    join public.scheduling_resources original_resource on original_resource.organization_id = appointment.organization_id and original_resource.id = intent.original_resource_id and original_resource.integration_id = intent.integration_id
    left join public.appointment_change_candidates target_candidate on target_candidate.organization_id = intent.organization_id and target_candidate.id = intent.candidate_id
    left join public.scheduling_resources target_resource on target_resource.organization_id = intent.organization_id and target_resource.id = intent.target_resource_id
    where appointment.id = intent.appointment_id and appointment.status = 'confirmed' and appointment.starts_at > now()
      and appointment.provider = intent.provider and appointment.integration_id = intent.integration_id
      and appointment.external_appointment_id = intent.original_external_appointment_id
      and appointment.starts_at = intent.original_starts_at and appointment.ends_at = intent.original_ends_at
      and coalesce(appointment.scheduling_resource_id, original_candidate.resource_id) = intent.original_resource_id
      and integration.status = 'connected' and appointment_type.active and appointment_type.bookable and original_resource.active and original_resource.bookable
      and (intent.operation = 'cancel' or (((target_candidate.id is not null and target_candidate.status = 'consumed' and target_candidate.expires_at > now()) or (intent.actor_category = 'staff' and target_candidate.id is null and intent.target_starts_at > now() and intent.target_ends_at > intent.target_starts_at)) and target_resource.active and target_resource.bookable and (integration.provider <> 'google_calendar' or target_resource.id = original_resource.id) and (integration.provider = 'ezyvet' or exists (select 1 from public.scheduling_appointment_type_resources mapping where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = target_resource.id))))
  ) into eligible;
  if not eligible then
    update public.appointment_change_intents set status = 'failed', failure_category = 'configuration_changed', updated_at = now() where id = intent.id;
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (intent.organization_id, intent.location_id, 'appointment.' || intent.operation || '.failed', 'appointment_change_intent', intent.id, jsonb_build_object('category', 'configuration_changed'));
    return query select 'configuration_changed'::text, intent.id, null::uuid; return;
  end if;
  update public.appointment_change_intents set status = 'executing', confirmed_message_id = inbound.id, mutation_attempt_count = 1, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound.id;
end;
$$;

create or replace function public.get_appointment_change_execution_context_v2(target_change_intent_id uuid)
returns table (
  change_intent_id uuid, organization_id uuid, location_id uuid, appointment_id uuid, booking_intent_id uuid,
  integration_id uuid, provider text, operation text, external_appointment_id text, provider_mutation_target_id text,
  original_starts_at timestamptz, original_ends_at timestamptz, target_starts_at timestamptz, target_ends_at timestamptz,
  original_resource_uid text, original_resource_name text, target_resource_uid text, target_resource_name text,
  appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, timezone text,
  business_hours jsonb, minimum_lead_minutes integer, candidate_expires_at timestamptz, intent_status text,
  current_write_eligible boolean
) language sql stable security definer set search_path = '' as $$
  select intent.id, intent.organization_id, intent.location_id, intent.appointment_id, intent.booking_intent_id,
    intent.integration_id, intent.provider, intent.operation, intent.original_external_appointment_id, intent.provider_mutation_target_id,
    intent.original_starts_at, intent.original_ends_at, intent.target_starts_at, intent.target_ends_at,
    original_resource.external_uid, original_resource.name, target_resource.external_uid, target_resource.name,
    appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes, location.timezone,
    location.business_hours, settings.minimum_lead_minutes, candidate.expires_at, intent.status,
    coalesce(intent.status = 'executing' and appointment.status = 'confirmed' and appointment.starts_at > now()
      and appointment.provider = intent.provider and appointment.integration_id = intent.integration_id
      and appointment.external_appointment_id = intent.original_external_appointment_id
      and appointment.starts_at = intent.original_starts_at and appointment.ends_at = intent.original_ends_at
      and coalesce(appointment.scheduling_resource_id, booking_candidate.resource_id) = intent.original_resource_id
      and integration.status = 'connected' and settings.active_integration_id = intent.integration_id
      and appointment_type.active and appointment_type.bookable and original_resource.active and original_resource.bookable
      and (intent.operation = 'cancel' or (((candidate.status = 'consumed' and candidate.expires_at > now()) or (intent.actor_category = 'staff' and candidate.id is null and intent.target_starts_at > now() and intent.target_ends_at > intent.target_starts_at)) and target_resource.active and target_resource.bookable and (integration.provider <> 'google_calendar' or target_resource.id = original_resource.id) and (integration.provider = 'ezyvet' or exists (select 1 from public.scheduling_appointment_type_resources mapping where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = target_resource.id)))), false)
  from public.appointment_change_intents intent
  join public.appointments appointment on appointment.organization_id = intent.organization_id and appointment.id = intent.appointment_id
  join public.booking_intents booking on booking.organization_id = intent.organization_id and booking.id = intent.booking_intent_id
  join public.booking_candidates booking_candidate on booking_candidate.organization_id = booking.organization_id and booking_candidate.id = booking.candidate_id
  join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = booking_candidate.appointment_type_id
  join public.integrations integration on integration.organization_id = intent.organization_id and integration.id = intent.integration_id
  join public.scheduling_resources original_resource on original_resource.organization_id = intent.organization_id and original_resource.id = intent.original_resource_id
  left join public.scheduling_resources target_resource on target_resource.organization_id = intent.organization_id and target_resource.id = intent.target_resource_id
  left join public.appointment_change_candidates candidate on candidate.organization_id = intent.organization_id and candidate.id = intent.candidate_id
  join public.locations location on location.organization_id = intent.organization_id and location.id = intent.location_id
  left join public.location_scheduling_settings settings on settings.organization_id = intent.organization_id and settings.location_id = intent.location_id
  where intent.id = target_change_intent_id and intent.status in ('executing','provider_success_pending_persistence','provider_state_unknown');
$$;

create or replace function public.complete_appointment_change_intent(target_change_intent_id uuid) returns table (appointment_id uuid, operation text)
language plpgsql security definer set search_path = '' as $$
declare intent public.appointment_change_intents%rowtype;
begin
  perform public.require_appointment_lifecycle_service_role();
  select * into intent from public.appointment_change_intents where id = target_change_intent_id for update;
  if intent.id is null or intent.status <> 'provider_success_pending_persistence' then raise exception using errcode = '42501', message = 'Appointment change has not recorded provider success'; end if;
  if intent.operation = 'cancel' then
    update public.appointments set status = 'cancelled', provider_status = 'cancelled', updated_at = now() where id = intent.appointment_id;
    update public.message_deliveries delivery set status = 'suppressed', error_code = 'appointment_cancelled', updated_at = now()
      from public.messages message where message.id = delivery.message_id and message.appointment_reminder_id is not null and message.appointment_reminder_id in (select id from public.appointment_reminders where appointment_id = intent.appointment_id) and delivery.status = 'queued';
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_cancelled', claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = intent.appointment_id and status in ('scheduled','processing','delivery_pending');
  else
    update public.message_deliveries delivery set status = 'suppressed', error_code = 'appointment_rescheduled', updated_at = now()
      from public.messages message where message.id = delivery.message_id and message.appointment_reminder_id is not null and message.appointment_reminder_id in (select id from public.appointment_reminders where appointment_id = intent.appointment_id) and delivery.status = 'queued';
    update public.appointment_reminders set status = 'skipped', last_error_code = 'appointment_rescheduled', claimed_at = null, claimed_by = null, updated_at = now()
      where appointment_id = intent.appointment_id and status in ('scheduled','processing','delivery_pending');
    update public.appointments set starts_at = intent.target_starts_at, ends_at = intent.target_ends_at, scheduling_resource_id = intent.target_resource_id, provider_status = 'confirmed', updated_at = now() where id = intent.appointment_id;
    perform public.refresh_appointment_reminders_internal(intent.appointment_id);
  end if;
  update public.appointment_change_intents set status = 'completed', completed_at = now(), updated_at = now() where id = intent.id;
  update public.appointment_change_slot_leases set status = 'released', updated_at = now() where change_intent_id = intent.id and status = 'active';
  update public.scheduling_slot_leases set status = 'released', updated_at = now() where change_intent_id = intent.id and status = 'active';
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (intent.organization_id, intent.location_id, 'appointment.' || intent.operation || '.completed', 'appointment_change_intent', intent.id, jsonb_build_object('provider_state', intent.provider_state));
  return query select intent.appointment_id, intent.operation;
end;
$$;

-- Both customer and staff preparations persist the immutable provider appointment key before any
-- provider call. A blank key is rejected rather than allowing a mutable-row fallback later.
create or replace function public.prepare_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid, target_operation text, target_candidate_id uuid default null)
returns table (change_intent_id uuid, operation text, starts_at timestamptz, timezone text, status text)
language plpgsql security definer set search_path = '' as $$
declare target public.appointment_management_targets%rowtype; appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype; candidate public.appointment_change_candidates%rowtype; existing public.appointment_change_intents%rowtype; resource_id uuid; expiry timestamptz;
begin
  perform public.require_appointment_lifecycle_service_role();
  if target_operation not in ('cancel', 'reschedule') then raise exception using errcode = '22023', message = 'Appointment change operation is invalid'; end if;
  if target_reference_id is null and target_candidate_id is not null then select management.* into target from public.appointment_change_candidates candidate join public.appointment_management_targets management on management.organization_id = candidate.organization_id and management.id = candidate.target_id where candidate.id = target_candidate_id and candidate.conversation_id = target_conversation_id and management.inbound_message_id = target_inbound_message_id and candidate.status = 'offered' and candidate.expires_at > now(); else select * into target from public.appointment_management_targets where id = target_reference_id and conversation_id = target_conversation_id and inbound_message_id = target_inbound_message_id and expires_at > now(); end if;
  if target.id is null then raise exception using errcode = '42501', message = 'Appointment reference is not available'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change-appointment:' || target.appointment_id::text, 0));
  select * into appointment_row from public.appointments where id = target.appointment_id and status = 'confirmed' and starts_at > now();
  select * into booking from public.booking_intents where organization_id = target.organization_id and id = appointment_row.booking_intent_id;
  resource_id := coalesce(appointment_row.scheduling_resource_id, (select resource_id from public.booking_candidates where organization_id = booking.organization_id and id = booking.candidate_id));
  if appointment_row.id is null or booking.id is null or appointment_row.integration_id is null or resource_id is null or nullif(btrim(appointment_row.external_appointment_id), '') is null then raise exception using errcode = '42501', message = 'Appointment cannot be changed safely'; end if;
  if target_operation = 'reschedule' then select * into candidate from public.appointment_change_candidates where id = target_candidate_id and target_id = target.id and status = 'offered' and expires_at > now(); if candidate.id is null then raise exception using errcode = '42501', message = 'Appointment change candidate is not available'; end if; if appointment_row.provider = 'google_calendar' and candidate.resource_id <> resource_id then raise exception using errcode = '42501', message = 'Google Calendar reschedules must retain the original resource'; end if; end if;
  select * into existing from public.appointment_change_intents where appointment_id = appointment_row.id and status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown') order by created_at desc limit 1 for update;
  if existing.id is not null and existing.status <> 'awaiting_confirmation' then return query select existing.id, existing.operation, existing.target_starts_at, coalesce(candidate.timezone, (select timezone from public.locations where id = target.location_id)), existing.status; return; end if;
  if existing.id is not null and existing.operation = target_operation and (target_operation = 'cancel' or existing.candidate_id = candidate.id) then return query select existing.id, existing.operation, existing.target_starts_at, coalesce(candidate.timezone, (select timezone from public.locations where id = target.location_id)), existing.status; return; end if;
  if existing.id is not null then update public.appointment_change_intents set status = 'expired', failure_category = 'superseded', updated_at = now() where id = existing.id; update public.appointment_change_slot_leases set status = 'released', updated_at = now() where change_intent_id = existing.id and status = 'active'; update public.scheduling_slot_leases set status = 'released', updated_at = now() where change_intent_id = existing.id and status = 'active'; end if;
  expiry := least(now() + interval '10 minutes', coalesce(candidate.expires_at, now() + interval '10 minutes'));
  insert into public.appointment_change_intents (organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, prepared_message_id, candidate_id, original_external_appointment_id, original_starts_at, original_ends_at, original_resource_id, target_starts_at, target_ends_at, target_resource_id, expires_at)
  values (target.organization_id, target.location_id, target.conversation_id, appointment_row.id, booking.id, appointment_row.integration_id, appointment_row.provider, target_operation, target_inbound_message_id, candidate.id, appointment_row.external_appointment_id, appointment_row.starts_at, appointment_row.ends_at, resource_id, candidate.starts_at, candidate.ends_at, candidate.resource_id, expiry) returning * into existing;
  if candidate.id is not null then update public.appointment_change_candidates set status = 'consumed', updated_at = now() where id = candidate.id; end if;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (target.organization_id, target.location_id, 'appointment.' || target_operation || '.prepared', 'appointment_change_intent', existing.id, jsonb_build_object('actor', 'customer'));
  return query select existing.id, existing.operation, existing.target_starts_at, coalesce(candidate.timezone, (select timezone from public.locations where id = target.location_id)), existing.status;
end;
$$;

create or replace function public.create_staff_appointment_cancellation_intent(target_user_id uuid, target_location_id uuid, target_appointment_id uuid)
returns table (change_intent_id uuid) language plpgsql security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype; resource_id uuid; saved_id uuid; target_org uuid;
begin
  perform public.require_appointment_lifecycle_service_role(); select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not exists (select 1 from public.organization_members member where member.organization_id = target_org and member.user_id = target_user_id and member.role in ('owner','admin')) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change-appointment:' || target_appointment_id::text, 0));
  if exists (select 1 from public.appointment_change_intents where appointment_id = target_appointment_id and status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown')) then raise exception using errcode = '22023', message = 'An appointment change is already in progress'; end if;
  select * into appointment_row from public.appointments where organization_id = target_org and location_id = target_location_id and id = target_appointment_id and status = 'confirmed' and starts_at > now() and integration_id is not null;
  select * into booking from public.booking_intents where organization_id = target_org and id = appointment_row.booking_intent_id;
  resource_id := coalesce(appointment_row.scheduling_resource_id, (select resource_id from public.booking_candidates where organization_id = target_org and id = booking.candidate_id));
  if appointment_row.id is null or booking.id is null or resource_id is null or nullif(btrim(appointment_row.external_appointment_id), '') is null then raise exception using errcode = '42501', message = 'Appointment cannot be cancelled safely'; end if;
  insert into public.appointment_change_intents (organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, actor_category, original_external_appointment_id, original_starts_at, original_ends_at, original_resource_id, status, mutation_attempt_count, expires_at) values (target_org, target_location_id, appointment_row.conversation_id, appointment_row.id, booking.id, appointment_row.integration_id, appointment_row.provider, 'cancel', 'staff', appointment_row.external_appointment_id, appointment_row.starts_at, appointment_row.ends_at, resource_id, 'executing', 1, now() + interval '10 minutes') returning id into saved_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (target_org, target_location_id, 'appointment.cancel.prepared', 'appointment_change_intent', saved_id, jsonb_build_object('actor', 'staff'));
  return query select saved_id;
end;
$$;

create or replace function public.create_staff_appointment_reschedule_intent(target_user_id uuid, target_location_id uuid, target_appointment_id uuid, target_starts_at timestamptz, target_ends_at timestamptz)
returns table (change_intent_id uuid) language plpgsql security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; booking public.booking_intents%rowtype; resource_id uuid; type_row public.scheduling_appointment_types%rowtype; saved_id uuid; target_org uuid;
begin
  perform public.require_appointment_lifecycle_service_role(); select organization_id into target_org from public.locations where id = target_location_id;
  if target_org is null or not exists (select 1 from public.organization_members member where member.organization_id = target_org and member.user_id = target_user_id and member.role in ('owner','admin')) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  if target_ends_at <= target_starts_at or target_starts_at <= now() then raise exception using errcode = '22023', message = 'Reschedule time is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('appointment-change-appointment:' || target_appointment_id::text, 0));
  if exists (select 1 from public.appointment_change_intents where appointment_id = target_appointment_id and status in ('awaiting_confirmation','executing','provider_success_pending_persistence','provider_state_unknown')) then raise exception using errcode = '22023', message = 'An appointment change is already in progress'; end if;
  select * into appointment_row from public.appointments where organization_id = target_org and location_id = target_location_id and id = target_appointment_id and status = 'confirmed' and starts_at > now() and integration_id is not null;
  select * into booking from public.booking_intents where organization_id = target_org and id = appointment_row.booking_intent_id;
  select appointment_type.* into type_row from public.booking_candidates candidate join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = candidate.organization_id and appointment_type.id = candidate.appointment_type_id where candidate.organization_id = target_org and candidate.id = booking.candidate_id;
  resource_id := coalesce(appointment_row.scheduling_resource_id, (select resource_id from public.booking_candidates where organization_id = target_org and id = booking.candidate_id));
  if appointment_row.id is null or booking.id is null or resource_id is null or type_row.id is null or nullif(btrim(appointment_row.external_appointment_id), '') is null or target_ends_at - target_starts_at <> make_interval(mins => type_row.default_duration_minutes) then raise exception using errcode = '42501', message = 'Appointment cannot be rescheduled safely'; end if;
  insert into public.appointment_change_intents (organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, actor_category, original_external_appointment_id, original_starts_at, original_ends_at, original_resource_id, target_starts_at, target_ends_at, target_resource_id, status, mutation_attempt_count, expires_at) values (target_org, target_location_id, appointment_row.conversation_id, appointment_row.id, booking.id, appointment_row.integration_id, appointment_row.provider, 'reschedule', 'staff', appointment_row.external_appointment_id, appointment_row.starts_at, appointment_row.ends_at, resource_id, target_starts_at, target_ends_at, resource_id, 'executing', 1, now() + interval '10 minutes') returning id into saved_id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details) values (target_org, target_location_id, 'appointment.reschedule.prepared', 'appointment_change_intent', saved_id, jsonb_build_object('actor', 'staff'));
  return query select saved_id;
end;
$$;

revoke all on function public.create_conversation_appointment_management_targets(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_conversation_appointment_management_targets(uuid, uuid, text) to service_role;
revoke all on function public.get_voice_appointment_lifecycle_turn(text, uuid) from public, anon, authenticated;
grant execute on function public.get_voice_appointment_lifecycle_turn(text, uuid) to service_role;

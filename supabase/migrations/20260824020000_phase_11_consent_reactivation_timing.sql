-- Phase 11 final hardening: an SMS START can re-enable only an untouched opted-out
-- follow-up snapshot, and the worker re-evaluates the current safe send-time policy.

create or replace function public.sync_sms_followup_consent_from_preference()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  source_message public.messages%rowtype;
  command text;
  consent public.sms_consents%rowtype;
  prior_status text;
begin
  if new.channel_type <> 'sms' or new.sender_phone_number_id is null or new.source_message_id is null then
    return new;
  end if;

  select * into source_message
  from public.messages
  where organization_id = new.organization_id
    and location_id = new.location_id
    and id = new.source_message_id
    and contact_id = new.contact_id
    and direction = 'inbound'
    and source_channel = 'sms'
    and author_type = 'customer';
  if source_message.id is null or source_message.transport_sender_e164 is null then
    return new;
  end if;

  command := lower(coalesce(source_message.metadata -> 'provider_metadata' ->> 'opt_out_type', ''));
  if command not in ('start', 'stop') then
    command := case lower(regexp_replace(btrim(coalesce(source_message.body, '')), '\\s+', ' ', 'g'))
      when 'start' then 'start'
      when 'unstop' then 'start'
      when 'stop' then 'stop'
      when 'stopall' then 'stop'
      when 'unsubscribe' then 'stop'
      when 'cancel' then 'stop'
      when 'end' then 'stop'
      when 'quit' then 'stop'
      else null
    end;
  end if;

  if command = 'start' and new.status = 'active' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'sms-followup-consent:' || new.organization_id::text || ':' || new.sender_phone_number_id::text || ':' || source_message.transport_sender_e164,
      0
    ));

    select status into prior_status
    from public.sms_consents
    where organization_id = new.organization_id
      and location_id = new.location_id
      and sender_phone_number_id = new.sender_phone_number_id
      and recipient_e164 = source_message.transport_sender_e164
      and purpose = 'lead_followup'
    for update;

    insert into public.sms_consents as current_consent
      (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose, status, source_type, source_message_id, granted_at)
    values (
      new.organization_id,
      new.location_id,
      new.sender_phone_number_id,
      source_message.transport_sender_e164,
      'lead_followup',
      'active',
      'sms_start',
      source_message.id,
      now()
    )
    on conflict (organization_id, location_id, sender_phone_number_id, recipient_e164, purpose) do update set
      status = 'active',
      source_type = case when current_consent.status = 'active' then current_consent.source_type else excluded.source_type end,
      source_message_id = case when current_consent.status = 'active' then current_consent.source_message_id else excluded.source_message_id end,
      source_call_id = case when current_consent.status = 'active' then current_consent.source_call_id else null end,
      granted_at = case when current_consent.status = 'active' then current_consent.granted_at else now() end,
      revoked_at = null,
      updated_at = now()
    returning * into consent;

    if prior_status is distinct from 'active' then
      insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (
        consent.organization_id,
        consent.location_id,
        'sms.consent.granted',
        'sms_consent',
        consent.id,
        jsonb_build_object('channel', 'sms', 'purpose', 'lead_followup')
      );
    end if;
  elsif command = 'stop' and new.status = 'opted_out' then
    update public.sms_consents
    set status = 'revoked', revoked_at = now(), source_message_id = source_message.id, updated_at = now()
    where organization_id = new.organization_id
      and location_id = new.location_id
      and sender_phone_number_id = new.sender_phone_number_id
      and recipient_e164 = source_message.transport_sender_e164
      and purpose = 'lead_followup'
      and status = 'active'
    returning * into consent;

    if consent.id is not null then
      insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (
        consent.organization_id,
        consent.location_id,
        'sms.consent.revoked',
        'sms_consent',
        consent.id,
        jsonb_build_object('channel', 'sms', 'purpose', 'lead_followup')
      );
    end if;

    perform public.suppress_lead_followups_for_route(
      new.organization_id,
      new.location_id,
      new.sender_phone_number_id,
      source_message.transport_sender_e164,
      'opted_out'
    );
  end if;

  return new;
end;
$$;

create or replace function public.lead_followup_eligible(target_lead_id uuid)
returns table (
  consent_id uuid,
  sender_phone_number_id uuid,
  sender_e164 text,
  recipient_e164 text,
  trigger_message_id uuid,
  scheduled_for timestamptz,
  reason text
)
language plpgsql security definer set search_path = '' as $$
declare
  lead_row public.leads%rowtype;
  conversation_row public.conversations%rowtype;
  consent public.sms_consents%rowtype;
  sender_row public.phone_numbers%rowtype;
  location_row public.locations%rowtype;
  candidate_time timestamptz;
begin
  select * into lead_row from public.leads where id = target_lead_id;
  if lead_row.id is null
    or lead_row.location_id is null
    or lead_row.status not in ('new', 'qualified')
    or lead_row.urgency = 'urgent'
    or lead_row.qualification_reason = 'needs_human' then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'lead_ineligible';
    return;
  end if;

  select * into conversation_row
  from public.conversations
  where organization_id = lead_row.organization_id
    and location_id = lead_row.location_id
    and id = lead_row.conversation_id;
  if conversation_row.id is null
    or conversation_row.status <> 'open'
    or conversation_row.ai_mode <> 'ai'
    or exists (
      select 1 from public.handoffs handoff
      where handoff.organization_id = lead_row.organization_id
        and handoff.conversation_id = conversation_row.id
        and handoff.status in ('open', 'acknowledged')
    )
    or exists (
      select 1 from public.appointments appointment
      where appointment.organization_id = lead_row.organization_id
        and appointment.location_id = lead_row.location_id
        and appointment.conversation_id = conversation_row.id
        and appointment.status = 'confirmed'
    )
    or exists (
      select 1 from public.booking_intents booking
      where booking.organization_id = lead_row.organization_id
        and booking.location_id = lead_row.location_id
        and booking.conversation_id = conversation_row.id
        and booking.status in ('awaiting_confirmation', 'booking', 'provider_success_pending_persistence', 'provider_state_unknown')
    )
    or exists (
      select 1 from public.appointment_change_intents change_intent
      where change_intent.organization_id = lead_row.organization_id
        and change_intent.location_id = lead_row.location_id
        and change_intent.conversation_id = conversation_row.id
        and change_intent.status in ('awaiting_confirmation', 'executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'handoff_required')
    ) then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'conversation_ineligible';
    return;
  end if;

  select phone.* into sender_row
  from public.lead_followup_settings settings
  join public.phone_numbers phone
    on phone.organization_id = settings.organization_id
    and phone.location_id = settings.location_id
    and phone.id = settings.sender_phone_number_id
  where settings.organization_id = lead_row.organization_id
    and settings.location_id = lead_row.location_id
    and public.lead_followup_settings_sender_is_current(
      settings.organization_id,
      settings.location_id,
      settings.sender_phone_number_id
    );
  if sender_row.id is null or sender_row.phone_number !~ E'^\\+[1-9][0-9]{7,14}$' then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'settings_disabled';
    return;
  end if;

  select consent_row.* into consent
  from public.sms_consents consent_row
  left join public.messages consent_message
    on consent_message.organization_id = consent_row.organization_id
    and consent_message.location_id = consent_row.location_id
    and consent_message.id = consent_row.source_message_id
  left join public.calls consent_call
    on consent_call.organization_id = consent_row.organization_id
    and consent_call.location_id = consent_row.location_id
    and consent_call.id = consent_row.source_call_id
  where consent_row.organization_id = lead_row.organization_id
    and consent_row.location_id = lead_row.location_id
    and consent_row.sender_phone_number_id = sender_row.id
    and consent_row.purpose = 'lead_followup'
    and consent_row.status = 'active'
    and (consent_message.conversation_id = lead_row.conversation_id or consent_call.conversation_id = lead_row.conversation_id)
  order by consent_row.granted_at desc
  limit 1;
  if consent.id is null then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'consent_unavailable';
    return;
  end if;

  if exists (
    select 1
    from public.messaging_contact_preferences preference
    join public.messages route_message
      on route_message.organization_id = preference.organization_id
      and route_message.location_id = preference.location_id
      and route_message.contact_id = preference.contact_id
      and route_message.transport_sender_e164 = consent.recipient_e164
    where preference.organization_id = lead_row.organization_id
      and preference.location_id = lead_row.location_id
      and preference.sender_phone_number_id = sender_row.id
      and preference.channel_type = 'sms'
      and preference.status = 'opted_out'
  ) then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'opted_out';
    return;
  end if;

  if not exists (
    select 1
    from public.messages trigger_message
    where trigger_message.organization_id = lead_row.organization_id
      and trigger_message.location_id = lead_row.location_id
      and trigger_message.id = lead_row.last_captured_message_id
      and trigger_message.conversation_id = lead_row.conversation_id
      and trigger_message.direction = 'inbound'
      and trigger_message.author_type = 'customer'
  ) then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'trigger_unavailable';
    return;
  end if;

  if exists (
    select 1
    from public.messages message
    join public.messages trigger_message
      on trigger_message.organization_id = lead_row.organization_id
      and trigger_message.location_id = lead_row.location_id
      and trigger_message.id = lead_row.last_captured_message_id
    where message.organization_id = lead_row.organization_id
      and message.location_id = lead_row.location_id
      and message.conversation_id = lead_row.conversation_id
      and message.created_at > trigger_message.created_at
      and message.id is distinct from consent.source_message_id
      and (
        message.author_type = 'human'
        or (
          message.direction = 'inbound'
          and message.author_type = 'customer'
          and (
            message.source_channel <> 'sms'
            or lower(regexp_replace(btrim(coalesce(message.body, '')), '\\s+', ' ', 'g')) not in
              ('start', 'unstop', 'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit')
          )
        )
        or (
          message.direction = 'outbound'
          and message.source_channel = 'sms'
          and message.author_type in ('ai', 'system')
        )
      )
  ) then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'conversation_has_newer_message';
    return;
  end if;

  select * into location_row
  from public.locations
  where organization_id = lead_row.organization_id
    and id = lead_row.location_id;
  candidate_time := public.lead_followup_next_allowed_time(
    now() + make_interval(mins => (
      select delay_minutes
      from public.lead_followup_settings
      where organization_id = lead_row.organization_id
        and location_id = lead_row.location_id
    )),
    location_row.timezone,
    (
      select quiet_hours_start
      from public.lead_followup_settings
      where organization_id = lead_row.organization_id
        and location_id = lead_row.location_id
    ),
    (
      select quiet_hours_end
      from public.lead_followup_settings
      where organization_id = lead_row.organization_id
        and location_id = lead_row.location_id
    ),
    location_row.business_hours,
    (
      select business_hours_only
      from public.lead_followup_settings
      where organization_id = lead_row.organization_id
        and location_id = lead_row.location_id
    )
  );
  if candidate_time is null then
    return query select null::uuid, null::uuid, null::text, null::text, null::uuid, null::timestamptz, 'no_allowed_window';
    return;
  end if;

  return query select
    consent.id,
    sender_row.id,
    sender_row.phone_number,
    consent.recipient_e164,
    lead_row.last_captured_message_id,
    candidate_time,
    null::text;
end;
$$;

create or replace function public.try_materialize_lead_followup(target_lead_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  lead_row public.leads%rowtype;
  existing_job public.lead_followup_jobs%rowtype;
  eligible record;
begin
  select * into lead_row from public.leads where id = target_lead_id for update;
  if lead_row.id is null then
    return;
  end if;

  select * into existing_job
  from public.lead_followup_jobs
  where organization_id = lead_row.organization_id
    and lead_id = lead_row.id
  for update;

  if existing_job.id is not null
    and not (
      existing_job.status = 'skipped'
      and existing_job.skip_reason = 'opted_out'
      and existing_job.message_id is null
      and existing_job.delivery_id is null
    ) then
    return;
  end if;

  select * into eligible from public.lead_followup_eligible(lead_row.id);
  if eligible.reason is not null or eligible.trigger_message_id is null then
    return;
  end if;

  if existing_job.id is not null then
    if existing_job.status = 'skipped'
      and existing_job.skip_reason = 'opted_out'
      and existing_job.message_id is null
      and existing_job.delivery_id is null
      and existing_job.consent_id = eligible.consent_id
      and existing_job.sender_phone_number_id = eligible.sender_phone_number_id
      and existing_job.sender_e164 = eligible.sender_e164
      and existing_job.recipient_e164 = eligible.recipient_e164
      and existing_job.trigger_message_id = eligible.trigger_message_id
      and not exists (
        select 1
        from public.lead_followup_jobs prior_job
        join public.message_deliveries prior_delivery
          on prior_delivery.organization_id = prior_job.organization_id
          and prior_delivery.location_id = prior_job.location_id
          and prior_delivery.id = prior_job.delivery_id
        where prior_job.organization_id = lead_row.organization_id
          and prior_job.location_id = lead_row.location_id
          and prior_job.sender_phone_number_id = eligible.sender_phone_number_id
          and prior_job.recipient_e164 = eligible.recipient_e164
          and prior_delivery.attempted_at is not null
          and prior_delivery.attempted_at > now() - interval '24 hours'
          and prior_delivery.status <> 'suppressed'
      ) then
      update public.lead_followup_jobs
      set status = 'scheduled',
        scheduled_for = eligible.scheduled_for,
        skip_reason = null,
        failure_reason = null,
        claimed_at = null,
        claimed_by = null,
        updated_at = now()
      where id = existing_job.id;
    end if;
    return;
  end if;

  if exists (
    select 1
    from public.lead_followup_jobs existing_job
    join public.message_deliveries delivery
      on delivery.organization_id = existing_job.organization_id
      and delivery.location_id = existing_job.location_id
      and delivery.id = existing_job.delivery_id
    where existing_job.organization_id = lead_row.organization_id
      and existing_job.location_id = lead_row.location_id
      and existing_job.sender_phone_number_id = eligible.sender_phone_number_id
      and existing_job.recipient_e164 = eligible.recipient_e164
      and delivery.attempted_at is not null
      and delivery.attempted_at > now() - interval '24 hours'
      and delivery.status <> 'suppressed'
  ) then
    insert into public.lead_followup_jobs (
      organization_id,
      location_id,
      lead_id,
      conversation_id,
      consent_id,
      sender_phone_number_id,
      sender_e164,
      recipient_e164,
      trigger_message_id,
      status,
      skip_reason
    ) values (
      lead_row.organization_id,
      lead_row.location_id,
      lead_row.id,
      lead_row.conversation_id,
      eligible.consent_id,
      eligible.sender_phone_number_id,
      eligible.sender_e164,
      eligible.recipient_e164,
      eligible.trigger_message_id,
      'skipped',
      'frequency_cap'
    );
  else
    insert into public.lead_followup_jobs (
      organization_id,
      location_id,
      lead_id,
      conversation_id,
      consent_id,
      sender_phone_number_id,
      sender_e164,
      recipient_e164,
      trigger_message_id,
      scheduled_for
    ) values (
      lead_row.organization_id,
      lead_row.location_id,
      lead_row.id,
      lead_row.conversation_id,
      eligible.consent_id,
      eligible.sender_phone_number_id,
      eligible.sender_e164,
      eligible.recipient_e164,
      eligible.trigger_message_id,
      eligible.scheduled_for
    );
  end if;
end;
$$;

create function public.lead_followup_time_is_allowed(
  target_time timestamptz,
  target_timezone text,
  quiet_start time,
  quiet_end time,
  target_business_hours jsonb,
  enforce_business_hours boolean
)
returns boolean language plpgsql stable set search_path = '' as $$
declare
  local_time timestamp without time zone;
  day_hours jsonb;
begin
  local_time := target_time at time zone target_timezone;
  if (quiet_start < quiet_end and local_time::time >= quiet_start and local_time::time < quiet_end)
    or (quiet_start > quiet_end and (local_time::time >= quiet_start or local_time::time < quiet_end)) then
    return false;
  end if;

  if not enforce_business_hours then
    return true;
  end if;

  day_hours := target_business_hours -> lower(to_char(local_time::date, 'FMDay'));
  if coalesce((day_hours ->> 'closed')::boolean, true)
    or day_hours ->> 'open' is null
    or day_hours ->> 'close' is null then
    return false;
  end if;

  return local_time::time >= (day_hours ->> 'open')::time
    and local_time::time < (day_hours ->> 'close')::time;
end;
$$;

create or replace function public.claim_lead_followup_delivery(target_job_id uuid)
returns table (message_id uuid, to_e164 text, from_e164 text, body text)
language plpgsql security definer set search_path = '' as $$
declare
  job public.lead_followup_jobs%rowtype;
  delivery public.message_deliveries%rowtype;
  lead_row public.leads%rowtype;
  conversation_row public.conversations%rowtype;
  consent public.sms_consents%rowtype;
  sender public.phone_numbers%rowtype;
  message_row public.messages%rowtype;
  settings public.lead_followup_settings%rowtype;
  location_row public.locations%rowtype;
  next_allowed_at timestamptz;
begin
  perform public.require_messaging_service_role();
  select * into job from public.lead_followup_jobs where id = target_job_id for update;
  if job.id is null
    or job.status not in ('processing', 'delivery_pending')
    or job.message_id is null
    or job.delivery_id is null then
    return;
  end if;

  select * into delivery from public.message_deliveries where id = job.delivery_id for update;
  select * into lead_row from public.leads where id = job.lead_id;
  select * into conversation_row from public.conversations where id = job.conversation_id;
  select * into consent from public.sms_consents
  where id = job.consent_id
    and status = 'active'
    and recipient_e164 = job.recipient_e164
    and sender_phone_number_id = job.sender_phone_number_id;
  select * into sender from public.phone_numbers
  where id = job.sender_phone_number_id
    and status = 'active'
    and sms_enabled;
  select * into message_row from public.messages where id = job.message_id;
  select * into settings from public.lead_followup_settings
  where organization_id = job.organization_id
    and location_id = job.location_id;
  select * into location_row from public.locations
  where organization_id = job.organization_id
    and id = job.location_id;

  if delivery.id is null
    or delivery.status <> 'queued'
    or not public.lead_followup_settings_sender_is_current(job.organization_id, job.location_id, job.sender_phone_number_id)
    or lead_row.id is null
    or lead_row.status not in ('new', 'qualified')
    or lead_row.urgency = 'urgent'
    or lead_row.qualification_reason = 'needs_human'
    or conversation_row.id is null
    or conversation_row.status <> 'open'
    or conversation_row.ai_mode <> 'ai'
    or consent.id is null
    or sender.id is null
    or sender.phone_number <> job.sender_e164
    or settings.id is null
    or location_row.id is null
    or exists (
      select 1 from public.handoffs handoff
      where handoff.organization_id = job.organization_id
        and handoff.conversation_id = job.conversation_id
        and handoff.status in ('open', 'acknowledged')
    )
    or exists (
      select 1 from public.appointments appointment
      where appointment.organization_id = job.organization_id
        and appointment.location_id = job.location_id
        and appointment.conversation_id = job.conversation_id
        and appointment.status = 'confirmed'
    )
    or exists (
      select 1 from public.booking_intents booking
      where booking.organization_id = job.organization_id
        and booking.location_id = job.location_id
        and booking.conversation_id = job.conversation_id
        and booking.status in ('awaiting_confirmation', 'booking', 'provider_success_pending_persistence', 'provider_state_unknown')
    )
    or exists (
      select 1 from public.appointment_change_intents change_intent
      where change_intent.organization_id = job.organization_id
        and change_intent.location_id = job.location_id
        and change_intent.conversation_id = job.conversation_id
        and change_intent.status in ('awaiting_confirmation', 'executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'handoff_required')
    )
    or exists (
      select 1
      from public.messaging_contact_preferences preference
      join public.messages route_message
        on route_message.organization_id = preference.organization_id
        and route_message.location_id = preference.location_id
        and route_message.contact_id = preference.contact_id
        and route_message.transport_sender_e164 = job.recipient_e164
      where preference.organization_id = job.organization_id
        and preference.location_id = job.location_id
        and preference.sender_phone_number_id = job.sender_phone_number_id
        and preference.channel_type = 'sms'
        and preference.status = 'opted_out'
    )
    or exists (
      select 1
      from public.messages message
      where message.organization_id = job.organization_id
        and message.location_id = job.location_id
        and message.conversation_id = job.conversation_id
        and message.created_at > message_row.created_at
        and (
          message.author_type in ('customer', 'human')
          or (
            message.id <> job.message_id
            and message.direction = 'outbound'
            and message.source_channel = 'sms'
            and message.author_type in ('ai', 'system')
          )
        )
    ) then
    perform public.suppress_lead_followup_job(job.id, 'lead_followup_ineligible');
    return;
  end if;

  if not public.lead_followup_time_is_allowed(
    now(),
    location_row.timezone,
    settings.quiet_hours_start,
    settings.quiet_hours_end,
    location_row.business_hours,
    settings.business_hours_only
  ) then
    next_allowed_at := public.lead_followup_next_allowed_time(
      greatest(now(), coalesce(job.scheduled_for, now())),
      location_row.timezone,
      settings.quiet_hours_start,
      settings.quiet_hours_end,
      location_row.business_hours,
      settings.business_hours_only
    );
    if next_allowed_at is null then
      perform public.suppress_lead_followup_job(job.id, 'no_allowed_window');
    else
      update public.lead_followup_jobs
      set status = 'scheduled',
        scheduled_for = next_allowed_at,
        claimed_at = null,
        claimed_by = null,
        updated_at = now()
      where id = job.id;
    end if;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'lead-followup-frequency:' || job.organization_id::text || ':' || job.location_id::text || ':' || job.sender_phone_number_id::text || ':' || job.recipient_e164,
    0
  ));
  if exists (
    select 1
    from public.lead_followup_jobs existing_job
    join public.message_deliveries existing_delivery
      on existing_delivery.organization_id = existing_job.organization_id
      and existing_delivery.location_id = existing_job.location_id
      and existing_delivery.id = existing_job.delivery_id
    where existing_job.organization_id = job.organization_id
      and existing_job.location_id = job.location_id
      and existing_job.sender_phone_number_id = job.sender_phone_number_id
      and existing_job.recipient_e164 = job.recipient_e164
      and existing_job.id <> job.id
      and existing_delivery.attempted_at is not null
      and existing_delivery.attempted_at > now() - interval '24 hours'
      and existing_delivery.status <> 'suppressed'
  ) then
    perform public.suppress_lead_followup_job(job.id, 'frequency_cap');
    return;
  end if;

  update public.message_deliveries
  set status = 'submitting', attempted_at = now(), updated_at = now()
  where id = delivery.id
    and status = 'queued';
  if not found then
    return;
  end if;

  return query select message_row.id, job.recipient_e164, job.sender_e164, message_row.body;
end;
$$;

revoke all on function
  public.sync_sms_followup_consent_from_preference(),
  public.lead_followup_eligible(uuid),
  public.try_materialize_lead_followup(uuid),
  public.lead_followup_time_is_allowed(timestamptz, text, time, time, jsonb, boolean),
  public.claim_lead_followup_delivery(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.claim_lead_followup_delivery(uuid) to service_role;

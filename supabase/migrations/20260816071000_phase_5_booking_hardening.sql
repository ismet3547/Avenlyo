-- Phase 5 contract and recovery hardening. A provider write is never retried once its outcome is uncertain.

alter table public.booking_intents
  drop constraint booking_intents_status_check,
  add constraint booking_intents_status_check check (
    status in (
      'awaiting_confirmation', 'booking', 'provider_success_pending_persistence',
      'completed', 'failed', 'provider_state_unknown', 'expired'
    )
  );

create or replace function public.store_ezyvet_connection(
  target_organization_id uuid,
  target_location_id uuid,
  target_client_id text,
  target_client_secret text,
  target_environment text,
  target_site_uid text,
  target_provider_site_id text,
  target_provider_timezone text
)
returns table (integration_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_integration_id uuid;
  existing_secret_id uuid;
  previous_version integer;
  secret_payload text;
begin
  perform public.require_ezyvet_service_role();
  if target_environment not in ('production', 'trial')
    or length(btrim(coalesce(target_client_id, ''))) = 0
    or length(btrim(coalesce(target_client_secret, ''))) = 0
    or length(btrim(coalesce(target_site_uid, ''))) = 0
    or length(btrim(coalesce(target_provider_site_id, ''))) = 0
    or length(btrim(coalesce(target_provider_timezone, ''))) = 0 then
    raise exception using errcode = '22023', message = 'ezyVet connection details are invalid';
  end if;
  if not exists (
    select 1 from public.organizations as organization
    join public.locations as location on location.organization_id = organization.id
    where organization.id = target_organization_id
      and organization.primary_industry_id = 'veterinary'
      and location.id = target_location_id
  ) then
    raise exception using errcode = '23503', message = 'Veterinary location is not available';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ezyvet:' || target_location_id::text, 0)
  );
  insert into public.integrations (
    organization_id, location_id, provider, status, environment, site_uid, site_timezone,
    configuration, last_verified_at, last_error_category
  ) values (
    target_organization_id, target_location_id, 'ezyvet', 'connected', target_environment,
    target_site_uid, target_provider_timezone,
    jsonb_build_object('provider_site_id', target_provider_site_id), now(), null
  ) on conflict (organization_id, location_id, provider) do update
  set status = 'connected', environment = excluded.environment, site_uid = excluded.site_uid,
      site_timezone = excluded.site_timezone, configuration = excluded.configuration,
      last_verified_at = now(), last_error_category = null, updated_at = now()
  returning id into saved_integration_id;

  select vault_secret_id, credential_version
  into existing_secret_id, previous_version
  from public.integration_credentials
  where organization_id = target_organization_id and integration_id = saved_integration_id;
  secret_payload := jsonb_build_object(
    'client_id', target_client_id,
    'client_secret', target_client_secret,
    'environment', target_environment,
    'site_uid', target_site_uid
  )::text;
  if existing_secret_id is null then
    select vault.create_secret(
      secret_payload,
      'avenlyo-ezyvet-' || saved_integration_id::text,
      'Avenlyo ezyVet credential'
    ) into existing_secret_id;
    insert into public.integration_credentials (
      organization_id, location_id, integration_id, vault_secret_id, credential_version
    ) values (
      target_organization_id, target_location_id, saved_integration_id, existing_secret_id, 1
    );
  else
    perform vault.update_secret(
      existing_secret_id,
      secret_payload,
      'avenlyo-ezyvet-' || saved_integration_id::text,
      'Avenlyo ezyVet credential'
    );
    update public.integration_credentials
    set location_id = target_location_id, credential_version = previous_version + 1, updated_at = now()
    where organization_id = target_organization_id and integration_id = saved_integration_id;
  end if;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (target_organization_id, target_location_id, 'integration.ezyvet.connected', 'integration',
    saved_integration_id, jsonb_build_object('environment', target_environment));
  return query select saved_integration_id;
end;
$$;

create or replace function public.claim_voice_booking_intent(
  target_call_id text,
  target_booking_intent_id uuid,
  target_tool_call_id text
)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare context record;
declare intent public.booking_intents%rowtype;
declare candidate public.booking_candidates%rowtype;
declare inbound_message_id uuid;
begin
  perform public.require_ezyvet_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) = 0 or length(target_tool_call_id) > 200 then
    raise exception using errcode = '22023', message = 'Booking tool call is invalid';
  end if;
  select * into context from public.get_voice_ezyvet_scheduling_context(target_call_id);
  if context.integration_id is null then
    raise exception using errcode = '42501', message = 'Bookable ezyVet integration is not available';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)
  );
  select * into intent from public.booking_intents
  where organization_id = context.organization_id and location_id = context.location_id
    and conversation_id = context.conversation_id and integration_id = context.integration_id
    and id = target_booking_intent_id;
  if intent.id is null then
    raise exception using errcode = '42501', message = 'Booking intent is not available for this conversation';
  end if;
  if intent.status = 'completed' then
    return query select 'completed'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status = 'provider_success_pending_persistence' then
    return query select 'provider_success_pending_persistence'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status = 'booking' then
    return query select 'booking_recovery'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status = 'provider_state_unknown' then
    return query select 'provider_state_unknown'::text, intent.id, intent.confirmed_message_id;
    return;
  end if;
  if intent.status <> 'awaiting_confirmation' then
    return query select intent.status, intent.id, intent.confirmed_message_id;
    return;
  end if;
  select * into candidate from public.booking_candidates
  where organization_id = intent.organization_id and id = intent.candidate_id;
  if candidate.expires_at <= now() then
    update public.booking_intents set status = 'expired', updated_at = now() where id = intent.id;
    return query select 'expired'::text, intent.id, null::uuid;
    return;
  end if;
  select message.id into inbound_message_id from public.messages as message
  where message.organization_id = intent.organization_id and message.conversation_id = intent.conversation_id
    and message.direction = 'inbound' and message.created_at > intent.created_at
  order by message.created_at desc limit 1;
  if inbound_message_id is null then
    return query select 'confirmation_required'::text, intent.id, null::uuid;
    return;
  end if;
  update public.booking_intents set status = 'booking', booking_tool_call_id = target_tool_call_id,
    confirmed_message_id = inbound_message_id, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound_message_id;
end;
$$;

create or replace function public.record_voice_booking_provider_success(
  target_booking_intent_id uuid,
  target_external_appointment_id text,
  target_provider_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare intent public.booking_intents%rowtype;
begin
  perform public.require_ezyvet_service_role();
  if length(btrim(coalesce(target_external_appointment_id, ''))) = 0
    or length(target_external_appointment_id) > 200
    or target_provider_status not in ('unconfirmed', 'confirmed') then
    raise exception using errcode = '22023', message = 'Provider booking result is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)
  );
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then
    raise exception using errcode = '42501', message = 'Booking intent is not available';
  end if;
  if intent.status = 'provider_success_pending_persistence' then
    if intent.provider_appointment_id <> btrim(target_external_appointment_id) then
      raise exception using errcode = '22023', message = 'Provider booking result conflicts with the claimed intent';
    end if;
    return;
  end if;
  if intent.status <> 'booking' then
    raise exception using errcode = '22023', message = 'Booking intent is not claimed';
  end if;
  update public.booking_intents
  set status = 'provider_success_pending_persistence', provider_appointment_id = btrim(target_external_appointment_id),
      failure_category = null, updated_at = now()
  where id = intent.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (intent.organization_id, intent.location_id, 'booking.provider_success_recorded', 'booking_intent',
    intent.id, jsonb_build_object('provider', 'ezyvet', 'provider_status', target_provider_status));
end;
$$;

create or replace function public.get_voice_booking_execution_context(target_booking_intent_id uuid)
returns table (
  booking_intent_id uuid, organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid,
  integration_id uuid, external_contact_uid text, external_subject_uid text, subject_name text,
  appointment_type_uid text, appointment_type_name text, default_duration_minutes integer,
  resource_uid text, resource_name text, starts_at timestamptz, ends_at timestamptz, timezone text,
  provider_appointment_id text, intent_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_ezyvet_service_role();
  return query
  select intent.id, intent.organization_id, intent.location_id, intent.conversation_id, call.contact_id,
    intent.integration_id, intent.external_contact_uid, intent.external_subject_uid, intent.subject_name,
    appointment_type.external_uid, appointment_type.name, appointment_type.default_duration_minutes,
    resource.external_uid, resource.name, candidate.starts_at, candidate.ends_at, candidate.timezone,
    intent.provider_appointment_id, intent.status
  from public.booking_intents as intent
  join public.booking_candidates as candidate on candidate.organization_id = intent.organization_id and candidate.id = intent.candidate_id
  join public.scheduling_appointment_types as appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id
  join public.scheduling_resources as resource on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id
  left join public.calls as call on call.organization_id = intent.organization_id and call.conversation_id = intent.conversation_id and call.provider = 'openai-realtime-sip'
  where intent.id = target_booking_intent_id
    and intent.status in ('booking', 'provider_success_pending_persistence')
    and (
      intent.status = 'provider_success_pending_persistence'
      or (appointment_type.active and appointment_type.bookable and resource.active and resource.bookable)
    );
end;
$$;

create or replace function public.complete_voice_booking_intent(
  target_booking_intent_id uuid,
  target_external_appointment_id text,
  target_provider_status text
)
returns table (appointment_id uuid, is_existing boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare intent public.booking_intents%rowtype;
declare candidate public.booking_candidates%rowtype;
declare appointment_type public.scheduling_appointment_types%rowtype;
declare inserted_appointment_id uuid;
begin
  perform public.require_ezyvet_service_role();
  if length(btrim(coalesce(target_external_appointment_id, ''))) = 0
    or length(target_external_appointment_id) > 200
    or target_provider_status not in ('unconfirmed', 'confirmed') then
    raise exception using errcode = '22023', message = 'Provider booking result is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)
  );
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  select id into inserted_appointment_id from public.appointments
  where organization_id = intent.organization_id and booking_intent_id = intent.id;
  if inserted_appointment_id is not null then
    return query select inserted_appointment_id, true;
    return;
  end if;
  if intent.status <> 'provider_success_pending_persistence'
    or intent.provider_appointment_id <> btrim(target_external_appointment_id) then
    raise exception using errcode = '22023', message = 'Provider booking result has not been recorded';
  end if;
  select * into candidate from public.booking_candidates where organization_id = intent.organization_id and id = intent.candidate_id;
  select * into appointment_type from public.scheduling_appointment_types where organization_id = intent.organization_id and id = candidate.appointment_type_id;
  insert into public.appointments (
    organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at,
    provider, external_appointment_id, integration_id, booking_intent_id, appointment_type,
    provider_status, external_contact_uid, external_subject_uid, metadata
  ) values (
    intent.organization_id, intent.location_id,
    (select call.contact_id from public.calls as call where call.organization_id = intent.organization_id and call.conversation_id = intent.conversation_id and call.provider = 'openai-realtime-sip' limit 1),
    intent.conversation_id, appointment_type.name || ' — ' || intent.subject_name,
    'requested', candidate.starts_at, candidate.ends_at, 'ezyvet', intent.provider_appointment_id,
    intent.integration_id, intent.id, appointment_type.name, target_provider_status,
    intent.external_contact_uid, intent.external_subject_uid,
    jsonb_build_object('source', 'inbound_voice', 'subject_name', intent.subject_name)
  ) returning id into inserted_appointment_id;
  update public.booking_intents set status = 'completed', completed_at = now(), failure_category = null, updated_at = now()
  where id = intent.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (intent.organization_id, intent.location_id, 'booking.confirmed', 'appointment', inserted_appointment_id,
    jsonb_build_object('provider', 'ezyvet'));
  return query select inserted_appointment_id, false;
end;
$$;

create or replace function public.fail_voice_booking_intent(
  target_booking_intent_id uuid,
  target_status text,
  target_error_category text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare intent public.booking_intents%rowtype;
begin
  perform public.require_ezyvet_service_role();
  if target_status not in ('awaiting_confirmation', 'failed', 'provider_state_unknown') then
    raise exception using errcode = '22023', message = 'Booking outcome is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0)
  );
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown') then return; end if;
  if intent.status <> 'booking' then
    raise exception using errcode = '22023', message = 'Booking intent cannot transition to this outcome';
  end if;
  update public.booking_intents set status = target_status,
    failure_category = nullif(btrim(coalesce(target_error_category, '')), ''), updated_at = now()
  where id = intent.id;
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (intent.organization_id, intent.location_id,
    case when target_status = 'provider_state_unknown' then 'booking.provider_unknown' else 'booking.failed' end,
    'booking_intent', intent.id, jsonb_build_object('category', nullif(btrim(coalesce(target_error_category, '')), '')));
end;
$$;

revoke all on function public.record_voice_booking_provider_success(uuid, text, text) from public;
grant execute on function public.record_voice_booking_provider_success(uuid, text, text) to service_role;

-- Phase 6 reliability hardening: first writes obey the current booking policy, while
-- provider-success and recovery paths remain anchored to the immutable intent identity.

alter table public.booking_intents
  add column if not exists provider_booking_status text;

alter table public.booking_intents
  drop constraint if exists booking_intents_provider_booking_status_check,
  add constraint booking_intents_provider_booking_status_check
    check (provider_booking_status is null or provider_booking_status in ('unconfirmed', 'confirmed'));

-- A disconnected Google integration must still be readable by the trusted backend for a
-- pre-existing booking recovery. Client access to this credential RPC remains prohibited.
create or replace function public.get_google_calendar_execution_credentials(target_integration_id uuid)
returns table (organization_id uuid, location_id uuid, refresh_token text, credential_version integer)
language plpgsql security definer set search_path = '' as $$
declare decrypted text;
begin
  perform public.require_scheduling_service_role();
  select secret.decrypted_secret into decrypted from public.integration_credentials as credential
  join vault.decrypted_secrets as secret on secret.id = credential.vault_secret_id where credential.integration_id = target_integration_id;
  if decrypted is null then raise exception using errcode = '42501', message = 'Google Calendar credentials are not available'; end if;
  return query select integration.organization_id, integration.location_id, (decrypted::jsonb ->> 'refresh_token'), credential.credential_version
  from public.integration_credentials as credential join public.integrations as integration
    on integration.organization_id = credential.organization_id and integration.id = credential.integration_id
  where credential.integration_id = target_integration_id and integration.provider = 'google_calendar';
end; $$;

-- Recovery and terminal replay identify the call by its immutable conversation scope. Only a
-- new provider write is coupled to the presently-active provider and catalog policy.
create or replace function public.claim_voice_scheduling_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare call_context record; intent public.booking_intents%rowtype; candidate public.booking_candidates%rowtype; inbound_message_id uuid; write_eligible boolean;
begin
  perform public.require_scheduling_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) = 0 or length(target_tool_call_id) > 200 then
    raise exception using errcode = '22023', message = 'Booking tool call is invalid';
  end if;
  select call.organization_id, call.location_id, call.conversation_id into call_context
  from public.calls as call
  where call.provider = 'openai-realtime-sip' and call.external_call_id = target_call_id;
  if call_context.organization_id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents
  where id = target_booking_intent_id and organization_id = call_context.organization_id
    and location_id = call_context.location_id and conversation_id = call_context.conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status = 'completed' then return query select 'completed'::text, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status = 'provider_success_pending_persistence' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status = 'provider_state_unknown' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status = 'booking' then return query select 'booking_recovery'::text, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  select * into candidate from public.booking_candidates where id = intent.candidate_id and organization_id = intent.organization_id and integration_id = intent.integration_id;
  if candidate.id is null or candidate.expires_at <= now() then
    update public.booking_intents set status = 'expired', updated_at = now() where id = intent.id;
    return query select 'expired'::text, intent.id, null::uuid;
    return;
  end if;
  select exists(
    select 1 from public.location_scheduling_settings as settings
    join public.integrations as integration on integration.organization_id = settings.organization_id
      and integration.location_id = settings.location_id and integration.id = settings.active_integration_id
    join public.scheduling_appointment_types as appointment_type on appointment_type.organization_id = intent.organization_id
      and appointment_type.id = candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
    join public.scheduling_resources as resource on resource.organization_id = intent.organization_id
      and resource.id = candidate.resource_id and resource.integration_id = intent.integration_id
    where settings.organization_id = intent.organization_id and settings.location_id = intent.location_id
      and settings.active_integration_id = intent.integration_id and integration.id = intent.integration_id
      and integration.status = 'connected' and appointment_type.active and appointment_type.bookable
      and resource.active and resource.bookable
      and (integration.provider = 'ezyvet' or exists (
        select 1 from public.scheduling_appointment_type_resources as mapping
        where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id
          and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id
          and mapping.resource_id = resource.id
      ))
  ) into write_eligible;
  if not write_eligible then
    update public.booking_intents set failure_category = 'configuration_changed', updated_at = now() where id = intent.id;
    return query select 'configuration_changed'::text, intent.id, null::uuid;
    return;
  end if;
  select id into inbound_message_id from public.messages where organization_id = intent.organization_id
    and conversation_id = intent.conversation_id and direction = 'inbound' and created_at > intent.created_at
    order by created_at desc limit 1;
  if inbound_message_id is null then return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  update public.booking_intents set status = 'booking', booking_tool_call_id = target_tool_call_id,
    confirmed_message_id = inbound_message_id, failure_category = null, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound_message_id;
end; $$;

-- Keep the existing exclusion constraint, and validate policy once more as the execution lease
-- is acquired immediately before final FreeBusy verification and the first provider write.
create or replace function public.claim_booking_slot_lease(target_booking_intent_id uuid)
returns table (lease_id uuid) language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; candidate public.booking_candidates%rowtype; saved_id uuid;
begin
  perform public.require_scheduling_service_role();
  update public.booking_slot_leases set status = 'expired', updated_at = now() where status = 'active' and expires_at <= now();
  select * into intent from public.booking_intents where id = target_booking_intent_id and status = 'booking';
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not claimed'; end if;
  select * into candidate from public.booking_candidates where id = intent.candidate_id and organization_id = intent.organization_id and integration_id = intent.integration_id;
  if candidate.id is null or not exists (
    select 1 from public.location_scheduling_settings as settings
    join public.integrations as integration on integration.organization_id = settings.organization_id
      and integration.location_id = settings.location_id and integration.id = settings.active_integration_id
    join public.scheduling_appointment_types as appointment_type on appointment_type.organization_id = intent.organization_id
      and appointment_type.id = candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
    join public.scheduling_resources as resource on resource.organization_id = intent.organization_id
      and resource.id = candidate.resource_id and resource.integration_id = intent.integration_id
    where settings.organization_id = intent.organization_id and settings.location_id = intent.location_id
      and settings.active_integration_id = intent.integration_id and integration.id = intent.integration_id
      and integration.status = 'connected' and appointment_type.active and appointment_type.bookable
      and resource.active and resource.bookable
      and (integration.provider = 'ezyvet' or exists (
        select 1 from public.scheduling_appointment_type_resources as mapping
        where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id
          and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id
          and mapping.resource_id = resource.id
      ))
  ) then
    perform public.release_booking_slot_lease(intent.id);
    raise exception using errcode = '22023', message = 'Booking configuration changed';
  end if;
  insert into public.booking_slot_leases (organization_id, location_id, integration_id, resource_id, booking_intent_id, starts_at, ends_at, expires_at)
  values (intent.organization_id, intent.location_id, intent.integration_id, candidate.resource_id, intent.id, candidate.starts_at, candidate.ends_at, now() + interval '2 minutes')
  on conflict (organization_id, booking_intent_id) do update set expires_at = excluded.expires_at, status = 'active', updated_at = now() returning id into saved_id;
  return query select saved_id;
exception when exclusion_violation then raise exception using errcode = '23P01', message = 'Booking slot is no longer available';
end; $$;

create or replace function public.record_voice_booking_provider_success(target_booking_intent_id uuid, target_external_appointment_id text, target_provider_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role();
  if length(btrim(coalesce(target_external_appointment_id, ''))) = 0 or length(target_external_appointment_id) > 200
    or target_provider_status not in ('unconfirmed', 'confirmed') then
    raise exception using errcode = '22023', message = 'Provider booking result is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status = 'provider_success_pending_persistence' then
    if intent.provider_appointment_id is distinct from btrim(target_external_appointment_id)
      or intent.provider_booking_status is distinct from target_provider_status then
      raise exception using errcode = '22023', message = 'Provider booking result conflicts with the claimed intent';
    end if;
    return;
  end if;
  if intent.status <> 'booking' then raise exception using errcode = '22023', message = 'Booking intent is not claimed'; end if;
  update public.booking_intents set status = 'provider_success_pending_persistence', provider_appointment_id = btrim(target_external_appointment_id),
    provider_booking_status = target_provider_status, failure_category = null, updated_at = now() where id = intent.id;
end; $$;

drop function public.get_voice_booking_execution_context(uuid);
create function public.get_voice_booking_execution_context(target_booking_intent_id uuid)
returns table (booking_intent_id uuid, organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, integration_id uuid, provider text, external_contact_uid text, external_subject_uid text, subject_name text, trusted_phone_e164 text, customer_display_name text, appointment_type_uid text, appointment_type_name text, default_duration_minutes integer, resource_uid text, resource_name text, starts_at timestamptz, ends_at timestamptz, timezone text, business_hours jsonb, minimum_lead_minutes integer, provider_appointment_id text, provider_booking_status text, intent_status text, current_write_eligible boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select intent.id, intent.organization_id, intent.location_id, intent.conversation_id, intent.contact_id,
    intent.integration_id, integration.provider, intent.external_contact_uid, intent.external_subject_uid, intent.subject_name,
    contact.phone, nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), appointment_type.external_uid,
    appointment_type.name, appointment_type.default_duration_minutes, resource.external_uid, resource.name, candidate.starts_at,
    candidate.ends_at, candidate.timezone, location.business_hours, coalesce(settings.minimum_lead_minutes, 60),
    intent.provider_appointment_id, intent.provider_booking_status, intent.status,
    coalesce((intent.status = 'booking' and integration.status = 'connected' and settings.active_integration_id = intent.integration_id
      and appointment_type.active and appointment_type.bookable and resource.active and resource.bookable
      and (integration.provider = 'ezyvet' or exists (
        select 1 from public.scheduling_appointment_type_resources as mapping
        where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id
          and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id
          and mapping.resource_id = resource.id
      ))), false)
  from public.booking_intents as intent
  join public.booking_candidates as candidate on candidate.organization_id = intent.organization_id and candidate.id = intent.candidate_id and candidate.integration_id = intent.integration_id
  join public.integrations as integration on integration.organization_id = intent.organization_id and integration.id = intent.integration_id
  join public.locations as location on location.organization_id = intent.organization_id and location.id = intent.location_id
  left join public.location_scheduling_settings as settings on settings.organization_id = intent.organization_id and settings.location_id = intent.location_id
  join public.scheduling_appointment_types as appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
  join public.scheduling_resources as resource on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id and resource.integration_id = intent.integration_id
  left join public.contacts as contact on contact.organization_id = intent.organization_id and contact.id = intent.contact_id
  where intent.id = target_booking_intent_id and intent.status in ('booking', 'provider_success_pending_persistence');
end; $$;

drop function public.complete_voice_booking_intent(uuid, text, text);
create function public.complete_voice_booking_intent(target_booking_intent_id uuid)
returns table (appointment_id uuid, is_existing boolean) language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; candidate public.booking_candidates%rowtype; appointment_type public.scheduling_appointment_types%rowtype; integration public.integrations%rowtype; saved_id uuid;
begin
  perform public.require_scheduling_service_role();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  select id into saved_id from public.appointments where organization_id = intent.organization_id and booking_intent_id = intent.id;
  if saved_id is not null then return query select saved_id, true; return; end if;
  if intent.status <> 'provider_success_pending_persistence' or length(btrim(coalesce(intent.provider_appointment_id, ''))) = 0
    or intent.provider_booking_status not in ('unconfirmed', 'confirmed') then
    raise exception using errcode = '22023', message = 'Provider booking result has not been recorded';
  end if;
  select * into candidate from public.booking_candidates where organization_id = intent.organization_id and id = intent.candidate_id;
  select * into appointment_type from public.scheduling_appointment_types where organization_id = intent.organization_id and id = candidate.appointment_type_id;
  select * into integration from public.integrations where organization_id = intent.organization_id and id = intent.integration_id;
  insert into public.appointments (organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at, provider, external_appointment_id, integration_id, booking_intent_id, appointment_type, provider_status, external_contact_uid, external_subject_uid, metadata)
  values (intent.organization_id, intent.location_id, intent.contact_id, intent.conversation_id,
    appointment_type.name || coalesce(' â€” ' || intent.subject_name, ''), 'requested', candidate.starts_at, candidate.ends_at,
    integration.provider, intent.provider_appointment_id, intent.integration_id, intent.id, appointment_type.name,
    intent.provider_booking_status, intent.external_contact_uid, intent.external_subject_uid,
    jsonb_build_object('source', 'inbound_voice', 'subject_name', intent.subject_name)) returning id into saved_id;
  update public.booking_intents set status = 'completed', completed_at = now(), failure_category = null, updated_at = now() where id = intent.id;
  perform public.release_booking_slot_lease(intent.id);
  return query select saved_id, false;
end; $$;

create or replace function public.fail_voice_booking_intent(target_booking_intent_id uuid, target_status text, target_error_category text)
returns void language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role();
  if target_status not in ('awaiting_confirmation', 'failed', 'provider_state_unknown') then raise exception using errcode = '22023', message = 'Booking outcome is invalid'; end if;
  select * into intent from public.booking_intents where id = target_booking_intent_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status in ('completed', 'provider_success_pending_persistence') then return; end if;
  if intent.status = 'provider_state_unknown' then perform public.release_booking_slot_lease(intent.id); return; end if;
  if intent.status <> 'booking' then raise exception using errcode = '22023', message = 'Booking intent cannot transition to this outcome'; end if;
  update public.booking_intents set status = target_status, failure_category = nullif(btrim(coalesce(target_error_category, '')), ''), updated_at = now() where id = intent.id;
  perform public.release_booking_slot_lease(intent.id);
end; $$;

revoke all on function public.get_voice_booking_execution_context(uuid), public.complete_voice_booking_intent(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_voice_booking_execution_context(uuid), public.complete_voice_booking_intent(uuid) to service_role;

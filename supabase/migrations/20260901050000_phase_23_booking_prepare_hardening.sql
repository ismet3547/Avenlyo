-- Phase 23: make the internal booking prepare validator return the durable action-intent truth.
--
-- The Phase 7 implementation inserted a booking_intents row with `returning id into existing.id`.
-- That preserved the opaque ID but left every other field of the row variable null, including
-- `existing.status`, so a successful first prepare returned a null status even though the durable
-- row was correctly created as awaiting_confirmation. Phase 23 treats the durable action-intent
-- snapshot as authority, so the internal validator must return the complete persisted row.
--
-- This replacement preserves all existing validation, transport-identity, candidate-consumption,
-- and idempotent replay behavior. The only semantic correction is that a newly inserted action
-- intent is read back as the row PostgreSQL actually persisted.

create or replace function public.prepare_conversation_scheduling_booking_intent_base(
  target_conversation_id uuid,
  target_candidate_id uuid,
  resolved_contact_uid text,
  resolved_subject_uid text,
  resolved_subject_name text,
  trusted_contact_id uuid,
  target_inbound_message_id uuid
)
returns table (
  booking_intent_id uuid,
  appointment_type_name text,
  starts_at timestamptz,
  timezone text,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  context record;
  candidate public.booking_candidates%rowtype;
  existing public.booking_intents%rowtype;
begin
  perform public.require_scheduling_service_role();

  select * into context
  from public.get_conversation_scheduling_context(
    target_conversation_id,
    target_inbound_message_id
  );

  if context.integration_id is null then
    raise exception using errcode = '42501', message = 'Bookable scheduling integration is not available';
  end if;

  if context.provider = 'ezyvet' and (
    context.trusted_transport_phone_e164 is null
    or length(btrim(coalesce(resolved_contact_uid, ''))) = 0
    or length(btrim(coalesce(resolved_subject_uid, ''))) = 0
    or length(btrim(coalesce(resolved_subject_name, ''))) not between 1 and 80
  ) then
    raise exception using errcode = '22023', message = 'Resolved ezyVet booking identity is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('booking-candidate:' || target_candidate_id::text, 0)
  );

  select booking_candidate.* into candidate
  from public.booking_candidates booking_candidate
  where booking_candidate.id = target_candidate_id
    and booking_candidate.organization_id = context.organization_id
    and booking_candidate.location_id = context.location_id
    and booking_candidate.conversation_id = context.conversation_id
    and booking_candidate.integration_id = context.integration_id;

  if candidate.id is null or candidate.status <> 'offered' or candidate.expires_at <= now() then
    raise exception using errcode = '42501', message = 'Booking candidate is not available';
  end if;

  select booking_intent.* into existing
  from public.booking_intents booking_intent
  where booking_intent.organization_id = candidate.organization_id
    and booking_intent.candidate_id = candidate.id;

  if existing.id is not null then
    return query
    select existing.id,
      appointment_type.name,
      candidate.starts_at,
      candidate.timezone,
      existing.status
    from public.scheduling_appointment_types appointment_type
    where appointment_type.organization_id = candidate.organization_id
      and appointment_type.id = candidate.appointment_type_id;
    return;
  end if;

  insert into public.booking_intents as inserted (
    organization_id,
    location_id,
    conversation_id,
    integration_id,
    candidate_id,
    contact_id,
    external_contact_uid,
    external_subject_uid,
    subject_name,
    trusted_transport_phone_e164
  )
  values (
    candidate.organization_id,
    candidate.location_id,
    candidate.conversation_id,
    candidate.integration_id,
    candidate.id,
    coalesce(trusted_contact_id, context.contact_id),
    nullif(btrim(coalesce(resolved_contact_uid, '')), ''),
    nullif(btrim(coalesce(resolved_subject_uid, '')), ''),
    nullif(btrim(coalesce(resolved_subject_name, '')), ''),
    context.trusted_transport_phone_e164
  )
  returning inserted.* into existing;

  update public.booking_candidates booking_candidate
  set status = 'consumed', updated_at = now()
  where booking_candidate.id = candidate.id;

  return query
  select existing.id,
    appointment_type.name,
    candidate.starts_at,
    candidate.timezone,
    existing.status
  from public.scheduling_appointment_types appointment_type
  where appointment_type.organization_id = candidate.organization_id
    and appointment_type.id = candidate.appointment_type_id;
end;
$$;

revoke all on function public.prepare_conversation_scheduling_booking_intent_base(uuid, uuid, text, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;

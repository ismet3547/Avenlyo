-- Phase 23 closure: an unclassified internal failure after a consequential claim is uncertainty,
-- never evidence that the provider mutation did not happen. Retries must surface durable review.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(7);

insert into auth.users (id, email)
values ('f1010000-0000-0000-0000-000000000001', 'phase23-provider-retry@example.test');
insert into public.users (id, email)
values ('f1010000-0000-0000-0000-000000000001', 'phase23-provider-retry@example.test')
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values (
  'f1020000-0000-0000-0000-000000000001',
  'Phase 23 provider retry',
  'phase23-provider-retry',
  'f1010000-0000-0000-0000-000000000001',
  'veterinary'
);
insert into public.locations (id, organization_id, name, timezone)
values (
  'f1030000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'Phase 23 provider retry location',
  'UTC'
);
insert into public.integrations
  (id, organization_id, location_id, provider, status, environment, site_timezone)
values (
  'f1040000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'google_calendar', 'connected', 'production', 'UTC'
);
insert into public.scheduling_appointment_types
  (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name,
   default_duration_minutes, active, bookable)
values (
  'f1050000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'f1040000-0000-0000-0000-000000000001',
  'google_calendar', 'avenlyo', 'phase23-provider-retry-type', 'Retry visit', 30, true, true
);
insert into public.scheduling_resources
  (id, organization_id, location_id, integration_id, provider, external_uid,
   external_ownership_id, name, active, bookable)
values (
  'f1060000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'f1040000-0000-0000-0000-000000000001',
  'google_calendar', 'phase23-provider-retry-calendar', null, 'Retry calendar', true, true
);
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values (
  'f1070000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'phone', 'Retry phone'
);
insert into public.conversations
  (id, organization_id, location_id, channel_id, mode, ai_mode)
values (
  'f1080000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'f1070000-0000-0000-0000-000000000001',
  'customer', 'ai'
);
insert into public.messages
  (id, organization_id, location_id, conversation_id, direction, message_type, body,
   source_channel, author_type)
values (
  'f1090000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'f1080000-0000-0000-0000-000000000001',
  'inbound', 'text', 'Yes, do it.', 'phone', 'customer'
);

insert into public.booking_candidates
  (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id,
   resource_id, starts_at, ends_at, timezone, status, expires_at)
values
  (
    'f1100000-0000-0000-0000-000000000001',
    'f1020000-0000-0000-0000-000000000001',
    'f1030000-0000-0000-0000-000000000001',
    'f1080000-0000-0000-0000-000000000001',
    'f1040000-0000-0000-0000-000000000001',
    'f1050000-0000-0000-0000-000000000001',
    'f1060000-0000-0000-0000-000000000001',
    now() + interval '4 days', now() + interval '4 days 30 minutes', 'UTC', 'consumed',
    now() + interval '1 hour'
  ),
  (
    'f1100000-0000-0000-0000-000000000002',
    'f1020000-0000-0000-0000-000000000001',
    'f1030000-0000-0000-0000-000000000001',
    'f1080000-0000-0000-0000-000000000001',
    'f1040000-0000-0000-0000-000000000001',
    'f1050000-0000-0000-0000-000000000001',
    'f1060000-0000-0000-0000-000000000001',
    now() + interval '5 days', now() + interval '5 days 30 minutes', 'UTC', 'consumed',
    now() + interval '1 hour'
  );
insert into public.booking_intents
  (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status)
values
  (
    'f1110000-0000-0000-0000-000000000001',
    'f1020000-0000-0000-0000-000000000001',
    'f1030000-0000-0000-0000-000000000001',
    'f1080000-0000-0000-0000-000000000001',
    'f1040000-0000-0000-0000-000000000001',
    'f1100000-0000-0000-0000-000000000001',
    'booking'
  ),
  (
    'f1110000-0000-0000-0000-000000000002',
    'f1020000-0000-0000-0000-000000000001',
    'f1030000-0000-0000-0000-000000000001',
    'f1080000-0000-0000-0000-000000000001',
    'f1040000-0000-0000-0000-000000000001',
    'f1100000-0000-0000-0000-000000000002',
    'completed'
  );
insert into public.appointments
  (id, organization_id, location_id, conversation_id, title, status, starts_at, ends_at,
   provider, external_appointment_id, integration_id, booking_intent_id,
   scheduling_resource_id, provider_status)
values (
  'f1120000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'f1080000-0000-0000-0000-000000000001',
  'Retry appointment', 'confirmed', now() + interval '5 days',
  now() + interval '5 days 30 minutes', 'google_calendar', 'phase23-provider-retry-event',
  'f1040000-0000-0000-0000-000000000001',
  'f1110000-0000-0000-0000-000000000002',
  'f1060000-0000-0000-0000-000000000001', 'confirmed'
);
insert into public.appointment_change_intents
  (id, organization_id, location_id, conversation_id, appointment_id, booking_intent_id,
   integration_id, provider, operation, actor_category, original_external_appointment_id,
   original_starts_at, original_ends_at, original_resource_id, status, expires_at)
values (
  'f1130000-0000-0000-0000-000000000001',
  'f1020000-0000-0000-0000-000000000001',
  'f1030000-0000-0000-0000-000000000001',
  'f1080000-0000-0000-0000-000000000001',
  'f1120000-0000-0000-0000-000000000001',
  'f1110000-0000-0000-0000-000000000002',
  'f1040000-0000-0000-0000-000000000001',
  'google_calendar', 'cancel', 'customer', 'phase23-provider-retry-event',
  now() + interval '5 days', now() + interval '5 days 30 minutes',
  'f1060000-0000-0000-0000-000000000001', 'executing', now() + interval '10 minutes'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.fail_scheduling_booking_intent(
  'f1110000-0000-0000-0000-000000000001', 'failed', 'internal'
);
select public.fail_appointment_change_intent(
  'f1130000-0000-0000-0000-000000000001', 'failed', 'internal'
);
reset role;

select extensions.is(
  (select status from public.booking_intents where id = 'f1110000-0000-0000-0000-000000000001'),
  'provider_state_unknown',
  'an unclassified booking failure cannot erase provider uncertainty'
);
select extensions.is(
  (select status from public.appointment_change_intents where id = 'f1130000-0000-0000-0000-000000000001'),
  'provider_state_unknown',
  'an unclassified lifecycle failure cannot erase provider uncertainty'
);
select extensions.is(
  has_function_privilege(
    'service_role',
    'public.fail_scheduling_booking_intent_without_uncertainty_guard(uuid,text,text)',
    'EXECUTE'
  ),
  false,
  'service_role cannot bypass the booking uncertainty guard'
);
select extensions.is(
  has_function_privilege(
    'service_role',
    'public.fail_appointment_change_intent_without_uncertainty_guard(uuid,text,text)',
    'EXECUTE'
  ),
  false,
  'service_role cannot bypass the lifecycle uncertainty guard'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select review_required from public.get_message_agent_work_state_v2(
    'f1090000-0000-0000-0000-000000000001'
  )),
  true,
  'the original inbound retry surfaces unresolved provider work as mandatory human review'
);
reset role;

select extensions.is(
  (select schema_version from public.platform_schema_contract where id),
  22,
  'schema 22 is declared only after provider retry hardening exists'
);
select extensions.ok(
  has_function_privilege('service_role', 'public.get_message_agent_work_state_v2(uuid)', 'EXECUTE'),
  'service_role can read the retry-safe work-state contract'
);

select extensions.finish();
rollback;

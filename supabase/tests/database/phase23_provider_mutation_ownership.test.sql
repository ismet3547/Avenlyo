-- Phase 23: fresh customer scheduling mutations serialize against human conversation ownership.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(16);

insert into auth.users (id, email)
values ('c3010000-0000-0000-0000-000000000001', 'phase23-ownership@example.test');
insert into public.users (id, email)
values ('c3010000-0000-0000-0000-000000000001', 'phase23-ownership@example.test')
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('c3020000-0000-0000-0000-000000000001', 'Phase 23 ownership', 'phase23-ownership',
  'c3010000-0000-0000-0000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name, timezone)
values ('c3030000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'Phase 23 location', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values ('c3040000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3010000-0000-0000-0000-000000000001', 'owner');
insert into public.integrations
  (id, organization_id, location_id, provider, status, environment, site_timezone)
values ('c3050000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3030000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'UTC');
insert into public.scheduling_appointment_types
  (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name,
   default_duration_minutes, active, bookable)
values ('c3060000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3030000-0000-0000-0000-000000000001', 'c3050000-0000-0000-0000-000000000001',
  'google_calendar', 'avenlyo', 'phase23-type', 'Phase 23 visit', 30, true, true);
insert into public.scheduling_resources
  (id, organization_id, location_id, integration_id, provider, external_uid, external_ownership_id,
   name, active, bookable)
values ('c3070000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3030000-0000-0000-0000-000000000001', 'c3050000-0000-0000-0000-000000000001',
  'google_calendar', 'phase23-calendar', null, 'Phase 23 calendar', true, true);
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values ('c3080000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3030000-0000-0000-0000-000000000001', 'phone', 'Phase 23 phone');
insert into public.conversations
  (id, organization_id, location_id, channel_id, mode, ai_mode)
values ('c3090000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3030000-0000-0000-0000-000000000001', 'c3080000-0000-0000-0000-000000000001',
  'customer', 'human');

-- One candidate/intent exercises fresh booking ownership. A second completed booking backs the
-- appointment used by lifecycle tests so changing the first intent cannot alter appointment truth.
insert into public.booking_candidates
  (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id,
   resource_id, starts_at, ends_at, timezone, expires_at)
values
  ('c3100000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
   'c3030000-0000-0000-0000-000000000001', 'c3090000-0000-0000-0000-000000000001',
   'c3050000-0000-0000-0000-000000000001', 'c3060000-0000-0000-0000-000000000001',
   'c3070000-0000-0000-0000-000000000001', now() + interval '4 days',
   now() + interval '4 days 30 minutes', 'UTC', now() + interval '1 hour'),
  ('c3100000-0000-0000-0000-000000000002', 'c3020000-0000-0000-0000-000000000001',
   'c3030000-0000-0000-0000-000000000001', 'c3090000-0000-0000-0000-000000000001',
   'c3050000-0000-0000-0000-000000000001', 'c3060000-0000-0000-0000-000000000001',
   'c3070000-0000-0000-0000-000000000001', now() + interval '5 days',
   now() + interval '5 days 30 minutes', 'UTC', now() + interval '1 hour');
insert into public.booking_intents
  (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status,
   trusted_transport_phone_e164)
values
  ('c3110000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
   'c3030000-0000-0000-0000-000000000001', 'c3090000-0000-0000-0000-000000000001',
   'c3050000-0000-0000-0000-000000000001', 'c3100000-0000-0000-0000-000000000001',
   'awaiting_confirmation', '+14155550123'),
  ('c3110000-0000-0000-0000-000000000002', 'c3020000-0000-0000-0000-000000000001',
   'c3030000-0000-0000-0000-000000000001', 'c3090000-0000-0000-0000-000000000001',
   'c3050000-0000-0000-0000-000000000001', 'c3100000-0000-0000-0000-000000000002',
   'completed', '+14155550123');
insert into public.appointments
  (id, organization_id, location_id, conversation_id, title, status, starts_at, ends_at, provider,
   external_appointment_id, integration_id, booking_intent_id, scheduling_resource_id,
   provider_status, trusted_sms_recipient_e164)
values ('c3120000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3030000-0000-0000-0000-000000000001', 'c3090000-0000-0000-0000-000000000001',
  'Phase 23 appointment', 'confirmed', now() + interval '5 days', now() + interval '5 days 30 minutes',
  'google_calendar', 'phase23-event', 'c3050000-0000-0000-0000-000000000001',
  'c3110000-0000-0000-0000-000000000002', 'c3070000-0000-0000-0000-000000000001',
  'confirmed', '+14155550123');
insert into public.appointment_change_intents
  (id, organization_id, location_id, conversation_id, appointment_id, booking_intent_id,
   integration_id, provider, operation, actor_category, original_external_appointment_id,
   original_starts_at, original_ends_at, original_resource_id, created_at, expires_at)
values ('c3130000-0000-0000-0000-000000000001', 'c3020000-0000-0000-0000-000000000001',
  'c3030000-0000-0000-0000-000000000001', 'c3090000-0000-0000-0000-000000000001',
  'c3120000-0000-0000-0000-000000000001', 'c3110000-0000-0000-0000-000000000002',
  'c3050000-0000-0000-0000-000000000001', 'google_calendar', 'cancel', 'customer',
  'phase23-event', now() + interval '5 days', now() + interval '5 days 30 minutes',
  'c3070000-0000-0000-0000-000000000001', now() - interval '1 minute', now() + interval '10 minutes');

select extensions.ok(
  pg_catalog.pg_get_functiondef(
    'public.claim_conversation_scheduling_booking_intent(uuid,uuid,uuid,text)'::regprocedure
  ) ~ 'lock_conversation_ownership',
  'fresh booking claim is serialized by the Phase 13 conversation ownership lock'
);
select extensions.ok(
  pg_catalog.pg_get_functiondef(
    'public.claim_appointment_change_intent(uuid,uuid,uuid,text)'::regprocedure
  ) ~ 'lock_conversation_ownership',
  'fresh lifecycle claim is serialized by the same conversation ownership lock'
);
select extensions.is(
  has_function_privilege('service_role',
    'public.claim_conversation_scheduling_booking_intent_without_ownership(uuid,uuid,uuid,text)',
    'EXECUTE'), false,
  'service_role cannot bypass the booking ownership wrapper through its renamed implementation'
);
select extensions.is(
  has_function_privilege('service_role',
    'public.claim_appointment_change_intent_without_ownership(uuid,uuid,uuid,text)',
    'EXECUTE'), false,
  'service_role cannot bypass the lifecycle ownership wrapper through its renamed implementation'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_conversation_scheduling_booking_intent(
    'c3090000-0000-0000-0000-000000000001', null::uuid,
    'c3110000-0000-0000-0000-000000000001', 'phase23-booking-human')),
  'configuration_changed',
  'human ownership wins before a fresh booking provider-write claim'
);
reset role;
select extensions.is(
  (select status from public.booking_intents where id = 'c3110000-0000-0000-0000-000000000001'),
  'failed', 'the vetoed fresh booking intent is terminal rather than left replayable'
);
select extensions.is(
  (select failure_category from public.booking_intents where id = 'c3110000-0000-0000-0000-000000000001'),
  'human_control', 'the booking intent retains the bounded internal reason for the veto'
);

update public.conversations set ai_mode = 'ai'
where id = 'c3090000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_conversation_scheduling_booking_intent(
    'c3090000-0000-0000-0000-000000000001', null::uuid,
    'c3110000-0000-0000-0000-000000000001', 'phase23-booking-replay')),
  'configuration_changed',
  'Resume AI cannot revive the stale booking confirmation after human ownership vetoed it'
);
reset role;

update public.conversations set ai_mode = 'human'
where id = 'c3090000-0000-0000-0000-000000000001';
update public.booking_intents set status = 'provider_state_unknown', failure_category = null
where id = 'c3110000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_conversation_scheduling_booking_intent(
    'c3090000-0000-0000-0000-000000000001', null::uuid,
    'c3110000-0000-0000-0000-000000000001', 'phase23-booking-recovery')),
  'provider_state_unknown',
  'human ownership never rewrites an ambiguous booking operation that may have crossed the provider boundary'
);
reset role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_appointment_change_intent(
    'c3090000-0000-0000-0000-000000000001', null::uuid,
    'c3130000-0000-0000-0000-000000000001', 'phase23-change-human')),
  'configuration_changed',
  'human ownership wins before a fresh appointment-change provider-write claim'
);
reset role;
select extensions.is(
  (select status from public.appointment_change_intents where id = 'c3130000-0000-0000-0000-000000000001'),
  'failed', 'the vetoed appointment-change intent is terminal rather than left replayable'
);
select extensions.is(
  (select failure_category from public.appointment_change_intents where id = 'c3130000-0000-0000-0000-000000000001'),
  'human_control', 'the appointment-change intent retains the bounded internal veto reason'
);

update public.conversations set ai_mode = 'ai'
where id = 'c3090000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_appointment_change_intent(
    'c3090000-0000-0000-0000-000000000001', null::uuid,
    'c3130000-0000-0000-0000-000000000001', 'phase23-change-replay')),
  'configuration_changed',
  'Resume AI cannot revive a stale appointment-change confirmation after the human-control veto'
);
reset role;

update public.conversations set ai_mode = 'human'
where id = 'c3090000-0000-0000-0000-000000000001';
update public.appointment_change_intents set status = 'provider_state_unknown', failure_category = null
where id = 'c3130000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_appointment_change_intent(
    'c3090000-0000-0000-0000-000000000001', null::uuid,
    'c3130000-0000-0000-0000-000000000001', 'phase23-change-recovery')),
  'provider_state_unknown',
  'human ownership preserves ambiguous lifecycle provider truth for reconciliation'
);
reset role;

select extensions.ok(
  strpos(
    pg_catalog.pg_get_functiondef(
      'public.claim_conversation_scheduling_booking_intent(uuid,uuid,uuid,text)'::regprocedure
    ), 'provider_state_unknown'
  ) < strpos(
    pg_catalog.pg_get_functiondef(
      'public.claim_conversation_scheduling_booking_intent(uuid,uuid,uuid,text)'::regprocedure
    ), 'billing_feature_available'
  ),
  'booking recovery remains ahead of current billing entitlement after ownership hardening'
);
select extensions.ok(
  pg_catalog.pg_get_functiondef(
    'public.claim_appointment_change_intent(uuid,uuid,uuid,text)'::regprocedure
  ) ~ 'provider_state_unknown.*claim_appointment_change_intent_without_ownership',
  'lifecycle recovery remains delegated rather than re-authorized as a fresh provider write'
);

select extensions.finish();
rollback;
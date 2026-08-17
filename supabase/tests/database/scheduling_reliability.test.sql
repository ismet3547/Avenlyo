-- Phase 6 recovery semantics: current policy gates a first write only. Once a provider result
-- exists, replay and persistence use the immutable booking intent/provider identity.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(25);

insert into auth.users (id, email) values ('83000000-0000-0000-0000-000000000001', 'reliability-owner@example.test');
insert into public.users (id, email) values ('83000000-0000-0000-0000-000000000001', 'reliability-owner@example.test') on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('83100000-0000-0000-0000-000000000001', 'Reliability', 'reliability', '83000000-0000-0000-0000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name, timezone)
values ('83200000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', 'Reliability One', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values ('83300000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000001', 'owner');
insert into public.integrations (id, organization_id, location_id, provider, status, environment, site_timezone) values
  ('83400000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'UTC'),
  ('83400000-0000-0000-0000-000000000002', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', 'ezyvet', 'connected', 'trial', 'UTC');
insert into public.location_scheduling_settings (organization_id, location_id, active_integration_id)
values ('83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001');
insert into public.integration_credentials (organization_id, location_id, integration_id, vault_secret_id)
values (
  '83100000-0000-0000-0000-000000000001',
  '83200000-0000-0000-0000-000000000001',
  '83400000-0000-0000-0000-000000000002',
  vault.create_secret(
    '{"client_id":"test-ezyvet-client","client_secret":"test-ezyvet-secret","site_uid":"test-ezyvet-site"}',
    'avenlyo-ezyvet-recovery-test',
    'ezyVet recovery test credential'
  )
);
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name, default_duration_minutes, active, bookable) values
  ('83500000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', 'google_calendar', 'avenlyo', 'avenlyo:reliability', 'Google Consultation', 30, true, true),
  ('83500000-0000-0000-0000-000000000002', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', 'ezyvet', 'ezyvet', 'ezyvet:reliability', 'ezyVet Wellness', 30, true, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, external_ownership_id, active, bookable) values
  ('83600000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', 'google_calendar', 'calendar-reliability', 'Google Room', null, true, true),
  ('83600000-0000-0000-0000-000000000002', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', 'ezyvet', 'ezyvet-resource', 'Dr Reliable', 'owner-scope', true, true);
insert into public.scheduling_appointment_type_resources (organization_id, location_id, integration_id, appointment_type_id, resource_id)
values ('83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '83500000-0000-0000-0000-000000000001', '83600000-0000-0000-0000-000000000001');
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values ('83700000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', 'phone', 'Reliability phone');
insert into public.conversations (id, organization_id, location_id, channel_id)
values ('83800000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83700000-0000-0000-0000-000000000001');
insert into public.calls (id, organization_id, location_id, conversation_id, direction, provider, external_call_id)
values ('83900000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', 'inbound', 'openai-realtime-sip', 'reliability-call');

insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at) values
  ('84000000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '83500000-0000-0000-0000-000000000001', '83600000-0000-0000-0000-000000000001', now() + interval '2 hours', now() + interval '150 minutes', 'UTC', now() + interval '10 minutes'),
  ('84000000-0000-0000-0000-000000000002', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '83500000-0000-0000-0000-000000000001', '83600000-0000-0000-0000-000000000001', now() + interval '3 hours', now() + interval '210 minutes', 'UTC', now() + interval '10 minutes'),
  ('84000000-0000-0000-0000-000000000003', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '83500000-0000-0000-0000-000000000001', '83600000-0000-0000-0000-000000000001', now() + interval '4 hours', now() + interval '270 minutes', 'UTC', now() + interval '10 minutes'),
  ('84000000-0000-0000-0000-000000000004', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '83500000-0000-0000-0000-000000000001', '83600000-0000-0000-0000-000000000001', now() + interval '5 hours', now() + interval '330 minutes', 'UTC', now() + interval '10 minutes'),
  ('84000000-0000-0000-0000-000000000005', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', '83500000-0000-0000-0000-000000000002', '83600000-0000-0000-0000-000000000002', now() + interval '6 hours', now() + interval '390 minutes', 'UTC', now() + interval '10 minutes'),
  ('84000000-0000-0000-0000-000000000006', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', '83500000-0000-0000-0000-000000000002', '83600000-0000-0000-0000-000000000002', now() + interval '7 hours', now() + interval '450 minutes', 'UTC', now() + interval '10 minutes'),
  ('84000000-0000-0000-0000-000000000007', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', '83500000-0000-0000-0000-000000000002', '83600000-0000-0000-0000-000000000002', now() + interval '8 hours', now() + interval '510 minutes', 'UTC', now() + interval '10 minutes');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status, external_contact_uid, external_subject_uid, subject_name) values
  ('84100000-0000-0000-0000-000000000001', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-000000000001', 'booking', null, null, null),
  ('84100000-0000-0000-0000-000000000002', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-000000000002', 'booking', null, null, null),
  ('84100000-0000-0000-0000-000000000003', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-000000000003', 'awaiting_confirmation', null, null, null),
  ('84100000-0000-0000-0000-000000000004', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-000000000004', 'booking', null, null, null),
  ('84100000-0000-0000-0000-000000000005', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', '84000000-0000-0000-0000-000000000005', 'booking', 'ezyvet-contact', 'ezyvet-subject', 'Max'),
  ('84100000-0000-0000-0000-000000000006', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', '84000000-0000-0000-0000-000000000006', 'booking', 'ezyvet-contact', 'ezyvet-subject', 'Max'),
  ('84100000-0000-0000-0000-000000000007', '83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001', '83800000-0000-0000-0000-000000000001', '83400000-0000-0000-0000-000000000002', '84000000-0000-0000-0000-000000000007', 'awaiting_confirmation', 'ezyvet-contact', 'ezyvet-subject', 'Max');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.record_voice_booking_provider_success('84100000-0000-0000-0000-000000000001', 'google-event-1', 'confirmed') $$,
  'trusted backend records a confirmed Google provider result'
);
select extensions.throws_ok(
  $$ select public.record_voice_booking_provider_success('84100000-0000-0000-0000-000000000001', 'google-event-1', 'unconfirmed') $$,
  '22023', 'Provider booking result conflicts with the claimed intent', 'provider-success replay requires compatible identity and normalized status'
);
reset role;
select extensions.is(
  (select provider_booking_status from public.booking_intents where id = '84100000-0000-0000-0000-000000000001'),
  'confirmed',
  'provider booking status is stored before local persistence'
);

update public.integrations set status = 'connected' where id = '83400000-0000-0000-0000-000000000002';
update public.location_scheduling_settings set active_integration_id = '83400000-0000-0000-0000-000000000002';
update public.integrations set status = 'disabled' where id = '83400000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.complete_voice_booking_intent('84100000-0000-0000-0000-000000000001') $$,
  'provider success persists after Google is disconnected and no longer active'
);
reset role;
select extensions.is(
  (select provider_status from public.appointments where booking_intent_id = '84100000-0000-0000-0000-000000000001'),
  'confirmed',
  'local appointment retains the durable confirmed Google status'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.record_voice_booking_provider_success('84100000-0000-0000-0000-000000000006', 'ezyvet-appointment-1', 'unconfirmed') $$,
  'trusted backend records an unconfirmed ezyVet provider result before disconnect'
);
select extensions.lives_ok(
  $$ select public.disable_ezyvet_integration('83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001') $$,
  'trusted backend disables ezyVet integration'
);
reset role;
select extensions.is(
  (select active_integration_id from public.location_scheduling_settings where organization_id = '83100000-0000-0000-0000-000000000001' and location_id = '83200000-0000-0000-0000-000000000001'),
  null,
  'disabling the active ezyVet integration clears the active provider'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.complete_voice_booking_intent('84100000-0000-0000-0000-000000000006') $$,
  'provider success persists after ezyVet is disconnected'
);
reset role;
select extensions.is(
  (select provider_status from public.appointments where booking_intent_id = '84100000-0000-0000-0000-000000000006'),
  'unconfirmed',
  'local appointment retains the durable unconfirmed ezyVet status'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.get_ezyvet_execution_credentials('83400000-0000-0000-0000-000000000002')),
  1,
  'service role retrieves vaulted ezyVet credentials after disconnect for recovery'
);
select extensions.is(
  (select state from public.claim_voice_scheduling_booking_intent('reliability-call', '84100000-0000-0000-0000-000000000005', 'tool-ezyvet-recovery')),
  'booking_recovery',
  'a disconnected ezyVet booking recovers against its stored integration'
);
select extensions.is(
  (select state from public.claim_voice_scheduling_booking_intent('reliability-call', '84100000-0000-0000-0000-000000000007', 'tool-ezyvet-fresh')),
  'configuration_changed',
  'a fresh ezyVet write is blocked after disconnect'
);
reset role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_voice_scheduling_booking_intent('reliability-call', '84100000-0000-0000-0000-000000000002', 'tool-recovery')),
  'booking_recovery',
  'a booking crash recovers against its stored integration after provider switch'
);
select extensions.is(
  (select state from public.claim_voice_scheduling_booking_intent('reliability-call', '84100000-0000-0000-0000-000000000001', 'tool-replay')),
  'completed',
  'completed replay remains booked after provider switch'
);
select extensions.is(
  (select state from public.claim_voice_scheduling_booking_intent('reliability-call', '84100000-0000-0000-0000-000000000003', 'tool-fresh')),
  'configuration_changed',
  'a fresh confirmation is blocked after active provider switch'
);
reset role;

set local role anon;
select extensions.throws_ok(
  $$ select * from public.get_ezyvet_execution_credentials('83400000-0000-0000-0000-000000000002') $$,
  '42501', 'permission denied for function get_ezyvet_execution_credentials',
  'anon cannot execute ezyVet recovery credential RPC'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select extensions.throws_ok(
  $$ select * from public.get_ezyvet_execution_credentials('83400000-0000-0000-0000-000000000002') $$,
  '42501', 'permission denied for function get_ezyvet_execution_credentials',
  'authenticated users cannot execute ezyVet recovery credential RPC'
);
reset role;
select extensions.ok(
  not has_table_privilege('service_role', 'public.integration_credentials', 'select'),
  'service role receives no direct integration credential table grant'
);

update public.integrations set status = 'connected' where id = '83400000-0000-0000-0000-000000000001';
update public.integrations set status = 'connected' where id = '83400000-0000-0000-0000-000000000002';
update public.location_scheduling_settings set active_integration_id = '83400000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.disable_ezyvet_integration('83100000-0000-0000-0000-000000000001', '83200000-0000-0000-0000-000000000001') $$,
  'disabling ezyVet does not alter another active provider'
);
reset role;
select extensions.is(
  (select active_integration_id from public.location_scheduling_settings where organization_id = '83100000-0000-0000-0000-000000000001' and location_id = '83200000-0000-0000-0000-000000000001'),
  '83400000-0000-0000-0000-000000000001'::uuid,
  'disabling ezyVet leaves an active Google provider unchanged'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
update public.integrations set status = 'connected' where id = '83400000-0000-0000-0000-000000000001';
update public.location_scheduling_settings set active_integration_id = '83400000-0000-0000-0000-000000000001';
update public.scheduling_resources set bookable = false where id = '83600000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$ select public.claim_booking_slot_lease('84100000-0000-0000-0000-000000000004') $$,
  '22023', 'Booking configuration changed', 'disabled Google resource blocks a first provider write'
);
reset role;

update public.scheduling_resources set bookable = true where id = '83600000-0000-0000-0000-000000000001';
delete from public.scheduling_appointment_type_resources where appointment_type_id = '83500000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$ select public.claim_booking_slot_lease('84100000-0000-0000-0000-000000000004') $$,
  '22023', 'Booking configuration changed', 'removed Google type-resource mapping blocks a first provider write'
);
reset role;

update public.integrations set status = 'connected' where id = '83400000-0000-0000-0000-000000000002';
update public.location_scheduling_settings set active_integration_id = '83400000-0000-0000-0000-000000000002';
update public.scheduling_resources set bookable = false where id = '83600000-0000-0000-0000-000000000002';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$ select public.claim_booking_slot_lease('84100000-0000-0000-0000-000000000005') $$,
  '22023', 'Booking configuration changed', 'disabled ezyVet resource blocks a first provider write'
);
reset role;

select extensions.is(
  (select count(*)::integer from public.booking_slot_leases where booking_intent_id in ('84100000-0000-0000-0000-000000000004', '84100000-0000-0000-0000-000000000005') and status = 'active'),
  0,
  'policy failures do not leave active execution leases'
);
select * from extensions.finish();
rollback;

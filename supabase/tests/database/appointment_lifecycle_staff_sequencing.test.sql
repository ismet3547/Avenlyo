-- Completed staff operations are idempotent history, not active work that can block a later change.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(7);

insert into auth.users (id, email)
values ('d9010000-0000-0000-0000-000000000001', 'staff-sequencing@example.test');
insert into public.users (id, email)
values ('d9010000-0000-0000-0000-000000000001', 'staff-sequencing@example.test')
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('d9020000-0000-0000-0000-000000000001', 'Staff sequencing', 'staff-sequencing', 'd9010000-0000-0000-0000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name, timezone)
values ('d9030000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'Staff sequencing location', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values ('d9040000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9010000-0000-0000-0000-000000000001', 'owner');
insert into public.integrations (id, organization_id, location_id, provider, status, environment, site_timezone)
values ('d9050000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'UTC');
insert into public.location_scheduling_settings (organization_id, location_id, active_integration_id)
values ('d9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name, default_duration_minutes, active, bookable)
values ('d9060000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'google_calendar', 'avenlyo', 'staff-sequencing-type', 'Staff sequencing visit', 30, true, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, external_ownership_id, name, active, bookable)
values ('d9070000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'google_calendar', 'staff-sequencing-calendar', null, 'Staff sequencing calendar', true, true);
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values ('d9080000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'phone', 'Staff sequencing phone');
insert into public.conversations (id, organization_id, location_id, channel_id)
values ('d9090000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9080000-0000-0000-0000-000000000001');

insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
values
  ('d9100000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9060000-0000-0000-0000-000000000001', 'd9070000-0000-0000-0000-000000000001', now() + interval '5 days', now() + interval '5 days 30 minutes', 'UTC', now() + interval '1 day'),
  ('d9100000-0000-0000-0000-000000000002', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9060000-0000-0000-0000-000000000001', 'd9070000-0000-0000-0000-000000000001', now() + interval '7 days', now() + interval '7 days 30 minutes', 'UTC', now() + interval '1 day'),
  ('d9100000-0000-0000-0000-000000000003', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9060000-0000-0000-0000-000000000001', 'd9070000-0000-0000-0000-000000000001', now() + interval '9 days', now() + interval '9 days 30 minutes', 'UTC', now() + interval '1 day'),
  ('d9100000-0000-0000-0000-000000000004', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9060000-0000-0000-0000-000000000001', 'd9070000-0000-0000-0000-000000000001', now() + interval '11 days', now() + interval '11 days 30 minutes', 'UTC', now() + interval '1 day'),
  ('d9100000-0000-0000-0000-000000000005', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9060000-0000-0000-0000-000000000001', 'd9070000-0000-0000-0000-000000000001', now() + interval '13 days', now() + interval '13 days 30 minutes', 'UTC', now() + interval '1 day');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status)
values
  ('d9200000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9100000-0000-0000-0000-000000000001', 'completed'),
  ('d9200000-0000-0000-0000-000000000002', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9100000-0000-0000-0000-000000000002', 'completed'),
  ('d9200000-0000-0000-0000-000000000003', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9100000-0000-0000-0000-000000000003', 'completed'),
  ('d9200000-0000-0000-0000-000000000004', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9100000-0000-0000-0000-000000000004', 'completed'),
  ('d9200000-0000-0000-0000-000000000005', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'd9050000-0000-0000-0000-000000000001', 'd9100000-0000-0000-0000-000000000005', 'completed');
insert into public.appointments (id, organization_id, location_id, conversation_id, title, status, starts_at, ends_at, provider, external_appointment_id, integration_id, booking_intent_id, scheduling_resource_id, provider_status)
values
  ('d9300000-0000-0000-0000-000000000001', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'Sequencing one', 'confirmed', now() + interval '5 days', now() + interval '5 days 30 minutes', 'google_calendar', 'sequencing-one', 'd9050000-0000-0000-0000-000000000001', 'd9200000-0000-0000-0000-000000000001', 'd9070000-0000-0000-0000-000000000001', 'confirmed'),
  ('d9300000-0000-0000-0000-000000000002', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'Sequencing two', 'confirmed', now() + interval '7 days', now() + interval '7 days 30 minutes', 'google_calendar', 'sequencing-two', 'd9050000-0000-0000-0000-000000000001', 'd9200000-0000-0000-0000-000000000002', 'd9070000-0000-0000-0000-000000000001', 'confirmed'),
  ('d9300000-0000-0000-0000-000000000003', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'Sequencing three', 'confirmed', now() + interval '9 days', now() + interval '9 days 30 minutes', 'google_calendar', 'sequencing-three', 'd9050000-0000-0000-0000-000000000001', 'd9200000-0000-0000-0000-000000000003', 'd9070000-0000-0000-0000-000000000001', 'confirmed'),
  ('d9300000-0000-0000-0000-000000000004', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'Sequencing four', 'confirmed', now() + interval '11 days', now() + interval '11 days 30 minutes', 'google_calendar', 'sequencing-four', 'd9050000-0000-0000-0000-000000000001', 'd9200000-0000-0000-0000-000000000004', 'd9070000-0000-0000-0000-000000000001', 'confirmed'),
  ('d9300000-0000-0000-0000-000000000005', 'd9020000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9090000-0000-0000-0000-000000000001', 'Sequencing five', 'confirmed', now() + interval '13 days', now() + interval '13 days 30 minutes', 'google_calendar', 'sequencing-five', 'd9050000-0000-0000-0000-000000000001', 'd9200000-0000-0000-0000-000000000005', 'd9070000-0000-0000-0000-000000000001', 'confirmed');

-- Completed reschedule -> cancellation starts a separate first-write operation from the updated appointment.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('app.reschedule_one', (select change_intent_id::text from public.create_staff_appointment_reschedule_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000001', now() + interval '6 days', now() + interval '6 days 30 minutes')), true);
select public.persist_appointment_change_mutation_target(current_setting('app.reschedule_one')::uuid, 'sequencing-one');
select public.record_appointment_change_provider_success(current_setting('app.reschedule_one')::uuid, 'confirmed');
select * from public.complete_appointment_change_intent(current_setting('app.reschedule_one')::uuid);
select set_config('app.cancel_after_reschedule', (select change_intent_id::text from public.create_staff_appointment_cancellation_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000001')), true);
reset role;
select extensions.ok(
  current_setting('app.cancel_after_reschedule')::uuid <> current_setting('app.reschedule_one')::uuid
  and exists (select 1 from public.appointment_change_intents where id = current_setting('app.cancel_after_reschedule')::uuid and operation = 'cancel' and status = 'executing' and mutation_attempt_count = 1),
  'a completed reschedule permits one new staff cancellation from the current appointment state'
);

-- Same completed reschedule is idempotent; a new target creates a separate first-write operation.
set local role service_role;
select set_config('app.reschedule_two', (select change_intent_id::text from public.create_staff_appointment_reschedule_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000002', now() + interval '8 days', now() + interval '8 days 30 minutes')), true);
select public.persist_appointment_change_mutation_target(current_setting('app.reschedule_two')::uuid, 'sequencing-two');
select public.record_appointment_change_provider_success(current_setting('app.reschedule_two')::uuid, 'confirmed');
select * from public.complete_appointment_change_intent(current_setting('app.reschedule_two')::uuid);
select extensions.is((select change_intent_id::text from public.create_staff_appointment_reschedule_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000002', now() + interval '8 days', now() + interval '8 days 30 minutes')), current_setting('app.reschedule_two'), 'an exact completed reschedule retry returns the completed intent');
select set_config('app.reschedule_two_b', (select change_intent_id::text from public.create_staff_appointment_reschedule_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000002', now() + interval '9 days', now() + interval '9 days 30 minutes')), true);
reset role;
select extensions.ok(
  current_setting('app.reschedule_two_b')::uuid <> current_setting('app.reschedule_two')::uuid
  and exists (select 1 from public.appointment_change_intents where id = current_setting('app.reschedule_two_b')::uuid and operation = 'reschedule' and status = 'executing' and mutation_attempt_count = 1),
  'a different completed reschedule target creates one new durable first-write operation'
);

-- Completed cancel retry is idempotent; a later reschedule reaches current-state validation instead
-- of being rejected as conflicting history.
set local role service_role;
select set_config('app.cancel_three', (select change_intent_id::text from public.create_staff_appointment_cancellation_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000003')), true);
select public.persist_appointment_change_mutation_target(current_setting('app.cancel_three')::uuid, 'sequencing-three');
select public.record_appointment_change_provider_success(current_setting('app.cancel_three')::uuid, 'confirmed');
select * from public.complete_appointment_change_intent(current_setting('app.cancel_three')::uuid);
select extensions.is((select change_intent_id::text from public.create_staff_appointment_cancellation_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000003')), current_setting('app.cancel_three'), 'a completed cancellation retry returns the completed intent');
select extensions.throws_ok(
  $$ select * from public.create_staff_appointment_reschedule_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000003', now() + interval '10 days', now() + interval '10 days 30 minutes') $$,
  '42501',
  'Appointment cannot be changed safely',
  'a later reschedule after a completed cancellation is rejected by the current cancelled appointment state'
);

-- Active/recovery work still blocks conflicting operations.
select set_config('app.active_reschedule', (select change_intent_id::text from public.create_staff_appointment_reschedule_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000004', now() + interval '12 days', now() + interval '12 days 30 minutes')), true);
select extensions.throws_ok(
  $$ select * from public.create_staff_appointment_cancellation_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000004') $$,
  '22023',
  'A different appointment change is already in progress',
  'an executing reschedule blocks a conflicting cancellation'
);
select set_config('app.unknown_cancel', (select change_intent_id::text from public.create_staff_appointment_cancellation_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000005')), true);
reset role;
update public.appointment_change_intents set status = 'provider_state_unknown' where id = current_setting('app.unknown_cancel')::uuid;
set local role service_role;
select extensions.throws_ok(
  $$ select * from public.create_staff_appointment_reschedule_intent('d9010000-0000-0000-0000-000000000001', 'd9030000-0000-0000-0000-000000000001', 'd9300000-0000-0000-0000-000000000005', now() + interval '14 days', now() + interval '14 days 30 minutes') $$,
  '22023',
  'A different appointment change is already in progress',
  'a provider-state-unknown cancellation blocks a conflicting reschedule'
);

reset role;
select * from extensions.finish();
rollback;

-- Phase 6 database-only checks. HTTP/OAuth exchanges are covered by Vitest; this suite proves
-- tenant relationships, backend-only state, active-provider policy, and exclusion leases.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(16);

insert into auth.users (id, email) values
  ('81000000-0000-0000-0000-000000000001', 'google-owner@example.test'),
  ('81000000-0000-0000-0000-000000000002', 'google-member@example.test'),
  ('82000000-0000-0000-0000-000000000001', 'google-owner-b@example.test');
insert into public.users (id, email) select id, email from auth.users where id in ('81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-000000000001') on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('81100000-0000-0000-0000-000000000001', 'Google A', 'google-a', '81000000-0000-0000-0000-000000000001', 'medspa'),
  ('82100000-0000-0000-0000-000000000001', 'Google B', 'google-b', '82000000-0000-0000-0000-000000000001', 'auto-repair');
insert into public.locations (id, organization_id, name, timezone) values
  ('81200000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', 'Google A One', 'America/New_York'),
  ('82200000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-000000000001', 'Google B One', 'America/New_York');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('81300000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', 'owner'),
  ('81300000-0000-0000-0000-000000000002', '81100000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'member'),
  ('82300000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'owner');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('81100000-0000-0000-0000-000000000001', '81300000-0000-0000-0000-000000000002', '81200000-0000-0000-0000-000000000001');
insert into public.integrations (id, organization_id, location_id, provider, status, environment, site_timezone) values
  ('81400000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'America/New_York'),
  ('82400000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-000000000001', '82200000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'America/New_York');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name, default_duration_minutes, bookable) values
  ('81500000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', 'google_calendar', 'avenlyo', 'avenlyo:type-a', 'Consultation', 30, true),
  ('82500000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-000000000001', '82200000-0000-0000-0000-000000000001', '82400000-0000-0000-0000-000000000001', 'google_calendar', 'avenlyo', 'avenlyo:type-b', 'Oil Change', 45, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, active, bookable, metadata) values
  ('81600000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', 'google_calendar', 'calendar-a', 'A Calendar', true, true, '{"access_role":"writer"}'),
  ('81600000-0000-0000-0000-000000000002', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', 'google_calendar', 'calendar-a2', 'A Calendar 2', true, true, '{"access_role":"owner"}'),
  ('82600000-0000-0000-0000-000000000001', '82100000-0000-0000-0000-000000000001', '82200000-0000-0000-0000-000000000001', '82400000-0000-0000-0000-000000000001', 'google_calendar', 'calendar-b', 'B Calendar', true, true, '{"access_role":"writer"}');
insert into public.scheduling_appointment_type_resources (organization_id, location_id, integration_id, appointment_type_id, resource_id)
values
  ('81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81500000-0000-0000-0000-000000000001', '81600000-0000-0000-0000-000000000001'),
  ('81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81500000-0000-0000-0000-000000000001', '81600000-0000-0000-0000-000000000002');

select extensions.throws_ok(
  $$ insert into public.scheduling_appointment_type_resources (organization_id, location_id, integration_id, appointment_type_id, resource_id) values ('81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81500000-0000-0000-0000-000000000001', '82600000-0000-0000-0000-000000000001') $$,
  '23503', 'insert or update on table "scheduling_appointment_type_resources" violates foreign key constraint "scheduling_type_resource_resource_fk"', 'type-resource mapping rejects a cross-tenant resource');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000002', true);
select extensions.throws_ok($$ select * from public.oauth_connection_states $$, '42501', 'permission denied for table oauth_connection_states', 'member cannot read OAuth state');
select extensions.throws_ok($$ select * from public.integration_credentials $$, '42501', 'permission denied for table integration_credentials', 'member cannot read Vault credential references');
select extensions.throws_ok($$ select public.create_my_google_appointment_type('81200000-0000-0000-0000-000000000001', 'Member type', 30) $$, '42501', 'Organization owner or admin access is required', 'member cannot create Google appointment types');
select extensions.throws_ok($$ update public.booking_intents set provider_appointment_id = 'forged-google-event' $$, '42501', 'permission denied for table booking_intents', 'member cannot forge a Google provider result');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok($$ select public.create_my_google_appointment_type('81200000-0000-0000-0000-000000000001', 'Follow up', 30) $$, 'owner creates an Avenlyo-managed type through RPC');
select extensions.throws_ok($$ select public.create_my_google_appointment_type('81200000-0000-0000-0000-000000000001', 'Bad duration', 17) $$, '22023', 'Appointment type is invalid', 'duration must be 5-minute increments');
select extensions.lives_ok($$ select public.set_my_active_scheduling_integration('81200000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', 60) $$, 'owner selects the one active scheduling integration');
select extensions.is((select active_integration_id from public.location_scheduling_settings where location_id = '81200000-0000-0000-0000-000000000001'), '81400000-0000-0000-0000-000000000001'::uuid, 'active provider remains location scoped');
reset role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok($$ select public.create_google_oauth_state('81000000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', repeat('a', 64)) $$, 'backend creates a hashed, owner-bound OAuth state');
select extensions.is((select count(*)::integer from public.consume_google_oauth_state(repeat('a', 64))), 1, 'OAuth state is atomically consumed once');
select extensions.is((select count(*)::integer from public.consume_google_oauth_state(repeat('a', 64))), 0, 'consumed OAuth state cannot be reused');
reset role;

insert into public.channels (id, organization_id, location_id, channel_type, display_name) values ('81700000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', 'phone', 'Google phone');
insert into public.conversations (id, organization_id, location_id, channel_id) values ('81800000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81700000-0000-0000-0000-000000000001');
insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at) values
  ('81900000-0000-0000-0000-000000000001', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81800000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81500000-0000-0000-0000-000000000001', '81600000-0000-0000-0000-000000000001', now() + interval '2 hours', now() + interval '150 minutes', 'America/New_York', now() + interval '10 minutes'),
  ('81900000-0000-0000-0000-000000000002', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81800000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81500000-0000-0000-0000-000000000001', '81600000-0000-0000-0000-000000000001', now() + interval '135 minutes', now() + interval '195 minutes', 'America/New_York', now() + interval '10 minutes'),
  ('81900000-0000-0000-0000-000000000003', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81800000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81500000-0000-0000-0000-000000000001', '81600000-0000-0000-0000-000000000002', now() + interval '135 minutes', now() + interval '195 minutes', 'America/New_York', now() + interval '10 minutes');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status) values
  ('81900000-0000-0000-0000-000000000011', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81800000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81900000-0000-0000-0000-000000000001', 'booking'),
  ('81900000-0000-0000-0000-000000000012', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81800000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81900000-0000-0000-0000-000000000002', 'booking'),
  ('81900000-0000-0000-0000-000000000013', '81100000-0000-0000-0000-000000000001', '81200000-0000-0000-0000-000000000001', '81800000-0000-0000-0000-000000000001', '81400000-0000-0000-0000-000000000001', '81900000-0000-0000-0000-000000000003', 'booking');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok($$ select public.claim_booking_slot_lease('81900000-0000-0000-0000-000000000011') $$, 'service role claims the first Google slot lease');
select extensions.throws_ok($$ select public.claim_booking_slot_lease('81900000-0000-0000-0000-000000000012') $$, '23P01', 'Booking slot is no longer available', 'overlapping leases for the same resource are rejected');
select extensions.lives_ok($$ select public.claim_booking_slot_lease('81900000-0000-0000-0000-000000000013') $$, 'overlapping time on a different resource is allowed');
reset role;

select extensions.is((select count(*)::integer from public.booking_slot_leases where status = 'active'), 2, 'only non-overlapping active leases persist');
select * from extensions.finish();
rollback;

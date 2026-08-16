-- Phase 5 scheduling tenant isolation and backend-only write guarantees. This runs with
-- `supabase test db`; provider HTTP/Vault behavior is intentionally covered by Vitest and manual trial verification.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(11);

insert into auth.users (id, email)
values
  ('70000000-0000-0000-0000-000000000001', 'scheduling-owner@example.test'),
  ('70000000-0000-0000-0000-000000000002', 'scheduling-member@example.test'),
  ('70000000-0000-0000-0000-000000000003', 'scheduling-owner-b@example.test');
insert into public.users (id, email)
select id, email from auth.users
where id in (
  '70000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000002',
  '70000000-0000-0000-0000-000000000003'
) on conflict (id) do nothing;

insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values
  ('71000000-0000-0000-0000-000000000001', 'Scheduling A', 'scheduling-a', '70000000-0000-0000-0000-000000000001', 'veterinary'),
  ('72000000-0000-0000-0000-000000000001', 'Scheduling B', 'scheduling-b', '70000000-0000-0000-0000-000000000003', 'veterinary');
insert into public.locations (id, organization_id, name, timezone)
values
  ('71100000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'A One', 'UTC'),
  ('71200000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'A Two', 'UTC'),
  ('72100000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'B One', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values
  ('71300000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'owner'),
  ('71300000-0000-0000-0000-000000000002', '71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002', 'member'),
  ('72300000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000003', 'owner');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('71000000-0000-0000-0000-000000000001', '71300000-0000-0000-0000-000000000002', '71100000-0000-0000-0000-000000000001');

insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values ('71400000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '71100000-0000-0000-0000-000000000001', 'phone', 'A phone');
insert into public.conversations (id, organization_id, location_id, channel_id)
values ('71500000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '71100000-0000-0000-0000-000000000001', '71400000-0000-0000-0000-000000000001');
insert into public.integrations (id, organization_id, location_id, provider, status, environment, site_uid, site_timezone)
values
  ('71600000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '71100000-0000-0000-0000-000000000001', 'ezyvet', 'connected', 'trial', 'site-a', 'UTC'),
  ('72600000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', '72100000-0000-0000-0000-000000000001', 'ezyvet', 'connected', 'trial', 'site-b', 'UTC');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, external_uid, name, default_duration_minutes, bookable)
values
  ('71700000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '71100000-0000-0000-0000-000000000001', '71600000-0000-0000-0000-000000000001', 'ezyvet', 'type-a', 'Wellness', 30, true),
  ('72700000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', '72100000-0000-0000-0000-000000000001', '72600000-0000-0000-0000-000000000001', 'ezyvet', 'type-b', 'Wellness', 30, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, external_ownership_id, bookable)
values
  ('71800000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '71100000-0000-0000-0000-000000000001', '71600000-0000-0000-0000-000000000001', 'ezyvet', 'resource-a', 'Dr A', 'scope-a', true),
  ('72800000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', '72100000-0000-0000-0000-000000000001', '72600000-0000-0000-0000-000000000001', 'ezyvet', 'resource-b', 'Dr B', 'scope-b', true);

select extensions.throws_ok(
  $$ insert into public.booking_candidates (organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
     values ('71000000-0000-0000-0000-000000000001', '71100000-0000-0000-0000-000000000001', '71500000-0000-0000-0000-000000000001', '71600000-0000-0000-0000-000000000001', '71700000-0000-0000-0000-000000000001', '72800000-0000-0000-0000-000000000001', now() + interval '1 hour', now() + interval '90 minutes', 'UTC', now() + interval '10 minutes') $$,
  '23503',
  'insert or update on table "booking_candidates" violates foreign key constraint "booking_candidates_resource_scope_fk"',
  'inserted candidate cannot reference an ezyVet resource owned by another organization'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000002', true);

select extensions.is(
  (select count(*)::integer from public.scheduling_appointment_types),
  1,
  'location-scoped member reads catalog only for their assigned location'
);
select extensions.is(
  (select count(*)::integer from public.scheduling_resources where location_id = '72100000-0000-0000-0000-000000000001'),
  0,
  'member cannot read another organization catalog'
);
select extensions.throws_ok(
  $$ update public.scheduling_appointment_types set bookable = false where id = '71700000-0000-0000-0000-000000000001' $$,
  '42501',
  'permission denied for table scheduling_appointment_types',
  'member cannot directly change catalog bookability'
);
select extensions.is_empty(
  $$ update public.integrations set status = 'disabled' where id = '71600000-0000-0000-0000-000000000001' returning id $$,
  'member cannot directly disconnect an integration'
);
select extensions.throws_ok(
  $$ select * from public.integration_credentials $$,
  '42501',
  'permission denied for table integration_credentials',
  'member cannot read Vault credential references'
);
select extensions.throws_ok(
  $$ select * from public.get_ezyvet_execution_credentials('71600000-0000-0000-0000-000000000001') $$,
  '42501',
  'permission denied for function get_ezyvet_execution_credentials',
  'authenticated member cannot execute trusted credential RPC'
);
select extensions.throws_ok(
  $$ select public.update_my_ezyvet_booking_policy('71100000-0000-0000-0000-000000000001', array['71700000-0000-0000-0000-000000000001']::uuid[], array['71800000-0000-0000-0000-000000000001']::uuid[]) $$,
  '42501',
  'Organization owner or admin access is required',
  'member cannot change the ezyVet booking policy'
);

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select public.update_my_ezyvet_booking_policy('71100000-0000-0000-0000-000000000001', array['71700000-0000-0000-0000-000000000001']::uuid[], array['71800000-0000-0000-0000-000000000001']::uuid[]) $$,
  'owner can set the explicit ezyVet booking policy through its audited RPC'
);
select extensions.throws_ok(
  $$ select * from public.get_my_ezyvet_integration_configuration('72100000-0000-0000-0000-000000000001') $$,
  '42501',
  'Location access is required',
  'owner in organization A cannot view organization B integration configuration'
);

reset role;
select extensions.is(
  (select bookable from public.scheduling_appointment_types where id = '71700000-0000-0000-0000-000000000001'),
  true,
  'owner policy retained the selected appointment type'
);

select * from extensions.finish();
rollback;

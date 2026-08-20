-- Phase 16 customer history: location scoping, test-mode isolation, and read-only boundaries.
--
-- The fixture is built around one shared contact who is genuinely active at two locations, because
-- that is the case a naive implementation gets wrong: it is easy to scope by organization and never
-- notice until one clinic can read another clinic's customer history.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(84);

create function pg_temp.as_user(target_user_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', target_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', target_user_id, 'role', 'authenticated')::text, true);
end;
$$;

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture: two locations in one organization, one foreign organization
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('c1000000-0000-4000-8000-000000000001', 'owner@history.test', now()),
  ('c1000000-0000-4000-8000-000000000002', 'member-a@history.test', now()),
  ('c1000000-0000-4000-8000-000000000003', 'member-b@history.test', now()),
  ('c1000000-0000-4000-8000-000000000004', 'revoked@history.test', now()),
  ('c1000000-0000-4000-8000-000000000005', 'foreign@history.test', now());

insert into public.users (id, email, display_name)
select id, email, split_part(email, '@', 1) from auth.users
where id::text like 'c1000000-0000-4000-8000-%'
on conflict (id) do update set email = excluded.email, display_name = excluded.display_name;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('c2000000-0000-4000-8000-000000000001', 'History Org', 'history-org',
   'c1000000-0000-4000-8000-000000000001', 'veterinary'),
  ('c2000000-0000-4000-8000-000000000009', 'Foreign Org', 'foreign-history-org',
   'c1000000-0000-4000-8000-000000000005', 'veterinary');

insert into public.locations (id, organization_id, name) values
  ('c3000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001', 'Location A'),
  ('c3000000-0000-4000-8000-00000000000b', 'c2000000-0000-4000-8000-000000000001', 'Location B'),
  ('c3000000-0000-4000-8000-00000000000f', 'c2000000-0000-4000-8000-000000000009', 'Foreign Location');

insert into public.organization_onboarding (organization_id, location_id, current_step, status, completed_at) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-00000000000a', 'completed', 'completed', now()),
  ('c2000000-0000-4000-8000-000000000009', 'c3000000-0000-4000-8000-00000000000f', 'completed', 'completed', now());

insert into public.organization_members (id, organization_id, user_id, role) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'owner'),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'member'),
  ('c4000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'member'),
  ('c4000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000004', 'member'),
  ('c4000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000005', 'owner');

-- Member A sees Location A only; Member B sees Location B only.
insert into public.organization_member_locations (organization_id, organization_member_id, location_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-00000000000a'),
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-00000000000b'),
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-00000000000a');

insert into public.channels (id, organization_id, location_id, channel_type, display_name, status, configuration) values
  ('c5000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-00000000000a', 'sms', 'A SMS', 'active', '{}'),
  ('c5000000-0000-4000-8000-00000000000c', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-00000000000a', 'web', 'A Web', 'active', '{}'),
  ('c5000000-0000-4000-8000-00000000000b', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-00000000000b', 'sms', 'B SMS', 'active', '{}');

-- The shared customer: one contact row, genuinely active at both locations.
insert into public.contacts (id, organization_id, location_id, first_name, last_name, phone, email) values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'Robin', 'Shared', '+15405550101', 'robin@customer.test'),
  -- Active only at B, so Member A must never see them.
  ('c6000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000b', 'Blake', 'OnlyB', '+15405550102', null),
  -- Belongs to the organization but has never interacted anywhere: not a customer of any location.
  ('c6000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'Inert', 'NoActivity', '+15405550103', null),
  ('c6000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000009',
   'c3000000-0000-4000-8000-00000000000f', 'Foreign', 'Person', '+15405550109', null);

-- Robin at Location A: two production conversations, one test conversation that must stay hidden.
insert into public.conversations
  (id, organization_id, location_id, contact_id, channel_id, mode, status, ai_mode, last_message_at,
   created_at, test_owner_user_id) values
  ('c7000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001',
   'c5000000-0000-4000-8000-00000000000a', 'customer', 'open', 'human',
   now() - interval '1 hour', now() - interval '2 days', null),
  ('c7000000-0000-4000-8000-00000000000c', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001',
   'c5000000-0000-4000-8000-00000000000c', 'customer', 'closed', 'ai',
   now() - interval '5 days', now() - interval '6 days', null),
  -- Robin at Location B.
  ('c7000000-0000-4000-8000-00000000000b', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000b', 'c6000000-0000-4000-8000-000000000001',
   'c5000000-0000-4000-8000-00000000000b', 'customer', 'open', 'ai',
   now() - interval '2 hours', now() - interval '3 days', null),
  -- A test-agent conversation at Location A. Synthetic activity is not customer history.
  ('c7000000-0000-4000-8000-00000000000d', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001',
   'c5000000-0000-4000-8000-00000000000a', 'test', 'open', 'ai',
   now(), now(), 'c1000000-0000-4000-8000-000000000001'),
  -- An anonymous web visitor at Location A: legitimate, with no customer identity.
  ('c7000000-0000-4000-8000-00000000000e', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', null,
   'c5000000-0000-4000-8000-00000000000c', 'customer', 'open', 'ai',
   now() - interval '30 minutes', now() - interval '1 day', null),
  -- Blake, only at Location B.
  ('c7000000-0000-4000-8000-00000000000f', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000b', 'c6000000-0000-4000-8000-000000000002',
   'c5000000-0000-4000-8000-00000000000b', 'customer', 'open', 'ai',
   now() - interval '4 hours', now() - interval '4 days', null);


-- Transcript at Location A, covering every author type and a durable delivery outcome.
insert into public.messages
  (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body,
   source_channel, author_type, sent_by_user_id, created_at) values
  ('c8000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a',
   'c6000000-0000-4000-8000-000000000001', 'inbound', 'text', 'Are you open on Saturday?',
   'sms', 'customer', null, now() - interval '3 hours'),
  ('c8000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a',
   'c6000000-0000-4000-8000-000000000001', 'outbound', 'text', 'We are open until noon.',
   'sms', 'ai', null, now() - interval '2 hours'),
  -- Sent by the teammate whose access is revoked later in this file.
  ('c8000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a',
   'c6000000-0000-4000-8000-000000000001', 'outbound', 'text', 'This is Dana, happy to help.',
   'sms', 'human', 'c1000000-0000-4000-8000-000000000004', now() - interval '90 minutes'),
  ('c8000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a',
   'c6000000-0000-4000-8000-000000000001', 'internal', 'text', 'Conversation handed to a teammate.',
   'internal', 'system', null, now() - interval '80 minutes'),
  -- Location B message: must never appear in a Location A transcript.
  ('c8000000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000b', 'c7000000-0000-4000-8000-00000000000b',
   'c6000000-0000-4000-8000-000000000001', 'inbound', 'text', 'Location B only content',
   'sms', 'customer', null, now() - interval '2 hours');

-- Durable delivery truth, including the deliberately ambiguous state.
insert into public.message_deliveries
  (organization_id, location_id, message_id, provider, status, provider_message_id) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-00000000000a',
   'c8000000-0000-4000-8000-000000000002', 'twilio', 'delivered', 'SM_fixture_delivered'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-00000000000a',
   'c8000000-0000-4000-8000-000000000003', 'twilio', 'unknown', 'SM_fixture_unknown');

-- Calls, appointments, and leads split across both locations for the same person.
insert into public.calls
  (id, organization_id, location_id, conversation_id, contact_id, direction, status, started_at, ended_at) values
  ('c9000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a',
   'c6000000-0000-4000-8000-000000000001', 'inbound', 'completed',
   now() - interval '3 days', now() - interval '3 days' + interval '4 minutes'),
  ('c9000000-0000-4000-8000-00000000000b', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000b', 'c7000000-0000-4000-8000-00000000000b',
   'c6000000-0000-4000-8000-000000000001', 'inbound', 'completed',
   now() - interval '4 days', now() - interval '4 days' + interval '2 minutes'),
  -- A call attached to the test conversation, which must stay out of production history.
  ('c9000000-0000-4000-8000-00000000000d', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000d',
   'c6000000-0000-4000-8000-000000000001', 'inbound', 'completed', now(), now());

insert into public.appointments
  (id, organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at) values
  ('ca000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001',
   'c7000000-0000-4000-8000-00000000000a', 'Wellness visit', 'confirmed',
   now() + interval '3 days', now() + interval '3 days' + interval '30 minutes'),
  ('ca000000-0000-4000-8000-00000000000b', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000b', 'c6000000-0000-4000-8000-000000000001',
   'c7000000-0000-4000-8000-00000000000b', 'Location B visit', 'confirmed',
   now() + interval '5 days', now() + interval '5 days' + interval '30 minutes');

insert into public.leads
  (id, organization_id, location_id, contact_id, conversation_id, status, source, created_at, updated_at) values
  ('cb000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001',
   'c7000000-0000-4000-8000-00000000000a', 'qualified', 'sms',
   now() - interval '2 days', now() - interval '2 days'),
  ('cb000000-0000-4000-8000-00000000000b', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000b', 'c6000000-0000-4000-8000-000000000001',
   'c7000000-0000-4000-8000-00000000000b', 'new', 'sms',
   now() - interval '3 days', now() - interval '3 days');

insert into public.handoffs
  (id, organization_id, location_id, conversation_id, mode, status, urgency, reason,
   assigned_user_id, assigned_at, first_acknowledged_at, created_at) values
  ('cc000000-0000-4000-8000-00000000000a', 'c2000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a',
   'customer', 'acknowledged', 'urgent', 'Customer asked for a person',
   'c1000000-0000-4000-8000-000000000004', now() - interval '90 minutes',
   now() - interval '90 minutes', now() - interval '95 minutes');

insert into public.messaging_contact_preferences
  (organization_id, contact_id, channel_type, status, opted_out_at)
values ('c2000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000002',
        'sms', 'opted_out', now() - interval '1 day');

-- Foreign organization activity, to prove the boundary from the outside.
insert into public.conversations
  (id, organization_id, location_id, contact_id, mode, status, ai_mode, last_message_at)
values ('c7000000-0000-4000-8000-0000000000ff', 'c2000000-0000-4000-8000-000000000009',
        'c3000000-0000-4000-8000-00000000000f', 'c6000000-0000-4000-8000-000000000009',
        'customer', 'open', 'ai', now());

-- ---------------------------------------------------------------------------
-- Customer directory
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('c1000000-0000-4000-8000-000000000002');

select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  1,
  'Location A lists exactly the customer with local production activity'
);
select extensions.is(
  (select contact_id from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  'c6000000-0000-4000-8000-000000000001',
  'the shared customer is visible at Location A'
);
select extensions.is(
  (select display_name from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  'Robin Shared',
  'the display name is composed deterministically from stored identity'
);
-- The whole point of the phase: counts are the location's, not the organization's.
select extensions.is(
  (select conversation_count from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  2,
  'Location A counts its own two conversations, not the three across the organization'
);
select extensions.is(
  (select call_count from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  1,
  'the call attached to a test conversation is excluded from production counts'
);
select extensions.is(
  (select appointment_count from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  1,
  'appointments are counted per location'
);
select extensions.is(
  (select lead_status from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  'qualified',
  'the lead status shown is the local lead, not the one at another location'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')
    where contact_id = 'c6000000-0000-4000-8000-000000000002'
  ),
  'a customer active only at Location B is absent from Location A'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')
    where contact_id = 'c6000000-0000-4000-8000-000000000003'
  ),
  'an organization contact with no location activity is not a customer of that location'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000b')),
  0,
  'a Location A member gets nothing from Location B'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000f')),
  0,
  'a foreign organization location returns nothing rather than an error that confirms it exists'
);

-- Search is location-authorized before it matches anything.
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory(
    'c3000000-0000-4000-8000-00000000000a', 'Robin')),
  1,
  'name search finds the local customer'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory(
    'c3000000-0000-4000-8000-00000000000a', '5405550101')),
  1,
  'phone search finds the local customer'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory(
    'c3000000-0000-4000-8000-00000000000a', 'robin@customer.test')),
  1,
  'email search finds the local customer'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory(
    'c3000000-0000-4000-8000-00000000000a', 'Blake')),
  0,
  'search cannot reach a customer who only exists at another location'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a', 'a')
  $sql$, '22023', 'Customer search is invalid')),
  'a one-character search is refused rather than scanning the directory'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_customer_directory(
      'c3000000-0000-4000-8000-00000000000a', repeat('x', 200))
  $sql$, '22023', 'Customer search is invalid')),
  'an oversized search term is refused'
);
-- The page cap is enforced in the database, not by a caller promising to be reasonable.
select extensions.ok(
  (select count(*)::integer from public.get_my_customer_directory(
    'c3000000-0000-4000-8000-00000000000a', null, null, null, 5000)) <= 50,
  'the page size is capped regardless of what the caller requests'
);
reset role;

-- ---------------------------------------------------------------------------
-- Shared contact, opposite direction
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('c1000000-0000-4000-8000-000000000003');
select extensions.is(
  (select contact_id from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000b')
   where contact_id = 'c6000000-0000-4000-8000-000000000001'),
  'c6000000-0000-4000-8000-000000000001',
  'the same shared customer is visible at Location B'
);
select extensions.is(
  (select conversation_count from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000b')
   where contact_id = 'c6000000-0000-4000-8000-000000000001'),
  1,
  'Location B sees only its own conversation for the shared customer'
);
select extensions.is(
  (select lead_status from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000b')
   where contact_id = 'c6000000-0000-4000-8000-000000000001'),
  'new',
  'Location B sees its own lead status'
);
select extensions.ok(
  (select sms_opted_out from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000b')
   where contact_id = 'c6000000-0000-4000-8000-000000000002'),
  'SMS opt-out comes from the durable preference record'
);

-- ---------------------------------------------------------------------------
-- Customer overview
-- ---------------------------------------------------------------------------
select pg_temp.as_user('c1000000-0000-4000-8000-000000000002');
select extensions.is(
  (select display_name from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  'Robin Shared',
  'the overview returns identity for a locally visible customer'
);
select extensions.is(
  (select conversation_count from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  2,
  'the overview conversation count is location scoped'
);
select extensions.is(
  (select call_count from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  1,
  'the overview call count excludes the test-mode call'
);
select extensions.is(
  (select next_appointment_title from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  'Wellness visit',
  'the next appointment is the local upcoming one'
);
select extensions.is(
  (select lead_status from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  'qualified',
  'the overview lead status is the local lead'
);
select extensions.is(
  (select active_handoff_count from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  1,
  'live human work at this location is surfaced as a count'
);
select extensions.is(
  (select active_handoff_urgency from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  'urgent',
  'urgency reflects the durable handoff row'
);
select extensions.ok(
  not (select sms_opted_out from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  'consent is read from the preference record, never inferred from having a phone number'
);
-- A customer at another location, a customer with no activity, and a foreign customer are all
-- equally unavailable. Nothing distinguishes them.
select extensions.is(
  (select count(*)::integer from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000002')),
  0,
  'a customer active only at another location is unavailable here'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000003')),
  0,
  'an organization contact with no local activity is unavailable'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000009')),
  0,
  'a foreign organization customer is unavailable'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000ff')),
  0,
  'a guessed identifier is unavailable, with nothing that confirms whether it exists'
);
reset role;

-- ---------------------------------------------------------------------------
-- Timeline
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('c1000000-0000-4000-8000-000000000002');

select extensions.ok(
  (select count(distinct event_kind)::integer from public.get_my_customer_timeline(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')) = 5,
  'the timeline carries every event family: conversation, call, appointment, lead, and handoff'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_timeline(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')
   where event_kind = 'conversation'),
  2,
  'only local production conversations appear on the timeline'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_customer_timeline(
      'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')
    where event_id = 'c7000000-0000-4000-8000-00000000000d'
  ),
  'the test-agent conversation never appears in customer history'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_customer_timeline(
      'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')
    where event_id in ('c7000000-0000-4000-8000-00000000000b', 'c9000000-0000-4000-8000-00000000000b',
                       'ca000000-0000-4000-8000-00000000000b', 'cb000000-0000-4000-8000-00000000000b')
  ),
  'no Location B event leaks into the Location A timeline'
);
select extensions.ok(
  (select bool_and(ordered) from (
    select event_at <= lag(event_at) over (order by rn) as ordered
    from (
      select event_at, row_number() over () as rn
      from public.get_my_customer_timeline(
        'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')
    ) as numbered
  ) as sequence where ordered is not null),
  'the timeline is ordered newest first'
);
-- Paging one event at a time must visit every event exactly once.
select extensions.is(
  (select count(distinct event_id)::integer from (
    select event_id from public.get_my_customer_timeline(
      'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001', null, null, null, 1)
    union all
    select page_two.event_id from public.get_my_customer_timeline(
      'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001',
      (select event_at from public.get_my_customer_timeline(
        'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001', null, null, null, 1)),
      (select event_kind from public.get_my_customer_timeline(
        'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001', null, null, null, 1)),
      (select event_id from public.get_my_customer_timeline(
        'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001', null, null, null, 1)),
      1) as page_two
  ) as paged),
  2,
  'paging by cursor yields distinct events with no duplicate and no skip'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_timeline(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000002')),
  0,
  'a customer with no local activity has no local timeline'
);

-- ---------------------------------------------------------------------------
-- Conversation archive
-- ---------------------------------------------------------------------------
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a')),
  3,
  'the archive lists local production conversations including the anonymous visitor'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a')
    where conversation_id = 'c7000000-0000-4000-8000-00000000000d'
  ),
  'the test conversation is excluded from the archive'
);
select extensions.is(
  (select customer_display_name from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a')
   where conversation_id = 'c7000000-0000-4000-8000-00000000000e'),
  'Anonymous visitor',
  'a web conversation with no contact is labelled rather than given a synthesised customer'
);
select extensions.ok(
  (select contact_id is null from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a')
   where conversation_id = 'c7000000-0000-4000-8000-00000000000e'),
  'the anonymous conversation exposes no customer identifier to link to'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_archive(
    'c3000000-0000-4000-8000-00000000000a', 'sms')),
  1,
  'the channel filter narrows to SMS'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_archive(
    'c3000000-0000-4000-8000-00000000000a', null, 'closed')),
  1,
  'the status filter finds closed history'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a', 'telepathy')
  $sql$, '22023', 'Conversation channel filter is invalid')),
  'an invented channel filter is refused rather than passed through'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a', null, 'archived')
  $sql$, '22023', 'Conversation status filter is invalid')),
  'an invented status filter is refused'
);
select extensions.is(
  (select active_handoff_urgency from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a')
   where conversation_id = 'c7000000-0000-4000-8000-00000000000a'),
  'urgent',
  'live human work is surfaced on the archive row'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000b')),
  0,
  'a Location A member sees no Location B conversation'
);
reset role;

-- ---------------------------------------------------------------------------
-- Conversation detail and transcript
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('c1000000-0000-4000-8000-000000000002');

select extensions.is(
  (select customer_display_name from public.get_my_conversation_detail(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')),
  'Robin Shared',
  'conversation detail resolves the customer identity'
);
select extensions.is(
  (select lead_status from public.get_my_conversation_detail(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')),
  'qualified',
  'associated records are resolved through canonical foreign keys'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_detail(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000b')),
  0,
  'a conversation at another location is unavailable even with a correct identifier'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_detail(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000d')),
  0,
  'a test conversation is unavailable through the history surface'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_detail(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-0000000000ff')),
  0,
  'a foreign organization conversation is unavailable'
);

select extensions.is(
  (select count(*)::integer from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')),
  4,
  'the transcript returns every durable message in the conversation'
);
select extensions.is(
  (select body from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')
   where author_type = 'customer'),
  'Are you open on Saturday?',
  'the customer message body is returned'
);
select extensions.is(
  (select author_display_name from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')
   where author_type = 'human'),
  'revoked',
  'a human message resolves its author from durable attribution'
);
select extensions.ok(
  (select author_display_name is null from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')
   where author_type = 'ai'),
  'an AI message carries no human author'
);
select extensions.is(
  (select delivery_status from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')
   where message_id = 'c8000000-0000-4000-8000-000000000002'),
  'delivered',
  'durable delivery truth is returned as stored'
);
-- The Phase 7 invariant: ambiguous stays ambiguous.
select extensions.is(
  (select delivery_status from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')
   where message_id = 'c8000000-0000-4000-8000-000000000003'),
  'unknown',
  'an unknown delivery is never relabelled as sent or failed'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_conversation_transcript(
      'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')
    where body = 'Location B only content'
  ),
  'no message from another location appears in this transcript'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000b')),
  0,
  'a transcript for another location returns nothing'
);
select extensions.ok(
  (select count(*)::integer from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a', null, null, 900)) <= 50,
  'the transcript page size is capped in the database'
);

-- Provider identifiers must not be reachable through any customer read model.
select extensions.ok(
  not exists (
    select 1 from information_schema.routines routine
    join information_schema.parameters parameter
      on parameter.specific_name = routine.specific_name
    where routine.routine_schema = 'public'
      and routine.routine_name in (
        'get_my_customer_directory', 'get_my_customer_overview', 'get_my_customer_timeline',
        'get_my_conversation_archive', 'get_my_conversation_detail', 'get_my_conversation_transcript'
      )
      and parameter.parameter_mode = 'OUT'
      and parameter.parameter_name ~* 'metadata|provider_message|external_id|token|secret|authorization|cookie|refresh|access_token|idempotency'
  ),
  'no customer read model exposes provider identifiers, tokens, or raw metadata'
);
reset role;

-- ---------------------------------------------------------------------------
-- Revocation, owner behaviour, and mutation boundaries
-- ---------------------------------------------------------------------------
-- Before revocation the member has real access. This is the control for the assertions below.
set local role authenticated;
select pg_temp.as_user('c1000000-0000-4000-8000-000000000004');
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  1,
  'an active member can browse customers at their location'
);

select pg_temp.as_user('c1000000-0000-4000-8000-000000000001');
select public.revoke_my_organization_member('c4000000-0000-4000-8000-000000000004');

-- Same user, next request. No sign-out, no token refresh.
select pg_temp.as_user('c1000000-0000-4000-8000-000000000004');
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory('c3000000-0000-4000-8000-00000000000a')),
  0,
  'a revoked member immediately loses the customer directory'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  0,
  'a revoked member immediately loses Customer 360'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_archive('c3000000-0000-4000-8000-00000000000a')),
  0,
  'a revoked member immediately loses the conversation archive'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')),
  0,
  'a revoked member immediately loses transcript access'
);

-- Their historical message still renders, because attribution comes from the preserved profile row
-- rather than from active membership.
select pg_temp.as_user('c1000000-0000-4000-8000-000000000002');
select extensions.is(
  (select author_display_name from public.get_my_conversation_transcript(
    'c3000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a')
   where author_type = 'human'),
  'revoked',
  'a message sent by a since-revoked teammate still shows their name'
);

-- An owner is organization-wide but the page is still location-contextual: asking for Location A
-- returns Location A, not a silent merge of every location the owner could legally switch to.
select pg_temp.as_user('c1000000-0000-4000-8000-000000000001');
select extensions.is(
  (select conversation_count from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001')),
  2,
  'an owner asking for Location A receives Location A history only'
);
select extensions.is(
  (select conversation_count from public.get_my_customer_overview(
    'c3000000-0000-4000-8000-00000000000b', 'c6000000-0000-4000-8000-000000000001')),
  1,
  'the same owner asking for Location B receives Location B history only'
);
reset role;

-- Direct client mutation of contacts is withdrawn. Every contact row is created inside a definer
-- function on the ingestion paths, so no legitimate client flow is affected.
select extensions.ok(
  not has_table_privilege('authenticated', 'public.contacts', 'insert'),
  'a browser client cannot insert a contact'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.contacts', 'update'),
  'a browser client cannot rewrite a customer phone number or name'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.contacts', 'delete'),
  'a browser client cannot delete a contact'
);
select extensions.ok(
  has_table_privilege('authenticated', 'public.contacts', 'select'),
  'contact reads survive, because tenant-scoped joins legitimately need them'
);
select extensions.ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'contacts' and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ),
  'the unreachable contact mutation policies are dropped rather than left ambiguous'
);
-- Phase 7 and 13 hardening is still in force; History did not reopen anything to build a UI.
select extensions.ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('conversations', 'messages')
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ),
  'conversation and message mutation remains closed to the browser'
);

select extensions.ok(
  not has_function_privilege('authenticated', 'public.contact_visible_at_location(uuid,uuid,uuid)', 'execute'),
  'the visibility helper is internal rather than a browser API'
);
select extensions.ok(
  not has_function_privilege('service_role', 'public.get_my_customer_directory(uuid,text,timestamptz,uuid,integer)', 'execute'),
  'customer history is an authenticated staff view, not a service-role surface'
);
select extensions.ok(
  not exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname like 'get_my_c%'
      and proc.proname in (
        'get_my_customer_directory', 'get_my_customer_overview', 'get_my_customer_timeline',
        'get_my_conversation_archive', 'get_my_conversation_detail', 'get_my_conversation_transcript'
      )
      and (
        proc.proconfig is null
        or not exists (select 1 from unnest(proc.proconfig) as setting where setting like 'search_path=%')
      )
  ),
  'every customer history function pins an empty search path'
);
select extensions.ok(
  (select schema_version >= 16 from public.platform_schema_contract),
  'the deployed schema is at least the version Phase 16 requires'
);

select * from extensions.finish();
rollback;

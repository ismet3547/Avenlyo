-- Phase 16 hardening: the contact read boundary, canonical voice channels, location-scoped
-- associations, and cursor completeness.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(34);

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
-- Fixture: one organization, two locations, a canonical Phase 4 voice conversation
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('e1000000-0000-4000-8000-000000000001', 'owner@hardening.test', now()),
  ('e1000000-0000-4000-8000-000000000002', 'member-a@hardening.test', now());

insert into public.users (id, email, display_name)
select id, email, split_part(email, '@', 1) from auth.users
where id::text like 'e1000000-0000-4000-8000-%'
on conflict (id) do update set email = excluded.email, display_name = excluded.display_name;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('e2000000-0000-4000-8000-000000000001', 'Hardening Org', 'hardening-org',
   'e1000000-0000-4000-8000-000000000001', 'veterinary');

-- Phase 17 makes production automation require an entitled Core subscription, so every
-- organization these existing guarantees run against carries one.  Billing is a separate
-- execution condition: nothing else about the fixtures below changes.
insert into public.billing_accounts (organization_id, stripe_customer_id, livemode, billing_state) values
  ('e2000000-0000-4000-8000-000000000001', 'cus_entitled_e2000000', false, 'active');
insert into public.billing_subscriptions (organization_id, stripe_customer_id, stripe_subscription_id,
  stripe_product_id, stripe_price_id, plan_key, is_supported, stripe_status, livemode) values
  ('e2000000-0000-4000-8000-000000000001', 'cus_entitled_e2000000', 'sub_entitled_e2000000', 'prod_core', 'price_core', 'core', true, 'active', false);

insert into public.locations (id, organization_id, name) values
  ('e3000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-000000000001', 'Location A'),
  ('e3000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-000000000001', 'Location B');

insert into public.organization_onboarding (organization_id, location_id, current_step, status, completed_at)
values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-00000000000a',
        'completed', 'completed', now());

insert into public.organization_members (id, organization_id, user_id, role) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'owner'),
  ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'member');

insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000002',
        'e3000000-0000-4000-8000-00000000000a');

insert into public.phone_numbers (id, organization_id, location_id, phone_number, status)
values ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
        'e3000000-0000-4000-8000-00000000000a', '+15405558001', 'active');

-- The canonical Phase 4 inbound voice shape: the channel row is 'phone', not 'voice'.
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status, configuration) values
  ('e6000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'phone', 'Inbound voice', 'active',
   jsonb_build_object('phone_number_id', 'e5000000-0000-4000-8000-000000000001', 'provider', 'twilio')),
  ('e6000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'web', 'Web chat', 'active', '{}');

insert into public.contacts (id, organization_id, location_id, first_name, last_name, phone, metadata) values
  ('e7000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'Casey', 'Caller', '+15405550201',
   jsonb_build_object('source', 'voice', 'secret_note', 'contact-metadata-must-not-be-readable')),
  -- Home location is A, but this person has never actually interacted with it. Under the Phase 0
  -- policy a browser could read them directly; under the Phase 16 rule they are not a customer here.
  ('e7000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'Inert', 'NoActivity', '+15405550202',
   jsonb_build_object('secret_note', 'activity-less-contact-metadata'));

-- A real voice conversation: phone channel, customer mode, voice-sourced message, SIP call.
insert into public.conversations
  (id, organization_id, location_id, contact_id, channel_id, mode, status, ai_mode, last_message_at, created_at)
values
  ('e8000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001',
   'e6000000-0000-4000-8000-00000000000a', 'customer', 'open', 'ai',
   now() - interval '1 hour', now() - interval '1 day'),
  -- A conversation whose channel row is absent: it must not be declared web chat.
  ('e8000000-0000-4000-8000-00000000000c', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001',
   null, 'customer', 'open', 'ai', now() - interval '2 hours', now() - interval '2 days');

insert into public.messages
  (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body,
   source_channel, author_type, created_at)
values
  ('e9000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a',
   'e7000000-0000-4000-8000-000000000001', 'inbound', 'text', 'Caller asked about hours.',
   'voice', 'customer', now() - interval '90 minutes');

insert into public.calls
  (id, organization_id, location_id, conversation_id, contact_id, direction, status,
   started_at, ended_at, provider)
values
  ('ea000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a',
   'e7000000-0000-4000-8000-000000000001', 'inbound', 'completed',
   now() - interval '95 minutes', now() - interval '90 minutes', 'openai-realtime-sip');

-- ---------------------------------------------------------------------------
-- The contact read boundary
-- ---------------------------------------------------------------------------
select extensions.ok(
  not has_table_privilege('authenticated', 'public.contacts', 'select'),
  'a browser client cannot read the contacts table directly'
);
select extensions.ok(
  not has_table_privilege('anon', 'public.contacts', 'select'),
  'an anonymous client cannot read the contacts table directly'
);
select extensions.ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'contacts' and cmd = 'SELECT'
  ),
  'the weaker location-based select policy is gone rather than shadowed'
);

set local role authenticated;
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');

-- The Phase 0 policy would have authorized both of these by contacts.location_id alone.
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select first_name from public.contacts where id = 'e7000000-0000-4000-8000-000000000001'
  $sql$, '42501', 'permission denied for table contacts')),
  'a customer with real local activity is still not readable through the raw table'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select first_name from public.contacts where id = 'e7000000-0000-4000-8000-000000000002'
  $sql$, '42501', 'permission denied for table contacts')),
  'an activity-less contact whose home location is accessible cannot be fetched directly'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select metadata from public.contacts where id = 'e7000000-0000-4000-8000-000000000001'
  $sql$, '42501', 'permission denied for table contacts')),
  'contact metadata is not browser-readable'
);

-- The read models still work, which is the point: the boundary moved rather than closing.
select extensions.is(
  (select count(*)::integer from public.get_my_customer_directory('e3000000-0000-4000-8000-00000000000a')),
  1,
  'the customer directory still returns the customer with real activity'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_customer_directory('e3000000-0000-4000-8000-00000000000a')
    where contact_id = 'e7000000-0000-4000-8000-000000000002'
  ),
  'the activity-less contact is absent from the directory, as the visibility rule requires'
);
select extensions.is(
  (select display_name from public.get_my_customer_overview(
    'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001')),
  'Casey Caller',
  'the customer overview still returns identity'
);
select extensions.is(
  (select count(*)::integer from public.get_my_customer_overview(
    'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000002')),
  0,
  'the overview still refuses an activity-less contact'
);
reset role;

-- ---------------------------------------------------------------------------
-- Trusted ingestion is unaffected
-- ---------------------------------------------------------------------------
-- Closing the browser read must not close the paths that create contacts. Both run inside
-- SECURITY DEFINER functions, so they never needed the authenticated grant.
insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled)
values ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001',
        'e3000000-0000-4000-8000-00000000000a', '+15405558002', 'active', true);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.bootstrap_inbound_sms(
       'SMhardeninginboundfixture000000000', '+15405550301', '+15405558002', 'Hello from SMS') $$,
  'trusted inbound SMS ingestion still runs'
);
reset role;

select extensions.ok(
  exists (
    select 1 from public.contacts
    where organization_id = 'e2000000-0000-4000-8000-000000000001'
      and phone = '+15405550301'
  ),
  'trusted SMS ingestion still creates its contact'
);

-- The voice path is the other producer of contact rows, and it never needed the browser grant
-- either: it runs inside a SECURITY DEFINER function on the trusted webhook boundary. Inbound voice
-- only routes when the dialled number is a Twilio number with voice enabled for its location.
update public.phone_numbers set provider = 'twilio'
where id = 'e5000000-0000-4000-8000-000000000001';
insert into public.voice_configurations (organization_id, location_id, enabled)
values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-00000000000a', true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.bootstrap_inbound_voice_call(
       'evt_hardening_voice', 'realtime.call.incoming', 'call_hardening_voice',
       'sip_hardening_voice', '+15405558001', '+15405550401') $$,
  'trusted inbound voice ingestion still runs'
);
reset role;

select extensions.ok(
  exists (
    select 1 from public.contacts
    where organization_id = 'e2000000-0000-4000-8000-000000000001'
      and phone = '+15405550401'
  ),
  'trusted voice ingestion still creates its contact'
);

-- ---------------------------------------------------------------------------
-- Canonical voice projects as voice
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');

select extensions.ok(
  exists (
    select 1 from public.get_my_conversation_archive('e3000000-0000-4000-8000-00000000000a')
    where conversation_id = 'e8000000-0000-4000-8000-00000000000a'
  ),
  'the unfiltered archive includes the canonical voice conversation'
);
select extensions.is(
  (select channel from public.get_my_conversation_archive('e3000000-0000-4000-8000-00000000000a')
   where conversation_id = 'e8000000-0000-4000-8000-00000000000a'),
  'voice',
  'a phone-channel conversation projects as voice, which is the word the product uses'
);
select extensions.ok(
  exists (
    select 1 from public.get_my_conversation_archive(
      'e3000000-0000-4000-8000-00000000000a', 'voice')
    where conversation_id = 'e8000000-0000-4000-8000-00000000000a'
  ),
  'the voice filter finds a real Phase 4 voice conversation'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_conversation_archive(
      'e3000000-0000-4000-8000-00000000000a', 'web')
    where conversation_id = 'e8000000-0000-4000-8000-00000000000a'
  ),
  'the web filter does not claim the voice conversation'
);
select extensions.is(
  (select channel from public.get_my_conversation_detail(
    'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a')),
  'voice',
  'conversation detail reports the same normalized channel'
);
select extensions.is(
  (select channel from public.get_my_customer_timeline(
    'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001')
   where event_kind = 'conversation' and event_id = 'e8000000-0000-4000-8000-00000000000a'),
  'voice',
  'the customer timeline reports the same normalized channel'
);

-- A missing channel is unknown, not web.
select extensions.is(
  (select channel from public.get_my_conversation_archive('e3000000-0000-4000-8000-00000000000a')
   where conversation_id = 'e8000000-0000-4000-8000-00000000000c'),
  'unknown',
  'a conversation with no channel row is reported unknown rather than declared web chat'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_conversation_archive(
      'e3000000-0000-4000-8000-00000000000a', 'web')
    where conversation_id = 'e8000000-0000-4000-8000-00000000000c'
  ),
  'an unknown channel matches no channel filter'
);
select extensions.ok(
  exists (
    select 1 from public.get_my_conversation_archive('e3000000-0000-4000-8000-00000000000a')
    where conversation_id = 'e8000000-0000-4000-8000-00000000000c'
  ),
  'an unknown channel is still real history and stays in the unfiltered archive'
);
reset role;

-- ---------------------------------------------------------------------------
-- Associated records stay inside the selected location
-- ---------------------------------------------------------------------------
-- Authorizing the parent conversation does not make every historically attached row safe: an
-- appointment and a call are separate rows carrying their own location.
insert into public.appointments
  (id, organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at)
values
  ('eb000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001',
   'e8000000-0000-4000-8000-00000000000a', 'Local visit', 'confirmed',
   now() + interval '2 days', now() + interval '2 days' + interval '30 minutes'),
  -- Attached to a Location A conversation but recorded at Location B. The schema permits it.
  ('eb000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000b', 'e7000000-0000-4000-8000-000000000001',
   'e8000000-0000-4000-8000-00000000000a', 'Other location visit', 'confirmed',
   now() + interval '9 days', now() + interval '9 days' + interval '30 minutes');

insert into public.calls
  (id, organization_id, location_id, conversation_id, contact_id, direction, status, started_at, ended_at)
values
  ('ea000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-000000000001',
   'e3000000-0000-4000-8000-00000000000b', 'e8000000-0000-4000-8000-00000000000a',
   'e7000000-0000-4000-8000-000000000001', 'inbound', 'completed',
   now() - interval '10 minutes', now() - interval '5 minutes');

set local role authenticated;
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');

select extensions.is(
  (select appointment_id from public.get_my_conversation_detail(
    'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a')),
  'eb000000-0000-4000-8000-00000000000a',
  'the local associated appointment is still returned'
);
-- The Location B appointment sorts first by start time, so without the predicate it would win.
select extensions.ok(
  (select appointment_id from public.get_my_conversation_detail(
    'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a'))
  is distinct from 'eb000000-0000-4000-8000-00000000000b',
  'an appointment recorded at another location is not returned with this conversation'
);
select extensions.is(
  (select call_id from public.get_my_conversation_detail(
    'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a')),
  'ea000000-0000-4000-8000-00000000000a',
  'the local associated call is still returned'
);
-- The Location B call is the most recent, so without the predicate it would win.
select extensions.ok(
  (select call_id from public.get_my_conversation_detail(
    'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a'))
  is distinct from 'ea000000-0000-4000-8000-00000000000b',
  'a call recorded at another location is not returned with this conversation'
);

-- ---------------------------------------------------------------------------
-- Cursor completeness
-- ---------------------------------------------------------------------------
-- Half a keyset cursor is not a smaller page: it changes the comparison and can skip or repeat a
-- row, so a non-web caller cannot request one.
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_customer_directory(
      'e3000000-0000-4000-8000-00000000000a', null, now(), null)
  $sql$, '22023', 'History cursor is incomplete')),
  'a directory cursor missing its identifier is refused'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_conversation_archive(
      'e3000000-0000-4000-8000-00000000000a', null, null, null, null,
      'e8000000-0000-4000-8000-00000000000a')
  $sql$, '22023', 'History cursor is incomplete')),
  'an archive cursor missing its timestamp is refused'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_conversation_transcript(
      'e3000000-0000-4000-8000-00000000000a', 'e8000000-0000-4000-8000-00000000000a', now(), null)
  $sql$, '22023', 'History cursor is incomplete')),
  'a transcript cursor missing its identifier is refused'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select * from public.get_my_customer_timeline(
      'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001',
      now(), 'conversation', null)
  $sql$, '22023', 'History cursor is incomplete')),
  'a timeline cursor missing one of its three parts is refused'
);
select extensions.lives_ok(
  $$ select * from public.get_my_customer_directory(
       'e3000000-0000-4000-8000-00000000000a', null, null, null) $$,
  'no cursor at all is the first page, not an incomplete cursor'
);
select extensions.lives_ok(
  $$ select * from public.get_my_customer_timeline(
       'e3000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001',
       now(), 'conversation', 'e8000000-0000-4000-8000-00000000000a') $$,
  'a complete timeline cursor still pages normally'
);
select extensions.ok(
  (select count(*)::integer from public.get_my_conversation_archive(
    'e3000000-0000-4000-8000-00000000000a', null, null, null, null, null, 5000)) <= 50,
  'the page cap still holds'
);
reset role;

select * from extensions.finish();
rollback;

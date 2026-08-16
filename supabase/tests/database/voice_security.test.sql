-- Phase 4 inbound-voice tenancy, privilege, and idempotency guarantees.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(25);

insert into auth.users (id, email)
values
  ('60000000-0000-0000-0000-000000000001', 'voice-owner-a@example.test'),
  ('60000000-0000-0000-0000-000000000002', 'voice-member-a@example.test'),
  ('60000000-0000-0000-0000-000000000003', 'voice-owner-b@example.test');

insert into public.users (id, email)
select id, email from auth.users
where id in (
  '60000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000003'
)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values
  ('61000000-0000-0000-0000-000000000001', 'Voice organization A', 'voice-organization-a', '60000000-0000-0000-0000-000000000001', 'veterinary'),
  ('62000000-0000-0000-0000-000000000001', 'Voice organization B', 'voice-organization-b', '60000000-0000-0000-0000-000000000003', 'medspa');

insert into public.locations (id, organization_id, name)
values
  ('61100000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', 'Voice A one'),
  ('61100000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000001', 'Voice A two'),
  ('62100000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'Voice B one');

insert into public.organization_members (id, organization_id, user_id, role)
values
  ('61200000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'owner'),
  ('61200000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', 'member'),
  ('62200000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000003', 'owner');

insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('61000000-0000-0000-0000-000000000001', '61200000-0000-0000-0000-000000000002', '61100000-0000-0000-0000-000000000001');

insert into public.phone_numbers (id, organization_id, location_id, phone_number, status)
values
  ('61300000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000001', '+14155550123', 'active'),
  ('62300000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', '+14155550124', 'active');

insert into public.channels (id, organization_id, location_id, channel_type, display_name, status)
values
  ('61400000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000001', 'phone', 'Voice A one', 'active'),
  ('61400000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000002', 'phone', 'Voice A two', 'active'),
  ('62400000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', 'phone', 'Voice B one', 'active');

insert into public.conversations (id, organization_id, location_id, channel_id, mode)
values
  ('61500000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000001', '61400000-0000-0000-0000-000000000001', 'customer'),
  ('61500000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000002', '61400000-0000-0000-0000-000000000002', 'customer'),
  ('62500000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', '62400000-0000-0000-0000-000000000001', 'customer');

insert into public.calls (
  id, organization_id, location_id, conversation_id, phone_number_id, direction, status,
  provider, external_call_id, started_at
)
values
  ('61600000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000001', '61500000-0000-0000-0000-000000000001', '61300000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'rtc_voice_a_one', now()),
  ('61600000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000002', '61500000-0000-0000-0000-000000000002', '61300000-0000-0000-0000-000000000001', 'inbound', 'completed', 'openai-realtime-sip', 'rtc_voice_a_two', now()),
  ('62600000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', '62500000-0000-0000-0000-000000000001', '62300000-0000-0000-0000-000000000001', 'inbound', 'completed', 'openai-realtime-sip', 'rtc_voice_b_one', now());

select extensions.throws_ok(
  $$
    insert into public.phone_numbers (organization_id, location_id, phone_number, status)
    values ('62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', '+14155550123', 'active')
  $$,
  '23505',
  'duplicate key value violates unique constraint "phone_numbers_provider_e164_key"',
  'global Twilio DID cannot be assigned to two organizations'
);

select extensions.throws_ok(
  $$
    insert into public.calls (organization_id, location_id, conversation_id, phone_number_id, direction, status, provider, external_call_id)
    values ('62000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', '62500000-0000-0000-0000-000000000001', '62300000-0000-0000-0000-000000000001', 'inbound', 'ringing', 'openai-realtime-sip', 'rtc_voice_a_one')
  $$,
  '23505',
  'duplicate key value violates unique constraint "calls_provider_external_call_id_key"',
  'provider external call identity is globally idempotent'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000002', true);

select extensions.is(
  (select count(*)::integer from public.calls where provider = 'openai-realtime-sip'),
  1,
  'location-scoped member reads only their location voice call'
);
select extensions.is(
  (select count(*)::integer from public.calls where organization_id = '62000000-0000-0000-0000-000000000001'),
  0,
  'organization A member cannot read organization B voice calls'
);
select extensions.throws_ok(
  $$ update public.phone_numbers set status = 'disabled' where id = '61300000-0000-0000-0000-000000000001' $$,
  '42501',
  'permission denied for table phone_numbers',
  'authenticated member cannot mutate provider DID ownership'
);
select extensions.results_eq(
  $$
    with updated as (
      update public.calls set status = 'completed'
      where id = '61600000-0000-0000-0000-000000000001'
      returning 1
    ) select count(*)::integer from updated
  $$,
  array[0],
  'authenticated member cannot transition a provider-backed voice call'
);
select extensions.throws_ok(
  $$ select * from public.bootstrap_inbound_voice_call('evt_denied', 'realtime.call.incoming', 'rtc_denied', 'sip_denied', '+14155550123', null) $$,
  '42501',
  'permission denied for function bootstrap_inbound_voice_call',
  'authenticated clients cannot execute the inbound bootstrap RPC'
);
select extensions.throws_ok(
  $$ select * from public.match_inbound_voice_knowledge('61000000-0000-0000-0000-000000000001', '61100000-0000-0000-0000-000000000001', '[0]'::text, 1) $$,
  '42501',
  'permission denied for function match_inbound_voice_knowledge',
  'authenticated clients cannot execute the backend knowledge RPC'
);
select extensions.throws_ok(
  $$ select * from public.upsert_my_voice_configuration('61100000-0000-0000-0000-000000000001', true, 'marin', false, '') $$,
  '42501',
  'Organization owner or admin access is required',
  'normal member cannot mutate voice configuration'
);

select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select * from public.upsert_my_voice_configuration('61100000-0000-0000-0000-000000000001', true, 'marin', false, '') $$,
  'owner can configure voice without direct provider DID mutation'
);

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.throws_ok(
  $$ select * from public.assign_voice_phone_number('61000000-0000-0000-0000-000000000001', '62100000-0000-0000-0000-000000000001', '+14155550125', null) $$,
  '23503',
  'Location does not belong to organization',
  'service backend rejects an organization/location mismatch during DID assignment'
);
select extensions.lives_ok(
  $$ select public.record_inbound_voice_transcript('rtc_voice_a_one', 'item_1', 'inbound', 'Final caller transcript') $$,
  'service backend persists a final inbound transcript'
);
select extensions.is(
  (select public.record_inbound_voice_transcript('rtc_voice_a_one', 'item_1', 'inbound', 'Final caller transcript')),
  false,
  'transcript external identity is idempotent'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_voice_a_one', 'tool_1', 'Caller requested a person.', 'normal')),
  true,
  'model human-help request creates the first handoff for its call'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_voice_a_one', 'safety:item_1', 'Urgent clinical concern.', 'urgent')),
  false,
  'transcript safety backstop reuses the model handoff for the same call'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_voice_a_two', 'safety:item_2', 'Urgent clinical concern.', 'urgent')),
  true,
  'transcript safety creates a handoff for a different call'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_voice_a_two', 'tool_2', 'Caller requested a person.', 'normal')),
  false,
  'model human-help reuses the safety handoff for the same call'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_voice_a_one', 'tool_1', 'Caller requested a person.', 'normal')),
  false,
  'duplicate provider tool call returns the durable existing handoff'
);
select extensions.lives_ok(
  $$ select * from public.bootstrap_inbound_voice_call('evt_voice_replay_1', 'realtime.call.incoming', 'rtc_voice_replay', 'sip_voice_replay', '+14155550123', '+14155550199') $$,
  'service backend bootstraps one routed provider call'
);
select extensions.is(
  (select is_duplicate from public.bootstrap_inbound_voice_call('evt_voice_replay_1', 'realtime.call.incoming', 'rtc_voice_replay', 'sip_voice_replay', '+14155550123', '+14155550199')),
  true,
  'same provider event replays without a second bootstrap'
);
select extensions.is(
  (select is_duplicate from public.bootstrap_inbound_voice_call('evt_voice_replay_2', 'realtime.call.incoming', 'rtc_voice_replay', 'sip_voice_replay', '+14155550123', '+14155550199')),
  true,
  'same provider call identity replays without a unique-constraint failure'
);

reset role;
select extensions.is(
  (select count(*)::integer from public.handoffs where call_id = '61600000-0000-0000-0000-000000000001'),
  1,
  'model and safety paths produce one handoff for the first call'
);
select extensions.is(
  (select count(*)::integer from public.handoffs where call_id = '61600000-0000-0000-0000-000000000002'),
  1,
  'model and safety paths produce one handoff for the second call'
);
select extensions.is(
  (select count(*)::integer from public.handoffs where organization_id = '61000000-0000-0000-0000-000000000001'),
  2,
  'different calls retain separate operational handoffs'
);
select extensions.is(
  (select count(*)::integer from public.calls where provider = 'openai-realtime-sip' and external_call_id = 'rtc_voice_replay'),
  1,
  'provider-call replay creates one call, conversation, and contact path'
);

select * from extensions.finish();
rollback;

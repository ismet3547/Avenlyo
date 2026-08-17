-- Phase 7 messaging tenant isolation, public-token, and durable processing checks.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(22);

insert into auth.users (id, email)
values
  ('90000000-0000-0000-0000-000000000001', 'messaging-owner@example.test'),
  ('90000000-0000-0000-0000-000000000002', 'messaging-member@example.test'),
  ('90000000-0000-0000-0000-000000000003', 'messaging-owner-b@example.test');
insert into public.users (id, email)
select id, email from auth.users where id between '90000000-0000-0000-0000-000000000001' and '90000000-0000-0000-0000-000000000003'
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values
  ('91000000-0000-0000-0000-000000000001', 'Messaging A', 'messaging-a', '90000000-0000-0000-0000-000000000001', 'veterinary'),
  ('92000000-0000-0000-0000-000000000001', 'Messaging B', 'messaging-b', '90000000-0000-0000-0000-000000000003', 'medspa');
insert into public.locations (id, organization_id, name, timezone)
values
  ('91100000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Messaging A one', 'UTC'),
  ('91200000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Messaging A two', 'UTC'),
  ('92100000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'Messaging B one', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values
  ('91300000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 'owner'),
  ('91300000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000002', 'member'),
  ('92300000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000003', 'owner');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('91000000-0000-0000-0000-000000000001', '91300000-0000-0000-0000-000000000002', '91100000-0000-0000-0000-000000000001');
insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled)
values
  ('91400000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '+14155550901', 'active', true),
  ('91400000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', '91200000-0000-0000-0000-000000000001', '+14155550902', 'active', true),
  ('92400000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', '92100000-0000-0000-0000-000000000001', '+14155550903', 'active', true);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000001', '+14155550101', '+14155550901', 'Hello', '[]', '{}')),
  true,
  'trusted webhook routes an SMS only through a configured SMS DID'
);
select extensions.is(
  (select is_duplicate from public.bootstrap_inbound_sms('SM00000000000000000000000000000001', '+14155550101', '+14155550901', 'Hello', '[]', '{}')),
  true,
  'Twilio MessageSid replay is idempotent'
);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000002', '+14155550102', '+14155550902', 'Location two', '[]', '{}')),
  true,
  'a second configured DID creates its own location-scoped SMS conversation'
);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000003', '+14155550103', '+14155550903', 'STOP', '[]', '{}')),
  true,
  'STOP is durably received through the trusted webhook path'
);
select extensions.is(
  (select status from public.messaging_contact_preferences preference join public.contacts contact on contact.id = preference.contact_id where contact.phone = '+14155550103'),
  'opted_out',
  'STOP persists an SMS opt-out preference'
);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000004', '+14155550103', '+14155550903', 'START', '[]', '{}')),
  true,
  'START is accepted through the trusted webhook path'
);
select extensions.is(
  (select status from public.messaging_contact_preferences preference join public.contacts contact on contact.id = preference.contact_id where contact.phone = '+14155550103'),
  'active',
  'START restores the explicit SMS preference'
);
select extensions.is(
  (select count(*)::integer from public.message_processing_jobs job join public.messages message on message.id = job.message_id where message.external_id = 'SM00000000000000000000000000000001' and job.job_kind = 'inbound_ai'),
  1,
  'exactly one durable inbound AI job is created for a MessageSid'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);

select extensions.is(
  (select count(*)::integer from public.get_my_inbox_conversations(null)),
  1,
  'location-scoped member sees only their assigned location inbox conversation'
);
select extensions.is_empty(
  $$ select * from public.get_my_inbox_conversations('91200000-0000-0000-0000-000000000001') $$,
  'location-scoped member cannot read another location inbox list'
);
select extensions.throws_ok(
  $$ select public.take_over_my_conversation((select conversation_id from public.get_my_inbox_conversations('91200000-0000-0000-0000-000000000001') limit 1)) $$,
  '42501',
  'Conversation is not available',
  'location-scoped member cannot take over another location conversation'
);
select extensions.is_empty(
  $$ update public.messages set body = 'forged confirmation' where source_channel = 'sms' returning id $$,
  'authenticated clients cannot directly mutate durable message state'
);
select extensions.throws_ok(
  $$ select * from public.claim_message_processing_jobs('untrusted-worker', 1) $$,
  '42501',
  'permission denied for function claim_message_processing_jobs',
  'authenticated clients cannot claim messaging jobs'
);

select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select public.take_over_my_conversation((select conversation_id from public.get_my_inbox_conversations('91100000-0000-0000-0000-000000000001') limit 1)) $$,
  'owner can take over a permitted conversation through the audited RPC'
);
select extensions.is(
  (select ai_mode from public.conversations where location_id = '91100000-0000-0000-0000-000000000001' order by created_at limit 1),
  'human',
  'takeover stops automatic replies for the conversation'
);
select extensions.lives_ok(
  $$ select public.resume_my_conversation_ai((select conversation_id from public.get_my_inbox_conversations('91100000-0000-0000-0000-000000000001') limit 1)) $$,
  'owner can resume AI without fabricating an immediate reply'
);

reset role;
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status)
values ('91500000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', 'web', 'Website chat', 'active');
insert into public.web_chat_widgets (id, organization_id, location_id, channel_id, public_key, enabled, allowed_origins)
values ('91600000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '91500000-0000-0000-0000-000000000001', '91600000-0000-0000-0000-000000000002', true, '["https://clinic.example"]');

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select extensions.throws_ok(
  $$ select * from public.create_web_chat_session('91600000-0000-0000-0000-000000000002', 'https://evil.example', repeat('a', 64), repeat('b', 64)) $$,
  '42501',
  'Web chat widget is not available for this origin',
  'public web chat session rejects an unconfigured exact origin'
);
select extensions.lives_ok(
  $$ select * from public.create_web_chat_session('91600000-0000-0000-0000-000000000002', 'https://clinic.example/', repeat('c', 64), repeat('d', 64)) $$,
  'public web chat session accepts a normalized configured HTTPS origin'
);
select extensions.is(
  (select is_duplicate from public.append_web_chat_message(repeat('c', 64), 'https://clinic.example', '91600000-0000-0000-0000-000000000003', 'Hello from web chat', repeat('e', 64))),
  false,
  'first public client UUID persists one inbound web message'
);
select extensions.is(
  (select is_duplicate from public.append_web_chat_message(repeat('c', 64), 'https://clinic.example', '91600000-0000-0000-0000-000000000003', 'Hello from web chat', repeat('e', 64))),
  true,
  'public client UUID replay does not create another web message'
);
select extensions.throws_ok(
  $$ select * from public.get_web_chat_messages(repeat('c', 64), 'https://evil.example', null) $$,
  '42501',
  'Web chat session is unavailable',
  'public session token cannot be replayed from another origin'
);
select extensions.throws_ok(
  $$ select * from public.web_chat_sessions $$,
  '42501',
  'permission denied for table web_chat_sessions',
  'anon cannot inspect opaque web chat session rows directly'
);

select * from extensions.finish();
rollback;

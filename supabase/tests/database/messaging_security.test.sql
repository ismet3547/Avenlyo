-- Phase 7 messaging tenant isolation, public-token, and durable processing checks.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(69);

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
insert into public.conversations (id, organization_id, location_id, mode, test_owner_user_id, status)
values
  ('91700000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', 'test', '90000000-0000-0000-0000-000000000001', 'open'),
  ('92700000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', '92100000-0000-0000-0000-000000000001', 'customer', null, 'open');
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
reset role;
select extensions.is(
  (select status from public.messaging_contact_preferences preference join public.contacts contact on contact.id = preference.contact_id where contact.phone = '+14155550103'),
  'opted_out',
  'STOP persists an SMS opt-out preference'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000004', '+14155550103', '+14155550903', 'START', '[]', '{}')),
  true,
  'START is accepted through the trusted webhook path'
);
reset role;
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
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.bootstrap_inbound_sms('SM00000000000000000000000000000005', '+14155550104', '+14155550901', 'Photo attached', '[{"content_type":"image/jpeg","url":"https://api.twilio.test/private-media"}]', '{}') $$,
  'text plus media is persisted without fetching provider media'
);
reset role;
select extensions.ok(
  (select metadata::text not like '%private-media%' from public.messages where external_id = 'SM00000000000000000000000000000005'),
  'Twilio MediaUrl values are never persisted in message metadata'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.bootstrap_inbound_sms('SM00000000000000000000000000000006', '+14155550105', '+14155550901', '', '[{"content_type":"image/jpeg"}]', '{}') $$,
  'media-only inbound event is persisted through the deterministic safe path'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.message_processing_jobs job join public.messages message on message.id = job.message_id where message.message_type = 'media' and job.job_kind = 'inbound_ai'),
  0,
  'media-only inbound SMS never enqueues the OpenAI text agent'
);
select extensions.is(
  (select count(*)::integer from public.handoffs handoff join public.messages message on message.conversation_id = handoff.conversation_id
    where message.external_id = 'SM00000000000000000000000000000006' and handoff.idempotency_key = 'message:' || message.id::text || ':media-unsupported'),
  1,
  'media-only SMS creates exactly one durable human handoff'
);
select extensions.is(
  (select conversation.ai_mode from public.conversations conversation join public.messages message on message.conversation_id = conversation.id
    where message.external_id = 'SM00000000000000000000000000000006'),
  'human',
  'media-only SMS stops automatic replies while a human follows up'
);
select extensions.is(
  (select count(*)::integer from public.messages reply join public.messages inbound on inbound.id = reply.in_reply_to_message_id
    where inbound.external_id = 'SM00000000000000000000000000000006' and reply.author_type = 'system'),
  1,
  'media-only SMS has exactly one deterministic acknowledgement'
);
update public.contacts set phone = '+14155550155' where phone = '+14155550105';
select extensions.is(
  (select transport_sender_e164 from public.messages where external_id = 'SM00000000000000000000000000000006'),
  '+14155550105',
  'inbound SMS retains the verified Twilio From value after the contact phone changes'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000008', '+14155550107', '+14155550901', 'Please connect me to a person', '[]', '{}')),
  true,
  'handoff test inbound SMS is accepted through the trusted ingress'
);
select extensions.is(
  (select created from public.request_message_handoff(
    (select message_id from public.bootstrap_inbound_sms(
      'SM00000000000000000000000000000008', '+14155550107', '+14155550901',
      'Please connect me to a person', '[]', '{}'
    )),
    'handoff-test', 'Customer requested a person', 'normal'
  )),
  true,
  'requesting a handoff immediately changes the conversation mode'
);
select extensions.lives_ok(
  $$ select * from public.persist_ai_message_reply(
    (select message_id from public.bootstrap_inbound_sms(
      'SM00000000000000000000000000000008', '+14155550107', '+14155550901',
      'Please connect me to a person', '[]', '{}'
    )),
    'A team member will help shortly.', true
  ) $$,
  'the triggering inbound turn may receive its one handoff acknowledgement after mode changes'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.messages reply join public.messages inbound on inbound.id = reply.in_reply_to_message_id
    where inbound.external_id = 'SM00000000000000000000000000000008' and reply.author_type = 'ai'),
  1,
  'handoff acknowledgement replay cannot create a second AI reply'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.persist_ai_message_reply(
    (select message_id from public.bootstrap_inbound_sms(
      'SM00000000000000000000000000000008', '+14155550107', '+14155550901',
      'Please connect me to a person', '[]', '{}'
    )),
    'A team member will help shortly.', true
  )),
  false,
  'replaying the exact handoff acknowledgement returns the original reply without duplication'
);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000009', '+14155550107', '+14155550901', 'Are you still there?', '[]', '{}')),
  true,
  'a later inbound message remains durable after handoff'
);
select extensions.is(
  (select created from public.persist_ai_message_reply(
    (select message_id from public.bootstrap_inbound_sms(
      'SM00000000000000000000000000000009', '+14155550107', '+14155550901',
      'Are you still there?', '[]', '{}'
    )),
    'This must not be sent after staff takeover.', false
  )),
  false,
  'late ordinary AI persistence is blocked after the conversation enters human mode'
);
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.bootstrap_inbound_sms('SM00000000000000000000000000000007', '+14155550106', '+14155550901', 'hello', '[]', '{"opt_out_type":"stop"}') $$,
  'trusted provider STOP metadata is handled before the agent path'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.message_processing_jobs job join public.messages message on message.id = job.message_id where message.external_id = 'SM00000000000000000000000000000007' and job.job_kind = 'inbound_ai'),
  0,
  'provider-handled STOP never enqueues an AI job'
);
reset role;
select extensions.throws_ok(
  $$
    insert into public.messages (organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type, in_reply_to_message_id)
    select '91000000-0000-0000-0000-000000000001', '91200000-0000-0000-0000-000000000001', second_conversation.id,
      'outbound', 'text', 'Forged cross-conversation reply', 'sms', 'ai', first_message.id
    from public.conversations second_conversation cross join public.messages first_message
    where second_conversation.transport_phone_number_id = '91400000-0000-0000-0000-000000000002'
      and first_message.external_id = 'SM00000000000000000000000000000001'
  $$,
  '23503',
  'insert or update on table "messages" violates foreign key constraint "messages_reply_conversation_scope_fk"',
  'a reply cannot point at an inbound message from another conversation in the same organization'
);
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, in_reply_to_message_id)
select '91800000-0000-0000-0000-000000000001', conversation.organization_id, conversation.location_id, conversation.id, conversation.contact_id,
  'outbound', 'text', 'Durable test reply', 'sms', 'system', inbound.id
from public.conversations conversation
join public.messages inbound on inbound.organization_id = conversation.organization_id and inbound.conversation_id = conversation.id
  and inbound.external_id = 'SM00000000000000000000000000000001'
where conversation.transport_phone_number_id = '91400000-0000-0000-0000-000000000001';
insert into public.message_deliveries (id, organization_id, location_id, message_id, provider)
select '91800000-0000-0000-0000-000000000002', organization_id, location_id, id, 'twilio' from public.messages where id = '91800000-0000-0000-0000-000000000001';
insert into public.message_processing_jobs (id, organization_id, location_id, conversation_id, message_id, job_kind, status, claimed_at, claimed_by)
select '91800000-0000-0000-0000-000000000003', organization_id, location_id, conversation_id, id, 'outbound_delivery', 'processing', now() - interval '6 minutes', 'crashed-worker'
from public.messages where id = '91800000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission('91800000-0000-0000-0000-000000000001')),
  1,
  'only queued to submitting atomically authorizes a Twilio provider post'
);
reset role;
select extensions.is(
  (select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000002'),
  'submitting',
  'a crash-window delivery is durably marked submitting before the provider request'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.claim_message_processing_jobs('recovery-worker', 1);
reset role;
select extensions.is(
  (select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000002'),
  'unknown',
  'stale submitting delivery becomes unknown instead of authorizing a second provider post'
);
select extensions.is(
  (select status from public.message_processing_jobs where id = '91800000-0000-0000-0000-000000000003'),
  'completed',
  'stale crash-window outbound job is finalized without a resend'
);

insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type)
select '91800000-0000-0000-0000-000000000010', organization_id, location_id, id, 'outbound', 'text', 'Delivery one', 'sms', 'system'
from public.conversations where transport_phone_number_id = '91400000-0000-0000-0000-000000000001' limit 1;
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type)
select '91800000-0000-0000-0000-000000000011', organization_id, location_id, id, 'outbound', 'text', 'Delivery two', 'sms', 'system'
from public.conversations where transport_phone_number_id = '91400000-0000-0000-0000-000000000001' limit 1;
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type)
select '91800000-0000-0000-0000-000000000012', organization_id, location_id, id, 'outbound', 'text', 'Delivery three', 'sms', 'system'
from public.conversations where transport_phone_number_id = '91400000-0000-0000-0000-000000000001' limit 1;
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type)
select '91800000-0000-0000-0000-000000000013', organization_id, location_id, id, 'outbound', 'text', 'Delivery four', 'sms', 'system'
from public.conversations where transport_phone_number_id = '91400000-0000-0000-0000-000000000001' limit 1;
insert into public.message_deliveries (id, organization_id, location_id, message_id, provider, provider_message_id, status)
values
  ('91800000-0000-0000-0000-000000000020', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '91800000-0000-0000-0000-000000000010', 'twilio', 'SM00000000000000000000000000000010', 'queued'),
  ('91800000-0000-0000-0000-000000000021', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '91800000-0000-0000-0000-000000000011', 'twilio', 'SM00000000000000000000000000000011', 'queued'),
  ('91800000-0000-0000-0000-000000000022', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '91800000-0000-0000-0000-000000000012', 'twilio', 'SM00000000000000000000000000000012', 'sent'),
  ('91800000-0000-0000-0000-000000000023', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '91800000-0000-0000-0000-000000000013', 'twilio', 'SM00000000000000000000000000000013', 'failed');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_twilio_message_status('SM00000000000000000000000000000010', 'sent');
select public.record_twilio_message_status('SM00000000000000000000000000000011', 'failed', '30001');
select public.record_twilio_message_status('SM00000000000000000000000000000012', 'delivered');
reset role;
select extensions.is((select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000020'), 'sent', 'queued delivery may transition to sent');
select extensions.is((select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000021'), 'failed', 'queued delivery may transition to failed');
select extensions.is((select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000022'), 'delivered', 'sent delivery may transition to delivered');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_twilio_message_status('SM00000000000000000000000000000010', 'undelivered', '30002');
reset role;
select extensions.is((select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000020'), 'undelivered', 'sent delivery may transition to undelivered');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_twilio_message_status('SM00000000000000000000000000000012', 'failed', '30003');
reset role;
select extensions.is((select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000022'), 'delivered', 'delivered delivery ignores a later failed callback');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_twilio_message_status('SM00000000000000000000000000000013', 'sent');
reset role;
select extensions.is((select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000023'), 'failed', 'failed delivery ignores a later sent callback');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_twilio_message_status('SM00000000000000000000000000000010', 'sent');
reset role;
select extensions.is((select status from public.message_deliveries where id = '91800000-0000-0000-0000-000000000020'), 'undelivered', 'late older callbacks do not reopen a terminal delivery');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);

select extensions.is(
  (select exists(select 1 from public.get_my_inbox_conversations(null) inbox where inbox.contact_phone = '+14155550101')),
  true,
  'location-scoped member sees an authorized customer conversation at their assigned location'
);
select extensions.is(
  (select count(*)::integer from public.conversations conversation join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id where conversation.organization_id = '91000000-0000-0000-0000-000000000001' and conversation.location_id = '91100000-0000-0000-0000-000000000001' and conversation.mode = 'customer' and contact.phone = '+14155550101'),
  1,
  'location-scoped member can directly read the authorized operational customer conversation'
);
select extensions.is(
  (select count(*)::integer from public.conversations where organization_id = '91000000-0000-0000-0000-000000000001' and location_id = '91200000-0000-0000-0000-000000000001'),
  0,
  'location-scoped member cannot read an unrelated location conversation'
);
select extensions.is(
  (select count(*)::integer from public.conversations where organization_id = '92000000-0000-0000-0000-000000000001'),
  0,
  'location-scoped member cannot read another organization conversation'
);
select extensions.is(
  (select count(*)::integer from public.conversations where id = '91700000-0000-0000-0000-000000000001'),
  0,
  'normal location member cannot read an internal test-mode conversation'
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
select extensions.is(
  (select count(*)::integer from public.conversations where id = '91700000-0000-0000-0000-000000000001'),
  1,
  'organization owner retains Phase 3 test-conversation visibility'
);
select extensions.lives_ok(
  $$ select public.take_over_my_conversation((select conversation_id from public.get_my_inbox_conversations('91100000-0000-0000-0000-000000000001') where contact_phone = '+14155550101' limit 1)) $$,
  'owner can take over a permitted conversation through the audited RPC'
);
select extensions.is(
  (select conversation.ai_mode from public.conversations conversation join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id where contact.phone = '+14155550101'),
  'human',
  'takeover stops automatic replies for the conversation'
);
select extensions.lives_ok(
  $$ select public.resume_my_conversation_ai((select conversation_id from public.get_my_inbox_conversations('91100000-0000-0000-0000-000000000001') where contact_phone = '+14155550101' limit 1)) $$,
  'owner can resume AI without fabricating an immediate reply'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM00000000000000000000000000000010', '+14155550101', '+14155550901', 'A newer inbound SMS', '[]', '{}')),
  true,
  'a second SMS from the same sender is accepted through the trusted route'
);
reset role;
update public.messages set created_at = created_at + interval '1 second', sent_at = sent_at + interval '1 second'
  where external_id = 'SM00000000000000000000000000000010';
select extensions.is(
  (select latest.conversation_id = first_message.conversation_id from public.messages latest
    cross join public.messages first_message
    where latest.external_id = 'SM00000000000000000000000000000010'
      and first_message.external_id = 'SM00000000000000000000000000000001'),
  true,
  'the newer inbound SMS belongs to the original conversation and route'
);
update public.contacts set phone = '+14155559999' where phone = '+14155550101';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select public.take_over_my_conversation((select conversation_id from public.messages where external_id = 'SM00000000000000000000000000000010')) $$,
  'owner can take over the trusted SMS conversation before replying'
);
select extensions.lives_ok(
  $$ select * from public.create_my_human_reply((select conversation_id from public.messages where external_id = 'SM00000000000000000000000000000010'), 'Human reply bound to the newest SMS') $$,
  'owner can create an SMS reply from the inbox through the trusted RPC'
);
reset role;
select extensions.is(
  (select reply.in_reply_to_message_id from public.messages reply where reply.body = 'Human reply bound to the newest SMS'),
  (select id from public.messages where external_id = 'SM00000000000000000000000000000010'),
  'human SMS reply binds to the latest eligible inbound SMS, not a contact field'
);
select extensions.is(
  (select count(*)::integer from public.message_deliveries delivery join public.messages reply on reply.id = delivery.message_id
    where reply.body = 'Human reply bound to the newest SMS' and delivery.provider = 'twilio' and delivery.status = 'queued'),
  1,
  'trusted human SMS reply creates exactly one queued Twilio delivery'
);
select set_config('test.human_sms_reply_id', (select id::text from public.messages where body = 'Human reply bound to the newest SMS'), true);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission(current_setting('test.human_sms_reply_id')::uuid)),
  1,
  'human SMS delivery claim authorizes exactly one provider submission'
);
select extensions.is(
  (select to_e164 from public.get_sms_delivery_execution_context(current_setting('test.human_sms_reply_id')::uuid)),
  '+14155550101',
  'human SMS delivery resolves the original immutable inbound Twilio From after contact mutation'
);
select extensions.is(
  (select from_e164 from public.get_sms_delivery_execution_context(current_setting('test.human_sms_reply_id')::uuid)),
  '+14155550901',
  'human SMS delivery resolves the conversation Twilio DID as its trusted sender'
);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission(current_setting('test.human_sms_reply_id')::uuid)),
  0,
  'human SMS delivery cannot authorize a second provider submission'
);
reset role;

insert into public.contacts (id, organization_id, location_id, phone)
values ('91800000-0000-0000-0000-000000000030', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '+14155550130');
insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, transport_phone_number_id, mode, status)
select '91800000-0000-0000-0000-000000000031', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001',
  '91800000-0000-0000-0000-000000000030', channel.id, '91400000-0000-0000-0000-000000000001', 'customer', 'open'
from public.channels channel
where channel.organization_id = '91000000-0000-0000-0000-000000000001' and channel.location_id = '91100000-0000-0000-0000-000000000001'
  and channel.channel_type = 'sms' and channel.status = 'active';
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type)
values ('91800000-0000-0000-0000-000000000032', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001',
  '91800000-0000-0000-0000-000000000031', '91800000-0000-0000-0000-000000000030', 'inbound', 'text', 'Untrusted legacy inbound', 'sms', 'customer');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select extensions.throws_ok(
  $$ select * from public.create_my_human_reply('91800000-0000-0000-0000-000000000031', 'This must not queue') $$,
  '42501',
  'SMS transport identity is unavailable',
  'human SMS replies without an immutable inbound transport identity are rejected before delivery creation'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.messages where body = 'This must not queue'),
  0,
  'missing SMS transport identity creates neither an outbound message nor an undeliverable provider delivery'
);

reset role;
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status)
values ('91500000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', 'web', 'Website chat', 'active');
insert into public.web_chat_widgets (id, organization_id, location_id, channel_id, public_key, enabled, allowed_origins)
values ('91600000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '91100000-0000-0000-0000-000000000001', '91500000-0000-0000-0000-000000000001', '91600000-0000-0000-0000-000000000002', true, '["https://clinic.example"]');

set local role anon;
select set_config('request.jwt.claim.role', 'anon', true);
select extensions.throws_ok(
  $$ select * from public.create_web_chat_session('91600000-0000-0000-0000-000000000002', 'https://clinic.example', repeat('a', 64), repeat('b', 64)) $$,
  '42501',
  'permission denied for function create_web_chat_session',
  'anon cannot bypass Fastify and create an internal web chat session'
);
select extensions.throws_ok(
  $$ select * from public.web_chat_sessions $$,
  '42501',
  'permission denied for table web_chat_sessions',
  'anon cannot inspect opaque web chat session rows directly'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select extensions.throws_ok(
  $$ select * from public.append_web_chat_message(repeat('c', 64), '91600000-0000-0000-0000-000000000003', 'Hello from web chat', repeat('e', 64)) $$,
  '42501',
  'permission denied for function append_web_chat_message',
  'authenticated callers cannot bypass Fastify and append a public web chat message'
);

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.create_web_chat_session('91600000-0000-0000-0000-000000000002', 'https://clinic.example/', repeat('c', 64), repeat('d', 64)) $$,
  'trusted backend creates a session for an exact configured HTTPS origin'
);
select extensions.throws_ok(
  $$ select * from public.create_web_chat_session('91600000-0000-0000-0000-000000000002', 'http://localhost:3000', repeat('f', 64), repeat('g', 64)) $$,
  '22023',
  'Web chat origin is invalid',
  'database configuration rejects HTTP localhost origins'
);
select extensions.is(
  (select count(*)::integer from (
    select * from public.append_web_chat_message(repeat('c', 64), '91600000-0000-0000-0000-000000000003', 'Hello from web chat', repeat('e', 64))
    union all
    select * from public.append_web_chat_message(repeat('c', 64), '91600000-0000-0000-0000-000000000003', 'Hello from web chat', repeat('e', 64))
  ) calls where not is_duplicate),
  1,
  'trusted backend preserves client-message idempotency for a session token hash'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.web_chat_sessions where token_hash = repeat('c', 64) and origin = 'https://clinic.example'),
  1,
  'web chat stores only the supplied SHA-256 token hash with its original allowed origin'
);

select * from extensions.finish();
rollback;

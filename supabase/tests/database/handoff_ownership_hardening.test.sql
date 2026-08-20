-- Phase 13 hardening: one serialization protocol for conversation ownership, automation paused by
-- the central handoff path, and a send boundary that human ownership always wins.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(44);

insert into auth.users (id, email) values
  ('c0000000-0000-0000-0000-000000000001', 'ownership-owner@example.test'),
  ('c0000000-0000-0000-0000-000000000002', 'ownership-operator-a@example.test'),
  ('c0000000-0000-0000-0000-000000000003', 'ownership-operator-b@example.test');
insert into public.users (id, email, display_name) values
  ('c0000000-0000-0000-0000-000000000001', 'ownership-owner@example.test', 'Odette Owner'),
  ('c0000000-0000-0000-0000-000000000002', 'ownership-operator-a@example.test', 'Avery Operator'),
  ('c0000000-0000-0000-0000-000000000003', 'ownership-operator-b@example.test', 'Blake Operator')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('c1000000-0000-0000-0000-000000000001', 'Ownership Organization', 'ownership-org', 'c0000000-0000-0000-0000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name) values
  ('c1100000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'Ownership first location'),
  ('c1200000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'Ownership second location');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('c1300000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'owner'),
  ('c1300000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'member'),
  ('c1300000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003', 'member');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id) values
  ('c1000000-0000-0000-0000-000000000001', 'c1300000-0000-0000-0000-000000000002', 'c1100000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000001', 'c1300000-0000-0000-0000-000000000003', 'c1100000-0000-0000-0000-000000000001');

insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, provider, sms_enabled) values
  ('c1900000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', '+15205550901', 'active', 'twilio', true);
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status, configuration) values
  ('c1400000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'sms', 'Ownership SMS', 'active', '{}'),
  ('c1400000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'phone', 'Ownership voice', 'active', '{}');
insert into public.contacts (id, organization_id, location_id, first_name, phone) values
  ('c1500000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'Takeover caller', '+15205550101'),
  ('c1500000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'Resolved caller', '+15205550102'),
  ('c1500000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'Unclaimed caller', '+15205550103'),
  ('c1500000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'Submitted caller', '+15205550104'),
  ('c1500000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'Voice caller', '+15205550105');

-- Four SMS conversations exercise the send boundary, plus one voice conversation.
insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, transport_phone_number_id, mode, status) values
  ('c1600000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1500000-0000-0000-0000-000000000001', 'c1400000-0000-0000-0000-000000000001', 'c1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('c1600000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1500000-0000-0000-0000-000000000002', 'c1400000-0000-0000-0000-000000000001', 'c1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('c1600000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1500000-0000-0000-0000-000000000003', 'c1400000-0000-0000-0000-000000000001', 'c1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('c1600000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1500000-0000-0000-0000-000000000004', 'c1400000-0000-0000-0000-000000000001', 'c1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('c1600000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1500000-0000-0000-0000-000000000005', 'c1400000-0000-0000-0000-000000000002', null, 'customer', 'open');

insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('c1700000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000001', 'c1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'Are you open?', 'sms', 'customer', '+15205550101', now() - interval '10 minutes', now() - interval '10 minutes'),
  ('c1700000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000002', 'c1500000-0000-0000-0000-000000000002', 'inbound', 'text', 'I need a person.', 'sms', 'customer', '+15205550102', now() - interval '10 minutes', now() - interval '10 minutes'),
  ('c1700000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000003', 'c1500000-0000-0000-0000-000000000003', 'inbound', 'text', 'Please get someone.', 'sms', 'customer', '+15205550103', now() - interval '10 minutes', now() - interval '10 minutes'),
  ('c1700000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000004', 'c1500000-0000-0000-0000-000000000004', 'inbound', 'text', 'Any update?', 'sms', 'customer', '+15205550104', now() - interval '10 minutes', now() - interval '10 minutes');

insert into public.calls (id, organization_id, location_id, conversation_id, contact_id, phone_number_id, direction, status, provider, external_call_id, started_at) values
  ('c1800000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000005', 'c1500000-0000-0000-0000-000000000005', 'c1900000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'rtc_ownership_voice', now() - interval '2 minutes');

-- Every automated reply below is queued but not yet submitted to the provider.
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, in_reply_to_message_id, sent_at) values
  ('c1700000-0000-0000-0000-000000000101', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000001', 'c1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'Automated answer', 'sms', 'ai', 'c1700000-0000-0000-0000-000000000001', now()),
  ('c1700000-0000-0000-0000-000000000102', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000002', 'c1500000-0000-0000-0000-000000000002', 'outbound', 'text', 'Automated answer', 'sms', 'ai', 'c1700000-0000-0000-0000-000000000002', now()),
  ('c1700000-0000-0000-0000-000000000103', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000003', 'c1500000-0000-0000-0000-000000000003', 'outbound', 'text', 'A team member will help shortly.', 'sms', 'ai', 'c1700000-0000-0000-0000-000000000003', now()),
  ('c1700000-0000-0000-0000-000000000104', 'c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1600000-0000-0000-0000-000000000004', 'c1500000-0000-0000-0000-000000000004', 'outbound', 'text', 'Automated answer', 'sms', 'ai', 'c1700000-0000-0000-0000-000000000004', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider) values
  ('c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1700000-0000-0000-0000-000000000101', 'twilio'),
  ('c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1700000-0000-0000-0000-000000000102', 'twilio'),
  ('c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1700000-0000-0000-0000-000000000103', 'twilio'),
  ('c1000000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-000000000001', 'c1700000-0000-0000-0000-000000000104', 'twilio');

-- The central creation path owns the pause invariant for every trusted caller.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('c1700000-0000-0000-0000-000000000002', 'tool-resolved', 'Customer asked for a person.', 'normal')),
  true,
  'a text escalation opens one durable episode'
);
select extensions.is(
  (select created from public.request_message_handoff('c1700000-0000-0000-0000-000000000003', 'tool-unclaimed', 'Customer asked for a person.', 'normal')),
  true,
  'a second conversation opens its own episode'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_ownership_voice', 'voice-tool-1', 'Caller asked for a person.', 'normal')),
  true,
  'voice ingress opens one durable episode'
);
reset role;

select extensions.is(
  (select ai_mode from public.conversations where id = 'c1600000-0000-0000-0000-000000000005'),
  'human',
  'a voice escalation pauses automation through the central creation path'
);
select extensions.ok(
  (select assigned_user_id is null from public.conversations where id = 'c1600000-0000-0000-0000-000000000005'),
  'requesting a person never invents a staff assignment'
);
select extensions.ok(
  (select assigned_user_id is null from public.handoffs where conversation_id = 'c1600000-0000-0000-0000-000000000005'),
  'a newly requested voice episode is unclaimed'
);
select extensions.is(
  (select status from public.calls where id = 'c1800000-0000-0000-0000-000000000001'),
  'in_progress',
  'a voice escalation does not mutate provider call state'
);
select extensions.is(
  (select count(*)::integer from public.messages where conversation_id = 'c1600000-0000-0000-0000-000000000005'),
  0,
  'a voice escalation creates no automatic message'
);
select extensions.ok(
  not exists (
    select 1 from public.conversations conversation
    join public.handoffs handoff on handoff.conversation_id = conversation.id
    where handoff.mode = 'customer' and handoff.status in ('open', 'acknowledged')
      and conversation.ai_mode <> 'human'
  ),
  'no customer conversation can hold an active episode while automation still owns it'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'conversation.human_takeover'
      and entity_id = 'c1600000-0000-0000-0000-000000000005'),
  1,
  'the ai to human transition is audited exactly once for a trusted handoff'
);
select extensions.is(
  (select details ->> 'trigger' from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'c1600000-0000-0000-0000-000000000005'),
  'handoff',
  'the transition audit records why automation was paused'
);
select extensions.ok(
  not exists (
    select 1 from public.action_logs
    where action = 'conversation.human_takeover' and details ?| array['reason', 'body', 'phone', 'transcript']
  ),
  'the transition audit carries no reason, message, phone, or transcript data'
);

-- Replay, escalation, and coalescing must not re-audit a transition that already happened.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_ownership_voice', 'voice-tool-2', 'Caller asked again.', 'urgent')),
  false,
  'a replayed voice tool call coalesces onto the durable episode'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'c1600000-0000-0000-0000-000000000005'),
  1,
  'coalescing and urgency escalation add no second transition audit'
);

-- Requirement C: an unclaimed episode must not suppress the acknowledgement it just produced.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission('c1700000-0000-0000-0000-000000000103')),
  1,
  'an unclaimed episode still lets its handoff acknowledgement reach the provider'
);
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = 'c1700000-0000-0000-0000-000000000103'),
  'submitting',
  'the acknowledgement crosses the provider boundary normally'
);

-- Requirement A: manual takeover with no active handoff still beats queued automation.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.take_over_my_conversation('c1600000-0000-0000-0000-000000000001')),
  'taken_over',
  'an operator takes over a conversation that has no active episode'
);
reset role;
select extensions.is(
  (select ai_mode from public.conversations where id = 'c1600000-0000-0000-0000-000000000001'),
  'human',
  'manual takeover pauses automation'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission('c1700000-0000-0000-0000-000000000101')),
  0,
  'a manual takeover with no handoff authorizes zero provider submissions'
);
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = 'c1700000-0000-0000-0000-000000000101'),
  'suppressed',
  'the stale automated SMS is suppressed after manual takeover'
);
select extensions.is(
  (select error_code from public.message_deliveries where message_id = 'c1700000-0000-0000-0000-000000000101'),
  'human_ownership_suppressed',
  'the suppression records human ownership as the reason'
);

-- Requirement B: a resolved episode leaves the conversation human-owned, and automation still loses.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'c1600000-0000-0000-0000-000000000002'))),
  'claimed',
  'an operator claims the episode'
);
select extensions.is(
  (select outcome from public.resolve_my_handoff(
    (select id from public.handoffs where conversation_id = 'c1600000-0000-0000-0000-000000000002'))),
  'resolved',
  'the operator resolves the episode'
);
reset role;
select extensions.is(
  (select ai_mode || ':' || coalesce(assigned_user_id::text, 'none') from public.conversations
    where id = 'c1600000-0000-0000-0000-000000000002'),
  'human:c0000000-0000-0000-0000-000000000002',
  'resolving keeps the conversation paused and owned by the operator'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission('c1700000-0000-0000-0000-000000000102')),
  0,
  'a resolved episode with a human-owned conversation authorizes zero provider submissions'
);
reset role;
select extensions.is(
  (select status || ':' || coalesce(error_code, 'none') from public.message_deliveries
    where message_id = 'c1700000-0000-0000-0000-000000000102'),
  'suppressed:human_ownership_suppressed',
  'the stale automated SMS is suppressed after the episode is resolved'
);

-- Requirement D: provider truth survives a later human takeover untouched.
update public.message_deliveries set status = 'submitted', attempted_at = now(), provider_message_id = 'SM00000000000000000000000000000501'
where message_id = 'c1700000-0000-0000-0000-000000000104';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.take_over_my_conversation('c1600000-0000-0000-0000-000000000004')),
  'taken_over',
  'an operator takes over a conversation whose automated reply already reached the provider'
);
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = 'c1700000-0000-0000-0000-000000000104'),
  'submitted',
  'human ownership never rewrites delivery state that already crossed the provider boundary'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission('c1700000-0000-0000-0000-000000000104')),
  0,
  'an already-submitted delivery cannot be claimed a second time'
);
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = 'c1700000-0000-0000-0000-000000000104'),
  'submitted',
  'the send boundary leaves submitted provider truth alone instead of suppressing it'
);

-- Ownership counting: the queue list and the headline number describe the same conversations.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select assigned_to_me from public.get_my_handoff_queue_summary('c1100000-0000-0000-0000-000000000001')),
  3,
  'assigned to you counts manual takeovers and resolved-but-owned conversations'
);
select extensions.is(
  (select count(*)::integer from public.get_my_handoff_queue('c1100000-0000-0000-0000-000000000001', 'mine', 60)),
  3,
  'the mine filter returns exactly the conversations the summary counted'
);
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000003', true);
select extensions.is(
  (select assigned_to_me from public.get_my_handoff_queue_summary('c1100000-0000-0000-0000-000000000001')),
  0,
  'another operator owns none of it'
);
select extensions.is(
  (select count(*)::integer from public.get_my_handoff_queue('c1100000-0000-0000-0000-000000000001', 'mine', 60)),
  0,
  'the mine filter agrees with the summary for a non-owner'
);
reset role;

-- A newly requested voice episode is never presented as "needs a human" while AI still answers.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
select extensions.ok(
  not exists (
    select 1 from public.get_my_handoff_queue('c1100000-0000-0000-0000-000000000001', 'all_active', 60) queue
    where queue.handoff_is_active and queue.ai_mode <> 'human'
  ),
  'the operator queue never shows an active episode alongside an AI-owned conversation'
);
reset role;

-- Tenant scope is enforced by the central path itself, not only by source-binding foreign keys.
select extensions.throws_ok(
  $$ select * from public.persist_active_conversation_handoff(
    'c1000000-0000-0000-0000-000000000001', 'c1200000-0000-0000-0000-000000000001',
    'c1600000-0000-0000-0000-000000000001', 'Mis-scoped escalation', 'normal',
    'scope:mismatched-location') $$,
  '42501', 'Handoff conversation is not available',
  'a handoff cannot be created against a location the conversation does not belong to'
);
select extensions.throws_ok(
  $$ select * from public.persist_active_conversation_handoff(
    'c1000000-0000-0000-0000-000000000001', null,
    'c1600000-0000-0000-0000-000000000001', 'Mis-scoped escalation', 'normal',
    'scope:null-location') $$,
  '42501', 'Handoff conversation is not available',
  'a null location cannot stand in for the durable conversation location'
);

-- The serialization protocol itself: every ownership mutation takes the shared advisory lock, and
-- takes it before any row lock, so the row-lock order can never form a cycle.
select extensions.ok(
  not exists (
    select 1 from unnest(array[
      'public.persist_active_conversation_handoff(uuid,uuid,uuid,text,text,text,uuid,uuid)',
      'public.apply_handoff_claim(uuid,uuid)',
      'public.claim_my_handoff(uuid)',
      'public.release_my_handoff(uuid)',
      'public.resolve_my_handoff(uuid)',
      'public.take_over_my_conversation(uuid)',
      'public.resume_my_conversation_ai(uuid)',
      'public.create_my_human_reply(uuid,text)',
      'public.persist_ai_message_reply(uuid,text,boolean)',
      'public.claim_sms_delivery_submission(uuid)'
    ]) as signature
    where pg_get_functiondef(signature::regprocedure) not like '%lock_conversation_ownership%'
  ),
  'every conversation ownership mutation serializes on the shared advisory lock'
);
select extensions.ok(
  not exists (
    select 1 from unnest(array[
      'public.persist_active_conversation_handoff(uuid,uuid,uuid,text,text,text,uuid,uuid)',
      'public.apply_handoff_claim(uuid,uuid)',
      'public.release_my_handoff(uuid)',
      'public.resolve_my_handoff(uuid)',
      'public.take_over_my_conversation(uuid)',
      'public.resume_my_conversation_ai(uuid)',
      'public.create_my_human_reply(uuid,text)',
      'public.persist_ai_message_reply(uuid,text,boolean)',
      'public.claim_sms_delivery_submission(uuid)'
    ]) as signature
    where position('lock_conversation_ownership' in pg_get_functiondef(signature::regprocedure))
      > position('for update' in pg_get_functiondef(signature::regprocedure))
  ),
  'the advisory lock is always acquired before the first row lock'
);

-- The shared protocol helpers are implementation, not a callable boundary.
select extensions.ok(not has_function_privilege('authenticated', 'public.lock_conversation_ownership(uuid)', 'execute'),
  'authenticated clients cannot take the ownership lock directly');
select extensions.ok(not has_function_privilege('service_role', 'public.lock_conversation_ownership(uuid)', 'execute'),
  'the trusted backend cannot take the ownership lock directly');
select extensions.ok(not has_function_privilege('authenticated', 'public.pause_conversation_automation(uuid,uuid,text)', 'execute'),
  'authenticated clients cannot pause automation directly');
select extensions.ok(not has_function_privilege('service_role', 'public.pause_conversation_automation(uuid,uuid,text)', 'execute'),
  'the trusted backend cannot pause automation outside the handoff path');
select extensions.ok(not has_function_privilege('anon', 'public.handoff_queue_row_is_mine(uuid,uuid,boolean,uuid)', 'execute'),
  'the ownership predicate is not exposed to anonymous callers');

select * from extensions.finish();
rollback;

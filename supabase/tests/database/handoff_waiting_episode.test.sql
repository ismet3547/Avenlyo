-- Phase 13 follow-up: customer waiting belongs to the current human-attention episode, and a staff
-- ownership acquisition is auditable even when no handoff covers it.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(51);

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'episode-owner@example.test'),
  ('a0000000-0000-0000-0000-000000000002', 'episode-operator@example.test');
insert into public.users (id, email, display_name) values
  ('a0000000-0000-0000-0000-000000000001', 'episode-owner@example.test', 'Odile Owner'),
  ('a0000000-0000-0000-0000-000000000002', 'episode-operator@example.test', 'Avery Operator')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('a1000000-0000-0000-0000-000000000001', 'Episode Organization', 'episode-org', 'a0000000-0000-0000-0000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name) values
  ('a1100000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Episode location');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('a1300000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'owner'),
  ('a1300000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'member');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id) values
  ('a1000000-0000-0000-0000-000000000001', 'a1300000-0000-0000-0000-000000000002', 'a1100000-0000-0000-0000-000000000001');

insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, provider, sms_enabled) values
  ('a1900000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', '+15305550901', 'active', 'twilio', true);
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status, configuration) values
  ('a1400000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'sms', 'Episode SMS', 'active', '{}'),
  ('a1400000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'phone', 'Episode voice', 'active', '{}');
insert into public.contacts (id, organization_id, location_id, first_name, phone) values
  ('a1500000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'Escalation caller', '+15305550101'),
  ('a1500000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'Takeover caller', '+15305550102'),
  ('a1500000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'Voice caller', '+15305550103'),
  ('a1500000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'Reply caller', '+15305550104');

insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, transport_phone_number_id, mode, status) values
  ('a1600000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'a1400000-0000-0000-0000-000000000001', 'a1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('a1600000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000002', 'a1400000-0000-0000-0000-000000000001', 'a1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('a1600000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000003', 'a1400000-0000-0000-0000-000000000002', null, 'customer', 'open'),
  ('a1600000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000004', 'a1400000-0000-0000-0000-000000000001', 'a1900000-0000-0000-0000-000000000001', 'customer', 'open');

-- Conversation 1 is an old automation-handled thread: three weeks of customer turns that the AI
-- already answered, then one new turn today that triggers a handoff.
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('a1700000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'What are your hours?', 'sms', 'customer', '+15305550101', now() - interval '21 days', now() - interval '21 days'),
  ('a1700000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'And do you take walk-ins?', 'sms', 'customer', '+15305550101', now() - interval '20 days', now() - interval '20 days'),
  ('a1700000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'My dog is limping badly.', 'sms', 'customer', '+15305550101', now() - interval '4 minutes', now() - interval '4 minutes');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, in_reply_to_message_id, created_at, sent_at) values
  ('a1700000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'We are open 8 to 6.', 'sms', 'ai', 'a1700000-0000-0000-0000-000000000001', now() - interval '21 days', now() - interval '21 days'),
  ('a1700000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'Yes, walk-ins are welcome.', 'sms', 'ai', 'a1700000-0000-0000-0000-000000000003', now() - interval '20 days', now() - interval '20 days');

-- Conversation 2 is also old, but a staff member takes it over manually with no handoff at all.
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('a1700000-0000-0000-0000-000000000011', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000002', 'a1500000-0000-0000-0000-000000000002', 'inbound', 'text', 'Old question', 'sms', 'customer', '+15305550102', now() - interval '30 days', now() - interval '30 days'),
  ('a1700000-0000-0000-0000-000000000012', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000002', 'a1500000-0000-0000-0000-000000000002', 'inbound', 'text', 'Recent question', 'sms', 'customer', '+15305550102', now() - interval '3 minutes', now() - interval '3 minutes');

-- Conversation 4 exercises human reply ownership acquisition with no handoff.
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('a1700000-0000-0000-0000-000000000021', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000004', 'a1500000-0000-0000-0000-000000000004', 'inbound', 'text', 'Can a person call me?', 'sms', 'customer', '+15305550104', now() - interval '2 minutes', now() - interval '2 minutes');

insert into public.calls (id, organization_id, location_id, conversation_id, contact_id, phone_number_id, direction, status, provider, external_call_id, started_at) values
  ('a1800000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000003', 'a1500000-0000-0000-0000-000000000003', 'a1900000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'rtc_episode_voice', now() - interval '1 minute');

select extensions.ok(
  (select human_attention_started_at is null from public.conversations where id = 'a1600000-0000-0000-0000-000000000001'),
  'an automation-owned conversation has no open human episode'
);
select extensions.ok(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001') is null),
  'an automation-owned conversation is never counted as keeping a customer waiting'
);

-- A: the episode anchors on the turn that caused it, not on three weeks of answered history.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('a1700000-0000-0000-0000-000000000005', 'tool-limping', 'Customer reports a limping dog.', 'urgent')),
  true,
  'the new customer turn opens a durable episode'
);
reset role;
select extensions.is(
  (select human_attention_started_at from public.conversations where id = 'a1600000-0000-0000-0000-000000000001'),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000005'),
  'the episode anchors on the trusted source message that triggered the handoff'
);
select extensions.is(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001')),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000005'),
  'waiting starts at the escalating turn, not at a question answered three weeks ago'
);
select extensions.ok(
  (select assigned_user_id is null from public.conversations where id = 'a1600000-0000-0000-0000-000000000001'),
  'opening an episode never invents a staff assignment'
);

-- B: the automated handoff acknowledgement is not human handling.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.persist_ai_message_reply('a1700000-0000-0000-0000-000000000005', 'A team member will help shortly.', true)),
  true,
  'the triggering turn still receives its one handoff acknowledgement'
);
reset role;
select extensions.is(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001')),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000005'),
  'an automated acknowledgement does not clear a waiting customer'
);

-- C: only a human-authored reply clears waiting.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'a1600000-0000-0000-0000-000000000001'))),
  'claimed',
  'an operator claims the episode'
);
reset role;
select extensions.is(
  (select human_attention_started_at from public.conversations where id = 'a1600000-0000-0000-0000-000000000001'),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000005'),
  'claiming stays inside the same episode and never re-anchors it'
);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.create_my_human_reply('a1600000-0000-0000-0000-000000000001', 'On our way, bring him in now.')),
  'sent',
  'the owning operator answers the customer'
);
reset role;
select extensions.ok(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001') is null),
  'a human reply clears the waiting customer'
);

-- D: a later customer turn starts waiting again from that turn.
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('a1700000-0000-0000-0000-000000000006', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'We are leaving now.', 'sms', 'customer', '+15305550101', now() + interval '1 second', now() + interval '1 second');
select extensions.is(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001')),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000006'),
  'a new customer turn after a human reply starts waiting from that turn'
);

-- E and F: resolving ends the escalation but not the episode.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.resolve_my_handoff(
    (select id from public.handoffs where conversation_id = 'a1600000-0000-0000-0000-000000000001'))),
  'resolved',
  'the operator resolves the escalation'
);
reset role;
select extensions.is(
  (select human_attention_started_at from public.conversations where id = 'a1600000-0000-0000-0000-000000000001'),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000005'),
  'resolving preserves the episode anchor'
);
select extensions.is(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001')),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000006'),
  'a customer still waiting after resolution keeps its current waiting turn'
);

-- G: resuming automation closes the episode.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.resume_my_conversation_ai('a1600000-0000-0000-0000-000000000001')),
  'resumed',
  'the operator explicitly resumes automation'
);
reset role;
select extensions.ok(
  (select human_attention_started_at is null and assigned_user_id is null and ai_mode = 'ai'
   from public.conversations where id = 'a1600000-0000-0000-0000-000000000001'),
  'resuming clears the episode anchor along with ownership'
);
select extensions.ok(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001') is null),
  'a resumed conversation keeps nobody waiting on a person'
);

-- H: a future escalation is a new episode that ignores the finished one.
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('a1700000-0000-0000-0000-000000000007', 'a1000000-0000-0000-0000-000000000001', 'a1100000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001', 'a1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'New problem next week.', 'sms', 'customer', '+15305550101', now() + interval '2 seconds', now() + interval '2 seconds');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('a1700000-0000-0000-0000-000000000007', 'tool-next', 'A new problem needs a person.', 'normal')),
  true,
  'a later escalation opens a second episode'
);
reset role;
select extensions.is(
  (select human_attention_started_at from public.conversations where id = 'a1600000-0000-0000-0000-000000000001'),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000007'),
  'the new episode anchors on its own triggering turn'
);
select extensions.is(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000001')),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000007'),
  'turns from the finished episode never become waiting work again'
);

-- I: a voice escalation with no text history invents no waiting timestamp.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_episode_voice', 'voice-tool-1', 'Caller asked for a person.', 'normal')),
  true,
  'voice ingress opens a durable episode'
);
reset role;
select extensions.ok(
  (select human_attention_started_at is not null from public.conversations where id = 'a1600000-0000-0000-0000-000000000003'),
  'a voice episode anchors on its own escalation time'
);
select extensions.ok(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000003') is null),
  'a voice episode with no customer text turns fabricates no waiting timestamp'
);

-- J: manual takeover of an old conversation anchors on the latest actionable turn.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.take_over_my_conversation('a1600000-0000-0000-0000-000000000002')),
  'taken_over',
  'an operator takes over an old automation-owned conversation'
);
reset role;
select extensions.is(
  (select human_attention_started_at from public.conversations where id = 'a1600000-0000-0000-0000-000000000002'),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000012'),
  'manual takeover anchors on the latest customer turn, not the oldest'
);
select extensions.is(
  (select public.conversation_customer_waiting_since('a1000000-0000-0000-0000-000000000001', 'a1600000-0000-0000-0000-000000000002')),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000012'),
  'a month-old answered question never becomes the moment the customer started waiting'
);

-- The queue read model and the episode derivation agree.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select waiting_since from public.get_my_handoff_queue('a1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'a1600000-0000-0000-0000-000000000002'),
  (select created_at from public.messages where id = 'a1700000-0000-0000-0000-000000000012'),
  'the queue read model reports the same waiting turn as the episode derivation'
);
select extensions.is(
  (select customer_waiting from public.get_my_handoff_queue('a1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'a1600000-0000-0000-0000-000000000003'),
  false,
  'the queue reports a voice episode with no text turns as not waiting'
);
reset role;

-- Ownership audits: an assignment acquisition is never audit-invisible.
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000002'
      and details ->> 'trigger' = 'staff'),
  1,
  'taking over an automation-owned conversation writes one ownership audit'
);
select extensions.is(
  (select details ->> 'transition' from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000002'
      and details ->> 'trigger' = 'staff'),
  'ai_to_human_owned',
  'the audit records that automation was paused and the conversation was taken'
);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.take_over_my_conversation('a1600000-0000-0000-0000-000000000002')),
  'taken_over',
  'the same operator takes over again'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000002'
      and details ->> 'trigger' = 'staff'),
  1,
  'a replayed takeover by the same owner writes no duplicate audit'
);

-- An already-human but unassigned conversation still records who took it.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select outcome from public.release_my_handoff(
    (select id from public.handoffs where conversation_id = 'a1600000-0000-0000-0000-000000000003'))),
  'released',
  'an unassigned voice episode stays unassigned after a release no-op'
);
reset role;
update public.handoffs set status = 'resolved', resolved_at = now()
where conversation_id = 'a1600000-0000-0000-0000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.take_over_my_conversation('a1600000-0000-0000-0000-000000000003')),
  'taken_over',
  'an operator takes an already-human unassigned conversation with no active episode'
);
reset role;
select extensions.is(
  (select details ->> 'transition' from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000003'
      and details ->> 'trigger' = 'staff'),
  'unassigned_to_human_owner',
  'acquiring an already-human conversation is audited as an ownership change'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000003'
      and details ->> 'trigger' = 'staff'),
  1,
  'the already-human acquisition writes exactly one audit'
);

-- A human reply that acquires ownership is audited too, and a second reply is not.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('a1700000-0000-0000-0000-000000000021', 'tool-reply-owner', 'Customer asked for a call back.', 'normal')),
  true,
  'the reply conversation opens an episode'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select outcome from public.resolve_my_handoff(
    (select id from public.handoffs where conversation_id = 'a1600000-0000-0000-0000-000000000004'))),
  'resolved',
  'an owner resolves an unclaimed episode without taking it'
);
reset role;
update public.conversations set assigned_user_id = null where id = 'a1600000-0000-0000-0000-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.create_my_human_reply('a1600000-0000-0000-0000-000000000004', 'Calling you now.')),
  'sent',
  'a human reply on an unassigned human-mode conversation succeeds'
);
reset role;
select extensions.is(
  (select details ->> 'transition' from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000004'
      and details ->> 'trigger' = 'human_reply'),
  'unassigned_to_human_owner',
  'a reply that acquires ownership is audited as an ownership change'
);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.create_my_human_reply('a1600000-0000-0000-0000-000000000004', 'One more note.')),
  'sent',
  'the same operator replies again'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000004'
      and details ->> 'trigger' = 'human_reply'),
  1,
  'replying again when already the owner writes no duplicate audit'
);

-- Claiming an active handoff is audited as a handoff transition, not as a second conversation one.
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'handoff.claimed'
      and entity_id = (select id from public.handoffs where conversation_id = 'a1600000-0000-0000-0000-000000000001' and status <> 'resolved')),
  0,
  'an unclaimed episode has written no claim audit yet'
);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'a1600000-0000-0000-0000-000000000001' and status <> 'resolved'))),
  'claimed',
  'the operator claims the second episode'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'handoff.claimed'
      and entity_id = (select id from public.handoffs where conversation_id = 'a1600000-0000-0000-0000-000000000001' and status <> 'resolved')),
  1,
  'claiming an active handoff writes exactly one handoff ownership audit'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'conversation.human_takeover' and entity_id = 'a1600000-0000-0000-0000-000000000001'
      and details ->> 'trigger' = 'staff'),
  0,
  'claiming an active handoff writes no redundant conversation ownership audit'
);
select extensions.ok(
  not exists (
    select 1 from public.action_logs
    where action = 'conversation.human_takeover'
      and details ?| array['reason', 'body', 'phone', 'transcript', 'message']
  ),
  'ownership audits carry no reason, message, phone, or transcript data'
);

-- The episode anchor is ownership state, not client state.
select extensions.ok(not has_function_privilege('authenticated', 'public.acquire_conversation_ownership(uuid,uuid,text,timestamptz)', 'execute'),
  'authenticated clients cannot acquire ownership outside the narrow RPCs');
select extensions.ok(not has_function_privilege('service_role', 'public.latest_customer_turn_at(uuid,uuid)', 'execute'),
  'the episode anchor helper is internal to every role');

select * from extensions.finish();
rollback;

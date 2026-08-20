-- Phase 13 human handoff operations: one active episode per customer conversation, atomic staff
-- ownership, and the separation between resolving an episode and resuming AI.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(103);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-000000000001', 'handoff-owner@example.test'),
  ('d0000000-0000-0000-0000-000000000002', 'handoff-operator-a@example.test'),
  ('d0000000-0000-0000-0000-000000000003', 'handoff-operator-b@example.test'),
  ('d0000000-0000-0000-0000-000000000004', 'handoff-other-location@example.test'),
  ('d0000000-0000-0000-0000-000000000005', 'handoff-owner-b@example.test');
insert into public.users (id, email, display_name) values
  ('d0000000-0000-0000-0000-000000000001', 'handoff-owner@example.test', 'Dana Owner'),
  ('d0000000-0000-0000-0000-000000000002', 'handoff-operator-a@example.test', 'Avery Operator'),
  ('d0000000-0000-0000-0000-000000000003', 'handoff-operator-b@example.test', 'Blake Operator'),
  ('d0000000-0000-0000-0000-000000000004', 'handoff-other-location@example.test', 'Casey Elsewhere'),
  ('d0000000-0000-0000-0000-000000000005', 'handoff-owner-b@example.test', 'Erin Owner')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('d1000000-0000-0000-0000-000000000001', 'Handoff Organization A', 'handoff-org-a', 'd0000000-0000-0000-0000-000000000001', 'veterinary'),
  ('d2000000-0000-0000-0000-000000000001', 'Handoff Organization B', 'handoff-org-b', 'd0000000-0000-0000-0000-000000000005', 'medspa');

-- Phase 17 makes production automation require an entitled Core subscription, so every
-- organization these existing guarantees run against carries one.  Billing is a separate
-- execution condition: nothing else about the fixtures below changes.
insert into public.billing_accounts (organization_id, stripe_customer_id, livemode, billing_state) values
  ('d1000000-0000-0000-0000-000000000001', 'cus_entitled_d1000000', false, 'active'),
  ('d2000000-0000-0000-0000-000000000001', 'cus_entitled_d2000000', false, 'active');
insert into public.billing_subscriptions (organization_id, stripe_customer_id, stripe_subscription_id,
  stripe_product_id, stripe_price_id, plan_key, is_supported, stripe_status, livemode) values
  ('d1000000-0000-0000-0000-000000000001', 'cus_entitled_d1000000', 'sub_entitled_d1000000', 'prod_core', 'price_core', 'core', true, 'active', false),
  ('d2000000-0000-0000-0000-000000000001', 'cus_entitled_d2000000', 'sub_entitled_d2000000', 'prod_core', 'price_core', 'core', true, 'active', false);
insert into public.locations (id, organization_id, name) values
  ('d1100000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'Handoff A first location'),
  ('d1200000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'Handoff A second location'),
  ('d2100000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'Handoff B location');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('d1300000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'owner'),
  ('d1300000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'member'),
  ('d1300000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003', 'member'),
  ('d1300000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000004', 'member'),
  ('d2300000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000005', 'owner');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id) values
  ('d1000000-0000-0000-0000-000000000001', 'd1300000-0000-0000-0000-000000000002', 'd1100000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000001', 'd1300000-0000-0000-0000-000000000003', 'd1100000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000001', 'd1300000-0000-0000-0000-000000000004', 'd1200000-0000-0000-0000-000000000001');

insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, provider, sms_enabled) values
  ('d1900000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', '+15105550901', 'active', 'twilio', true);
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status, configuration) values
  ('d1400000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'sms', 'Handoff SMS', 'active', '{}'),
  ('d1400000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'phone', 'Handoff voice', 'active', '{}'),
  ('d1400000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'd1200000-0000-0000-0000-000000000001', 'sms', 'Handoff SMS second location', 'active', '{}'),
  ('d1400000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'web', 'Handoff web chat', 'active', '{}');
insert into public.contacts (id, organization_id, location_id, first_name, phone) values
  ('d1500000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'Urgent caller', '+15105550101'),
  ('d1500000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'Normal caller', '+15105550102'),
  ('d1500000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'd1200000-0000-0000-0000-000000000001', 'Second location caller', '+15105550103'),
  ('d1500000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'Voice caller', '+15105550104');

insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, transport_phone_number_id, mode, status) values
  ('d1600000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1500000-0000-0000-0000-000000000001', 'd1400000-0000-0000-0000-000000000001', 'd1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('d1600000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1500000-0000-0000-0000-000000000002', 'd1400000-0000-0000-0000-000000000001', 'd1900000-0000-0000-0000-000000000001', 'customer', 'open'),
  ('d1600000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1500000-0000-0000-0000-000000000004', 'd1400000-0000-0000-0000-000000000002', null, 'customer', 'open'),
  ('d1600000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000001', 'd1200000-0000-0000-0000-000000000001', 'd1500000-0000-0000-0000-000000000003', 'd1400000-0000-0000-0000-000000000003', null, 'customer', 'open'),
  ('d1600000-0000-0000-0000-000000000005', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1500000-0000-0000-0000-000000000002', 'd1400000-0000-0000-0000-000000000004', null, 'customer', 'open');
insert into public.conversations (id, organization_id, location_id, channel_id, mode, status, test_owner_user_id) values
  ('d1600000-0000-0000-0000-000000000009', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1400000-0000-0000-0000-000000000001', 'test', 'open', 'd0000000-0000-0000-0000-000000000001');

insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('d1700000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1600000-0000-0000-0000-000000000001', 'd1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'My pet is bleeding', 'sms', 'customer', '+15105550101', now() - interval '30 minutes', now() - interval '30 minutes'),
  ('d1700000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1600000-0000-0000-0000-000000000002', 'd1500000-0000-0000-0000-000000000002', 'inbound', 'text', 'Can someone call me back', 'sms', 'customer', '+15105550102', now() - interval '20 minutes', now() - interval '20 minutes'),
  ('d1700000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001', 'd1200000-0000-0000-0000-000000000001', 'd1600000-0000-0000-0000-000000000004', 'd1500000-0000-0000-0000-000000000003', 'inbound', 'text', 'Second location question', 'sms', 'customer', '+15105550103', now() - interval '15 minutes', now() - interval '15 minutes');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, created_at, sent_at) values
  ('d1700000-0000-0000-0000-000000000010', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1600000-0000-0000-0000-000000000005', 'd1500000-0000-0000-0000-000000000002', 'inbound', 'text', 'Still waiting on an answer', 'web', 'customer', now() - interval '9 minutes', now() - interval '9 minutes');

insert into public.calls (id, organization_id, location_id, conversation_id, contact_id, phone_number_id, direction, status, provider, external_call_id, started_at) values
  ('d1800000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1600000-0000-0000-0000-000000000003', 'd1500000-0000-0000-0000-000000000004', 'd1900000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'rtc_handoff_voice_one', now() - interval '4 minutes');

-- Source binding integrity: a handoff may only point at durable state inside its own tenant,
-- location, and conversation.
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, source_message_id)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000001', 'Cross conversation source', 'customer', 'normal',
    'd1700000-0000-0000-0000-000000000002')
$sql$, '23503', 'source message is out of scope')), 'handoff source message cannot come from another conversation');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, source_message_id)
  values ('d1000000-0000-0000-0000-000000000001', 'd1200000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000001', 'Cross location source', 'customer', 'normal',
    'd1700000-0000-0000-0000-000000000001')
$sql$, '23503', 'source message is out of scope')), 'handoff source message cannot cross locations');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, call_id)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000001', 'Cross conversation call', 'customer', 'normal',
    'd1800000-0000-0000-0000-000000000001')
$sql$, '23503', 'source call is out of scope')), 'handoff source call cannot come from another conversation');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, assigned_user_id, assigned_at)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000001', 'Foreign assignee', 'customer', 'normal',
    'd0000000-0000-0000-0000-000000000005', now())
$sql$, '23503', 'foreign key')), 'handoff assignee must be a member of the same organization');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, status, resolved_at, resolved_by_user_id)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000001', 'Foreign resolver', 'customer', 'normal',
    'resolved', now(), 'd0000000-0000-0000-0000-000000000005')
$sql$, '23503', 'foreign key')), 'handoff resolver must be a member of the same organization');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, assigned_user_id)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000001', 'Assignment without a timestamp', 'customer', 'normal',
    'd0000000-0000-0000-0000-000000000002')
$sql$, '23514', 'handoffs_assignment_state_check')), 'handoff ownership cannot exist without its assignment time');

-- Trusted text ingress creates exactly one durable episode and never forks it.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000001', 'tool-1', 'Customer reports bleeding.', 'normal')),
  true,
  'the first trusted text handoff request creates a durable episode'
);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000001', 'tool-1', 'Customer reports bleeding.', 'normal')),
  false,
  'replaying the same tool call reuses the durable episode'
);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000001', 'tool-2', 'Customer asked again for a person.', 'normal')),
  false,
  'a different tool call on an active conversation reuses the same episode'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  1,
  'repeated handoff requests keep exactly one durable row'
);
select extensions.is(
  (select source_message_id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  'd1700000-0000-0000-0000-000000000001',
  'the text episode binds the trusted inbound turn that triggered it'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000001', 'tool-3', 'Escalated by industry policy.', 'urgent')),
  false,
  'a later urgent signal escalates instead of creating a competing episode'
);
reset role;
select extensions.is(
  (select urgency from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  'urgent',
  'the existing episode carries the escalated urgency'
);
select extensions.ok(
  (select last_escalated_at is not null from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  'escalation records when the episode became urgent'
);
select extensions.is(
  (select reason from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  'Customer reports bleeding.',
  'repeated requests never rewrite the original operational reason'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000001', 'tool-4', 'Routine question after urgency.', 'normal')),
  false,
  'a later normal signal cannot fork a second episode'
);
reset role;
select extensions.is(
  (select urgency from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  'urgent',
  'a later normal signal cannot silently downgrade urgent work'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000002', 'tool-5', 'Customer wants a callback.', 'normal')),
  true,
  'a different conversation still gets its own episode'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_handoff_voice_one', 'voice-tool-1', 'Caller asked for a person.', 'normal')),
  true,
  'voice ingress creates one durable episode bound to the exact call'
);
select extensions.is(
  (select created from public.request_inbound_voice_handoff('rtc_handoff_voice_one', 'voice-tool-2', 'Caller asked again.', 'normal')),
  false,
  'a replayed voice tool call reuses the durable episode'
);
reset role;
select extensions.is(
  (select call_id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000003'),
  'd1800000-0000-0000-0000-000000000001',
  'the voice episode binds the exact provider call'
);
select extensions.is(
  (select count(*)::integer from public.action_logs where action = 'handoff.created' and entity_type = 'handoff'),
  3,
  'each durable episode writes exactly one creation audit'
);
select extensions.is(
  (select count(*)::integer from public.action_logs where action = 'handoff.escalated'),
  1,
  'escalation writes exactly one audit and replay adds none'
);
select extensions.ok(not exists (
  select 1 from public.action_logs
  where action in ('handoff.created', 'handoff.escalated')
    and details::text ~* 'bleeding|callback|\+1510'
), 'handoff audits carry no free-text reason or customer identifiers');

-- Database-level protection, not application convention.
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000001', 'Second active episode', 'customer', 'normal')
$sql$, '23505', 'duplicate key')), 'a customer conversation cannot hold two active handoffs');
select extensions.ok((select pg_temp.error_matches($sql$
  update public.handoffs set urgency = 'normal' where conversation_id = 'd1600000-0000-0000-0000-000000000001'
$sql$, '22023', 'urgency cannot be downgraded')), 'urgent work cannot be downgraded even by trusted writes');
select extensions.lives_ok($$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, idempotency_key)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000009', 'First test escalation', 'test', 'normal', 'agent-test:one'),
    ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000009', 'Second test escalation', 'test', 'normal', 'agent-test:two')
$$, 'test-mode agent handoffs stay outside the production one-active-episode rule');

-- Browser sessions may read handoffs, but every mutation is an RPC.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
select extensions.throws_ok($$
  insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency)
  values ('d1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001',
    'd1600000-0000-0000-0000-000000000005', 'Forged escalation', 'customer', 'urgent')
$$, '42501', 'permission denied for table handoffs',
  'authenticated clients cannot insert a handoff directly');
select extensions.throws_ok($$
  update public.handoffs set assigned_user_id = 'd0000000-0000-0000-0000-000000000002', status = 'acknowledged'
  where conversation_id = 'd1600000-0000-0000-0000-000000000001'
$$, '42501', 'permission denied for table handoffs',
  'authenticated clients cannot assign or resolve a handoff directly');
select extensions.is_empty($$
  update public.conversations set ai_mode = 'ai', assigned_user_id = null
  where id = 'd1600000-0000-0000-0000-000000000001' returning id
$$, 'authenticated clients have no row policy that can rewrite conversation ownership');
reset role;
create policy conversations_update_probe on public.conversations for update to authenticated
  using (public.has_location_access(organization_id, location_id))
  with check (public.has_location_write_access(organization_id, location_id));
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
select extensions.ok((select pg_temp.error_matches($sql$
  update public.conversations set ai_mode = 'ai', assigned_user_id = null
  where id = 'd1600000-0000-0000-0000-000000000001'
$sql$, '42501', 'ownership is not directly writable')),
  'authenticated clients cannot rewrite conversation ownership or automation mode directly');
reset role;
drop policy conversations_update_probe on public.conversations;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);

-- Claim, concurrency, and idempotency.
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000004', true);
select extensions.throws_ok(
  $$ select * from public.claim_my_handoff((select handoff.id from public.handoffs handoff
    where handoff.conversation_id = 'd1600000-0000-0000-0000-000000000001')) $$,
  '42501', 'Handoff is not available',
  'a member of another location cannot claim this location work'
);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'))),
  'claimed',
  'a location operator claims the unassigned urgent episode'
);
select set_config('test.first_acknowledged_at',
  (select first_acknowledged_at::text from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'), true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'))),
  'claimed',
  'the same operator claiming twice is an idempotent success'
);
select extensions.is(
  (select first_acknowledged_at::text from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  current_setting('test.first_acknowledged_at'),
  'a replayed claim never rewrites the first acknowledgement'
);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000003', true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'))),
  'already_claimed',
  'the operator who arrives second is told the work is already claimed'
);
select extensions.is(
  (select assigned_display_name from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'))),
  'Avery Operator',
  'a losing claim returns a safe owner display name for a UI refresh'
);
select extensions.is(
  (select outcome from public.create_my_human_reply('d1600000-0000-0000-0000-000000000001', 'Let me take this over')),
  'owned_by_other',
  'a human reply cannot silently steal a conversation another operator owns'
);
select extensions.is(
  (select outcome from public.take_over_my_conversation('d1600000-0000-0000-0000-000000000001')),
  'already_claimed',
  'manual takeover cannot steal an owned episode either'
);
select extensions.throws_ok(
  $$ select * from public.release_my_handoff((select handoff.id from public.handoffs handoff
    where handoff.conversation_id = 'd1600000-0000-0000-0000-000000000001')) $$,
  '42501', 'Handoff is owned by another teammate',
  'a normal member cannot release a teammate handoff'
);
select extensions.throws_ok(
  $$ select * from public.resolve_my_handoff((select handoff.id from public.handoffs handoff
    where handoff.conversation_id = 'd1600000-0000-0000-0000-000000000001')) $$,
  '42501', 'Handoff is owned by another teammate',
  'a normal member cannot resolve a teammate handoff'
);
reset role;
select extensions.is(
  (select assigned_user_id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  'd0000000-0000-0000-0000-000000000002',
  'contested claims leave exactly one durable owner'
);
select extensions.is(
  (select ai_mode from public.conversations where id = 'd1600000-0000-0000-0000-000000000001'),
  'human',
  'claiming pauses automation for the conversation'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'handoff.claimed'
      and entity_id = (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001')),
  1,
  'a replayed claim writes exactly one ownership audit'
);

-- Automation must not compete with the operator who now owns the episode.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.persist_ai_message_reply('d1700000-0000-0000-0000-000000000001', 'An automated answer that must not appear.', false)),
  false,
  'a claimed conversation suppresses an in-flight automated reply'
);
select extensions.is(
  (select created from public.persist_ai_message_reply('d1700000-0000-0000-0000-000000000001', 'A handoff acknowledgement after the claim.', true)),
  false,
  'even a handoff acknowledgement is suppressed once a person owns the episode'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.messages
    where conversation_id = 'd1600000-0000-0000-0000-000000000001' and author_type = 'ai'),
  0,
  'no automated message is persisted after human ownership'
);

-- Resolve is not resume.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.resume_my_conversation_ai('d1600000-0000-0000-0000-000000000001')),
  'resolve_handoff_first',
  'AI cannot resume while an escalation episode is still active'
);
select extensions.is(
  (select outcome from public.resolve_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'))),
  'resolved',
  'the assigned operator resolves their own episode'
);
select extensions.is(
  (select ai_mode from public.resolve_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'))),
  'human',
  'resolving leaves automation paused; resuming is a separate decision'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.action_logs
    where action = 'handoff.resolved'
      and entity_id = (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001')),
  1,
  'a replayed resolve writes exactly one lifecycle audit'
);
select extensions.is(
  (select resolved_by_user_id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  'd0000000-0000-0000-0000-000000000002',
  'resolution attribution is recorded by the trusted RPC, never by the client'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000003', true);
select extensions.is(
  (select outcome from public.resume_my_conversation_ai('d1600000-0000-0000-0000-000000000001')),
  'owned_by_other',
  'a normal member cannot resume a conversation another operator owns'
);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.resume_my_conversation_ai('d1600000-0000-0000-0000-000000000001')),
  'resumed',
  'the assigned operator may explicitly resume automation once the episode is resolved'
);
reset role;
select extensions.is(
  (select ai_mode || ':' || coalesce(assigned_user_id::text, 'none') from public.conversations
    where id = 'd1600000-0000-0000-0000-000000000001'),
  'ai:none',
  'resuming returns the conversation to automation and clears ownership'
);
select extensions.is(
  (select count(*)::integer from public.messages
    where conversation_id = 'd1600000-0000-0000-0000-000000000001' and direction = 'outbound'),
  0,
  'resuming never synthesises a reply to an already-answered turn'
);

-- A later escalation is a new historical episode, never a reopened one.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000001', 'tool-later', 'A new problem after resolution.', 'urgent')),
  true,
  'a future escalation after resolution opens a new episode'
);
select extensions.is(
  (select created from public.request_message_handoff('d1700000-0000-0000-0000-000000000010', 'tool-web', 'Web visitor asked for a person.', 'normal')),
  true,
  'a web-chat escalation opens its own episode'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  2,
  'the resolved episode is retained as history beside the new one'
);
select extensions.is(
  (select count(*)::integer from public.handoffs
    where conversation_id = 'd1600000-0000-0000-0000-000000000001' and status = 'resolved'),
  1,
  'the original episode is never reopened'
);

-- Release, admin recovery, and retained acknowledgement history.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000002'))),
  'claimed',
  'an operator claims the second conversation episode'
);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select outcome from public.release_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000002'))),
  'released',
  'an owner recovers work abandoned by an unavailable teammate'
);
reset role;
select extensions.is(
  (select status || ':' || coalesce(assigned_user_id::text, 'none') from public.handoffs
    where conversation_id = 'd1600000-0000-0000-0000-000000000002'),
  'open:none',
  'release returns the episode to the queue unassigned'
);
select extensions.ok(
  (select first_acknowledged_at is not null from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000002'),
  'release keeps the historical first acknowledgement'
);
select extensions.is(
  (select ai_mode from public.conversations where id = 'd1600000-0000-0000-0000-000000000002'),
  'human',
  'release does not hand the conversation back to automation'
);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000003', true);
select extensions.is(
  (select outcome from public.claim_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000002'))),
  'claimed',
  'after admin recovery another operator can claim the episode'
);
reset role;

-- A conversation whose episode is resolved but whose automation has not been resumed must stay
-- visible while the customer is still waiting.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select outcome from public.resolve_my_handoff(
    (select id from public.handoffs where conversation_id = 'd1600000-0000-0000-0000-000000000005'))),
  'resolved',
  'an owner may resolve an unclaimed episode at their location'
);
reset role;
select extensions.is(
  (select ai_mode from public.conversations where id = 'd1600000-0000-0000-0000-000000000005'),
  'human',
  'a resolved episode still leaves the conversation in human mode'
);

-- Queue derivation: waiting state, priority order, filters, and location isolation.
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, sent_by_user_id, created_at, sent_at) values
  ('d1700000-0000-0000-0000-000000000020', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1600000-0000-0000-0000-000000000002', 'd1500000-0000-0000-0000-000000000002', 'outbound', 'text', 'A teammate answered', 'sms', 'human', 'd0000000-0000-0000-0000-000000000003', now() - interval '12 minutes', now() - interval '12 minutes');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at, sent_at) values
  ('d1700000-0000-0000-0000-000000000021', 'd1000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 'd1600000-0000-0000-0000-000000000002', 'd1500000-0000-0000-0000-000000000002', 'inbound', 'text', 'Thanks, one more thing', 'sms', 'customer', '+15105550102', now() - interval '6 minutes', now() - interval '6 minutes');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000003', true);
select extensions.is(
  (select waiting_since::text from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000002'),
  (select created_at::text from public.messages where id = 'd1700000-0000-0000-0000-000000000021'),
  'waiting starts at the oldest customer turn no human reply has answered'
);
select extensions.is(
  (select customer_waiting from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000003'),
  false,
  'a voice episode with no unanswered customer turn is not marked as waiting'
);
select extensions.is(
  (select queue_priority from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000001'),
  1,
  'an urgent active episode with a waiting customer is the highest operator priority'
);
select extensions.is(
  (select queue_priority from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000002'),
  3,
  'a normal active episode with a waiting customer sorts below urgent work'
);
select extensions.is(
  (select queue_priority from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000003'),
  4,
  'a normal active episode without a waiting customer sorts below waiting work'
);
select extensions.is(
  (select queue_priority from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000005'),
  5,
  'a human-owned conversation with a waiting customer stays visible without an episode'
);
select extensions.is(
  (select conversation_id from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60) limit 1),
  'd1600000-0000-0000-0000-000000000001',
  'the urgent waiting episode is the first row an operator sees'
);
select extensions.is(
  (select handoff_source from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000003'),
  'voice',
  'voice escalations appear in the same operator queue'
);
select extensions.is(
  (select handoff_call_status from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'all_active', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000003'),
  'in_progress',
  'a voice row shows the current call state when it is available'
);
select extensions.is(
  (select count(*)::integer from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'urgent', 60)),
  1,
  'the urgent filter returns only urgent active episodes'
);
select extensions.is(
  (select count(*)::integer from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'mine', 60)),
  1,
  'the mine filter returns only the current operator ownership'
);
select extensions.is(
  (select conversation_id from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'mine', 60)),
  'd1600000-0000-0000-0000-000000000002',
  'the mine filter resolves the conversation this operator owns'
);
select extensions.is(
  (select count(*)::integer from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'needs_attention', 60)),
  4,
  'needs attention covers active episodes and waiting human-owned conversations'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'urgent', 60) queue
    where not queue.handoff_is_active
  ),
  'resolved episodes are never presented as active queue work'
);
select extensions.is(
  (select handoff_is_active from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'needs_attention', 60)
    where conversation_id = 'd1600000-0000-0000-0000-000000000005'),
  false,
  'a conversation whose episode is resolved stays visible without counting as active handoff work'
);
select extensions.is(
  (select conversation_id from public.get_my_handoff_queue('d1100000-0000-0000-0000-000000000001', 'resolved', 60)),
  'd1600000-0000-0000-0000-000000000005',
  'the resolved history filter surfaces finished episodes separately from active work'
);
select extensions.is_empty(
  $$ select * from public.get_my_handoff_queue('d1200000-0000-0000-0000-000000000001', 'all_active', 60) $$,
  'a location-scoped operator cannot read another location queue'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_handoff_queue(null, 'all_active', 200) queue
    where queue.conversation_id = 'd1600000-0000-0000-0000-000000000009'
  ),
  'test-mode agent conversations never enter the production operator queue'
);
select extensions.is(
  (select needs_attention from public.get_my_handoff_queue_summary('d1100000-0000-0000-0000-000000000001')),
  4,
  'the inbox summary counts the same operational work as the queue'
);
select extensions.is(
  (select urgent from public.get_my_handoff_queue_summary('d1100000-0000-0000-0000-000000000001')),
  1,
  'the inbox summary counts urgent active episodes'
);
select extensions.is(
  (select assigned_to_me from public.get_my_handoff_queue_summary('d1100000-0000-0000-0000-000000000001')),
  1,
  'the inbox summary counts what the current operator owns'
);
select extensions.is(
  (select count(*)::integer from public.get_my_conversation_handoff_history('d1600000-0000-0000-0000-000000000001', 10)),
  2,
  'resolved episodes stay queryable as bounded conversation history'
);
select extensions.ok(
  not exists (
    select 1 from public.get_my_conversation_handoff_history('d1600000-0000-0000-0000-000000000001', 10) history
    where history.resolved_by_display_name ~ '@'
  ),
  'history exposes staff display names rather than account identities'
);
reset role;

-- Claiming a voice escalation is operational ownership only.
select extensions.is(
  (select count(*)::integer from public.messages where conversation_id = 'd1600000-0000-0000-0000-000000000003'),
  0,
  'a voice escalation never creates an automatic text message'
);
select extensions.is(
  (select count(*)::integer from public.message_deliveries delivery
    join public.messages message on message.id = delivery.message_id
    where message.conversation_id = 'd1600000-0000-0000-0000-000000000003'),
  0,
  'a voice escalation never creates an outbound SMS delivery'
);
select extensions.is(
  (select status from public.calls where id = 'd1800000-0000-0000-0000-000000000001'),
  'in_progress',
  'operator ownership does not mutate provider call state'
);

-- Function privileges are the complete Phase 13 boundary.
select extensions.ok(has_function_privilege('authenticated', 'public.claim_my_handoff(uuid)', 'execute'),
  'staff can execute the narrow claim RPC');
select extensions.ok(not has_function_privilege('anon', 'public.claim_my_handoff(uuid)', 'execute'),
  'anonymous callers cannot execute the claim RPC');
select extensions.ok(not has_function_privilege('authenticated', 'public.persist_active_conversation_handoff(uuid,uuid,uuid,text,text,text,uuid,uuid)', 'execute'),
  'authenticated callers cannot reach the handoff coalescing core');
select extensions.ok(not has_function_privilege('service_role', 'public.apply_handoff_claim(uuid,uuid)', 'execute'),
  'the shared ownership transition is an internal helper for every role');
select extensions.ok(not has_function_privilege('authenticated', 'public.authorize_my_handoff_operation(uuid,boolean)', 'execute'),
  'the authorization helper is not a client-callable boundary');
select extensions.ok(has_function_privilege('service_role', 'public.request_message_handoff(uuid,text,text,text)', 'execute'),
  'the trusted runtime keeps its narrow text handoff RPC');
select extensions.ok(not has_table_privilege('authenticated', 'public.handoffs', 'insert,update,delete'),
  'browser sessions have no direct handoff write grant');
select extensions.ok(not has_table_privilege('service_role', 'public.handoffs', 'insert,update,delete'),
  'no broad service-role handoff CRUD grant exists');
select extensions.ok(has_table_privilege('authenticated', 'public.handoffs', 'select'),
  'location-scoped handoff reads remain available to staff');

select * from extensions.finish();
rollback;

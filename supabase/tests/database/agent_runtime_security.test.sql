-- Phase 3 test-mode agent conversation isolation and RPC-only persistence.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(22);

insert into auth.users (id, email)
values
  ('50000000-0000-0000-0000-000000000001', 'agent-admin-a@example.test'),
  ('50000000-0000-0000-0000-000000000002', 'agent-member-a@example.test'),
  ('50000000-0000-0000-0000-000000000003', 'agent-owner-b@example.test');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok($$ select * from public.bootstrap_workspace() $$, 'admin A can bootstrap a workspace');

select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000003', true);
select extensions.lives_ok($$ select * from public.bootstrap_workspace() $$, 'owner B can bootstrap a workspace');

reset role;
select set_config(
  'avenlyo.agent_org_a',
  (select organization_id::text from public.organization_members where user_id = '50000000-0000-0000-0000-000000000001'),
  true
);
select set_config(
  'avenlyo.agent_org_b',
  (select organization_id::text from public.organization_members where user_id = '50000000-0000-0000-0000-000000000003'),
  true
);
select set_config(
  'avenlyo.agent_location_a',
  (select location_id::text from public.organization_onboarding where organization_id = current_setting('avenlyo.agent_org_a')::uuid),
  true
);

insert into public.organization_members (organization_id, user_id, role)
values (current_setting('avenlyo.agent_org_a')::uuid, '50000000-0000-0000-0000-000000000002', 'member');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
select current_setting('avenlyo.agent_org_a')::uuid, member.id, current_setting('avenlyo.agent_location_a')::uuid
from public.organization_members as member
where member.organization_id = current_setting('avenlyo.agent_org_a')::uuid
  and member.user_id = '50000000-0000-0000-0000-000000000002';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000001', true);
select set_config(
  'avenlyo.agent_conversation_a',
  (
    select conversation_id::text
    from public.create_agent_test_conversation(current_setting('avenlyo.agent_location_a')::uuid)
  ),
  true
);
select extensions.is(
  (select mode from public.conversations where id = current_setting('avenlyo.agent_conversation_a')::uuid),
  'test',
  'owner/admin test conversation is persisted in separate test mode'
);

select extensions.throws_ok(
  $$
    insert into public.messages (organization_id, location_id, conversation_id, direction, body)
    values (
      current_setting('avenlyo.agent_org_a')::uuid,
      current_setting('avenlyo.agent_location_a')::uuid,
      current_setting('avenlyo.agent_conversation_a')::uuid,
      'outbound', 'direct test write'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "messages"',
  'test-mode messages cannot be directly inserted, even by an admin'
);

select set_config(
  'avenlyo.agent_run_a',
  (
    select run_id::text
    from public.begin_agent_test_turn(
      current_setting('avenlyo.agent_conversation_a')::uuid,
      '50000000-0000-0000-0000-000000000010',
      'Do you offer a dental cleaning?',
      'openai-responses',
      'gpt-5.6'
    )
  ),
  true
);
select extensions.is(
  (select status from public.agent_test_runs where id = current_setting('avenlyo.agent_run_a')::uuid),
  'running',
  'begin RPC atomically records a running test turn'
);

select extensions.lives_ok(
  $$
    select public.complete_agent_test_turn(
      current_setting('avenlyo.agent_run_a')::uuid,
      'Yes, the published services page lists dental cleaning.',
      '[{"title":"Services","source_url":"https://clinic.example/services","content":"raw chunk must not persist"}]'::jsonb,
      '[{"name":"search_business_knowledge","status":"succeeded","summary":"raw tool output must not persist"}]'::jsonb,
      false,
      null
    )
  $$,
  'complete RPC persists the safe assistant result'
);
select extensions.is(
  (
    select metadata -> 'sources' -> 0 ? 'content'
    from public.messages
    where conversation_id = current_setting('avenlyo.agent_conversation_a')::uuid
      and direction = 'outbound'
  ),
  false,
  'test metadata stores source references but never raw retrieved chunks'
);

select extensions.lives_ok(
  $$
    select * from public.request_agent_test_handoff(
      current_setting('avenlyo.agent_conversation_a')::uuid,
      'handoff-1', 'Customer requested a person.', 'normal'
    )
  $$,
  'handoff RPC creates a test-mode handoff'
);
select extensions.lives_ok(
  $$
    select * from public.request_agent_test_handoff(
      current_setting('avenlyo.agent_conversation_a')::uuid,
      'handoff-1', 'Customer requested a person.', 'normal'
    )
  $$,
  'duplicate tool call returns the persisted handoff safely'
);
select extensions.is(
  (
    select count(*)::integer from public.handoffs
    where conversation_id = current_setting('avenlyo.agent_conversation_a')::uuid
  ),
  1,
  'handoff persistence is idempotent per test conversation and tool call'
);

select extensions.is(
  (select is_existing from public.begin_agent_test_turn(
    current_setting('avenlyo.agent_conversation_a')::uuid,
    '50000000-0000-0000-0000-000000000010', 'Do you offer a dental cleaning?', 'openai-responses', 'gpt-5.6'
  )),
  true,
  'same conversation and idempotency key resolves the existing run'
);
select extensions.is(
  (select count(*)::integer from public.messages where conversation_id = current_setting('avenlyo.agent_conversation_a')::uuid and direction = 'inbound'),
  1,
  'duplicate completed submission creates no second inbound message'
);
select set_config('avenlyo.agent_conversation_duplicate_key', (
  select conversation_id::text from public.create_agent_test_conversation(current_setting('avenlyo.agent_location_a')::uuid)
), true);
select extensions.is(
  (select is_existing from public.begin_agent_test_turn(
    current_setting('avenlyo.agent_conversation_duplicate_key')::uuid,
    '50000000-0000-0000-0000-000000000010', 'A separate conversation message', 'openai-responses', 'gpt-5.6'
  )),
  false,
  'the same key in a different conversation starts a separately scoped run'
);
select extensions.is(
  (select is_existing from public.begin_agent_test_turn(
    current_setting('avenlyo.agent_conversation_duplicate_key')::uuid,
    '50000000-0000-0000-0000-000000000011', 'A competing message', 'openai-responses', 'gpt-5.6'
  )),
  true,
  'a second key is controlled while the first conversation turn is running'
);
select set_config('avenlyo.agent_conversation_failed', (
  select conversation_id::text from public.create_agent_test_conversation(current_setting('avenlyo.agent_location_a')::uuid)
), true);
select set_config('avenlyo.agent_run_failed', (
  select run_id::text from public.begin_agent_test_turn(
    current_setting('avenlyo.agent_conversation_failed')::uuid,
    '50000000-0000-0000-0000-000000000012', 'This provider fails', 'openai-responses', 'gpt-5.6'
  )
), true);
select public.fail_agent_test_turn(current_setting('avenlyo.agent_run_failed')::uuid, 'provider_error');
select extensions.is(
  (select status from public.begin_agent_test_turn(
    current_setting('avenlyo.agent_conversation_failed')::uuid,
    '50000000-0000-0000-0000-000000000012', 'This provider fails', 'openai-responses', 'gpt-5.6'
  )),
  'failed',
  'a failed duplicate resolves its persisted failure instead of silently re-executing'
);
select set_config('avenlyo.agent_conversation_stale', (
  select conversation_id::text from public.create_agent_test_conversation(current_setting('avenlyo.agent_location_a')::uuid)
), true);
select set_config('avenlyo.agent_run_stale', (
  select run_id::text from public.begin_agent_test_turn(
    current_setting('avenlyo.agent_conversation_stale')::uuid,
    '50000000-0000-0000-0000-000000000013', 'Abandoned turn', 'openai-responses', 'gpt-5.6'
  )
), true);
reset role;
alter table public.agent_test_runs disable trigger set_agent_test_runs_updated_at;
update public.agent_test_runs set updated_at = now() - interval '11 minutes'
where id = current_setting('avenlyo.agent_run_stale')::uuid;
alter table public.agent_test_runs enable trigger set_agent_test_runs_updated_at;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select is_existing from public.begin_agent_test_turn(
    current_setting('avenlyo.agent_conversation_stale')::uuid,
    '50000000-0000-0000-0000-000000000014', 'Recovered turn', 'openai-responses', 'gpt-5.6'
  )),
  false,
  'a stale running turn is safely failed and no longer blocks a new key'
);
select extensions.is(
  (select status from public.agent_test_runs where id = current_setting('avenlyo.agent_run_stale')::uuid),
  'failed',
  'stale recovery records a safe failed terminal state'
);

select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (
    select count(*)::integer from public.conversations
    where id = current_setting('avenlyo.agent_conversation_a')::uuid
  ),
  0,
  'location-scoped member cannot read test conversations'
);
select extensions.is(
  (
    select count(*)::integer from public.get_agent_test_conversation(
      current_setting('avenlyo.agent_conversation_a')::uuid
    )
  ),
  0,
  'location-scoped member cannot read test messages through the RPC'
);
select extensions.throws_ok(
  $$
    insert into public.conversations (organization_id, location_id, mode, test_owner_user_id)
    values (
      current_setting('avenlyo.agent_org_a')::uuid,
      current_setting('avenlyo.agent_location_a')::uuid,
      'test', '50000000-0000-0000-0000-000000000002'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "conversations"',
  'normal member cannot directly create a test conversation'
);

select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000003', true);
select extensions.is(
  (
    select count(*)::integer from public.get_agent_test_conversation(
      current_setting('avenlyo.agent_conversation_a')::uuid
    )
  ),
  0,
  'organization B cannot read organization A test records'
);
select extensions.throws_ok(
  $$
    select * from public.create_agent_test_conversation(
      current_setting('avenlyo.agent_location_a')::uuid
    )
  $$,
  '42501',
  'An organization owner or admin is required',
  'organization B cannot create a test conversation in organization A'
);

reset role;
select * from extensions.finish();
rollback;

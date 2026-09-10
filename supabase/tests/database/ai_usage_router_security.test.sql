-- Phase 25 AI usage telemetry: privilege and tenant-boundary regression checks.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(12);

select extensions.has_table('public', 'ai_usage_events', 'AI usage event table exists');
select extensions.ok(
  not has_table_privilege('authenticated', 'public.ai_usage_events', 'INSERT'),
  'authenticated users cannot insert usage rows directly'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.ai_usage_events', 'SELECT'),
  'authenticated clients cannot read raw usage rows directly'
);
select extensions.ok(
  has_function_privilege('authenticated', 'public.record_agent_test_ai_usage(uuid,text,text,integer,integer,integer,bigint,text)', 'EXECUTE'),
  'admins may reach the test usage RPC; the RPC derives and checks scope'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.record_message_ai_usage(uuid,text,text,text,integer,integer,integer,bigint,text)', 'EXECUTE'),
  'authenticated clients cannot reach customer usage persistence'
);
select extensions.ok(
  has_function_privilege('service_role', 'public.record_message_ai_usage(uuid,text,text,text,integer,integer,integer,bigint,text)', 'EXECUTE'),
  'messaging service role may persist customer usage'
);
select extensions.ok(
  has_function_privilege('authenticated', 'public.get_my_ai_usage_summary(uuid,integer)', 'EXECUTE'),
  'authenticated admins may reach the scoped usage summary RPC'
);
select extensions.col_is_pk('public', 'ai_usage_events', 'id', 'usage event id is the primary key');
select extensions.has_index('public', 'ai_usage_events', 'ai_usage_events_organization_created_at_idx', 'organization/time index exists');
select extensions.has_index('public', 'ai_usage_events', 'ai_usage_events_location_created_at_idx', 'location/time index exists');
select extensions.has_index('public', 'ai_usage_events', 'ai_usage_events_conversation_created_at_idx', 'conversation/time index exists');
select extensions.is(
  (select schema_version from public.platform_schema_contract where id),
  24,
  'Phase 25 advertises schema version 24'
);

select * from extensions.finish();
rollback;

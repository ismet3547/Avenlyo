-- Phase 14 platform operations: internal runtime state and global aggregate observation only.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(65);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

-- Schema compatibility contract.
select extensions.is(
  (select schema_version from public.platform_schema_contract),
  14,
  'the deployed schema advertises the Phase 14 compatibility version'
);
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.platform_schema_contract (id, schema_version) values (false, 15)
$sql$, '23514', 'platform_schema_contract_id_check')), 'the schema contract is a singleton by construction');
select extensions.is(
  (select count(*)::integer from public.platform_schema_contract),
  1,
  'exactly one schema contract row exists'
);

-- Every platform table is internal: no tenant reader, no client writer, no broad service grant.
select extensions.ok(not has_table_privilege('authenticated', 'public.platform_schema_contract', 'select'),
  'tenants cannot read the schema contract');
select extensions.ok(not has_table_privilege('authenticated', 'public.runtime_instances', 'select'),
  'tenants cannot read runtime instances');
select extensions.ok(not has_table_privilege('authenticated', 'public.runtime_component_heartbeats', 'select'),
  'tenants cannot read runtime component heartbeats');
select extensions.ok(not has_table_privilege('anon', 'public.runtime_instances', 'select'),
  'anonymous callers cannot read runtime instances');
select extensions.ok(not has_table_privilege('service_role', 'public.runtime_instances', 'insert,update,delete'),
  'the trusted backend has no broad runtime instance write grant');
select extensions.ok(not has_table_privilege('service_role', 'public.runtime_component_heartbeats', 'insert,update,delete'),
  'the trusted backend has no broad component heartbeat write grant');
select extensions.ok(not has_table_privilege('service_role', 'public.platform_schema_contract', 'update'),
  'the trusted backend cannot rewrite the schema contract directly');
select extensions.ok(
  (select relrowsecurity from pg_class where oid = 'public.runtime_instances'::regclass),
  'runtime instances keep row level security enabled'
);
select extensions.ok(
  not exists (select 1 from pg_policies where schemaname = 'public'
    and tablename in ('platform_schema_contract', 'runtime_instances', 'runtime_component_heartbeats')),
  'no tenant policy exposes platform operational state'
);

-- Narrow function boundary.
select extensions.ok(has_function_privilege('service_role', 'public.platform_readiness_probe()', 'execute'),
  'the trusted backend can run the readiness probe');
select extensions.ok(not has_function_privilege('authenticated', 'public.platform_readiness_probe()', 'execute'),
  'tenants cannot run the readiness probe');
select extensions.ok(not has_function_privilege('anon', 'public.platform_readiness_probe()', 'execute'),
  'anonymous callers cannot run the readiness probe');
select extensions.ok(not has_function_privilege('service_role', 'public.require_platform_service_role()', 'execute'),
  'the role guard is an internal helper for every role');
select extensions.ok(not has_function_privilege('service_role', 'public.prune_runtime_instances()', 'execute'),
  'runtime retention is an internal helper for every role');
select extensions.ok(not has_function_privilege('authenticated', 'public.get_platform_operational_snapshot()', 'execute'),
  'tenants cannot read the global operational snapshot');
select extensions.ok(not has_function_privilege('authenticated', 'public.get_platform_runtime_status()', 'execute'),
  'tenants cannot read global runtime status');
select extensions.ok(not has_function_privilege('authenticated', 'public.register_runtime_instance(uuid,text,text)', 'execute'),
  'tenants cannot register a runtime instance');
select extensions.ok(
  not exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname in (
        'platform_readiness_probe', 'register_runtime_instance', 'heartbeat_runtime_component',
        'stop_runtime_instance', 'get_platform_runtime_status', 'get_platform_operational_snapshot',
        'require_platform_service_role', 'prune_runtime_instances'
      )
      and (
        proc.proconfig is null
        or not exists (
          select 1 from unnest(proc.proconfig) as setting where setting like 'search_path=%'
        )
      )
  ),
  'every platform function pins an empty search path'
);

-- Authenticated callers are refused inside the functions as well as at the grant boundary.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select extensions.throws_ok(
  $$ select * from public.platform_readiness_probe() $$,
  '42501', 'permission denied for function platform_readiness_probe',
  'an authenticated caller cannot reach the readiness probe'
);
select extensions.throws_ok(
  $$ insert into public.runtime_instances (instance_id, service) values (extensions.gen_random_uuid(), 'forged') $$,
  '42501', 'permission denied for table runtime_instances',
  'an authenticated caller cannot write runtime state directly'
);
reset role;

-- Runtime lifecycle through the narrow service-role RPCs.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select schema_version from public.platform_readiness_probe()),
  14,
  'the readiness probe reports the deployed schema version'
);
select extensions.ok(
  (select checked_at is not null from public.platform_readiness_probe()),
  'the readiness probe proves the database answered'
);
select extensions.lives_ok(
  $$ select public.register_runtime_instance('e1000000-0000-4000-8000-000000000001', 'avenlyo-api', 'release-one') $$,
  'a runtime instance registers itself'
);
select extensions.lives_ok(
  $$ select public.register_runtime_instance('e1000000-0000-4000-8000-000000000002', 'avenlyo-api', 'release-one') $$,
  'a second replica registers independently'
);
select extensions.lives_ok(
  $$ select public.register_runtime_instance('e1000000-0000-4000-8000-000000000001', 'avenlyo-api', 'release-one') $$,
  'registration replay is idempotent'
);
select extensions.throws_ok(
  $$ select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000009', 'message_processing', 'running', true) $$,
  '42501', 'Runtime instance is not registered',
  'a component cannot report against an unregistered instance'
);
select extensions.throws_ok(
  $$ select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000001', 'message_processing', 'galloping', true) $$,
  '22023', 'Runtime component state is invalid',
  'a component state outside the bounded set is refused'
);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000001', 'crypto_miner', 'running', true)
$sql$, '23514', 'runtime_component_heartbeats_component_check')), 'an unknown component name is refused');

select extensions.lives_ok(
  $$ select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000001', 'message_processing', 'running', true) $$,
  'a successful empty tick is recorded'
);
reset role;
select extensions.ok(
  (select last_success_at is not null and consecutive_failures = 0
   from public.runtime_component_heartbeats
   where instance_id = 'e1000000-0000-4000-8000-000000000001' and component = 'message_processing'),
  'a tick that found no work still counts as success'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000001', 'message_processing', 'running', false, 'provider_timeout') $$,
  'a failed tick is recorded'
);
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000001', 'message_processing', 'running', false, 'provider_timeout') $$,
  'a second failed tick is recorded'
);
reset role;
select extensions.is(
  (select consecutive_failures from public.runtime_component_heartbeats
   where instance_id = 'e1000000-0000-4000-8000-000000000001' and component = 'message_processing'),
  2,
  'consecutive failures accumulate'
);
select extensions.is(
  (select last_error_code from public.runtime_component_heartbeats
   where instance_id = 'e1000000-0000-4000-8000-000000000001' and component = 'message_processing'),
  'provider_timeout',
  'the failure keeps a short bounded error code'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000001', 'message_processing', 'running', true) $$,
  'a later successful tick is recorded'
);
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_component('e1000000-0000-4000-8000-000000000002', 'billing_events', 'running', true) $$,
  'the second replica reports its own component'
);
reset role;
select extensions.is(
  (select consecutive_failures from public.runtime_component_heartbeats
   where instance_id = 'e1000000-0000-4000-8000-000000000001' and component = 'message_processing'),
  0,
  'a successful tick clears the failure streak'
);
select extensions.ok(
  (select last_error_code is null from public.runtime_component_heartbeats
   where instance_id = 'e1000000-0000-4000-8000-000000000001' and component = 'message_processing'),
  'a successful tick clears the last error code'
);
select extensions.is(
  (select count(*)::integer from public.runtime_component_heartbeats
   where instance_id = 'e1000000-0000-4000-8000-000000000001'),
  1,
  'a component reports one durable row per instance no matter how many ticks it runs'
);

-- Stopping one replica must never affect another.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.stop_runtime_instance('e1000000-0000-4000-8000-000000000001') $$,
  'one replica stops itself'
);
reset role;
select extensions.ok(
  (select stopped_at is not null from public.runtime_instances
   where instance_id = 'e1000000-0000-4000-8000-000000000001'),
  'the stopping replica is marked stopped'
);
select extensions.ok(
  (select stopped_at is null from public.runtime_instances
   where instance_id = 'e1000000-0000-4000-8000-000000000002'),
  'the other replica keeps running'
);
select extensions.is(
  (select state from public.runtime_component_heartbeats
   where instance_id = 'e1000000-0000-4000-8000-000000000002' and component = 'billing_events'),
  'running',
  'the other replica keeps its component state'
);

-- Bounded retention removes terminal history without deleting a stale diagnostic row.
insert into public.runtime_instances (instance_id, service, release, started_at, last_heartbeat_at, stopped_at)
values
  ('e1000000-0000-4000-8000-000000000003', 'avenlyo-api', 'old', now() - interval '10 days', now() - interval '10 days', now() - interval '9 days'),
  ('e1000000-0000-4000-8000-000000000004', 'avenlyo-api', 'silent', now() - interval '1 hour', now() - interval '90 minutes', null);
select extensions.ok((select public.prune_runtime_instances() >= 1), 'retention removes terminal history');
select extensions.ok(
  not exists (select 1 from public.runtime_instances where instance_id = 'e1000000-0000-4000-8000-000000000003'),
  'a long-stopped instance is removed'
);
select extensions.ok(
  exists (select 1 from public.runtime_instances where instance_id = 'e1000000-0000-4000-8000-000000000004'),
  'a recently silent instance is kept because silence is itself the diagnosis'
);

-- Operational snapshot.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select extensions.throws_ok(
  $$ select * from public.get_platform_operational_snapshot() $$,
  '42501', 'permission denied for function get_platform_operational_snapshot',
  'the operational snapshot is refused to a tenant caller'
);
reset role;

insert into auth.users (id, email) values ('e0000000-0000-4000-8000-000000000001', 'ops@example.test');
insert into public.users (id, email) select id, email from auth.users where id = 'e0000000-0000-4000-8000-000000000001'
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('e2000000-0000-4000-8000-000000000001', 'Ops Organization', 'ops-org', 'e0000000-0000-4000-8000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name)
values ('e2100000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Ops location');
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status, configuration)
values ('e2200000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'sms', 'Ops SMS', 'active', '{}');
insert into public.contacts (id, organization_id, location_id, first_name, phone)
values ('e2300000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'Ops contact', '+15405550101');
insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, mode, status)
values ('e2400000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'e2300000-0000-4000-8000-000000000001', 'e2200000-0000-4000-8000-000000000001', 'customer', 'open');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, sent_at)
values ('e2500000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'e2400000-0000-4000-8000-000000000001', 'e2300000-0000-4000-8000-000000000001', 'outbound', 'text', 'Ops message', 'sms', 'ai', now());
insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind, status)
values ('e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'e2400000-0000-4000-8000-000000000001', 'e2500000-0000-4000-8000-000000000001', 'inbound_ai', 'queued');
insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, error_code)
values ('e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'e2500000-0000-4000-8000-000000000001', 'twilio', 'unknown', 'stale_submission_unknown');
insert into public.stripe_webhook_events (stripe_event_id, event_type, livemode, status)
values ('evt_ops_failed', 'invoice.paid', false, 'failed');
insert into public.appointments (id, organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at)
values ('e2600000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'e2300000-0000-4000-8000-000000000001', 'e2400000-0000-4000-8000-000000000001', 'Ops visit', 'confirmed', now() + interval '3 days', now() + interval '3 days 30 minutes');
insert into public.appointment_reminders (id, organization_id, location_id, appointment_id, reminder_type, scheduled_for, status)
values
  ('e2700000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'e2600000-0000-4000-8000-000000000001', 'appointment_24h', now() - interval '5 minutes', 'scheduled'),
  ('e2700000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'e2600000-0000-4000-8000-000000000001', 'appointment_2h', now() + interval '2 days', 'scheduled');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select value from public.get_platform_operational_snapshot()
   where metric_group = 'message_jobs' and metric = 'queued'),
  1::bigint,
  'a queued message job is visible as aggregate backlog'
);
select extensions.is(
  (select value from public.get_platform_operational_snapshot()
   where metric_group = 'sms_delivery' and metric = 'unknown'),
  1::bigint,
  'an ambiguous SMS delivery is visible without being changed'
);
select extensions.is(
  (select value from public.get_platform_operational_snapshot()
   where metric_group = 'billing_events' and metric = 'failed'),
  1::bigint,
  'a failed Stripe webhook event is visible'
);
select extensions.is(
  (select value from public.get_platform_operational_snapshot()
   where metric_group = 'reminders' and metric = 'due'),
  1::bigint,
  'only a reminder that is actually due counts as due work'
);
select extensions.is(
  (select value from public.get_platform_operational_snapshot()
   where metric_group = 'reminders' and metric = 'scheduled_future'),
  1::bigint,
  'a reminder scheduled for the future is reported separately and never as backlog'
);
-- Instance ...002 is reporting; ...004 has been silent for ninety minutes against a
-- twenty-five second heartbeat interval.  Counting both as active was the defect: an operator
-- reading the number would never look for the outage.
select extensions.is(
  (select value from public.get_platform_operational_snapshot()
   where metric_group = 'runtime' and metric = 'active_instances'),
  1::bigint,
  'only an instance that has not stopped and is still reporting counts as active'
);
select extensions.is(
  (select value from public.get_platform_operational_snapshot()
   where metric_group = 'runtime' and metric = 'stale_instances'),
  1::bigint,
  'a silent instance counts as stale rather than active'
);
select extensions.ok(
  exists (select 1 from public.runtime_instances where instance_id = 'e1000000-0000-4000-8000-000000000004'),
  'the stale instance is still retained for diagnosis rather than deleted'
);
select extensions.ok(
  exists (select 1 from public.get_platform_operational_snapshot()
    where metric_group = 'runtime_component' and metric = 'billing_events' and detail = 'running'),
  'a component heartbeat state is visible in the snapshot'
);
select extensions.ok(
  not exists (
    select 1 from public.get_platform_operational_snapshot()
    where detail ~* '\\+1|@|customer|contact|phone'
       or metric ~* 'phone|email|contact|transcript|customer'
  ),
  'the snapshot exposes no customer or contact value'
);
select extensions.ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in ('runtime_instances', 'runtime_component_heartbeats', 'platform_schema_contract')
      and (
        column_name ~* 'contact|phone|email|body|message_text|transcript|customer|token'
        or column_name in ('organization_id', 'location_id')
      )
  ),
  'platform tables carry no tenant, customer, or credential column'
);
select extensions.ok(
  (select count(*)::integer from public.get_platform_runtime_status()) >= 2,
  'runtime status lists every replica that has reported'
);
reset role;

-- Reading operational state must never change product state.
select extensions.is(
  (select status from public.message_deliveries where message_id = 'e2500000-0000-4000-8000-000000000001'),
  'unknown',
  'reading the snapshot does not resolve an ambiguous delivery'
);
select extensions.is(
  (select status from public.stripe_webhook_events where stripe_event_id = 'evt_ops_failed'),
  'failed',
  'reading the snapshot does not clear a failed billing event'
);
select extensions.is(
  (select status from public.appointment_reminders where id = 'e2700000-0000-4000-8000-000000000002'),
  'scheduled',
  'reading the snapshot does not reschedule future work'
);

select * from extensions.finish();
rollback;

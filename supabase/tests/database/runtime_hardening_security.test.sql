-- Phase 14 runtime hardening: process heartbeat, liveness classification, and the approved
-- operational error-code boundary.  Everything here is internal runtime state.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(33);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

-- Grant boundary.  Only the process heartbeat became callable; the two helpers did not.
select extensions.ok(
  has_function_privilege('service_role', 'public.heartbeat_runtime_instance(uuid)', 'execute'),
  'the trusted backend can record a process heartbeat'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.heartbeat_runtime_instance(uuid)', 'execute'),
  'tenants cannot record a process heartbeat'
);
select extensions.ok(
  not has_function_privilege('anon', 'public.heartbeat_runtime_instance(uuid)', 'execute'),
  'anonymous callers cannot record a process heartbeat'
);
select extensions.ok(
  not has_function_privilege('service_role', 'public.is_approved_runtime_error_code(text)', 'execute'),
  'the error-code allowlist is a constraint helper, not a callable boundary'
);
select extensions.ok(
  not has_function_privilege('service_role', 'public.runtime_heartbeat_stale_after()', 'execute'),
  'the staleness threshold is a policy helper, not a callable boundary'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.runtime_instances', 'insert,update,delete'),
  'the process heartbeat added no broad runtime instance write grant'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.runtime_component_heartbeats', 'insert,update,delete'),
  'the process heartbeat added no broad component heartbeat write grant'
);
select extensions.ok(
  not exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname in (
        'heartbeat_runtime_instance', 'is_approved_runtime_error_code',
        'runtime_heartbeat_stale_after', 'get_platform_operational_snapshot'
      )
      and (
        proc.proconfig is null
        or not exists (
          select 1 from unnest(proc.proconfig) as setting where setting like 'search_path=%'
        )
      )
  ),
  'every hardening function pins an empty search path'
);

-- Authenticated callers are refused inside the function as well as at the grant boundary.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select extensions.throws_ok(
  $$ select public.heartbeat_runtime_instance('f1000000-0000-4000-8000-000000000001') $$,
  '42501', 'permission denied for function heartbeat_runtime_instance',
  'an authenticated caller cannot record a process heartbeat'
);
reset role;

-- A core-only deployment: one process, zero components, still visibly alive.  RPCs run as the
-- trusted backend; direct table reads run as the owner, because service_role has no table grant.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.register_runtime_instance('f1000000-0000-4000-8000-000000000001', 'avenlyo-api', 'release-one');
reset role;

update public.runtime_instances
set last_heartbeat_at = now() - interval '10 minutes'
where instance_id = 'f1000000-0000-4000-8000-000000000001';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_instance('f1000000-0000-4000-8000-000000000001') $$,
  'a process with no components can record its own heartbeat'
);
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_instance('f1000000-0000-4000-8000-000000000001') $$,
  'the process heartbeat is idempotent across intervals'
);
reset role;

select extensions.ok(
  (select last_heartbeat_at > now() - interval '5 seconds'
   from public.runtime_instances
   where instance_id = 'f1000000-0000-4000-8000-000000000001'),
  'the process heartbeat advances last_heartbeat_at without a component write'
);
select extensions.is(
  (select count(*)::integer from public.runtime_component_heartbeats
   where instance_id = 'f1000000-0000-4000-8000-000000000001'),
  0,
  'no component row is invented to keep a process visible'
);

-- A heartbeat must never resurrect a process that stopped on purpose.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.register_runtime_instance('f1000000-0000-4000-8000-000000000002', 'avenlyo-api', 'release-one');
select public.stop_runtime_instance('f1000000-0000-4000-8000-000000000002');
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_instance('f1000000-0000-4000-8000-000000000002') $$,
  'a heartbeat against a stopped instance is accepted without error'
);
-- An unknown instance is not created by a heartbeat either.
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_instance('f1000000-0000-4000-8000-0000000000ff') $$,
  'a heartbeat for an unknown instance is a no-op rather than an error'
);
select extensions.throws_ok(
  $$ select public.heartbeat_runtime_instance(null) $$,
  '22023', 'Runtime instance heartbeat is invalid',
  'a heartbeat without an instance identifier is refused'
);
reset role;

select extensions.ok(
  (select stopped_at is not null from public.runtime_instances
   where instance_id = 'f1000000-0000-4000-8000-000000000002'),
  'a heartbeat does not clear stopped_at'
);
select extensions.ok(
  (select last_heartbeat_at = stopped_at from public.runtime_instances
   where instance_id = 'f1000000-0000-4000-8000-000000000002'),
  'a stopped instance keeps the heartbeat it recorded when it stopped'
);
select extensions.is(
  (select count(*)::integer from public.runtime_instances
   where instance_id = 'f1000000-0000-4000-8000-0000000000ff'),
  0,
  'a heartbeat never creates an instance row'
);

-- Approved error codes only.  Length was never the safety property.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.register_runtime_instance('f1000000-0000-4000-8000-000000000003', 'avenlyo-api', 'release-one');
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_component(
       'f1000000-0000-4000-8000-000000000003', 'message_processing', 'running', false, 'provider_timeout') $$,
  'an approved operational error code is persisted'
);
select extensions.lives_ok(
  $$ select public.heartbeat_runtime_component(
       'f1000000-0000-4000-8000-000000000003', 'billing_events', 'running', false, 'provider_unavailable') $$,
  'a provider outage is recorded distinctly from a database outage'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
     update public.runtime_component_heartbeats set last_error_code = '+15551234567'
   $sql$, '42501', 'permission denied for table runtime_component_heartbeats')),
  'the trusted backend cannot write an error code directly at all'
);
reset role;

select extensions.is(
  (select last_error_code from public.runtime_component_heartbeats
   where instance_id = 'f1000000-0000-4000-8000-000000000003' and component = 'message_processing'),
  'provider_timeout',
  'the approved code is stored exactly as reported'
);
select extensions.is(
  (select last_error_code from public.runtime_component_heartbeats
   where instance_id = 'f1000000-0000-4000-8000-000000000003' and component = 'billing_events'),
  'provider_unavailable',
  'a provider outage keeps its own code rather than becoming a database outage'
);
select extensions.ok(
  not public.is_approved_runtime_error_code('+15551234567'),
  'a phone number is not an approved error code even though it is short'
);
select extensions.ok(
  not public.is_approved_runtime_error_code('Twilio said 21610 for cus_abc'),
  'a provider response fragment is not an approved error code'
);
select extensions.ok(
  public.is_approved_runtime_error_code('database_unavailable')
    and public.is_approved_runtime_error_code('provider_unavailable')
    and public.is_approved_runtime_error_code('unexpected_error'),
  'the approved set covers the operational codes the application emits'
);

-- The constraint holds against a direct write by the table owner, which is the strongest form of
-- the guarantee: a backend bug cannot persist free-form text by any path.
select extensions.ok(
  (select pg_temp.error_matches($sql$
     update public.runtime_component_heartbeats
     set last_error_code = 'phone +15551234567 rejected by provider'
     where component = 'message_processing'
   $sql$, '23514', 'runtime_component_heartbeats_error_code_approved')),
  'arbitrary error text is refused by the database constraint'
);

-- Fresh, stale, and stopped are three exclusive states.  A silent process is retained for
-- diagnosis and must never be counted as a live replica.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.register_runtime_instance('f2000000-0000-4000-8000-00000000000a', 'avenlyo-api', 'release-two');
select public.register_runtime_instance('f2000000-0000-4000-8000-00000000000b', 'avenlyo-api', 'release-two');
select public.register_runtime_instance('f2000000-0000-4000-8000-00000000000c', 'avenlyo-api', 'release-two');
select public.stop_runtime_instance('f2000000-0000-4000-8000-00000000000c');
reset role;

-- B went silent ninety minutes ago against a twenty-five second heartbeat interval.  The earlier
-- instances are marked stopped so the aggregate isolates exactly A, B, and C.
update public.runtime_instances
set last_heartbeat_at = now() - interval '90 minutes'
where instance_id = 'f2000000-0000-4000-8000-00000000000b';
update public.runtime_instances
set stopped_at = now()
where instance_id in (
  'f1000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000003'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select value::integer from public.get_platform_operational_snapshot()
   where metric_group = 'runtime' and metric = 'active_instances'),
  1,
  'only the freshly reporting instance counts as active'
);
select extensions.is(
  (select value::integer from public.get_platform_operational_snapshot()
   where metric_group = 'runtime' and metric = 'stale_instances'),
  1,
  'the silent instance counts as stale rather than active'
);
select extensions.ok(
  (select value::integer from public.get_platform_operational_snapshot()
   where metric_group = 'runtime' and metric = 'stopped_instances') >= 1,
  'a deliberately stopped instance is neither active nor stale'
);
select extensions.ok(
  exists (
    select 1 from public.get_platform_runtime_status()
    where instance_id = 'f2000000-0000-4000-8000-00000000000b'
  ),
  'runtime history still contains the silent instance for diagnosis'
);
select extensions.is(
  (select value::integer from public.get_platform_operational_snapshot()
   where metric_group = 'runtime' and metric = 'release' and detail = 'release-two'),
  1,
  'the release breakdown counts only instances that are still reporting'
);
reset role;

select * from extensions.finish();
rollback;

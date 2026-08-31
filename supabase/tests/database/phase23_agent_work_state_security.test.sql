begin;
select plan(3);

select has_function(
  'public',
  'get_message_agent_work_state',
  array['uuid'],
  'Phase 23 trusted message work-state read model exists'
);
select extensions.ok(
  has_function_privilege('service_role', 'public.get_message_agent_work_state(uuid)', 'EXECUTE'),
  'trusted backend can read message agent work state'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.get_message_agent_work_state(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_message_agent_work_state(uuid)', 'EXECUTE'),
  'browser roles cannot read opaque pending action identity'
);

select * from finish();
rollback;

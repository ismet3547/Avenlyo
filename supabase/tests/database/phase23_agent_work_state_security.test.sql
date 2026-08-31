begin;
select plan(11);

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

select extensions.ok(
  has_function_privilege(
    'service_role', 'public.persist_ai_mutation_confirmation_reply(uuid,text,uuid,text)', 'EXECUTE'
  ),
  'trusted messaging backend can atomically persist and bind mutation confirmations'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated', 'public.persist_ai_mutation_confirmation_reply(uuid,text,uuid,text)', 'EXECUTE'
  ) and not has_function_privilege(
    'anon', 'public.persist_ai_mutation_confirmation_reply(uuid,text,uuid,text)', 'EXECUTE'
  ),
  'browser roles cannot bind customer mutation confirmation authority'
);
select extensions.ok(
  has_function_privilege(
    'service_role', 'public.get_customer_booking_confirmation_snapshot(uuid)', 'EXECUTE'
  ) and has_function_privilege(
    'service_role', 'public.get_customer_appointment_change_confirmation_snapshot(uuid)', 'EXECUTE'
  ),
  'trusted backend can read deterministic confirmation snapshots'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated', 'public.get_customer_booking_confirmation_snapshot(uuid)', 'EXECUTE'
  ) and not has_function_privilege(
    'anon', 'public.get_customer_booking_confirmation_snapshot(uuid)', 'EXECUTE'
  ) and not has_function_privilege(
    'authenticated', 'public.get_customer_appointment_change_confirmation_snapshot(uuid)', 'EXECUTE'
  ) and not has_function_privilege(
    'anon', 'public.get_customer_appointment_change_confirmation_snapshot(uuid)', 'EXECUTE'
  ),
  'browser roles cannot read prepared mutation confirmation snapshots'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.claim_presented_conversation_scheduling_booking_intent(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) and has_function_privilege(
    'service_role', 'public.claim_presented_appointment_change_intent(uuid,uuid,uuid,text)', 'EXECUTE'
  ),
  'trusted runtime can use presented-confirmation claim entry points'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_presented_conversation_scheduling_booking_intent(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.claim_presented_conversation_scheduling_booking_intent(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated', 'public.claim_presented_appointment_change_intent(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon', 'public.claim_presented_appointment_change_intent(uuid,uuid,uuid,text)', 'EXECUTE'
  ),
  'browser roles cannot claim presented consequential mutations'
);
select extensions.ok(
  not has_function_privilege(
    'service_role', 'public.customer_mutation_confirmation_prompt_is_visible(uuid,uuid)', 'EXECUTE'
  ),
  'internal confirmation visibility predicate is not directly exposed to service_role'
);
select extensions.is(
  (select schema_version from public.platform_schema_contract where id),
  20,
  'Phase 23 database contract advertises schema version 20'
);

select * from finish();
rollback;

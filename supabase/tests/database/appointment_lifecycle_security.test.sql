begin;
select plan(8);

select has_table('public', 'appointment_change_intents', 'durable lifecycle intents exist');
select has_table('public', 'appointment_management_targets', 'opaque appointment references exist');
select has_index('public', 'appointment_change_intents', 'appointment_change_intents_one_active_appointment_key', 'only one active mutation can exist per appointment');
select extensions.ok(
  has_table_privilege('authenticated', 'public.appointment_change_intents', 'SELECT')
  and not has_table_privilege('authenticated', 'public.appointment_change_intents', 'INSERT, UPDATE, DELETE'),
  'authenticated users cannot write lifecycle state directly'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.appointment_change_intents', 'SELECT, INSERT, UPDATE, DELETE'),
  'service role has no direct lifecycle-table grant'
);
select extensions.ok(
  has_function_privilege('service_role', 'public.claim_appointment_change_intent(uuid,uuid,uuid,text)', 'EXECUTE'),
  'trusted backend can claim a lifecycle intent'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.claim_appointment_change_intent(uuid,uuid,uuid,text)', 'EXECUTE'),
  'authenticated users cannot claim a lifecycle intent'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.complete_appointment_change_intent(uuid)', 'EXECUTE'),
  'authenticated users cannot persist a provider result'
);

select * from finish();
rollback;

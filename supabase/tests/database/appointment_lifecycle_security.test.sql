begin;
select plan(8);

select has_table('public', 'appointment_change_intents', 'durable lifecycle intents exist');
select has_table('public', 'appointment_management_targets', 'opaque appointment references exist');
select has_index('public', 'appointment_change_intents', 'appointment_change_intents_one_active_appointment_key', 'only one active mutation can exist per appointment');
select table_privileges_are('authenticated', 'public', 'appointment_change_intents', array['SELECT']::text[], 'authenticated users cannot write lifecycle state directly');
select table_privileges_are('service_role', 'public', 'appointment_change_intents', array[]::text[], 'service role has no direct lifecycle-table grant');
select function_privs_are('service_role', 'public', 'claim_appointment_change_intent', array['uuid','uuid','uuid','text']::text[], array['EXECUTE']::text[], 'trusted backend can claim a lifecycle intent');
select function_privs_are('authenticated', 'public', 'claim_appointment_change_intent', array['uuid','uuid','uuid','text']::text[], array[]::text[], 'authenticated users cannot claim a lifecycle intent');
select function_privs_are('authenticated', 'public', 'complete_appointment_change_intent', array['uuid']::text[], array[]::text[], 'authenticated users cannot persist a provider result');

select * from finish();
rollback;

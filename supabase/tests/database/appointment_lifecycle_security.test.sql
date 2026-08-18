begin;
select plan(19);

select has_table('public', 'appointment_change_intents', 'durable lifecycle intents exist');
select has_table('public', 'appointment_management_targets', 'opaque appointment references exist');
select has_table('public', 'scheduling_slot_leases', 'booking and reschedule leases share one namespace');
select has_column('public', 'appointment_change_intents', 'provider_mutation_target_id', 'the immutable provider mutation target is persisted');
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
select extensions.ok(
  has_function_privilege('service_role', 'public.persist_appointment_change_mutation_target(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.persist_appointment_change_mutation_target(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.persist_appointment_change_mutation_target(uuid,text)', 'EXECUTE'),
  'only the trusted backend can persist a provider mutation target'
);
select extensions.ok(
  has_function_privilege('service_role', 'public.get_voice_appointment_lifecycle_turn(text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_voice_appointment_lifecycle_turn(text,uuid)', 'EXECUTE'),
  'voice call/transcript identity lookup is service-role-only'
);
select is(public.is_explicit_appointment_change_confirmation('cancel', 'Yes, please cancel.'), true, 'positive cancellation confirmation is accepted');
select is(public.is_explicit_appointment_change_confirmation('cancel', 'Do not cancel.'), false, 'negative cancellation phrase is rejected');
select is(public.is_explicit_appointment_change_confirmation('cancel', 'Can you cancel?'), false, 'cancellation question is rejected');
select is(public.is_explicit_appointment_change_confirmation('reschedule', 'yes reschedule'), true, 'positive reschedule confirmation is accepted');
select is(public.is_explicit_appointment_change_confirmation('reschedule', 'maybe move it later'), false, 'hesitant reschedule phrase is rejected');
select is(public.is_explicit_appointment_change_confirmation('reschedule', 'can we move it?'), false, 'reschedule question is rejected');
select extensions.ok(
  not has_table_privilege('service_role', 'public.scheduling_slot_leases', 'SELECT, INSERT, UPDATE, DELETE'),
  'service role has no direct shared scheduling lease table grant'
);

select * from finish();
rollback;

-- Phase 23: a material correction replaces only an uncommitted confirmation snapshot.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(26);

insert into auth.users (id, email)
values ('d4010000-0000-0000-0000-000000000001', 'phase23-correction@example.test');
insert into public.users (id, email)
values ('d4010000-0000-0000-0000-000000000001', 'phase23-correction@example.test')
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('d4020000-0000-0000-0000-000000000001', 'Phase 23 correction', 'phase23-correction',
  'd4010000-0000-0000-0000-000000000001', 'veterinary');
insert into public.billing_accounts (organization_id, stripe_customer_id, livemode, billing_state)
values ('d4020000-0000-0000-0000-000000000001', 'cus_phase23_correction', false, 'active');
insert into public.billing_subscriptions
  (organization_id, stripe_customer_id, stripe_subscription_id, stripe_product_id, stripe_price_id,
   plan_key, is_supported, stripe_status, livemode)
values ('d4020000-0000-0000-0000-000000000001', 'cus_phase23_correction',
  'sub_phase23_correction', 'prod_core', 'price_core', 'core', true, 'active', false);
insert into public.locations (id, organization_id, name, timezone)
values ('d4030000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'Phase 23 correction location', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values ('d4040000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4010000-0000-0000-0000-000000000001', 'owner');
insert into public.integrations
  (id, organization_id, location_id, provider, status, environment, site_timezone)
values ('d4050000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'UTC');
insert into public.location_scheduling_settings (organization_id, location_id, active_integration_id)
values ('d4020000-0000-0000-0000-000000000001', 'd4030000-0000-0000-0000-000000000001',
  'd4050000-0000-0000-0000-000000000001');
insert into public.scheduling_appointment_types
  (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name,
   default_duration_minutes, active, bookable)
values ('d4060000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'd4050000-0000-0000-0000-000000000001',
  'google_calendar', 'avenlyo', 'phase23-correction-type', 'Correction visit', 30, true, true);
insert into public.scheduling_resources
  (id, organization_id, location_id, integration_id, provider, external_uid, external_ownership_id,
   name, active, bookable)
values ('d4070000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'd4050000-0000-0000-0000-000000000001',
  'google_calendar', 'phase23-correction-calendar', null, 'Correction calendar', true, true);
insert into public.scheduling_appointment_type_resources
  (organization_id, location_id, integration_id, appointment_type_id, resource_id)
values ('d4020000-0000-0000-0000-000000000001', 'd4030000-0000-0000-0000-000000000001',
  'd4050000-0000-0000-0000-000000000001', 'd4060000-0000-0000-0000-000000000001',
  'd4070000-0000-0000-0000-000000000001');
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values ('d4080000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'web', 'Correction web');
insert into public.conversations
  (id, organization_id, location_id, channel_id, mode, ai_mode)
values ('d4090000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'd4080000-0000-0000-0000-000000000001',
  'customer', 'ai');

insert into public.messages
  (id, organization_id, location_id, conversation_id, direction, message_type, body,
   source_channel, author_type)
values
  ('d4100000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'inbound', 'text', 'Book the first time', 'web', 'customer'),
  ('d4100000-0000-0000-0000-000000000002', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'inbound', 'text', 'Actually make it the second time', 'web', 'customer'),
  ('d4100000-0000-0000-0000-000000000003', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'inbound', 'text', 'Cancel my existing appointment instead', 'web', 'customer'),
  ('d4100000-0000-0000-0000-000000000004', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'inbound', 'text', 'Actually move it to the new time', 'web', 'customer');

insert into public.booking_candidates
  (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id,
   resource_id, starts_at, ends_at, timezone, status, expires_at)
values
  ('d4110000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'd4050000-0000-0000-0000-000000000001', 'd4060000-0000-0000-0000-000000000001',
   'd4070000-0000-0000-0000-000000000001', now() + interval '3 days',
   now() + interval '3 days 30 minutes', 'UTC', 'offered', now() + interval '1 hour'),
  ('d4110000-0000-0000-0000-000000000002', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'd4050000-0000-0000-0000-000000000001', 'd4060000-0000-0000-0000-000000000001',
   'd4070000-0000-0000-0000-000000000001', now() + interval '4 days',
   now() + interval '4 days 30 minutes', 'UTC', 'offered', now() + interval '1 hour'),
  ('d4110000-0000-0000-0000-000000000003', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'd4050000-0000-0000-0000-000000000001', 'd4060000-0000-0000-0000-000000000001',
   'd4070000-0000-0000-0000-000000000001', now() + interval '6 days',
   now() + interval '6 days 30 minutes', 'UTC', 'offered', now() + interval '1 hour'),
  ('d4110000-0000-0000-0000-000000000004', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'd4050000-0000-0000-0000-000000000001', 'd4060000-0000-0000-0000-000000000001',
   'd4070000-0000-0000-0000-000000000001', now() + interval '5 days',
   now() + interval '5 days 30 minutes', 'UTC', 'consumed', now() + interval '1 hour');
insert into public.booking_intents
  (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status)
values ('d4120000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
  'd4050000-0000-0000-0000-000000000001', 'd4110000-0000-0000-0000-000000000004', 'completed');
insert into public.appointments
  (id, organization_id, location_id, conversation_id, title, status, starts_at, ends_at,
   provider, external_appointment_id, integration_id, booking_intent_id, scheduling_resource_id,
   provider_status)
values ('d4130000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
  'Existing appointment', 'confirmed', now() + interval '5 days', now() + interval '5 days 30 minutes',
  'google_calendar', 'phase23-existing-event', 'd4050000-0000-0000-0000-000000000001',
  'd4120000-0000-0000-0000-000000000001', 'd4070000-0000-0000-0000-000000000001', 'confirmed');

insert into public.appointment_management_targets
  (id, organization_id, location_id, conversation_id, appointment_id, inbound_message_id, expires_at)
values
  ('d4140000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'd4130000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000003',
   now() + interval '1 hour'),
  ('d4140000-0000-0000-0000-000000000002', 'd4020000-0000-0000-0000-000000000001',
   'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
   'd4130000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000004',
   now() + interval '1 hour');
insert into public.appointment_change_candidates
  (id, organization_id, location_id, conversation_id, target_id, integration_id,
   appointment_type_id, resource_id, starts_at, ends_at, timezone, status, expires_at)
values ('d4150000-0000-0000-0000-000000000001', 'd4020000-0000-0000-0000-000000000001',
  'd4030000-0000-0000-0000-000000000001', 'd4090000-0000-0000-0000-000000000001',
  'd4140000-0000-0000-0000-000000000002', 'd4050000-0000-0000-0000-000000000001',
  'd4060000-0000-0000-0000-000000000001', 'd4070000-0000-0000-0000-000000000001',
  now() + interval '7 days', now() + interval '7 days 30 minutes', 'UTC', 'offered', now() + interval '1 hour');

select extensions.ok(
  has_function_privilege('service_role',
    'public.prepare_conversation_scheduling_booking_intent(uuid,uuid,text,text,text,uuid,uuid)', 'EXECUTE'),
  'service_role can reach the ownership-aware booking prepare boundary'
);
select extensions.ok(
  has_function_privilege('service_role',
    'public.prepare_appointment_change_intent(uuid,uuid,uuid,text,uuid)', 'EXECUTE'),
  'service_role can reach the ownership-aware lifecycle prepare boundary'
);
select extensions.ok(
  not has_function_privilege('service_role',
    'public.prepare_conversation_scheduling_booking_intent_base(uuid,uuid,text,text,text,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.prepare_appointment_change_intent_base(uuid,uuid,uuid,text,uuid)', 'EXECUTE'),
  'service_role cannot bypass correction invalidation through the renamed prepare implementations'
);
select extensions.ok(
  not has_function_privilege('authenticated',
    'public.prepare_conversation_scheduling_booking_intent(uuid,uuid,text,text,text,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.prepare_conversation_scheduling_booking_intent(uuid,uuid,text,text,text,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.prepare_appointment_change_intent(uuid,uuid,uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.prepare_appointment_change_intent(uuid,uuid,uuid,text,uuid)', 'EXECUTE'),
  'browser roles cannot prepare or replace opaque customer mutation authority'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select status from public.prepare_conversation_scheduling_booking_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4110000-0000-0000-0000-000000000001',
    null, null, null, null, 'd4100000-0000-0000-0000-000000000001')),
  'awaiting_confirmation', 'the first booking prepare creates an uncommitted action intent'
);
reset role;
select set_config('phase23.booking_a',
  (select id::text from public.booking_intents where candidate_id = 'd4110000-0000-0000-0000-000000000001'), true);
select extensions.is(
  (select status from public.booking_candidates where id = 'd4110000-0000-0000-0000-000000000001'),
  'consumed', 'the authoritative booking prepare consumes its offered candidate'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select pending_mutation_count from public.get_message_agent_work_state(
    'd4100000-0000-0000-0000-000000000002')),
  0, 'work state does not expose a prepared booking before its confirmation prompt is presented'
);
select extensions.is(
  (select pending_mutation_intent_id from public.get_message_agent_work_state(
    'd4100000-0000-0000-0000-000000000002')),
  null::uuid,
  'work state exposes no opaque authority before the booking confirmation is presented'
);
select extensions.is(
  (select booking_intent_id from public.prepare_conversation_scheduling_booking_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4110000-0000-0000-0000-000000000001',
    null, null, null, null, 'd4100000-0000-0000-0000-000000000002')),
  current_setting('phase23.booking_a')::uuid,
  'replaying the exact booking prepare reuses the same pending intent'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.booking_intents
    where candidate_id = 'd4110000-0000-0000-0000-000000000001'),
  1, 'exact prepare replay does not duplicate the durable booking intent'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select status from public.prepare_conversation_scheduling_booking_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4110000-0000-0000-0000-000000000002',
    null, null, null, null, 'd4100000-0000-0000-0000-000000000002')),
  'awaiting_confirmation', 'a material booking correction prepares a replacement intent'
);
reset role;
select set_config('phase23.booking_b',
  (select id::text from public.booking_intents where candidate_id = 'd4110000-0000-0000-0000-000000000002'), true);
select extensions.is(
  (select status from public.booking_intents where id = current_setting('phase23.booking_a')::uuid),
  'invalidated', 'the old booking snapshot becomes INVALIDATED before replacement'
);
select extensions.is(
  (select failure_category from public.booking_intents where id = current_setting('phase23.booking_a')::uuid),
  'customer_correction', 'the old booking retains the bounded correction reason'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_conversation_scheduling_booking_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000002',
    current_setting('phase23.booking_a')::uuid, 'delayed-old-booking-confirmation')),
  'configuration_changed', 'a delayed confirmation cannot revive the invalidated booking snapshot'
);
reset role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select status from public.prepare_appointment_change_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000003',
    'd4140000-0000-0000-0000-000000000001', 'cancel', null)),
  'awaiting_confirmation', 'a cancellation correction prepares one lifecycle intent'
);
reset role;
select set_config('phase23.cancel_a',
  (select id::text from public.appointment_change_intents
    where conversation_id = 'd4090000-0000-0000-0000-000000000001'
      and operation = 'cancel' and status = 'awaiting_confirmation'), true);
select extensions.is(
  (select status from public.booking_intents where id = current_setting('phase23.booking_b')::uuid),
  'invalidated', 'cross-kind correction invalidates the pending booking before cancellation'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select change_intent_id from public.prepare_appointment_change_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000003',
    'd4140000-0000-0000-0000-000000000001', 'cancel', null)),
  current_setting('phase23.cancel_a')::uuid,
  'replaying the exact cancellation prepare is idempotent'
);
select extensions.is(
  (select status from public.prepare_appointment_change_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000004',
    null, 'reschedule', 'd4150000-0000-0000-0000-000000000001')),
  'awaiting_confirmation', 'a reschedule correction prepares a new exact snapshot'
);
reset role;
select set_config('phase23.reschedule_b',
  (select id::text from public.appointment_change_intents
    where conversation_id = 'd4090000-0000-0000-0000-000000000001'
      and operation = 'reschedule' and status = 'awaiting_confirmation'), true);
select extensions.is(
  (select status from public.appointment_change_intents where id = current_setting('phase23.cancel_a')::uuid),
  'invalidated', 'the superseded cancellation becomes INVALIDATED rather than merely expiring'
);
select extensions.is(
  (select failure_category from public.appointment_change_intents where id = current_setting('phase23.cancel_a')::uuid),
  'customer_correction', 'the invalidated lifecycle snapshot records customer_correction'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select state from public.claim_appointment_change_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000004',
    current_setting('phase23.cancel_a')::uuid, 'delayed-old-cancel-confirmation')),
  'configuration_changed', 'a delayed confirmation cannot revive the invalidated cancellation'
);
select extensions.is(
  (select pending_mutation_count from public.get_message_agent_work_state(
    'd4100000-0000-0000-0000-000000000004')),
  0, 'cross-kind correction remains non-actionable until its replacement prompt is presented'
);
reset role;

update public.conversations set ai_mode = 'human'
where id = 'd4090000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$select * from public.prepare_conversation_scheduling_booking_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4110000-0000-0000-0000-000000000003',
    null, null, null, null, 'd4100000-0000-0000-0000-000000000004')$$,
  '42501', 'Customer mutation preparation is not available',
  'human-paused conversation cannot prepare a replacement mutation'
);
reset role;

update public.conversations set ai_mode = 'ai'
where id = 'd4090000-0000-0000-0000-000000000001';
update public.appointment_change_intents
set status = 'provider_state_unknown', failure_category = 'provider_result_ambiguous', updated_at = now()
where id = current_setting('phase23.reschedule_b')::uuid;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$select * from public.prepare_conversation_scheduling_booking_intent(
    'd4090000-0000-0000-0000-000000000001', 'd4110000-0000-0000-0000-000000000003',
    null, null, null, null, 'd4100000-0000-0000-0000-000000000004')$$,
  '55000', 'Customer mutation outcome must be resolved before another mutation is prepared',
  'provider-unknown mutation blocks a fresh correction instead of permitting a blind second write'
);
reset role;
select extensions.is(
  (select status from public.appointment_change_intents where id = current_setting('phase23.reschedule_b')::uuid),
  'provider_state_unknown', 'blocked correction preserves the provider-unknown lifecycle truth'
);
select extensions.is(
  (select status from public.booking_candidates where id = 'd4110000-0000-0000-0000-000000000003'),
  'offered', 'blocked correction does not consume or mutate the new candidate'
);

select extensions.finish();
rollback;
-- Phase 23: a confirmation arriving on another channel/conversation cannot silently authorize
-- a consequential action prepared elsewhere. Cross-channel continuation must re-enter through a
-- trusted product flow and obtain a fresh confirmation; this test pins the fail-closed boundary.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(5);

insert into auth.users (id, email)
values ('d6010000-0000-0000-0000-000000000001', 'phase23-cross-channel@example.test');
insert into public.users (id, email)
values ('d6010000-0000-0000-0000-000000000001', 'phase23-cross-channel@example.test')
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values (
  'd6020000-0000-0000-0000-000000000001',
  'Phase 23 cross channel',
  'phase23-cross-channel',
  'd6010000-0000-0000-0000-000000000001',
  'veterinary'
);
insert into public.locations (id, organization_id, name, timezone)
values (
  'd6030000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'Phase 23 cross-channel location',
  'UTC'
);
insert into public.organization_members (id, organization_id, user_id, role)
values (
  'd6040000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'd6010000-0000-0000-0000-000000000001',
  'owner'
);

insert into public.integrations
  (id, organization_id, location_id, provider, status, environment, site_timezone)
values (
  'd6050000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'd6030000-0000-0000-0000-000000000001',
  'google_calendar', 'connected', 'production', 'UTC'
);
insert into public.scheduling_appointment_types
  (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name,
   default_duration_minutes, active, bookable)
values (
  'd6060000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'd6030000-0000-0000-0000-000000000001',
  'd6050000-0000-0000-0000-000000000001',
  'google_calendar', 'avenlyo', 'phase23-cross-channel-type', 'Cross-channel visit', 30, true, true
);
insert into public.scheduling_resources
  (id, organization_id, location_id, integration_id, provider, external_uid, external_ownership_id,
   name, active, bookable)
values (
  'd6070000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'd6030000-0000-0000-0000-000000000001',
  'd6050000-0000-0000-0000-000000000001',
  'google_calendar', 'phase23-cross-channel-calendar', null, 'Cross-channel calendar', true, true
);

insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values
  ('d6080000-0000-0000-0000-000000000001', 'd6020000-0000-0000-0000-000000000001',
   'd6030000-0000-0000-0000-000000000001', 'web', 'Cross-channel web'),
  ('d6080000-0000-0000-0000-000000000002', 'd6020000-0000-0000-0000-000000000001',
   'd6030000-0000-0000-0000-000000000001', 'sms', 'Cross-channel SMS');
insert into public.conversations
  (id, organization_id, location_id, channel_id, mode, ai_mode)
values
  ('d6090000-0000-0000-0000-000000000001', 'd6020000-0000-0000-0000-000000000001',
   'd6030000-0000-0000-0000-000000000001', 'd6080000-0000-0000-0000-000000000001',
   'customer', 'ai'),
  ('d6090000-0000-0000-0000-000000000002', 'd6020000-0000-0000-0000-000000000001',
   'd6030000-0000-0000-0000-000000000001', 'd6080000-0000-0000-0000-000000000002',
   'customer', 'ai');
insert into public.messages
  (id, organization_id, location_id, conversation_id, direction, message_type, body,
   source_channel, author_type)
values
  ('d6100000-0000-0000-0000-000000000001', 'd6020000-0000-0000-0000-000000000001',
   'd6030000-0000-0000-0000-000000000001', 'd6090000-0000-0000-0000-000000000001',
   'inbound', 'text', 'Book Friday at 2pm', 'web', 'customer'),
  ('d6100000-0000-0000-0000-000000000002', 'd6020000-0000-0000-0000-000000000001',
   'd6030000-0000-0000-0000-000000000001', 'd6090000-0000-0000-0000-000000000002',
   'inbound', 'text', 'Yes', 'sms', 'customer'),
  ('d6100000-0000-0000-0000-000000000003', 'd6020000-0000-0000-0000-000000000001',
   'd6030000-0000-0000-0000-000000000001', 'd6090000-0000-0000-0000-000000000001',
   'outbound', 'text', 'Please confirm the exact Web booking. Reply YES to confirm.', 'web', 'ai');
insert into public.message_deliveries
  (id, organization_id, location_id, message_id, provider, status, sent_at)
values (
  'd6130000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'd6030000-0000-0000-0000-000000000001',
  'd6100000-0000-0000-0000-000000000003',
  'web_chat', 'sent', now()
);

insert into public.booking_candidates
  (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id,
   resource_id, starts_at, ends_at, timezone, status, expires_at)
values (
  'd6110000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'd6030000-0000-0000-0000-000000000001',
  'd6090000-0000-0000-0000-000000000001',
  'd6050000-0000-0000-0000-000000000001',
  'd6060000-0000-0000-0000-000000000001',
  'd6070000-0000-0000-0000-000000000001',
  now() + interval '3 days', now() + interval '3 days 30 minutes', 'UTC', 'consumed',
  now() + interval '1 hour'
);
insert into public.booking_intents
  (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status,
   confirmation_prompt_message_id)
values (
  'd6120000-0000-0000-0000-000000000001',
  'd6020000-0000-0000-0000-000000000001',
  'd6030000-0000-0000-0000-000000000001',
  'd6090000-0000-0000-0000-000000000001',
  'd6050000-0000-0000-0000-000000000001',
  'd6110000-0000-0000-0000-000000000001',
  'awaiting_confirmation',
  'd6100000-0000-0000-0000-000000000003'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select pending_mutation_count from public.get_message_agent_work_state(
    'd6100000-0000-0000-0000-000000000001')),
  1,
  'the originating Web conversation sees its one presented pending booking authority'
);
select extensions.is(
  (select pending_mutation_intent_id from public.get_message_agent_work_state(
    'd6100000-0000-0000-0000-000000000001')),
  'd6120000-0000-0000-0000-000000000001'::uuid,
  'the originating Web work-state binds the exact opaque booking intent'
);
select extensions.is(
  (select pending_mutation_count from public.get_message_agent_work_state(
    'd6100000-0000-0000-0000-000000000002')),
  0,
  'a generic SMS confirmation in another conversation sees no pending Web authority'
);
select extensions.throws_ok(
  $$select * from public.claim_conversation_scheduling_booking_intent(
    'd6090000-0000-0000-0000-000000000002',
    'd6100000-0000-0000-0000-000000000002',
    'd6120000-0000-0000-0000-000000000001',
    'cross-channel-generic-yes')$$,
  '42501', 'Booking intent is not available',
  'another channel/conversation cannot claim the opaque booking intent even if it guesses the id'
);
reset role;
select extensions.is(
  (select status from public.booking_intents where id = 'd6120000-0000-0000-0000-000000000001'),
  'awaiting_confirmation',
  'a refused cross-channel confirmation leaves the original action pending and unmutated'
);

select extensions.finish();
rollback;

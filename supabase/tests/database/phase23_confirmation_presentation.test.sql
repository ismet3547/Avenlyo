-- Phase 23: durable prepare is not customer authorization. A text mutation becomes actionable only
-- after its exact bound confirmation prompt is customer-visible, and the confirming inbound turn is
-- later than that prompt in the same conversation.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(6);

insert into auth.users (id, email)
values ('e7010000-0000-0000-0000-000000000001', 'phase23-presentation@example.test');
insert into public.users (id, email)
values ('e7010000-0000-0000-0000-000000000001', 'phase23-presentation@example.test')
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values (
  'e7020000-0000-0000-0000-000000000001',
  'Phase 23 presentation',
  'phase23-presentation',
  'e7010000-0000-0000-0000-000000000001',
  'veterinary'
);
insert into public.locations (id, organization_id, name, timezone)
values (
  'e7030000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'Phase 23 presentation location',
  'UTC'
);
insert into public.integrations
  (id, organization_id, location_id, provider, status, environment, site_timezone)
values (
  'e7040000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'google_calendar', 'connected', 'production', 'UTC'
);
insert into public.scheduling_appointment_types
  (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name,
   default_duration_minutes, active, bookable)
values (
  'e7050000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'e7040000-0000-0000-0000-000000000001',
  'google_calendar', 'avenlyo', 'phase23-presentation-type', 'Presentation visit', 30, true, true
);
insert into public.scheduling_resources
  (id, organization_id, location_id, integration_id, provider, external_uid, external_ownership_id,
   name, active, bookable)
values (
  'e7060000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'e7040000-0000-0000-0000-000000000001',
  'google_calendar', 'phase23-presentation-calendar', null, 'Presentation calendar', true, true
);
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values (
  'e7070000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'sms', 'Presentation SMS'
);
insert into public.conversations
  (id, organization_id, location_id, channel_id, mode, ai_mode)
values (
  'e7080000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'e7070000-0000-0000-0000-000000000001',
  'customer', 'ai'
);

insert into public.messages
  (id, organization_id, location_id, conversation_id, direction, message_type, body,
   source_channel, author_type, created_at)
values
  ('e7090000-0000-0000-0000-000000000001', 'e7020000-0000-0000-0000-000000000001',
   'e7030000-0000-0000-0000-000000000001', 'e7080000-0000-0000-0000-000000000001',
   'inbound', 'text', 'Yes before the prompt', 'sms', 'customer', now() - interval '2 minutes'),
  ('e7090000-0000-0000-0000-000000000002', 'e7020000-0000-0000-0000-000000000001',
   'e7030000-0000-0000-0000-000000000001', 'e7080000-0000-0000-0000-000000000001',
   'outbound', 'text', 'Please confirm the exact appointment. Reply YES to confirm.', 'sms', 'ai',
   now() - interval '1 minute'),
  ('e7090000-0000-0000-0000-000000000003', 'e7020000-0000-0000-0000-000000000001',
   'e7030000-0000-0000-0000-000000000001', 'e7080000-0000-0000-0000-000000000001',
   'inbound', 'text', 'Yes after the prompt', 'sms', 'customer', now());
insert into public.message_deliveries
  (id, organization_id, location_id, message_id, provider, status)
values (
  'e7100000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'e7090000-0000-0000-0000-000000000002',
  'twilio', 'queued'
);
insert into public.booking_candidates
  (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id,
   resource_id, starts_at, ends_at, timezone, status, expires_at)
values (
  'e7110000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'e7080000-0000-0000-0000-000000000001',
  'e7040000-0000-0000-0000-000000000001',
  'e7050000-0000-0000-0000-000000000001',
  'e7060000-0000-0000-0000-000000000001',
  now() + interval '3 days', now() + interval '3 days 30 minutes', 'UTC', 'consumed',
  now() + interval '1 hour'
);
insert into public.booking_intents
  (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status,
   confirmation_prompt_message_id)
values (
  'e7120000-0000-0000-0000-000000000001',
  'e7020000-0000-0000-0000-000000000001',
  'e7030000-0000-0000-0000-000000000001',
  'e7080000-0000-0000-0000-000000000001',
  'e7040000-0000-0000-0000-000000000001',
  'e7110000-0000-0000-0000-000000000001',
  'awaiting_confirmation',
  'e7090000-0000-0000-0000-000000000002'
);

-- Public trusted reads execute as the backend role; fixture updates below deliberately return to
-- postgres because service_role has no direct table DML privilege and must never gain one for tests.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select pending_mutation_count from public.get_message_agent_work_state(
    'e7090000-0000-0000-0000-000000000003')),
  0,
  'a queued SMS confirmation does not expose a pending execution authority'
);
reset role;

select extensions.throws_ok(
  $$update public.booking_intents
    set status = 'booking', confirmed_message_id = 'e7090000-0000-0000-0000-000000000003'
    where id = 'e7120000-0000-0000-0000-000000000001'$$,
  '42501', 'Presented booking confirmation is required',
  'the transition guard rejects a customer confirmation while the prompt is not visible'
);

update public.message_deliveries
set status = 'sent', sent_at = now()
where id = 'e7100000-0000-0000-0000-000000000001';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select pending_mutation_count from public.get_message_agent_work_state(
    'e7090000-0000-0000-0000-000000000003')),
  1,
  'a visible bound SMS confirmation exposes exactly one pending authority'
);
reset role;

select extensions.throws_ok(
  $$update public.booking_intents
    set status = 'booking', confirmed_message_id = 'e7090000-0000-0000-0000-000000000001'
    where id = 'e7120000-0000-0000-0000-000000000001'$$,
  '42501', 'Presented booking confirmation is required',
  'a customer turn that predates the prompt cannot authorize the mutation'
);
select extensions.lives_ok(
  $$update public.booking_intents
    set status = 'booking', confirmed_message_id = 'e7090000-0000-0000-0000-000000000003'
    where id = 'e7120000-0000-0000-0000-000000000001'$$,
  'a later customer confirmation may cross the guarded transition once the prompt is visible'
);
select extensions.is(
  (select status from public.booking_intents where id = 'e7120000-0000-0000-0000-000000000001'),
  'booking',
  'the accepted transition records the consequential action as committing'
);

select extensions.finish();
rollback;

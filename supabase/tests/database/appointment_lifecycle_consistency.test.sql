-- Executable Phase 9 regression coverage for immutable lifecycle identity and reminder history.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(14);

insert into auth.users (id, email) values ('f9010000-0000-0000-0000-000000000001', 'lifecycle-consistency@example.test');
insert into public.users (id, email) values ('f9010000-0000-0000-0000-000000000001', 'lifecycle-consistency@example.test') on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('f9020000-0000-0000-0000-000000000001', 'Lifecycle consistency', 'lifecycle-consistency', 'f9010000-0000-0000-0000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name, timezone)
values ('f9030000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'Lifecycle location', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values ('f9040000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9010000-0000-0000-0000-000000000001', 'owner');
insert into public.integrations (id, organization_id, location_id, provider, status, environment, site_timezone) values
  ('f9050000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'UTC'),
  ('f9050000-0000-0000-0000-000000000002', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'ezyvet', 'connected', 'trial', 'UTC');
insert into public.location_scheduling_settings (organization_id, location_id, active_integration_id)
values ('f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9050000-0000-0000-0000-000000000001');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name, default_duration_minutes, active, bookable)
values ('f9060000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9050000-0000-0000-0000-000000000001', 'google_calendar', 'avenlyo', 'lifecycle-type', 'Lifecycle visit', 30, true, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, active, bookable) values
  ('f9070000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9050000-0000-0000-0000-000000000001', 'google_calendar', 'calendar-a', 'Calendar A', true, true),
  ('f9070000-0000-0000-0000-000000000002', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9050000-0000-0000-0000-000000000001', 'google_calendar', 'calendar-b', 'Calendar B', true, true),
  ('f9070000-0000-0000-0000-000000000003', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9050000-0000-0000-0000-000000000002', 'ezyvet', 'ezyvet-a', 'ezyVet A', true, true);
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values ('f9080000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'phone', 'Lifecycle phone');
insert into public.conversations (id, organization_id, location_id, channel_id)
values ('f9090000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9080000-0000-0000-0000-000000000001');
insert into public.calls (id, organization_id, location_id, conversation_id, direction, provider, external_call_id, transport_caller_e164) values
  ('f9100000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'inbound', 'openai-realtime-sip', 'historical-caller', '+14155550123'),
  ('f9100000-0000-0000-0000-000000000002', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'inbound', 'openai-realtime-sip', 'current-other-caller', '+14155559999');
insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
values ('f9110000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'f9050000-0000-0000-0000-000000000001', 'f9060000-0000-0000-0000-000000000001', 'f9070000-0000-0000-0000-000000000001', now() + interval '5 days', now() + interval '5 days 30 minutes', 'UTC', now() + interval '1 hour');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status, trusted_transport_phone_e164)
values ('f9120000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'f9050000-0000-0000-0000-000000000001', 'f9110000-0000-0000-0000-000000000001', 'completed', '+14155550123');
insert into public.appointments (id, organization_id, location_id, conversation_id, title, status, starts_at, ends_at, provider, external_appointment_id, integration_id, booking_intent_id, scheduling_resource_id, provider_status, trusted_sms_recipient_e164)
values ('f9130000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'Lifecycle appointment', 'confirmed', now() + interval '5 days', now() + interval '5 days 30 minutes', 'google_calendar', 'event-original', 'f9050000-0000-0000-0000-000000000001', 'f9120000-0000-0000-0000-000000000001', 'f9070000-0000-0000-0000-000000000001', 'confirmed', '+14155550123');

-- Each failed fresh claim gets a separate intent so the unique active-intent constraint remains real.
create function pg_temp.snapshot_claim(target_intent_id uuid, target_message_id uuid) returns text language plpgsql security definer set search_path = '' as $$
begin
  insert into public.appointment_change_intents (id, organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, original_external_appointment_id, original_starts_at, original_ends_at, original_resource_id, created_at, expires_at)
  select target_intent_id, appointment.organization_id, appointment.location_id, appointment.conversation_id, appointment.id, appointment.booking_intent_id, 'f9050000-0000-0000-0000-000000000001', 'google_calendar', 'cancel', 'event-original', now() + interval '5 days', now() + interval '5 days 30 minutes', 'f9070000-0000-0000-0000-000000000001', now() - interval '1 minute', now() + interval '10 minutes'
  from public.appointments appointment where appointment.id = 'f9130000-0000-0000-0000-000000000001';
  insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type)
  values (target_message_id, 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'inbound', 'voice_transcript', 'yes cancel', 'voice', 'customer');
  perform set_config('request.jwt.claim.role', 'service_role', true);
  return (select state from public.claim_appointment_change_intent('f9090000-0000-0000-0000-000000000001', target_message_id, target_intent_id, 'lifecycle-snapshot-test'));
end;
$$;

update public.appointments set starts_at = now() + interval '5 days 1 minute' where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select extensions.is(pg_temp.snapshot_claim('f9140000-0000-0000-0000-000000000001', 'f9150000-0000-0000-0000-000000000001'), 'configuration_changed', 'fresh lifecycle claim blocks a changed start time');
reset role;
update public.appointments set starts_at = now() + interval '5 days' where id = 'f9130000-0000-0000-0000-000000000001';
update public.appointments set ends_at = now() + interval '5 days 31 minutes' where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select extensions.is(pg_temp.snapshot_claim('f9140000-0000-0000-0000-000000000002', 'f9150000-0000-0000-0000-000000000002'), 'configuration_changed', 'fresh lifecycle claim blocks a changed end time');
reset role;
update public.appointments set ends_at = now() + interval '5 days 30 minutes' where id = 'f9130000-0000-0000-0000-000000000001';
update public.appointments set scheduling_resource_id = 'f9070000-0000-0000-0000-000000000002' where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select extensions.is(pg_temp.snapshot_claim('f9140000-0000-0000-0000-000000000003', 'f9150000-0000-0000-0000-000000000003'), 'configuration_changed', 'fresh lifecycle claim blocks a changed scheduling resource');
reset role;
update public.appointments set scheduling_resource_id = 'f9070000-0000-0000-0000-000000000001' where id = 'f9130000-0000-0000-0000-000000000001';
update public.appointments set external_appointment_id = 'event-changed' where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select extensions.is(pg_temp.snapshot_claim('f9140000-0000-0000-0000-000000000004', 'f9150000-0000-0000-0000-000000000004'), 'configuration_changed', 'fresh lifecycle claim blocks a changed provider appointment id');
reset role;
update public.appointments set external_appointment_id = 'event-original' where id = 'f9130000-0000-0000-0000-000000000001';
update public.appointments set provider = 'ezyvet' where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select extensions.is(pg_temp.snapshot_claim('f9140000-0000-0000-0000-000000000005', 'f9150000-0000-0000-0000-000000000005'), 'configuration_changed', 'fresh lifecycle claim blocks a changed provider');
reset role;
update public.appointments set provider = 'google_calendar' where id = 'f9130000-0000-0000-0000-000000000001';
update public.appointments set integration_id = 'f9050000-0000-0000-0000-000000000002', scheduling_resource_id = 'f9070000-0000-0000-0000-000000000003' where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select extensions.is(pg_temp.snapshot_claim('f9140000-0000-0000-0000-000000000006', 'f9150000-0000-0000-0000-000000000006'), 'configuration_changed', 'fresh lifecycle claim blocks a changed integration');
reset role;
update public.appointments set integration_id = 'f9050000-0000-0000-0000-000000000001', scheduling_resource_id = 'f9070000-0000-0000-0000-000000000001' where id = 'f9130000-0000-0000-0000-000000000001';

insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type)
values ('f9150000-0000-0000-0000-000000000007', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'inbound', 'voice_transcript', 'manage appointment', 'voice', 'customer');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.create_conversation_appointment_management_targets('f9090000-0000-0000-0000-000000000001', 'f9150000-0000-0000-0000-000000000007', (select trusted_caller_e164 from public.get_voice_appointment_lifecycle_turn('current-other-caller', 'f9150000-0000-0000-0000-000000000007')))), 0, 'a current unmatched voice caller cannot expose a historical caller appointment');
select extensions.is((select count(*)::integer from public.create_conversation_appointment_management_targets('f9090000-0000-0000-0000-000000000001', 'f9150000-0000-0000-0000-000000000007', (select trusted_caller_e164 from public.get_voice_appointment_lifecycle_turn('historical-caller', 'f9150000-0000-0000-0000-000000000007')))), 1, 'the exact current matching voice caller can receive an appointment reference');
reset role;

-- A sent reminder keeps its message link across both lifecycle completions; unsent reminders are
-- the only rows the cancellation/reschedule cleanup may invalidate.
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type)
values ('f9160000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9090000-0000-0000-0000-000000000001', 'outbound', 'text', 'Historical reminder', 'sms', 'system');
insert into public.appointment_reminder_settings (organization_id, location_id, sms_enabled, reminder_24h_enabled, reminder_2h_enabled, quiet_hours_start, quiet_hours_end)
values ('f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', true, true, true, '20:00', '08:00');
insert into public.appointment_reminders (id, organization_id, location_id, appointment_id, reminder_type, scheduled_for, status, message_id, trusted_sms_recipient_e164)
values ('f9170000-0000-0000-0000-000000000001', 'f9020000-0000-0000-0000-000000000001', 'f9030000-0000-0000-0000-000000000001', 'f9130000-0000-0000-0000-000000000001', 'appointment_24h', now() - interval '1 hour', 'sent', 'f9160000-0000-0000-0000-000000000001', '+14155550123');
insert into public.appointment_change_intents (id, organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, original_external_appointment_id, original_starts_at, original_ends_at, original_resource_id, target_starts_at, target_ends_at, target_resource_id, status, expires_at)
select 'f9180000-0000-0000-0000-000000000002', organization_id, location_id, conversation_id, id, booking_intent_id, integration_id, provider, 'reschedule', external_appointment_id, starts_at, ends_at, scheduling_resource_id, now() + interval '6 days', now() + interval '6 days 30 minutes', scheduling_resource_id, 'provider_success_pending_persistence', now() + interval '10 minutes' from public.appointments where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.complete_appointment_change_intent('f9180000-0000-0000-0000-000000000002');
reset role;
select extensions.is((select status from public.appointment_reminders where id = 'f9170000-0000-0000-0000-000000000001'), 'sent', 'rescheduling preserves a sent reminder status');
select extensions.is((select message_id from public.appointment_reminders where id = 'f9170000-0000-0000-0000-000000000001'), 'f9160000-0000-0000-0000-000000000001'::uuid, 'rescheduling preserves a sent reminder message history link');
select extensions.ok(exists (select 1 from public.appointment_reminders where appointment_id = 'f9130000-0000-0000-0000-000000000001' and id <> 'f9170000-0000-0000-0000-000000000001' and status = 'scheduled'), 'rescheduling creates a distinct future unsent reminder schedule');
insert into public.appointment_change_intents (id, organization_id, location_id, conversation_id, appointment_id, booking_intent_id, integration_id, provider, operation, original_external_appointment_id, original_starts_at, original_ends_at, original_resource_id, status, expires_at)
select 'f9180000-0000-0000-0000-000000000001', organization_id, location_id, conversation_id, id, booking_intent_id, integration_id, provider, 'cancel', external_appointment_id, starts_at, ends_at, scheduling_resource_id, 'provider_success_pending_persistence', now() + interval '10 minutes' from public.appointments where id = 'f9130000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.complete_appointment_change_intent('f9180000-0000-0000-0000-000000000001');
reset role;
select extensions.is((select status from public.appointment_reminders where id = 'f9170000-0000-0000-0000-000000000001'), 'sent', 'cancelling preserves a sent reminder status');
select extensions.is((select message_id from public.appointment_reminders where id = 'f9170000-0000-0000-0000-000000000001'), 'f9160000-0000-0000-0000-000000000001'::uuid, 'cancelling preserves a sent reminder message history link');
select extensions.ok(exists (select 1 from public.appointment_reminders where appointment_id = 'f9130000-0000-0000-0000-000000000001' and id <> 'f9170000-0000-0000-0000-000000000001' and status = 'skipped' and last_error_code = 'appointment_cancelled'), 'cancelling suppresses only the unsent reminder schedule');

select * from extensions.finish();
rollback;

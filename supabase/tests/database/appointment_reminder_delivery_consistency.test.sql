-- Phase 8 final delivery authorization and bounded reconciliation regression coverage.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(18);

insert into auth.users (id, email)
values ('a9700000-0000-0000-0000-000000000001', 'reminder-consistency-owner@example.test');
insert into public.users (id, email)
values ('a9700000-0000-0000-0000-000000000001', 'reminder-consistency-owner@example.test') on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('a9710000-0000-0000-0000-000000000001', 'Reminder Consistency', 'reminder-consistency', 'a9700000-0000-0000-0000-000000000001', 'veterinary');
insert into public.organization_members (id, organization_id, user_id, role)
values ('a9720000-0000-0000-0000-000000000001', 'a9710000-0000-0000-0000-000000000001', 'a9700000-0000-0000-0000-000000000001', 'owner');
insert into public.locations (id, organization_id, name, timezone)
values ('a9730000-0000-0000-0000-000000000001', 'a9710000-0000-0000-0000-000000000001', 'Policy delivery checks', 'UTC');
insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled)
values ('a9740000-0000-0000-0000-000000000001', 'a9710000-0000-0000-0000-000000000001', 'a9730000-0000-0000-0000-000000000001', '+14155550300', 'active', true);

insert into public.appointment_reminder_settings (
  organization_id, location_id, sms_enabled, reminder_24h_enabled, reminder_2h_enabled, quiet_hours_start, quiet_hours_end
) values (
  'a9710000-0000-0000-0000-000000000001', 'a9730000-0000-0000-0000-000000000001', true, true, true,
  ((now() at time zone 'UTC')::time + interval '2 hours')::time,
  ((now() at time zone 'UTC')::time + interval '3 hours')::time
);
select set_config('app.policy_quiet_start', (
  select quiet_hours_start::text from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001'
), true);
select set_config('app.policy_quiet_end', (
  select quiet_hours_end::text from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001'
), true);

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values
  ('a9750000-0000-0000-0000-000000000001', 'a9710000-0000-0000-0000-000000000001', 'a9730000-0000-0000-0000-000000000001', 'Disable 2h after materialization', 'confirmed', now() + interval '2 hours 10 minutes', now() + interval '2 hours 40 minutes', '+14155550301'),
  ('a9750000-0000-0000-0000-000000000002', 'a9710000-0000-0000-0000-000000000001', 'a9730000-0000-0000-0000-000000000001', 'Disable 24h after materialization', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550302'),
  ('a9750000-0000-0000-0000-000000000003', 'a9710000-0000-0000-0000-000000000001', 'a9730000-0000-0000-0000-000000000001', 'Quiet change after materialization', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550303'),
  ('a9750000-0000-0000-0000-000000000004', 'a9710000-0000-0000-0000-000000000001', 'a9730000-0000-0000-0000-000000000001', 'Time change after materialization', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550304'),
  ('a9750000-0000-0000-0000-000000000005', 'a9710000-0000-0000-0000-000000000001', 'a9730000-0000-0000-0000-000000000001', 'No-op settings after materialization', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550305');

-- 2-hour type disabled after the message is materialized: no provider authorization occurs.
update public.appointment_reminders set status = 'processing', revalidation_status = 'not_required'
where appointment_id = 'a9750000-0000-0000-0000-000000000001' and reminder_type = 'appointment_2h';
select set_config('app.policy_reminder_2h', (
  select id::text from public.appointment_reminders where appointment_id = 'a9750000-0000-0000-0000-000000000001' and reminder_type = 'appointment_2h'
), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.create_appointment_reminder_message(current_setting('app.policy_reminder_2h')::uuid);
reset role;
select set_config('app.policy_message_2h', (
  select message_id::text from public.appointment_reminders where id = current_setting('app.policy_reminder_2h')::uuid
), true);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9700000-0000-0000-0000-000000000001', true);
select public.upsert_my_appointment_reminder_settings(
  'a9730000-0000-0000-0000-000000000001', true, true, false,
  current_setting('app.policy_quiet_start')::time, current_setting('app.policy_quiet_end')::time
);
reset role;
update public.appointment_reminders
set schedule_version = (select schedule_version from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001')
where id = current_setting('app.policy_reminder_2h')::uuid;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_sms_delivery_submission(current_setting('app.policy_message_2h')::uuid)), 0, 'disabling 2-hour reminders after materialization authorizes zero provider sends');
reset role;
select extensions.is((select status from public.message_deliveries where message_id = current_setting('app.policy_message_2h')::uuid), 'suppressed', 'a disabled 2-hour reminder delivery is suppressed');
select extensions.is((select status from public.appointment_reminders where id = current_setting('app.policy_reminder_2h')::uuid), 'skipped', 'a disabled 2-hour reminder projects to skipped');

-- Restore the policy, then prove the same gate for the 24-hour type.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9700000-0000-0000-0000-000000000001', true);
select public.upsert_my_appointment_reminder_settings(
  'a9730000-0000-0000-0000-000000000001', true, true, true,
  current_setting('app.policy_quiet_start')::time, current_setting('app.policy_quiet_end')::time
);
reset role;
update public.appointment_reminders set status = 'processing', revalidation_status = 'not_required'
where appointment_id = 'a9750000-0000-0000-0000-000000000002' and reminder_type = 'appointment_24h';
select set_config('app.policy_reminder_24h_disabled', (
  select id::text from public.appointment_reminders where appointment_id = 'a9750000-0000-0000-0000-000000000002' and reminder_type = 'appointment_24h'
), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.create_appointment_reminder_message(current_setting('app.policy_reminder_24h_disabled')::uuid);
reset role;
select set_config('app.policy_message_24h_disabled', (
  select message_id::text from public.appointment_reminders where id = current_setting('app.policy_reminder_24h_disabled')::uuid
), true);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9700000-0000-0000-0000-000000000001', true);
select public.upsert_my_appointment_reminder_settings(
  'a9730000-0000-0000-0000-000000000001', true, false, true,
  current_setting('app.policy_quiet_start')::time, current_setting('app.policy_quiet_end')::time
);
reset role;
update public.appointment_reminders
set schedule_version = (select schedule_version from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001')
where id = current_setting('app.policy_reminder_24h_disabled')::uuid;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_sms_delivery_submission(current_setting('app.policy_message_24h_disabled')::uuid)), 0, 'disabling 24-hour reminders after materialization authorizes zero provider sends');
reset role;
select extensions.is((select status from public.message_deliveries where message_id = current_setting('app.policy_message_24h_disabled')::uuid), 'suppressed', 'a disabled 24-hour reminder delivery is suppressed');
select extensions.is((select status from public.appointment_reminders where id = current_setting('app.policy_reminder_24h_disabled')::uuid), 'skipped', 'a disabled 24-hour reminder projects to skipped');

-- Restore both types before the schedule-version and appointment-time cases.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9700000-0000-0000-0000-000000000001', true);
select public.upsert_my_appointment_reminder_settings(
  'a9730000-0000-0000-0000-000000000001', true, true, true,
  current_setting('app.policy_quiet_start')::time, current_setting('app.policy_quiet_end')::time
);
reset role;

update public.appointment_reminders set status = 'processing', revalidation_status = 'not_required'
where appointment_id = 'a9750000-0000-0000-0000-000000000003' and reminder_type = 'appointment_24h';
select set_config('app.policy_reminder_quiet', (
  select id::text from public.appointment_reminders where appointment_id = 'a9750000-0000-0000-0000-000000000003' and reminder_type = 'appointment_24h'
), true);
update public.appointment_reminders
set schedule_version = (select schedule_version from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001')
where id = current_setting('app.policy_reminder_quiet')::uuid;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.create_appointment_reminder_message(current_setting('app.policy_reminder_quiet')::uuid);
reset role;
select set_config('app.policy_message_quiet', (
  select message_id::text from public.appointment_reminders where id = current_setting('app.policy_reminder_quiet')::uuid
), true);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9700000-0000-0000-0000-000000000001', true);
select public.upsert_my_appointment_reminder_settings(
  'a9730000-0000-0000-0000-000000000001', true, true, true,
  ((now() at time zone 'UTC')::time + interval '4 hours')::time,
  ((now() at time zone 'UTC')::time + interval '5 hours')::time
);
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_sms_delivery_submission(current_setting('app.policy_message_quiet')::uuid)), 0, 'a quiet-hours schedule-version change after materialization authorizes zero provider sends');
reset role;
select extensions.is((select status from public.message_deliveries where message_id = current_setting('app.policy_message_quiet')::uuid), 'suppressed', 'a stale quiet-hours reminder delivery is suppressed');

-- Restore the original quiet policy and change only the appointment time after materialization.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9700000-0000-0000-0000-000000000001', true);
select public.upsert_my_appointment_reminder_settings(
  'a9730000-0000-0000-0000-000000000001', true, true, true,
  current_setting('app.policy_quiet_start')::time, current_setting('app.policy_quiet_end')::time
);
reset role;
update public.appointment_reminders set status = 'processing', revalidation_status = 'not_required'
where appointment_id = 'a9750000-0000-0000-0000-000000000004' and reminder_type = 'appointment_24h';
select set_config('app.policy_reminder_time', (
  select id::text from public.appointment_reminders where appointment_id = 'a9750000-0000-0000-0000-000000000004' and reminder_type = 'appointment_24h'
), true);
update public.appointment_reminders
set schedule_version = (select schedule_version from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001')
where id = current_setting('app.policy_reminder_time')::uuid;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.create_appointment_reminder_message(current_setting('app.policy_reminder_time')::uuid);
reset role;
select set_config('app.policy_message_time', (
  select message_id::text from public.appointment_reminders where id = current_setting('app.policy_reminder_time')::uuid
), true);
update public.appointments
set starts_at = starts_at + interval '15 minutes', ends_at = ends_at + interval '15 minutes'
where id = 'a9750000-0000-0000-0000-000000000004';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_sms_delivery_submission(current_setting('app.policy_message_time')::uuid)), 0, 'an appointment-time change after materialization authorizes zero provider sends');
reset role;
select extensions.is((select status from public.message_deliveries where message_id = current_setting('app.policy_message_time')::uuid), 'suppressed', 'an appointment-time stale reminder delivery is suppressed');

-- A no-op settings save retains the schedule version and keeps an otherwise-valid pending delivery eligible.
update public.appointment_reminders set status = 'processing', revalidation_status = 'not_required'
where appointment_id = 'a9750000-0000-0000-0000-000000000005' and reminder_type = 'appointment_24h';
select set_config('app.policy_reminder_noop', (
  select id::text from public.appointment_reminders where appointment_id = 'a9750000-0000-0000-0000-000000000005' and reminder_type = 'appointment_24h'
), true);
update public.appointment_reminders
set schedule_version = (select schedule_version from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001')
where id = current_setting('app.policy_reminder_noop')::uuid;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.create_appointment_reminder_message(current_setting('app.policy_reminder_noop')::uuid);
reset role;
select set_config('app.policy_message_noop', (
  select message_id::text from public.appointment_reminders where id = current_setting('app.policy_reminder_noop')::uuid
), true);
select set_config('app.policy_schedule_version', (
  select schedule_version::text from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001'
), true);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9700000-0000-0000-0000-000000000001', true);
select public.upsert_my_appointment_reminder_settings(
  'a9730000-0000-0000-0000-000000000001', true, true, true,
  current_setting('app.policy_quiet_start')::time, current_setting('app.policy_quiet_end')::time
);
reset role;
select extensions.is(
  (select schedule_version::text from public.appointment_reminder_settings where location_id = 'a9730000-0000-0000-0000-000000000001'),
  current_setting('app.policy_schedule_version'),
  'a no-op reminder settings save does not change the schedule version'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_sms_delivery_submission(current_setting('app.policy_message_noop')::uuid)), 1, 'a valid pending reminder remains submit-eligible after a no-op settings save');
reset role;
select extensions.is((select status from public.message_deliveries where message_id = current_setting('app.policy_message_noop')::uuid), 'submitting', 'a no-op settings save leaves the valid reminder in the authorized submitting state');

-- More than a worker batch of terminal stale skips cannot monopolize bounded reconciliation.
insert into public.locations (id, organization_id, name, timezone)
values ('a9760000-0000-0000-0000-000000000001', 'a9710000-0000-0000-0000-000000000001', 'Reconciliation progress', 'UTC');
insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled)
values ('a9770000-0000-0000-0000-000000000001', 'a9710000-0000-0000-0000-000000000001', 'a9760000-0000-0000-0000-000000000001', '+14155550400', 'active', true);
insert into public.appointment_reminder_settings (organization_id, location_id, sms_enabled, reminder_24h_enabled, reminder_2h_enabled, quiet_hours_start, quiet_hours_end)
values (
  'a9710000-0000-0000-0000-000000000001', 'a9760000-0000-0000-0000-000000000001', true, true, false,
  ((now() at time zone 'UTC')::time + interval '2 hours')::time,
  ((now() at time zone 'UTC')::time + interval '3 hours')::time
);
insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
select
  ('a9780000-0000-0000-0000-' || lpad(series::text, 12, '0'))::uuid,
  'a9710000-0000-0000-0000-000000000001', 'a9760000-0000-0000-0000-000000000001', 'Terminal provider stale ' || series,
  'confirmed', now() + interval '21 hours' + (series * interval '1 minute'), now() + interval '21 hours 30 minutes' + (series * interval '1 minute'), '+14155550401'
from generate_series(1, 55) as series;
update public.appointment_reminders reminder
set status = 'skipped', last_error_code = 'provider_unavailable', schedule_version = 0
from public.appointments appointment
where reminder.appointment_id = appointment.id and appointment.location_id = 'a9760000-0000-0000-0000-000000000001';
insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values ('a9790000-0000-0000-0000-000000000001', 'a9710000-0000-0000-0000-000000000001', 'a9760000-0000-0000-0000-000000000001', 'Later eligible stale schedule', 'confirmed', now() + interval '24 hours', now() + interval '24 hours 30 minutes', '+14155550456');
update public.appointment_reminders set schedule_version = 0
where appointment_id = 'a9790000-0000-0000-0000-000000000001' and reminder_type = 'appointment_24h';
update public.appointment_reminder_settings
set quiet_hours_start = ((now() at time zone 'UTC')::time + interval '4 hours')::time,
  quiet_hours_end = ((now() at time zone 'UTC')::time + interval '5 hours')::time,
  schedule_version = schedule_version + 1
where location_id = 'a9760000-0000-0000-0000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.reconcile_appointment_reminder_schedules(10)), 1, 'terminal provider skips do not occupy the first bounded reconciliation batch');
reset role;
select extensions.is(
  (select reminder.schedule_version from public.appointment_reminders reminder where reminder.appointment_id = 'a9790000-0000-0000-0000-000000000001' and reminder.reminder_type = 'appointment_24h'),
  (select settings.schedule_version from public.appointment_reminder_settings settings where settings.location_id = 'a9760000-0000-0000-0000-000000000001'),
  'the later genuinely stale reminder is refreshed despite more than one batch of earlier terminal skips'
);
select extensions.is(
  (select count(*)::integer from public.appointment_reminders reminder join public.appointments appointment on appointment.id = reminder.appointment_id where appointment.location_id = 'a9760000-0000-0000-0000-000000000001' and reminder.status = 'skipped' and reminder.last_error_code = 'provider_unavailable'),
  55,
  'terminal provider-unavailable skips are not reopened by an unrelated policy version change'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.reconcile_appointment_reminder_schedules(10)), 0, 'a repeated bounded reconciliation batch does not revisit terminal stale skips');
select extensions.is((select count(*)::integer from public.reconcile_appointment_reminder_schedules(10)), 0, 'subsequent bounded reconciliation batches continue to make forward progress');
reset role;

select * from extensions.finish();
rollback;

-- Phase 8 rollout, timing, snapshot, and delivery-truth regression coverage.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(44);

select extensions.is(
  public.reminder_local_time('2026-08-20 21:00:00+00', 'UTC', '20:00', '08:00'),
  '2026-08-20 19:59:59.999999+00'::timestamptz,
  'quiet hours move an evening reminder to the closest earlier permitted instant'
);
select extensions.ok(
  public.reminder_local_time('2026-08-20 21:00:00+00', 'UTC', '20:00', '08:00') < '2026-08-20 21:00:00+00'::timestamptz,
  'quiet hours never defer a reminder later'
);
select extensions.is(
  public.reminder_local_time('2026-03-08 07:30:00+00', 'America/New_York', '02:00', '04:00'),
  '2026-03-08 06:59:59.999999+00'::timestamptz,
  'spring-forward adjustment chooses an existing earlier New York instant'
);
select extensions.is(
  public.reminder_local_time('2026-03-08 07:30:00+00', 'America/New_York', '02:30', '04:00'),
  null::timestamptz,
  'a nonexistent spring-forward quiet boundary is omitted rather than shifted later'
);
select extensions.is(
  public.reminder_local_time('2026-11-01 06:45:00+00', 'America/New_York', '01:30', '02:00'),
  '2026-11-01 06:29:59.999999+00'::timestamptz,
  'fall-back ambiguity uses the documented standard-time boundary when it is earlier'
);

insert into auth.users (id, email) values ('a9000000-0000-0000-0000-000000000001', 'reminder-reliability-owner@example.test');
insert into public.users (id, email) values ('a9000000-0000-0000-0000-000000000001', 'reminder-reliability-owner@example.test') on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values ('a9100000-0000-0000-0000-000000000001', 'Reminder Reliability', 'reminder-reliability', 'a9000000-0000-0000-0000-000000000001', 'veterinary');

-- Phase 17 makes production automation require an entitled Core subscription, so every
-- organization these existing guarantees run against carries one.  Billing is a separate
-- execution condition: nothing else about the fixtures below changes.
insert into public.billing_accounts (organization_id, stripe_customer_id, livemode, billing_state) values
  ('a9100000-0000-0000-0000-000000000001', 'cus_entitled_a9100000', false, 'active');
insert into public.billing_subscriptions (organization_id, stripe_customer_id, stripe_subscription_id,
  stripe_product_id, stripe_price_id, plan_key, is_supported, stripe_status, livemode) values
  ('a9100000-0000-0000-0000-000000000001', 'cus_entitled_a9100000', 'sub_entitled_a9100000', 'prod_core', 'price_core', 'core', true, 'active', false);
insert into public.locations (id, organization_id, name, timezone) values
  ('a9110000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'Reminder Reliability One', 'UTC'),
  ('a9120000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'Reminder Reliability Two', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values ('a9130000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000001', 'owner');
insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled) values
  ('a9140000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', '+14155550100', 'active', true),
  ('a9140000-0000-0000-0000-000000000002', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', '+14155550200', 'active', true);
insert into public.appointment_reminder_settings (
  organization_id, location_id, sms_enabled, reminder_24h_enabled, reminder_2h_enabled, quiet_hours_start, quiet_hours_end
) values (
  'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', true, true, false,
  ((now() at time zone 'UTC')::time + interval '2 hours')::time,
  ((now() at time zone 'UTC')::time + interval '3 hours')::time
);
insert into public.contacts (id, organization_id, location_id, phone, first_name)
values ('a9160000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', '+14155550123', 'Snapshot');
insert into public.appointments (id, organization_id, location_id, contact_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values ('a9150000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', 'a9160000-0000-0000-0000-000000000001', 'Delivery truth', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550123');

select extensions.is(
  (select count(*)::integer from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000001'),
  1,
  'a 24-hour policy creates one logical reminder'
);
update public.appointment_reminders set revalidation_status = 'confirmed'
where appointment_id = 'a9150000-0000-0000-0000-000000000001';
select extensions.throws_ok(
  $$ update public.appointments set trusted_sms_recipient_e164 = '+14155559999' where id = 'a9150000-0000-0000-0000-000000000001' $$,
  '22023', 'Trusted appointment SMS recipient is immutable', 'appointment recipient cannot be rewritten'
);
select extensions.throws_ok(
  $$ update public.appointments set trusted_sms_recipient_e164 = null where id = 'a9150000-0000-0000-0000-000000000001' $$,
  '22023', 'Trusted appointment SMS recipient is immutable', 'appointment recipient cannot be cleared'
);
select extensions.throws_ok(
  $$ update public.appointment_reminders set trusted_sms_recipient_e164 = '+14155559999' where appointment_id = 'a9150000-0000-0000-0000-000000000001' $$,
  '22023', 'Trusted reminder SMS recipient is immutable', 'reminder recipient cannot be rewritten'
);
update public.contacts set phone = '+14155550999' where id = 'a9160000-0000-0000-0000-000000000001';
select extensions.is(
  (select trusted_sms_recipient_e164 from public.appointments where id = 'a9150000-0000-0000-0000-000000000001'),
  '+14155550123',
  'a later contact edit leaves the appointment recipient snapshot unchanged'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_due_appointment_reminders('reminder-reliability-worker', 1)),
  1,
  'claiming a due reminder succeeds through the service-only queue'
);
reset role;
select extensions.is(
  (select revalidation_status from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000001'),
  'pending',
  'every fresh claim atomically resets prior revalidation'
);
select set_config('app.reminder_one', (select id::text from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000001'), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$ select * from public.create_appointment_reminder_message(current_setting('app.reminder_one')::uuid) $$,
  '42501', 'Reminder has not passed required revalidation', 'materialization fails closed before revalidation'
);
select extensions.lives_ok(
  $$ select public.record_appointment_reminder_revalidation(current_setting('app.reminder_one')::uuid, 'not_required') $$,
  'a local appointment records explicit not-required revalidation'
);
select extensions.lives_ok(
  $$ select * from public.create_appointment_reminder_message(current_setting('app.reminder_one')::uuid) $$,
  'materialization creates only the deterministic local message and delivery'
);
reset role;
select extensions.is(
  (select status from public.appointment_reminders where id = current_setting('app.reminder_one')::uuid),
  'delivery_pending',
  'message materialization is delivery pending rather than sent'
);
select set_config('app.message_one', (select message_id::text from public.appointment_reminders where id = current_setting('app.reminder_one')::uuid), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission(current_setting('app.message_one')::uuid)),
  1,
  'the queued reminder delivery receives the Phase 7 single-send authorization'
);
select public.record_sms_delivery_submission(
  current_setting('app.message_one')::uuid,
  'SM11111111111111111111111111111111',
  'queued'
);
reset role;
select extensions.is(
  (select status from public.appointment_reminders where id = current_setting('app.reminder_one')::uuid),
  'delivery_pending',
  'Twilio acceptance remains delivery pending'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_twilio_message_status('SM11111111111111111111111111111111', 'sent');
reset role;
select extensions.is(
  (select status from public.appointment_reminders where id = current_setting('app.reminder_one')::uuid),
  'sent',
  'a sent delivery callback is the only success transition'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_twilio_message_status('SM11111111111111111111111111111111', 'undelivered', '30003');
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = current_setting('app.message_one')::uuid),
  'undelivered',
  'Phase 7 permits the legitimate sent to undelivered delivery transition'
);
select extensions.is(
  (select status from public.appointment_reminders where id = current_setting('app.reminder_one')::uuid),
  'failed',
  'a sent then undelivered delivery projects the reminder to failed'
);
select extensions.is(
  (select last_error_code from public.appointment_reminders where id = current_setting('app.reminder_one')::uuid),
  'delivery_failed',
  'an undelivered callback stores the normalized reminder failure reason'
);
select extensions.ok(
  exists (
    select 1 from public.action_logs
    where entity_id = current_setting('app.reminder_one')::uuid and action = 'appointment.reminder.failed'
  ),
  'the sent to undelivered transition records a failed reminder audit event'
);

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values ('a9150000-0000-0000-0000-000000000007', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', 'Delivered terminal', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550129');
update public.appointment_reminders set status = 'processing', revalidation_status = 'not_required'
where appointment_id = 'a9150000-0000-0000-0000-000000000007' and reminder_type = 'appointment_24h';
select set_config('app.reminder_delivered', (select id::text from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000007' and reminder_type = 'appointment_24h'), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.create_appointment_reminder_message(current_setting('app.reminder_delivered')::uuid);
reset role;
select set_config('app.message_delivered', (select message_id::text from public.appointment_reminders where id = current_setting('app.reminder_delivered')::uuid), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.claim_sms_delivery_submission(current_setting('app.message_delivered')::uuid);
select public.record_sms_delivery_submission(current_setting('app.message_delivered')::uuid, 'SM22222222222222222222222222222222', 'sent');
select public.record_twilio_message_status('SM22222222222222222222222222222222', 'delivered');
select public.record_twilio_message_status('SM22222222222222222222222222222222', 'undelivered', '30003');
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = current_setting('app.message_delivered')::uuid),
  'delivered',
  'the Phase 7 transition graph rejects delivered to undelivered'
);
select extensions.is(
  (select status from public.appointment_reminders where id = current_setting('app.reminder_delivered')::uuid),
  'sent',
  'a sent then delivered reminder remains sent'
);
select extensions.is(
  (select last_error_code from public.appointment_reminders where id = current_setting('app.reminder_delivered')::uuid),
  null::text,
  'a delivered reminder is not overwritten with a delivery failure'
);

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values ('a9150000-0000-0000-0000-000000000002', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', 'STOP suppression', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550124');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_due_appointment_reminders('reminder-reliability-worker', 1)), 1, 'second reminder is independently claimed');
reset role;
select set_config('app.reminder_two', (select id::text from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000002'), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_appointment_reminder_revalidation(current_setting('app.reminder_two')::uuid, 'not_required');
select * from public.create_appointment_reminder_message(current_setting('app.reminder_two')::uuid);
reset role;
insert into public.messaging_contact_preferences (organization_id, location_id, contact_id, channel_type, sender_phone_number_id, status)
select message.organization_id, message.location_id, message.contact_id, 'sms', 'a9140000-0000-0000-0000-000000000001', 'opted_out'
from public.messages message where message.appointment_reminder_id = current_setting('app.reminder_two')::uuid;
select set_config('app.message_two', (select message_id::text from public.appointment_reminders where id = current_setting('app.reminder_two')::uuid), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_sms_delivery_submission(current_setting('app.message_two')::uuid)), 0, 'STOP before submission authorizes zero Twilio sends');
reset role;
select extensions.is(
  (select status from public.appointment_reminders where id = current_setting('app.reminder_two')::uuid),
  'skipped',
  'a suppressed delivery synchronizes the reminder to skipped'
);

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values
  ('a9150000-0000-0000-0000-000000000003', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', 'Failed delivery', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550125'),
  ('a9150000-0000-0000-0000-000000000004', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', 'Undelivered SMS', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550126'),
  ('a9150000-0000-0000-0000-000000000005', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', 'Unknown SMS', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', '+14155550127');
update public.appointment_reminders set status = 'processing', revalidation_status = 'not_required'
where appointment_id in ('a9150000-0000-0000-0000-000000000003', 'a9150000-0000-0000-0000-000000000004', 'a9150000-0000-0000-0000-000000000005');
select set_config('app.reminder_failed', (select id::text from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000003'), true);
select set_config('app.reminder_undelivered', (select id::text from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000004'), true);
select set_config('app.reminder_unknown', (select id::text from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000005'), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.create_appointment_reminder_message(current_setting('app.reminder_failed')::uuid);
select * from public.create_appointment_reminder_message(current_setting('app.reminder_undelivered')::uuid);
select * from public.create_appointment_reminder_message(current_setting('app.reminder_unknown')::uuid);
reset role;
update public.message_deliveries set status = 'failed' where message_id = (select message_id from public.appointment_reminders where id = current_setting('app.reminder_failed')::uuid);
update public.message_deliveries set status = 'undelivered' where message_id = (select message_id from public.appointment_reminders where id = current_setting('app.reminder_undelivered')::uuid);
select extensions.is((select status from public.appointment_reminders where id = current_setting('app.reminder_failed')::uuid), 'failed', 'failed callback marks a reminder failed');
select extensions.is((select status from public.appointment_reminders where id = current_setting('app.reminder_undelivered')::uuid), 'failed', 'undelivered callback marks a reminder failed');
select set_config('app.message_unknown', (select message_id::text from public.appointment_reminders where id = current_setting('app.reminder_unknown')::uuid), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.claim_sms_delivery_submission(current_setting('app.message_unknown')::uuid);
select public.mark_sms_delivery_unknown(current_setting('app.message_unknown')::uuid, 'test_unknown');
reset role;
select extensions.is((select status from public.appointment_reminders where id = current_setting('app.reminder_unknown')::uuid), 'failed', 'an unknown crash-window delivery is never marked sent');
select extensions.is((select last_error_code from public.appointment_reminders where id = current_setting('app.reminder_unknown')::uuid), 'delivery_unknown', 'unknown delivery has a normalized failure reason');

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, provider, external_appointment_id, trusted_sms_recipient_e164)
values ('a9150000-0000-0000-0000-000000000006', 'a9100000-0000-0000-0000-000000000001', 'a9110000-0000-0000-0000-000000000001', 'Provider reminder', 'confirmed', now() + interval '23 hours', now() + interval '23 hours 30 minutes', 'ezyvet', 'provider-appointment', '+14155550128');
update public.appointment_reminders set status = 'processing', revalidation_status = 'pending' where appointment_id = 'a9150000-0000-0000-0000-000000000006';
select set_config('app.provider_reminder', (select id::text from public.appointment_reminders where appointment_id = 'a9150000-0000-0000-0000-000000000006'), true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$ select public.record_appointment_reminder_revalidation(current_setting('app.provider_reminder')::uuid, 'not_required') $$,
  '22023', 'Provider-backed reminders require confirmed revalidation', 'provider-backed reminder cannot choose not-required revalidation'
);
reset role;

insert into public.integrations (id, organization_id, location_id, provider, status, environment, site_timezone)
values ('a9170000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'google_calendar', 'connected', 'production', 'UTC');
insert into public.channels (id, organization_id, location_id, channel_type, display_name)
values ('a9180000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'phone', 'Legacy booking phone');
insert into public.conversations (id, organization_id, location_id, channel_id)
values ('a9190000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'a9180000-0000-0000-0000-000000000001');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, catalog_source, external_uid, name, default_duration_minutes, active, bookable)
values ('a9200000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'a9170000-0000-0000-0000-000000000001', 'google_calendar', 'avenlyo', 'legacy-type', 'Legacy type', 30, true, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, active, bookable)
values ('a9210000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'a9170000-0000-0000-0000-000000000001', 'google_calendar', 'legacy-resource', 'Legacy resource', true, true);
insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
values ('a9220000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'a9190000-0000-0000-0000-000000000001', 'a9170000-0000-0000-0000-000000000001', 'a9200000-0000-0000-0000-000000000001', 'a9210000-0000-0000-0000-000000000001', now() + interval '23 hours', now() + interval '23 hours 30 minutes', 'UTC', now() + interval '10 minutes');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status, trusted_transport_phone_e164, external_contact_uid, external_subject_uid, subject_name)
values ('a9230000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'a9190000-0000-0000-0000-000000000001', 'a9170000-0000-0000-0000-000000000001', 'a9220000-0000-0000-0000-000000000001', 'completed', '+14155550223', null, null, null);
insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, provider, external_appointment_id, integration_id, booking_intent_id, provider_status)
values ('a9240000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'Legacy completed booking', 'requested', now() + interval '23 hours', now() + interval '23 hours 30 minutes', 'google_calendar', 'legacy-event', 'a9170000-0000-0000-0000-000000000001', 'a9230000-0000-0000-0000-000000000001', 'confirmed');
select public.normalize_completed_booking_appointments_internal();
select extensions.is((select status from public.appointments where id = 'a9240000-0000-0000-0000-000000000001'), 'confirmed', 'legacy completed provider booking is normalized to confirmed');
select extensions.is((select trusted_sms_recipient_e164 from public.appointments where id = 'a9240000-0000-0000-0000-000000000001'), '+14155550223', 'legacy completed provider booking receives its trusted recipient snapshot');
select extensions.is((select count(*)::integer from public.appointment_reminders where appointment_id = 'a9240000-0000-0000-0000-000000000001'), 0, 'legacy normalization itself creates zero reminders while settings are disabled');

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values ('a9250000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'a9120000-0000-0000-0000-000000000001', 'Horizon entry', 'confirmed', now() + interval '45 days', now() + interval '45 days 30 minutes', '+14155550224');
select extensions.is((select count(*)::integer from public.appointment_reminders where appointment_id = 'a9250000-0000-0000-0000-000000000001'), 0, 'an appointment outside the 30-day horizon starts with no reminders');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select public.upsert_my_appointment_reminder_settings('a9120000-0000-0000-0000-000000000001', true, true, true, '20:00', '08:00') $$,
  'owner can enable reminders only after an active SMS sender exists'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.appointment_reminders where appointment_id = 'a9240000-0000-0000-0000-000000000001'),
  0,
  'settings save is bounded and leaves reminder materialization to reconciliation'
);
update public.appointment_reminder_settings
set quiet_hours_start = ((now() at time zone 'UTC')::time + interval '2 hours')::time,
  quiet_hours_end = ((now() at time zone 'UTC')::time + interval '3 hours')::time
where organization_id = 'a9100000-0000-0000-0000-000000000001'
  and location_id = 'a9120000-0000-0000-0000-000000000001';
select set_config('app.suppress_reminder_refresh', 'true', true);
update public.appointments set starts_at = now() + interval '23 hours', ends_at = now() + interval '23 hours 30 minutes' where id = 'a9250000-0000-0000-0000-000000000001';
select set_config('app.suppress_reminder_refresh', 'false', true);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.reconcile_appointment_reminder_schedules(25);
reset role;
select extensions.is((select count(*)::integer from public.appointment_reminders where appointment_id = 'a9250000-0000-0000-0000-000000000001'), 2, 'bounded reconciliation creates 24-hour and 2-hour reminders exactly once on horizon entry');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select * from public.reconcile_appointment_reminder_schedules(25);
reset role;
select extensions.is((select count(*)::integer from public.appointment_reminders where appointment_id = 'a9250000-0000-0000-0000-000000000001'), 2, 'repeated bounded reconciliation creates no duplicate logical reminder');

insert into public.locations (id, organization_id, name, timezone)
values ('a9260000-0000-0000-0000-000000000001', 'a9100000-0000-0000-0000-000000000001', 'No SMS sender', 'UTC');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000001', true);
select extensions.throws_ok(
  $$ select public.upsert_my_appointment_reminder_settings('a9260000-0000-0000-0000-000000000001', true, true, true, '20:00', '08:00') $$,
  '22023', 'An active SMS sender is required before reminders can be enabled', 'settings cannot claim reminders are enabled without an SMS sender'
);
reset role;
select extensions.ok(
  not exists (select 1 from public.action_logs where action like 'appointment.reminder.%' and details::text like '%+1415555%'),
  'reminder audit events contain no phone number or SMS body'
);

select * from extensions.finish();
rollback;

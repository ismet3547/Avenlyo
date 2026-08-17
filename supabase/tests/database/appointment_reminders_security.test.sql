-- Phase 8 durable reminder ownership, tenant isolation, and trusted transport assertions.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(21);

select extensions.is(
  public.reminder_local_time('2026-08-20 21:00:00+00', 'UTC', '20:00', '08:00'),
  '2026-08-21 08:00:00+00'::timestamptz,
  'overnight quiet hours defer an evening reminder to the following local morning'
);
select extensions.is(
  public.reminder_local_time('2026-08-20 06:00:00+00', 'UTC', '20:00', '08:00'),
  '2026-08-20 08:00:00+00'::timestamptz,
  'overnight quiet hours defer an early-morning reminder to that morning cutoff'
);

insert into auth.users (id, email)
values
  ('e8000000-0000-0000-0000-000000000001', 'reminder-owner@example.test'),
  ('e8000000-0000-0000-0000-000000000002', 'reminder-member@example.test'),
  ('e8000000-0000-0000-0000-000000000003', 'reminder-owner-b@example.test');
insert into public.users (id, email)
select id, email from auth.users where id between 'e8000000-0000-0000-0000-000000000001' and 'e8000000-0000-0000-0000-000000000003'
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, created_by, primary_industry_id)
values
  ('e8100000-0000-0000-0000-000000000001', 'Reminder A', 'reminder-a', 'e8000000-0000-0000-0000-000000000001', 'veterinary'),
  ('e8200000-0000-0000-0000-000000000001', 'Reminder B', 'reminder-b', 'e8000000-0000-0000-0000-000000000003', 'veterinary');
insert into public.locations (id, organization_id, name, timezone)
values
  ('e8110000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'Reminder A one', 'UTC'),
  ('e8120000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'Reminder A two', 'UTC'),
  ('e8210000-0000-0000-0000-000000000001', 'e8200000-0000-0000-0000-000000000001', 'Reminder B one', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role)
values
  ('e8130000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000001', 'owner'),
  ('e8130000-0000-0000-0000-000000000002', 'e8100000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000002', 'member'),
  ('e8230000-0000-0000-0000-000000000001', 'e8200000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000003', 'owner');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('e8100000-0000-0000-0000-000000000001', 'e8130000-0000-0000-0000-000000000002', 'e8110000-0000-0000-0000-000000000001');
insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled)
values ('e8140000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'e8110000-0000-0000-0000-000000000001', '+14155550801', 'active', true);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'e8000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select sms_enabled from public.get_my_appointment_reminder_settings('e8110000-0000-0000-0000-000000000001')),
  false,
  'owner sees disabled-by-default reminder settings'
);
select extensions.lives_ok(
  $$ select public.upsert_my_appointment_reminder_settings('e8110000-0000-0000-0000-000000000001', true, true, true, '20:00', '08:00') $$,
  'owner enables deterministic reminder policy through the only client mutation RPC'
);
select set_config('request.jwt.claim.sub', 'e8000000-0000-0000-0000-000000000002', true);
select extensions.throws_ok(
  $$ select public.upsert_my_appointment_reminder_settings('e8110000-0000-0000-0000-000000000001', true, true, true, '20:00', '08:00') $$,
  '42501',
  'Reminder settings are unavailable',
  'location-scoped member cannot manage reminder settings'
);
reset role;

insert into public.appointment_reminder_settings (organization_id, location_id, sms_enabled)
values ('e8100000-0000-0000-0000-000000000001', 'e8120000-0000-0000-0000-000000000001', true);

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values
  ('e8150000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'e8110000-0000-0000-0000-000000000001', 'A one appointment', 'confirmed', date_trunc('day', now()) + interval '3 days 12 hours', date_trunc('day', now()) + interval '3 days 12 hours 30 minutes', '+14155550811'),
  ('e8160000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'e8120000-0000-0000-0000-000000000001', 'A two appointment', 'confirmed', date_trunc('day', now()) + interval '4 days 12 hours', date_trunc('day', now()) + interval '4 days 12 hours 30 minutes', '+14155550812'),
  ('e8190000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'e8120000-0000-0000-0000-000000000001', 'Unschedulable A two appointment', 'requested', date_trunc('day', now()) + interval '4 days 12 hours', date_trunc('day', now()) + interval '4 days 12 hours 30 minutes', null);

select extensions.throws_ok(
  $$ insert into public.appointment_reminders (organization_id, location_id, appointment_id, reminder_type, scheduled_for)
     values ('e8100000-0000-0000-0000-000000000001', 'e8110000-0000-0000-0000-000000000001', 'e8190000-0000-0000-0000-000000000001', 'appointment_24h', now()) $$,
  '23503',
  'insert or update on table "appointment_reminders" violates foreign key constraint "appointment_reminders_appointment_fk"',
  'a reminder cannot cross location scope to reference another appointment'
);
select extensions.throws_ok(
  $$ insert into public.appointment_reminders (organization_id, location_id, appointment_id, reminder_type, scheduled_for)
     values ('e8100000-0000-0000-0000-000000000001', 'e8110000-0000-0000-0000-000000000001', 'e8150000-0000-0000-0000-000000000001', 'appointment_24h', now()) $$,
  '23505',
  'duplicate key value violates unique constraint "appointment_reminders_appointment_type_key"',
  'one appointment can have at most one reminder of each type'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'e8000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select count(*)::integer from public.appointment_reminders),
  2,
  'location-scoped member can read reminders for their assigned location only'
);
select extensions.is_empty(
  $$ select * from public.appointment_reminders where location_id = 'e8120000-0000-0000-0000-000000000001' $$,
  'location-scoped member cannot read another location reminders'
);
select extensions.is_empty(
  $$ select * from public.get_my_appointment_reminders('e8120000-0000-0000-0000-000000000001') $$,
  'reminder overview RPC does not bypass location scope'
);
select extensions.throws_ok(
  $$ update public.appointment_reminders set status = 'sent' where appointment_id = 'e8150000-0000-0000-0000-000000000001' $$,
  '42501',
  'permission denied for table appointment_reminders',
  'authenticated member cannot directly mutate reminder state'
);
select extensions.throws_ok(
  $$ select * from public.claim_due_appointment_reminders('forged-client', 1) $$,
  '42501',
  'permission denied for function claim_due_appointment_reminders',
  'authenticated member cannot claim the reminder worker queue'
);
reset role;

-- Make the claim assertion independent of the wall clock while keeping the
-- reminder-generation assertions above in the normal quiet-hours path.
update public.appointment_reminders
set scheduled_for = now() - interval '1 minute'
where appointment_id = 'e8150000-0000-0000-0000-000000000001'
  and reminder_type = 'appointment_24h';

insert into public.appointments (id, organization_id, location_id, title, status, starts_at, ends_at, trusted_sms_recipient_e164)
values
  ('e8170000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'e8110000-0000-0000-0000-000000000001', 'Cancelled appointment', 'confirmed', now() + interval '3 days 11 hours', now() + interval '3 days 11 hours 30 minutes', '+14155550813'),
  ('e8180000-0000-0000-0000-000000000001', 'e8100000-0000-0000-0000-000000000001', 'e8110000-0000-0000-0000-000000000001', 'Completed appointment', 'confirmed', now() + interval '4 days 11 hours', now() + interval '4 days 11 hours 30 minutes', '+14155550814');
update public.appointments set status = 'cancelled' where id = 'e8170000-0000-0000-0000-000000000001';
update public.appointments set status = 'completed' where id = 'e8180000-0000-0000-0000-000000000001';
select extensions.is(
  (select count(*)::integer from public.appointment_reminders where appointment_id = 'e8170000-0000-0000-0000-000000000001' and status = 'skipped'),
  2,
  'cancelling an appointment skips its pending reminders'
);
select extensions.is(
  (select count(*)::integer from public.appointment_reminders where appointment_id = 'e8180000-0000-0000-0000-000000000001' and status = 'skipped'),
  2,
  'completing an appointment skips its pending reminders'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok(
  $$ select * from public.appointment_reminders $$,
  '42501',
  'permission denied for table appointment_reminders',
  'service worker has no direct reminder-table grant'
);
select extensions.is(
  (select count(*)::integer from public.claim_due_appointment_reminders('phase8-test-worker', 4)),
  1,
  'service worker atomically claims the due 24-hour reminder'
);
reset role;
select set_config(
  'app.reminder_id',
  (select id::text from public.appointment_reminders where appointment_id = 'e8150000-0000-0000-0000-000000000001' and reminder_type = 'appointment_24h'),
  true
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select public.record_appointment_reminder_revalidation(current_setting('app.reminder_id')::uuid, 'not_required') $$,
  'local confirmed appointment can be marked as not requiring a provider read'
);
select extensions.lives_ok(
  $$ select * from public.create_appointment_reminder_message(current_setting('app.reminder_id')::uuid) $$,
  'service worker creates the deterministic reminder message through its trusted RPC'
);
reset role;

select extensions.is(
  (select count(*)::integer from public.messages where appointment_reminder_id = (select id from public.appointment_reminders where appointment_id = 'e8150000-0000-0000-0000-000000000001' and reminder_type = 'appointment_24h')),
  1,
  'a claimed reminder has exactly one outbound message'
);
select extensions.is(
  (select count(*)::integer from public.message_deliveries delivery join public.messages message on message.id = delivery.message_id where message.appointment_reminder_id = (select id from public.appointment_reminders where appointment_id = 'e8150000-0000-0000-0000-000000000001' and reminder_type = 'appointment_24h')),
  1,
  'a reminder message has exactly one Twilio delivery record'
);
update public.contacts set phone = '+14155550999' where phone = '+14155550811';
select set_config(
  'app.reminder_message_id',
  (select message_id::text from public.appointment_reminders where appointment_id = 'e8150000-0000-0000-0000-000000000001' and reminder_type = 'appointment_24h'),
  true
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select to_e164 from public.claim_sms_delivery_submission(current_setting('app.reminder_message_id')::uuid)),
  '+14155550811',
  'SMS delivery uses the immutable booking-time recipient after contact phone changes'
);
reset role;

select * from extensions.finish();
rollback;

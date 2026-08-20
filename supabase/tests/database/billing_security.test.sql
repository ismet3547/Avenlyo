-- Phase 12 billing authority, tenant integrity, and prospective metering guarantees.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(87);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

insert into auth.users (id, email) values
  ('b0000000-0000-0000-0000-000000000001', 'billing-owner@example.test'),
  ('b0000000-0000-0000-0000-000000000002', 'billing-member@example.test'),
  ('b0000000-0000-0000-0000-000000000003', 'billing-owner-b@example.test');
insert into public.users (id, email)
select id, email from auth.users where id::text like 'b0000000%'
on conflict (id) do nothing;
insert into public.organizations (id, name, slug, created_by) values
  ('b1000000-0000-0000-0000-000000000001', 'Billing Organization A', 'billing-org-a', 'b0000000-0000-0000-0000-000000000001'),
  ('b2000000-0000-0000-0000-000000000001', 'Billing Organization B', 'billing-org-b', 'b0000000-0000-0000-0000-000000000003');
insert into public.locations (id, organization_id, name) values
  ('b1100000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'Billing A location'),
  ('b1200000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'Billing A second location'),
  ('b2100000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'Billing B location');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('b1300000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'owner'),
  ('b1300000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'member'),
  ('b2300000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'owner');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('b1000000-0000-0000-0000-000000000001', 'b1300000-0000-0000-0000-000000000002', 'b1100000-0000-0000-0000-000000000001');

insert into public.billing_accounts (id, organization_id, stripe_customer_id, livemode) values
  ('b1400000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', null, null),
  ('b2400000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false);

select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.billing_accounts (organization_id, stripe_customer_id, livemode)
  values ('b1000000-0000-0000-0000-000000000001', 'cus_billing_b', false)
$sql$, '23505', 'duplicate key')), 'one Stripe customer cannot map to two organizations');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.billing_subscriptions (organization_id,stripe_customer_id,stripe_subscription_id,is_supported,stripe_status,livemode)
  values ('b1000000-0000-0000-0000-000000000001','cus_billing_b','sub_cross_org',false,'active',false)
$sql$, '23503', 'foreign key')), 'subscription customer cannot cross organizations');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.billing_checkout_sessions (organization_id,plan_key,stripe_customer_id,idempotency_key)
  values ('b1000000-0000-0000-0000-000000000001','core','cus_billing_b','avenlyo:test-cross-org-checkout')
$sql$, '23503', 'foreign key')), 'checkout customer cannot cross organizations');
insert into public.stripe_webhook_events (stripe_event_id,event_type,livemode) values ('evt_billing_unique', 'invoice.paid', false);
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.stripe_webhook_events (stripe_event_id,event_type,livemode)
  values ('evt_billing_unique', 'invoice.paid', false)
$sql$, '23505', 'duplicate key')), 'Stripe event identity is durable and unique');
select extensions.ok(not exists (
  select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stripe_webhook_events'
    and column_name in ('payload', 'raw_payload', 'signature', 'billing_address', 'card_number')
), 'webhook ledger stores no raw payment payload or signature');

select extensions.is(public.billing_subscription_topology('active'), 'current', 'active is current topology');
select extensions.is(public.billing_subscription_topology('trialing'), 'current', 'trialing is current topology');
select extensions.is(public.billing_subscription_topology('past_due'), 'current', 'past_due is current topology');
select extensions.is(public.billing_subscription_topology('incomplete'), 'current', 'incomplete is current topology');
select extensions.is(public.billing_subscription_topology('unpaid'), 'current', 'unpaid is current topology');
select extensions.is(public.billing_subscription_topology('paused'), 'current', 'paused is current topology');
select extensions.is(public.billing_subscription_topology('canceled'), 'terminal', 'canceled is terminal topology');
select extensions.is(public.billing_subscription_topology('incomplete_expired'), 'terminal', 'incomplete_expired is terminal topology');
select extensions.is(public.billing_subscription_topology('future_status'), 'unknown', 'unknown Stripe status requires review topology');

insert into public.channels (id, organization_id, location_id, channel_type, display_name, status) values
  ('b1500000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'sms', 'Billing SMS', 'active');
insert into public.contacts (id, organization_id, location_id, first_name) values
  ('b1600000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'Billing contact');
insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, mode) values
  ('b1700000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001', 'b1500000-0000-0000-0000-000000000001', 'customer');
insert into public.calls (id, organization_id, location_id, conversation_id, contact_id, direction, status, answered_at, ended_at)
values ('b1800000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001', 'inbound', 'completed', now() - interval '125 seconds', now());
select extensions.is((select quantity from public.billing_usage_events where call_id = 'b1800000-0000-0000-0000-000000000001'), 125, 'answered call records exact voice seconds');
update public.calls set updated_at = now() where id = 'b1800000-0000-0000-0000-000000000001';
select extensions.is((select count(*)::integer from public.billing_usage_events where call_id = 'b1800000-0000-0000-0000-000000000001'), 1, 'voice finalization replay records one usage event');
insert into public.calls (id, organization_id, location_id, conversation_id, contact_id, direction, status)
values ('b1800000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001', 'inbound', 'initiated');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.billing_usage_events (organization_id,location_id,metric,quantity,occurred_at,call_id)
  values ('b1000000-0000-0000-0000-000000000001','b1200000-0000-0000-0000-000000000001','voice_seconds',1,now(),'b1800000-0000-0000-0000-000000000002') $sql$, '23503', 'foreign key')),
  'usage source cannot cross locations');

insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, sent_at) values
  ('b1900000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001', 'outbound', 'text', 'AI reply', 'sms', 'ai', now()),
  ('b1900000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001', 'outbound', 'text', 'Deterministic follow-up', 'sms', 'system', now());
select extensions.is((select count(*)::integer from public.billing_usage_events where message_id = 'b1900000-0000-0000-0000-000000000001'), 1, 'AI SMS response records one AI text turn');
select extensions.is((select count(*)::integer from public.billing_usage_events where message_id = 'b1900000-0000-0000-0000-000000000002'), 0, 'system follow-up does not record an AI text turn');
insert into public.message_deliveries (id, organization_id, location_id, message_id, provider)
values ('b1a00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1900000-0000-0000-0000-000000000001', 'twilio');
select extensions.is((select count(*)::integer from public.billing_usage_events where message_delivery_id = 'b1a00000-0000-0000-0000-000000000001'), 0, 'queued SMS has no outbound usage');
update public.message_deliveries set status = 'submitting', attempted_at = now() where id = 'b1a00000-0000-0000-0000-000000000001';
select extensions.is((select count(*)::integer from public.billing_usage_events where message_delivery_id = 'b1a00000-0000-0000-0000-000000000001'), 1, 'provider submission records one outbound SMS usage');
update public.message_deliveries set status = 'unknown' where id = 'b1a00000-0000-0000-0000-000000000001';
select extensions.is((select count(*)::integer from public.billing_usage_events where message_delivery_id = 'b1a00000-0000-0000-0000-000000000001'), 1, 'unknown provider result does not double count SMS usage');

insert into public.integrations (id, organization_id, location_id, provider, status, environment, site_uid, site_timezone)
values ('b1b00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'ezyvet', 'connected', 'trial', 'billing-usage-site', 'UTC');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, external_uid, name, default_duration_minutes, bookable)
values ('b1c00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'ezyvet', 'billing-usage-type', 'Billing usage visit', 30, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, external_ownership_id, bookable)
values ('b1d00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'ezyvet', 'billing-usage-resource', 'Billing usage room', 'billing-usage-owner', true);
insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at) values
  ('b1e00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000001', 'b1d00000-0000-0000-0000-000000000001', now() + interval '2 days', now() + interval '2 days 30 minutes', 'UTC', now() + interval '1 day'),
  ('b1e00000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000001', 'b1d00000-0000-0000-0000-000000000001', now() + interval '3 days', now() + interval '3 days 30 minutes', 'UTC', now() + interval '1 day'),
  ('b1e00000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'b1c00000-0000-0000-0000-000000000001', 'b1d00000-0000-0000-0000-000000000001', now() + interval '4 days', now() + interval '4 days 30 minutes', 'UTC', now() + interval '1 day');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, contact_id, external_contact_uid, external_subject_uid, subject_name, status) values
  ('b1f00000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'b1e00000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001', 'contact-failed', 'subject-failed', 'Failed booking', 'failed'),
  ('b1f00000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'b1e00000-0000-0000-0000-000000000002', 'b1600000-0000-0000-0000-000000000001', 'contact-unknown', 'subject-unknown', 'Unknown booking', 'provider_state_unknown'),
  ('b1f00000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'b1b00000-0000-0000-0000-000000000001', 'b1e00000-0000-0000-0000-000000000003', 'b1600000-0000-0000-0000-000000000001', 'contact-success', 'subject-success', 'Completed booking', 'completed');
select extensions.is((select count(*)::integer from public.billing_usage_events where metric = 'appointment_booked'), 0, 'provider failure has no durable appointment usage');
select extensions.is((select count(*)::integer from public.appointments where booking_intent_id = 'b1f00000-0000-0000-0000-000000000002'), 0, 'provider_state_unknown has no durable appointment');
insert into public.appointments (id, organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at, provider, external_appointment_id, integration_id, booking_intent_id, appointment_type, provider_status)
values ('b2010000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b1100000-0000-0000-0000-000000000001', 'b1600000-0000-0000-0000-000000000001', 'b1700000-0000-0000-0000-000000000001', 'Completed booking', 'requested', now() + interval '4 days', now() + interval '4 days 30 minutes', 'ezyvet', 'billing-usage-appointment', 'b1b00000-0000-0000-0000-000000000001', 'b1f00000-0000-0000-0000-000000000003', 'Billing usage visit', 'unconfirmed');
select extensions.is((select count(*)::integer from public.billing_usage_events where appointment_id = 'b2010000-0000-0000-0000-000000000001'), 1, 'durable completed booking records one appointment usage event');
update public.appointments set starts_at = starts_at + interval '15 minutes', ends_at = ends_at + interval '15 minutes' where id = 'b2010000-0000-0000-0000-000000000001';
select extensions.is((select count(*)::integer from public.billing_usage_events where appointment_id = 'b2010000-0000-0000-0000-000000000001'), 1, 'reschedule preserves one historical appointment usage event');
update public.appointments set status = 'cancelled' where id = 'b2010000-0000-0000-0000-000000000001';
select extensions.is((select count(*)::integer from public.billing_usage_events where appointment_id = 'b2010000-0000-0000-0000-000000000001'), 1, 'cancel preserves one historical appointment usage event');
select extensions.is((select count(*)::integer from public.billing_usage_events where metric = 'appointment_booked'), 1, 'recovery replay cannot create a second appointment usage event');

insert into public.billing_subscriptions (organization_id, stripe_customer_id, stripe_subscription_id, is_supported, stripe_status, livemode)
values ('b2000000-0000-0000-0000-000000000001', 'cus_billing_b', 'sub_guard', false, 'unpaid', false);
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000003', true);
select extensions.is((select action from public.begin_my_billing_checkout('b2000000-0000-0000-0000-000000000001', 'core')), 'manage_existing_subscription', 'unpaid blocks new Checkout');
reset role;
update public.billing_subscriptions set stripe_status = 'paused' where stripe_subscription_id = 'sub_guard';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000003', true);
select extensions.is((select action from public.begin_my_billing_checkout('b2000000-0000-0000-0000-000000000001', 'core')), 'manage_existing_subscription', 'paused blocks new Checkout');
reset role;
update public.billing_subscriptions set stripe_status = 'incomplete' where stripe_subscription_id = 'sub_guard';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000003', true);
select extensions.is((select action from public.begin_my_billing_checkout('b2000000-0000-0000-0000-000000000001', 'core')), 'manage_existing_subscription', 'incomplete blocks new Checkout');
reset role;
update public.billing_subscriptions set stripe_status = 'past_due' where stripe_subscription_id = 'sub_guard';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000003', true);
select extensions.is((select action from public.begin_my_billing_checkout('b2000000-0000-0000-0000-000000000001', 'core')), 'manage_existing_subscription', 'past_due blocks new Checkout');
reset role;
update public.billing_subscriptions set stripe_status = 'active' where stripe_subscription_id = 'sub_guard';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000003', true);
select extensions.is((select action from public.begin_my_billing_checkout('b2000000-0000-0000-0000-000000000001', 'core')), 'manage_existing_subscription', 'active blocks new Checkout');
reset role;
update public.billing_subscriptions set stripe_status = 'canceled' where stripe_subscription_id = 'sub_guard';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000003', true);
select extensions.is((select action from public.begin_my_billing_checkout('b2000000-0000-0000-0000-000000000001', 'core')), 'create_checkout', 'canceled history permits a new Checkout');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000002', true);
select extensions.ok((select pg_temp.error_matches($sql$ select * from public.billing_accounts $sql$, '42501', 'permission denied')), 'member has no direct billing account read');
select extensions.ok((select pg_temp.error_matches($sql$ insert into public.billing_accounts (organization_id) values ('b1000000-0000-0000-0000-000000000001') $sql$, '42501', 'permission denied')), 'member cannot forge billing account state');
select extensions.ok((select pg_temp.error_matches($sql$ select * from public.begin_my_billing_checkout('b1000000-0000-0000-0000-000000000001', 'core') $sql$, '42501', 'Organization owner or admin')), 'member cannot create Checkout');
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.apply_stripe_billing_snapshot('b1000000-0000-0000-0000-000000000001', 'cus_invalid', false, 1, '[]'::jsonb, true, null, null)
$sql$, '42501', 'permission denied')), 'member cannot execute internal snapshot helper');
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.get_my_billing_overview('b1000000-0000-0000-0000-000000000001')
$sql$, '42501', 'Organization owner or admin')), 'member cannot read billing administration overview');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok($$ select * from public.begin_my_billing_checkout('b1000000-0000-0000-0000-000000000001', 'core') $$, 'owner can create trusted Core checkout intent');
select extensions.is((select count(*)::integer from public.get_my_billing_overview('b1000000-0000-0000-0000-000000000001')), 1, 'owner can read organization billing overview');
reset role;

create temporary table pg_temp.billing_state (checkout_id uuid);
insert into pg_temp.billing_state
select id from public.billing_checkout_sessions where organization_id = 'b1000000-0000-0000-0000-000000000001';
grant select on table pg_temp.billing_state to service_role;

create function pg_temp.apply_billing_snapshot(
  target_organization_id uuid,
  target_customer_id text,
  target_livemode boolean,
  target_subscriptions jsonb,
  target_snapshot_complete boolean
)
returns text language plpgsql as $$
declare fence record; applied record;
begin
  select * into fence
  from public.begin_stripe_billing_reconciliation(
    target_organization_id,
    target_customer_id,
    target_livemode
  );
  select * into applied
  from public.apply_stripe_billing_snapshot(
    target_organization_id,
    target_customer_id,
    target_livemode,
    fence.reconciliation_generation,
    target_subscriptions,
    target_snapshot_complete,
    null,
    null
  );
  if applied.outcome <> 'applied' then
    raise exception 'unexpected reconciliation outcome: %', applied.outcome;
  end if;
  return applied.billing_state;
end;
$$;
grant execute on function pg_temp.apply_billing_snapshot(uuid, text, boolean, jsonb, boolean) to service_role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$ select * from public.billing_accounts $sql$, '42501', 'permission denied')), 'service role has no direct billing table grant');
select extensions.lives_ok($$ select public.record_stripe_billing_customer((select checkout_id from pg_temp.billing_state), 'cus_billing_a', false) $$, 'service role can persist trusted Stripe customer mapping');
select extensions.lives_ok($$ select * from public.record_stripe_webhook_event('evt_billing_rpc', 'invoice.paid', 'in_1', now(), false) $$, 'service role can persist verified event identity');
select extensions.lives_ok($$ select * from public.record_stripe_webhook_event('evt_billing_rpc', 'invoice.paid', 'in_1', now(), false) $$, 'service role accepts a duplicate verified event safely');
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001',
    'cus_billing_a',
    false,
    jsonb_build_array(
      jsonb_build_object('subscription_id', 'sub_core_active', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'active', 'cancel_at_period_end', false),
      jsonb_build_object('subscription_id', 'sub_old_unsupported', 'product_id', 'prod_old', 'price_id', 'price_old', 'plan_key', null, 'is_supported', false, 'stripe_status', 'canceled', 'cancel_at_period_end', false)
    ),
    true
  ),
  'active',
  'terminal unsupported history does not poison an active Core subscription'
);
reset role;
select extensions.is((select count(*)::integer from public.action_logs where organization_id = 'b1000000-0000-0000-0000-000000000001' and action = 'billing.reconciled'), 1, 'one atomic snapshot writes one reconciliation audit');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001', 'cus_billing_a', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_core_trial', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'trialing', 'cancel_at_period_end', false)), true
  ),
  'active',
  'trialing Core normalizes to active'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001', 'cus_billing_a', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_core_past_due', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'past_due', 'cancel_at_period_end', false)), true
  ),
  'attention',
  'past_due Core normalizes to attention'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001', 'cus_billing_a', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_core_incomplete', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'incomplete', 'cancel_at_period_end', false)), true
  ),
  'inactive',
  'incomplete Core normalizes to inactive but remains current topology'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001', 'cus_billing_a', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_core_unpaid', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'unpaid', 'cancel_at_period_end', false)), true
  ),
  'inactive',
  'unpaid Core normalizes to inactive but remains current topology'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001', 'cus_billing_a', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_core_paused', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'paused', 'cancel_at_period_end', false)), true
  ),
  'inactive',
  'paused Core normalizes to inactive but remains current topology'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001',
    'cus_billing_a',
    false,
    jsonb_build_array(
      jsonb_build_object('subscription_id', 'sub_core_active', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'active', 'cancel_at_period_end', false),
      jsonb_build_object('subscription_id', 'sub_unpaid_unsupported', 'product_id', 'prod_other', 'price_id', 'price_other', 'plan_key', null, 'is_supported', false, 'stripe_status', 'unpaid', 'cancel_at_period_end', false)
    ),
    true
  ),
  'review_required',
  'current unsupported unpaid subscription requires review'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001',
    'cus_billing_a',
    false,
    jsonb_build_array(
      jsonb_build_object('subscription_id', 'sub_core_active', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'active', 'cancel_at_period_end', false),
      jsonb_build_object('subscription_id', 'sub_core_paused', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'paused', 'cancel_at_period_end', false)
    ),
    true
  ),
  'review_required',
  'multiple current subscriptions require review without intermediate activation'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b1000000-0000-0000-0000-000000000001',
    'cus_billing_a',
    false,
    jsonb_build_array(
      jsonb_build_object('subscription_id', 'sub_unknown_status', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'future_status', 'cancel_at_period_end', false)
    ),
    true
  ),
  'review_required',
  'unknown Stripe status never silently becomes inactive'
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b2000000-0000-0000-0000-000000000001',
    'cus_billing_b',
    false,
    jsonb_build_array(
      jsonb_build_object('subscription_id', 'sub_guard', 'plan_key', null, 'is_supported', false, 'stripe_status', 'incomplete_expired', 'cancel_at_period_end', false)
    ),
    true
  ),
  'inactive',
  'terminal unsupported history alone is inactive rather than review required'
);
reset role;

create temporary table pg_temp.billing_fences (
  generation_a bigint not null,
  generation_b bigint
);
create temporary table pg_temp.billing_b_checkout (checkout_id uuid not null);
insert into pg_temp.billing_b_checkout
select id
from public.billing_checkout_sessions
where organization_id = 'b2000000-0000-0000-0000-000000000001'
  and status = 'created';
grant select, insert, update on table pg_temp.billing_fences, pg_temp.billing_b_checkout to service_role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
insert into pg_temp.billing_fences (generation_a)
select reconciliation_generation
from public.begin_stripe_billing_reconciliation(
  'b2000000-0000-0000-0000-000000000001',
  'cus_billing_b',
  false
);
update pg_temp.billing_fences
set generation_b = (
  select reconciliation_generation
  from public.begin_stripe_billing_reconciliation(
    'b2000000-0000-0000-0000-000000000001',
    'cus_billing_b',
    false
  )
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (
    select billing_state
    from public.apply_stripe_billing_snapshot(
      'b2000000-0000-0000-0000-000000000001',
      'cus_billing_b',
      false,
      (select generation_b from pg_temp.billing_fences),
      jsonb_build_array(
        jsonb_build_object('subscription_id', 'sub_fence_preserved', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'active', 'cancel_at_period_end', false)
      ),
      true,
      null,
      null
    )
  ),
  'active',
  'newer reconciliation generation applies active provider truth'
);
select extensions.is(
  (
    select outcome
    from public.apply_stripe_billing_snapshot(
      'b2000000-0000-0000-0000-000000000001',
      'cus_billing_b',
      false,
      (select generation_a from pg_temp.billing_fences),
      jsonb_build_array(
        jsonb_build_object('subscription_id', 'sub_fence_stale', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'past_due', 'cancel_at_period_end', false)
      ),
      true,
      null,
      null
    )
  ),
  'superseded',
  'older complete snapshot is rejected before destructive missing-subscription handling'
);
select extensions.is(
  (
    select outcome
    from public.apply_stripe_billing_snapshot(
      'b2000000-0000-0000-0000-000000000001',
      'cus_billing_b',
      false,
      (select generation_a from pg_temp.billing_fences),
      jsonb_build_array(
        jsonb_build_object('subscription_id', 'sub_fence_deleted_stale', 'plan_key', null, 'is_supported', false, 'stripe_status', 'canceled', 'cancel_at_period_end', false)
      ),
      false,
      null,
      null
    )
  ),
  'superseded',
  'stale deleted-event fallback is rejected without mutation'
);
reset role;
select extensions.is((select stripe_status from public.billing_subscriptions where stripe_subscription_id = 'sub_fence_preserved'), 'active', 'stale complete snapshot cannot mark a newer subscription missing');
select extensions.is((select count(*)::integer from public.billing_subscriptions where stripe_subscription_id = 'sub_fence_stale'), 0, 'stale snapshot writes no stale provider subscription');
select extensions.is((select count(*)::integer from public.billing_subscriptions where stripe_subscription_id = 'sub_fence_deleted_stale'), 0, 'stale deleted fallback writes no provider subscription');
select extensions.is((select billing_state from public.billing_accounts where organization_id = 'b2000000-0000-0000-0000-000000000001'), 'active', 'stale reconciliation cannot regress account state');
select extensions.is((select count(*)::integer from public.action_logs where organization_id = 'b2000000-0000-0000-0000-000000000001' and action = 'billing.reconciled'), 2, 'stale reconciliation writes no reconciliation audit');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_fence_preserved', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'unpaid', 'cancel_at_period_end', false)), true
  ),
  'inactive',
  'active to unpaid normalizes inactive while retaining current topology'
);
reset role;
select extensions.ok(not exists (select 1 from public.action_logs where organization_id = 'b2000000-0000-0000-0000-000000000001' and action = 'billing.subscription.ended'), 'active to unpaid does not write a terminal lifecycle audit');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select pg_temp.apply_billing_snapshot(
  'b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false,
  jsonb_build_array(jsonb_build_object('subscription_id', 'sub_fence_preserved', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'active', 'cancel_at_period_end', false)), true
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_fence_preserved', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'paused', 'cancel_at_period_end', false)), true
  ),
  'inactive',
  'active to paused normalizes inactive while retaining current topology'
);
reset role;
select extensions.ok(not exists (select 1 from public.action_logs where organization_id = 'b2000000-0000-0000-0000-000000000001' and action = 'billing.subscription.ended'), 'active to paused does not write a terminal lifecycle audit');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select pg_temp.apply_billing_snapshot(
  'b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false,
  jsonb_build_array(jsonb_build_object('subscription_id', 'sub_fence_preserved', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'active', 'cancel_at_period_end', false)), true
);
select extensions.is(
  pg_temp.apply_billing_snapshot(
    'b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false,
    jsonb_build_array(jsonb_build_object('subscription_id', 'sub_fence_preserved', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'canceled', 'cancel_at_period_end', false)), true
  ),
  'inactive',
  'active to canceled removes current topology'
);
select pg_temp.apply_billing_snapshot(
  'b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false,
  jsonb_build_array(jsonb_build_object('subscription_id', 'sub_fence_preserved', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'canceled', 'cancel_at_period_end', false)), true
);
select extensions.lives_ok($$ select public.record_stripe_checkout_session((select checkout_id from pg_temp.billing_b_checkout), 'cs_pending_b', 'cus_billing_b', now() + interval '1 day', false) $$, 'service role can record the pending Checkout session');
select extensions.lives_ok($$ select * from public.reserve_billing_checkout_subscription_from_event('cs_pending_b', 'cus_billing_b', 'sub_pending_b', false) $$, 'verified Checkout subscription identity is retained while projection is pending');
select extensions.is(public.assert_billing_checkout_eligible((select checkout_id from pg_temp.billing_b_checkout)), false, 'verified pending purchase cannot authorize another Stripe Checkout');
reset role;
select extensions.is((select count(*)::integer from public.action_logs where organization_id = 'b2000000-0000-0000-0000-000000000001' and action = 'billing.subscription.ended'), 1, 'active to canceled writes one terminal lifecycle audit even after replay');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000003', true);
select extensions.is((select action from public.begin_my_billing_checkout('b2000000-0000-0000-0000-000000000001', 'core')), 'manage_existing_subscription', 'verified pending purchase blocks another Checkout attempt');
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (
    select outcome
    from public.apply_stripe_billing_snapshot(
      'b2000000-0000-0000-0000-000000000001',
      'cus_billing_b',
      false,
      (select reconciliation_generation from public.begin_stripe_billing_reconciliation('b2000000-0000-0000-0000-000000000001', 'cus_billing_b', false)),
      jsonb_build_array(jsonb_build_object('subscription_id', 'sub_pending_b', 'product_id', 'prod_core', 'price_id', 'price_core', 'plan_key', 'core', 'is_supported', true, 'stripe_status', 'active', 'cancel_at_period_end', false)),
      true,
      'cs_pending_b',
      'sub_pending_b'
    )
  ),
  'applied',
  'verified Checkout snapshot atomically applies after its exact subscription is visible'
);
reset role;
select extensions.is((select status from public.billing_checkout_sessions where id = (select checkout_id from pg_temp.billing_b_checkout)), 'completed', 'verified Checkout completes only with its fenced provider snapshot');
select extensions.is((select count(*)::integer from public.action_logs where organization_id = 'b2000000-0000-0000-0000-000000000001' and action = 'billing.checkout.completed'), 1, 'verified Checkout completion writes one durable audit');

update public.stripe_webhook_events set status = 'processed', processed_at = now(), claimed_at = null, claimed_by = null
where stripe_event_id in ('evt_billing_unique', 'evt_billing_rpc');
insert into public.stripe_webhook_events (stripe_event_id, event_type, livemode, status, claimed_at, claimed_by)
values ('evt_billing_expired_lease', 'invoice.paid', false, 'processing', now() - interval '6 minutes', 'old-worker');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select stripe_event_id from public.claim_stripe_webhook_events('new-worker', 1)),
  'evt_billing_expired_lease',
  'lease-expired Stripe event is recoverable by a later worker claim'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000001', true);
select extensions.is((select can_manage_billing from public.get_my_billing_overview('b1000000-0000-0000-0000-000000000001')), true, 'review-required current topology can manage trusted billing');
select extensions.is((select can_subscribe from public.get_my_billing_overview('b1000000-0000-0000-0000-000000000001')), false, 'review-required current topology cannot subscribe again');
select extensions.is((select period_kind from public.get_my_billing_usage_summary('b1000000-0000-0000-0000-000000000001')), 'current_month_preview', 'ambiguous topology uses a labelled current-month usage preview');
reset role;
select extensions.is((select count(*)::integer from public.stripe_webhook_events where stripe_event_id = 'evt_billing_rpc'), 1, 'webhook replay has one durable event row');
select extensions.ok(has_function_privilege('service_role', 'public.claim_stripe_webhook_events(text,integer)', 'execute'), 'service role has narrow event-claim RPC grant');
select extensions.ok(has_function_privilege('service_role', 'public.begin_stripe_billing_reconciliation(uuid,text,boolean)', 'execute'), 'service role has the narrow reconciliation fence RPC grant');
select extensions.ok(not has_function_privilege('authenticated', 'public.reserve_billing_checkout_subscription_from_event(text,text,text,boolean)', 'execute'), 'authenticated callers cannot reserve verified Checkout state');
select extensions.ok(not has_table_privilege('service_role', 'public.billing_usage_events', 'insert,update,delete'), 'service role has no broad usage-ledger CRUD grant');
select extensions.ok(not has_function_privilege('anon', 'public.get_my_billing_overview(uuid)', 'execute'), 'anon cannot execute the security-definer billing overview');

select * from extensions.finish();
rollback;

-- Phase 12 billing authority, tenant integrity, and prospective metering guarantees.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(26);

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
insert into public.users (id, email) select id, email from auth.users where id::text like 'b0000000%';
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

select extensions.throws_ok(
  $$ insert into public.billing_accounts (organization_id, stripe_customer_id, livemode) values ('b1000000-0000-0000-0000-000000000001', 'cus_billing_b', false) $$,
  '23505', 'duplicate key', 'one Stripe customer cannot map to two organizations'
);
select extensions.throws_ok(
  $$ insert into public.billing_subscriptions (organization_id,stripe_customer_id,stripe_subscription_id,is_supported,stripe_status,livemode) values ('b1000000-0000-0000-0000-000000000001','cus_billing_b','sub_cross_org',false,'active',false) $$,
  '23503', 'foreign key', 'subscription customer cannot cross organizations'
);
select extensions.throws_ok(
  $$ insert into public.billing_checkout_sessions (organization_id,plan_key,stripe_customer_id,idempotency_key) values ('b1000000-0000-0000-0000-000000000001','core','cus_billing_b','avenlyo:test-cross-org-checkout') $$,
  '23503', 'foreign key', 'checkout customer cannot cross organizations'
);
insert into public.stripe_webhook_events (stripe_event_id,event_type,livemode) values ('evt_billing_unique', 'invoice.paid', false);
select extensions.throws_ok(
  $$ insert into public.stripe_webhook_events (stripe_event_id,event_type,livemode) values ('evt_billing_unique', 'invoice.paid', false) $$,
  '23505', 'duplicate key', 'Stripe event identity is durable and unique'
);
select extensions.ok(not exists (
  select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stripe_webhook_events'
    and column_name in ('payload', 'raw_payload', 'signature', 'billing_address', 'card_number')
), 'webhook ledger stores no raw payment payload or signature');

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
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.billing_usage_events (organization_id,location_id,metric,quantity,occurred_at,call_id)
  values ('b1000000-0000-0000-0000-000000000001','b1200000-0000-0000-0000-000000000001','voice_seconds',1,now(),'b1800000-0000-0000-0000-000000000001') $sql$, '23503', 'foreign key')),
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

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000002', true);
select extensions.ok((select pg_temp.error_matches($sql$ select * from public.billing_accounts $sql$, '42501', 'permission denied')), 'member has no direct billing account read');
select extensions.ok((select pg_temp.error_matches($sql$ insert into public.billing_accounts (organization_id) values ('b1000000-0000-0000-0000-000000000001') $sql$, '42501', 'permission denied')), 'member cannot forge billing account state');
select extensions.ok((select pg_temp.error_matches($sql$ select * from public.begin_my_billing_checkout('core') $sql$, '42501', 'Organization owner or admin')), 'member cannot create Checkout');
select extensions.is((select count(*)::integer from public.get_my_billing_overview('b1000000-0000-0000-0000-000000000001')), 0, 'member cannot read billing administration overview');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok($$ select * from public.begin_my_billing_checkout('core') $$, 'owner can create trusted Core checkout intent');
select extensions.is((select count(*)::integer from public.get_my_billing_overview('b1000000-0000-0000-0000-000000000001')), 1, 'owner can read organization billing overview');
reset role;

create temporary table pg_temp.billing_state (checkout_id uuid);
insert into pg_temp.billing_state
select id from public.billing_checkout_sessions where organization_id = 'b1000000-0000-0000-0000-000000000001';
grant select on table pg_temp.billing_state to service_role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$ select * from public.billing_accounts $sql$, '42501', 'permission denied')), 'service role has no direct billing table grant');
select extensions.lives_ok($$ select public.record_stripe_billing_customer((select checkout_id from pg_temp.billing_state), 'cus_billing_a', false) $$, 'service role can persist trusted Stripe customer mapping');
select extensions.lives_ok($$ select * from public.record_stripe_webhook_event('evt_billing_rpc', 'invoice.paid', 'in_1', now(), false) $$, 'service role can persist verified event identity');
select extensions.lives_ok($$ select * from public.record_stripe_webhook_event('evt_billing_rpc', 'invoice.paid', 'in_1', now(), false) $$, 'service role accepts a duplicate verified event safely');
reset role;
select extensions.is((select count(*)::integer from public.stripe_webhook_events where stripe_event_id = 'evt_billing_rpc'), 1, 'webhook replay has one durable event row');
select extensions.ok(has_function_privilege('service_role', 'public.claim_stripe_webhook_events(text,integer)', 'execute'), 'service role has narrow event-claim RPC grant');
select extensions.ok(not has_table_privilege('service_role', 'public.billing_usage_events', 'insert,update,delete'), 'service role has no broad usage-ledger CRUD grant');

select * from extensions.finish();
rollback;

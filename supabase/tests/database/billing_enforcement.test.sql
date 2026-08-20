-- Phase 17 billing entitlement enforcement and graceful suspension.
--
-- The guarantees under test are: entitlement is derived only from durable provider truth; nothing a
-- browser or a trusted worker can say overrides it; blocked work terminates deliberately without a
-- provider call and never replays; and everything that is not new paid execution keeps working.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(84);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

-- The Core feature set, written out rather than read from the catalogue table, so a test that
-- passes proves the deployed catalogue matches this list instead of agreeing with itself.
create function pg_temp.every_feature(target_organization_id uuid)
returns boolean language sql as $$
  select bool_and(public.billing_feature_available(target_organization_id, feature))
  from unnest(array['voice', 'sms', 'web_chat', 'appointments', 'lead_capture', 'reminders',
    'lead_followups']) as feature;
$$;
create function pg_temp.any_feature(target_organization_id uuid)
returns boolean language sql as $$
  select bool_or(public.billing_feature_available(target_organization_id, feature))
  from unnest(array['voice', 'sms', 'web_chat', 'appointments', 'lead_capture', 'reminders',
    'lead_followups']) as feature;
$$;

-- One user owns organization A and administers organization B.  Phase 15 made that legitimate and
-- Phase 12's "exactly one admin organization" inference could not express it.
insert into auth.users (id, email) values
  ('bb000000-0000-0000-0000-000000000001', 'billing-enforcement-owner@example.test'),
  ('bb000000-0000-0000-0000-000000000002', 'billing-enforcement-member@example.test'),
  ('bb000000-0000-0000-0000-000000000003', 'billing-enforcement-outsider@example.test');
insert into public.users (id, email)
select id, email from auth.users where id::text like 'bb000000%'
on conflict (id) do nothing;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('bb100000-0000-0000-0000-000000000001', 'Enforcement A', 'enforcement-a',
   'bb000000-0000-0000-0000-000000000001', 'veterinary'),
  ('bb200000-0000-0000-0000-000000000001', 'Enforcement B', 'enforcement-b',
   'bb000000-0000-0000-0000-000000000001', 'medspa');
insert into public.locations (id, organization_id, name, timezone) values
  ('bb110000-0000-0000-0000-000000000001', 'bb100000-0000-0000-0000-000000000001', 'A clinic', 'UTC'),
  ('bb210000-0000-0000-0000-000000000001', 'bb200000-0000-0000-0000-000000000001', 'B clinic', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('bb130000-0000-0000-0000-000000000001', 'bb100000-0000-0000-0000-000000000001',
   'bb000000-0000-0000-0000-000000000001', 'owner'),
  ('bb130000-0000-0000-0000-000000000002', 'bb100000-0000-0000-0000-000000000001',
   'bb000000-0000-0000-0000-000000000002', 'member'),
  ('bb230000-0000-0000-0000-000000000001', 'bb200000-0000-0000-0000-000000000001',
   'bb000000-0000-0000-0000-000000000001', 'admin');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('bb100000-0000-0000-0000-000000000001', 'bb130000-0000-0000-0000-000000000002',
  'bb110000-0000-0000-0000-000000000001');

insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled)
values ('bb140000-0000-0000-0000-000000000001', 'bb100000-0000-0000-0000-000000000001',
  'bb110000-0000-0000-0000-000000000001', '+14155559001', 'active', true);
insert into public.voice_configurations (organization_id, location_id, enabled)
values ('bb100000-0000-0000-0000-000000000001', 'bb110000-0000-0000-0000-000000000001', true);
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status)
values ('bb150000-0000-0000-0000-000000000001', 'bb100000-0000-0000-0000-000000000001',
  'bb110000-0000-0000-0000-000000000001', 'web', 'Website chat', 'active');
insert into public.web_chat_widgets (id, organization_id, location_id, channel_id, public_key, enabled, allowed_origins)
values ('bb160000-0000-0000-0000-000000000001', 'bb100000-0000-0000-0000-000000000001',
  'bb110000-0000-0000-0000-000000000001', 'bb150000-0000-0000-0000-000000000001',
  'bb160000-0000-0000-0000-000000000002', true, '["https://enforcement.example"]');

-- Organization A carries an entitled Core subscription.  Organization B deliberately has no billing
-- account at all, which is the unconfigured case.
insert into public.billing_accounts (organization_id, stripe_customer_id, livemode, billing_state)
values ('bb100000-0000-0000-0000-000000000001', 'cus_enforcement_a', false, 'active');
insert into public.billing_subscriptions (organization_id, stripe_customer_id, stripe_subscription_id,
  stripe_product_id, stripe_price_id, plan_key, is_supported, stripe_status, livemode)
values ('bb100000-0000-0000-0000-000000000001', 'cus_enforcement_a', 'sub_enforcement_a',
  'prod_core', 'price_core', 'core', true, 'active', false);

-- ============================================================================================
-- Feature catalogue
-- ============================================================================================

select extensions.is(
  (select array_agg(feature order by feature) from public.billing_core_features),
  array['appointments', 'lead_capture', 'lead_followups', 'reminders', 'sms', 'voice', 'web_chat']::text[],
  'the deployed feature catalogue is exactly the source-controlled Core set'
);
select extensions.is(
  public.billing_feature_available('bb100000-0000-0000-0000-000000000001', 'unlimited_everything'),
  false,
  'an unknown feature name is never entitled'
);
select extensions.is(
  public.billing_feature_available('bb100000-0000-0000-0000-000000000001', 'test_mode'),
  false,
  'the non-production conversation marker is not a purchasable feature'
);
select extensions.is(
  public.billing_feature_available(null, 'sms'),
  false,
  'a missing organization is never entitled'
);

-- ============================================================================================
-- Entitlement matrix
-- ============================================================================================

select extensions.is(pg_temp.every_feature('bb100000-0000-0000-0000-000000000001'), true,
  'active supported Core entitles every Core feature');

update public.billing_subscriptions set stripe_status = 'trialing' where stripe_subscription_id = 'sub_enforcement_a';
select extensions.is(pg_temp.every_feature('bb100000-0000-0000-0000-000000000001'), true,
  'a supported Stripe trial remains entitled without a second Avenlyo trial system');

update public.billing_subscriptions set stripe_status = 'past_due' where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'attention' where stripe_customer_id = 'cus_enforcement_a';
select extensions.is(pg_temp.every_feature('bb100000-0000-0000-0000-000000000001'), true,
  'past_due normalizes to attention and stays entitled: one recoverable payment problem is not a suspension');

update public.billing_subscriptions set stripe_status = 'active', cancel_at_period_end = true
where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'active' where stripe_customer_id = 'cus_enforcement_a';
select extensions.is(pg_temp.every_feature('bb100000-0000-0000-0000-000000000001'), true,
  'a subscription scheduled to cancel stays entitled until the provider actually ends it');
update public.billing_subscriptions set cancel_at_period_end = false where stripe_subscription_id = 'sub_enforcement_a';

update public.billing_subscriptions set stripe_status = 'unpaid' where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'inactive' where stripe_customer_id = 'cus_enforcement_a';
select extensions.is(pg_temp.any_feature('bb100000-0000-0000-0000-000000000001'), false,
  'unpaid entitles nothing');

update public.billing_subscriptions set stripe_status = 'paused' where stripe_subscription_id = 'sub_enforcement_a';
select extensions.is(pg_temp.any_feature('bb100000-0000-0000-0000-000000000001'), false,
  'paused entitles nothing');

update public.billing_subscriptions set stripe_status = 'incomplete' where stripe_subscription_id = 'sub_enforcement_a';
select extensions.is(pg_temp.any_feature('bb100000-0000-0000-0000-000000000001'), false,
  'incomplete entitles nothing');

-- An unknown provider status is review_required topology and must fail closed rather than be
-- optimistically read as a working subscription.
update public.billing_subscriptions set stripe_status = 'some_future_stripe_status'
where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'review_required' where stripe_customer_id = 'cus_enforcement_a';
select extensions.is(pg_temp.any_feature('bb100000-0000-0000-0000-000000000001'), false,
  'an unrecognized provider status entitles nothing');

-- A cached state that disagrees with provider truth must not be able to grant entitlement on its
-- own: the subscription conditions are re-derived, so a stale projection fails closed.
update public.billing_accounts set billing_state = 'active' where stripe_customer_id = 'cus_enforcement_a';
select extensions.is(pg_temp.any_feature('bb100000-0000-0000-0000-000000000001'), false,
  'an active cached state cannot entitle an unsupported provider topology');

update public.billing_subscriptions set stripe_status = 'active', is_supported = false,
  plan_key = null, stripe_product_id = null, stripe_price_id = null
where stripe_subscription_id = 'sub_enforcement_a';
select extensions.is(pg_temp.any_feature('bb100000-0000-0000-0000-000000000001'), false,
  'an unsupported product entitles nothing even while Stripe reports it active');

update public.billing_subscriptions set is_supported = true, plan_key = 'core',
  stripe_product_id = 'prod_core', stripe_price_id = 'price_core'
where stripe_subscription_id = 'sub_enforcement_a';
insert into public.billing_subscriptions (organization_id, stripe_customer_id, stripe_subscription_id,
  stripe_product_id, stripe_price_id, plan_key, is_supported, stripe_status, livemode)
values ('bb100000-0000-0000-0000-000000000001', 'cus_enforcement_a', 'sub_enforcement_a2',
  'prod_core', 'price_core', 'core', true, 'active', false);
select extensions.is(pg_temp.any_feature('bb100000-0000-0000-0000-000000000001'), false,
  'two current subscriptions are ambiguous topology and entitle nothing rather than picking one');
delete from public.billing_subscriptions where stripe_subscription_id = 'sub_enforcement_a2';

select extensions.is(pg_temp.any_feature('bb200000-0000-0000-0000-000000000001'), false,
  'an organization with no billing account entitles nothing');

-- ============================================================================================
-- No browser or worker override
-- ============================================================================================

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000001', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.billing_feature_available('bb100000-0000-0000-0000-000000000001', 'sms')
$sql$, '42501', 'permission denied')), 'a browser cannot ask the entitlement helper anything');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.billing_message_job_blocked('bb100000-0000-0000-0000-000000000001')
$sql$, '42501', 'permission denied')), 'a browser cannot invoke the job suppression predicate');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.billing_sms_compliance_exempt('bb100000-0000-0000-0000-000000000001')
$sql$, '42501', 'permission denied')), 'a browser cannot declare a message compliance-exempt');
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.billing_core_features
$sql$, '42501', 'permission denied')), 'a browser cannot read the feature catalogue');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.billing_core_features (feature) values ('unlimited_everything')
$sql$, '42501', 'permission denied')), 'a browser cannot add itself a feature');
select extensions.ok((select pg_temp.error_matches($sql$
  update public.billing_accounts set billing_state = 'active'
$sql$, '42501', 'permission denied')), 'a browser cannot mark itself active');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.billing_subscriptions (organization_id, stripe_customer_id, stripe_subscription_id,
    stripe_product_id, stripe_price_id, plan_key, is_supported, stripe_status, livemode)
  values ('bb100000-0000-0000-0000-000000000001', 'cus_enforcement_a', 'sub_forged',
    'prod_core', 'price_core', 'core', true, 'active', false)
$sql$, '42501', 'permission denied')), 'a browser cannot forge a supported subscription');
select extensions.ok((select pg_temp.error_matches($sql$
  update public.message_processing_jobs set status = 'queued'
$sql$, '42501', 'permission denied')), 'a browser cannot reopen suppressed work');
reset role;

-- Provider and service identity prove a caller may do backend work.  They do not prove the
-- organization may consume a paid product feature, so the trusted backend cannot ask either.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.billing_feature_available('bb100000-0000-0000-0000-000000000001', 'sms')
$sql$, '42501', 'permission denied')), 'service role is not an entitlement bypass');
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.billing_core_features
$sql$, '42501', 'permission denied')), 'service role cannot read the feature catalogue directly');
reset role;

-- ============================================================================================
-- Multi-organization billing actions
-- ============================================================================================

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select action from public.begin_my_billing_checkout('bb200000-0000-0000-0000-000000000001', 'core')),
  'create_checkout',
  'a user who administers a second organization can start its checkout: the exactly-one assumption is gone'
);
select extensions.is(
  (select action from public.begin_my_billing_checkout('bb100000-0000-0000-0000-000000000001', 'core')),
  'manage_existing_subscription',
  'the same user acting on the organization they own gets that organization answer, not the other one'
);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.begin_my_billing_portal('bb200000-0000-0000-0000-000000000001')
$sql$, '42501', 'Billing portal is unavailable')),
  'the portal answers for the organization asked for: B has no Stripe customer even though A does');
select extensions.lives_ok(
  $$ select public.begin_my_billing_portal('bb100000-0000-0000-0000-000000000001') $$,
  'the same caller reaches the portal for the organization that does have one'
);
reset role;
-- Read the checkout rows as the migration role: the browser has no direct table grant, which is
-- exactly the Phase 12 guarantee the assertion above depends on.
select extensions.is(
  (select count(*)::integer from public.billing_checkout_sessions
   where organization_id = 'bb100000-0000-0000-0000-000000000001'),
  0,
  'a checkout intent is never created against the wrong organization'
);
select extensions.is(
  (select count(*)::integer from public.billing_checkout_sessions
   where organization_id = 'bb200000-0000-0000-0000-000000000001'),
  1,
  'the checkout intent lands on exactly the organization the caller was acting in'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000002', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.begin_my_billing_checkout('bb100000-0000-0000-0000-000000000001', 'core')
$sql$, '42501', 'Organization owner or admin')), 'a member cannot start checkout for their own organization');
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.begin_my_billing_refresh('bb200000-0000-0000-0000-000000000001')
$sql$, '42501', 'Organization owner or admin')), 'a member cannot refresh another organization billing');
select extensions.is(
  (select automation_available from public.get_my_billing_execution_summary('bb100000-0000-0000-0000-000000000001')),
  true,
  'a member may read the execution summary for the organization they belong to'
);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.get_my_billing_execution_summary('bb200000-0000-0000-0000-000000000001')
$sql$, '42501', 'Organization access is required')),
  'the execution summary is refused for an organization the caller does not belong to');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000003', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.begin_my_billing_checkout('bb100000-0000-0000-0000-000000000001', 'core')
$sql$, '42501', 'Organization owner or admin')),
  'a guessed organization identifier from outside is denied at the database boundary');
reset role;

-- The summary is a product fact, not a billing record: no provider identifier is in its shape.
select extensions.is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public' and table_name = 'billing_core_features'
     and column_name <> 'feature'),
  0,
  'the feature catalogue stores a feature name and nothing else'
);
select extensions.ok(
  (select not bool_or(argument ~* 'stripe|customer|subscription|price|product')
   from unnest(string_to_array(
     pg_catalog.pg_get_function_result('public.get_my_billing_execution_summary(uuid)'::regprocedure), ','
   )) as argument),
  'the member-visible execution summary exposes no Stripe customer, subscription, product, or price'
);

-- ============================================================================================
-- Voice: entitlement is enforced before the model session is accepted
-- ============================================================================================

update public.billing_subscriptions set stripe_status = 'unpaid' where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'inactive' where stripe_customer_id = 'cus_enforcement_a';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select accepted from public.bootstrap_inbound_voice_call('evt_bb_voice_1', 'realtime.call.incoming',
    'rtc_bb_1', 'sip_bb_1', '+14155559001', '+14155559101')),
  false,
  'a configured and routed voice number is not accepted while billing is unavailable'
);
reset role;
select extensions.is(
  (select rejection_reason from public.voice_webhook_events where event_id = 'evt_bb_voice_1'),
  'billing_unavailable',
  'the provider event is recorded with a bounded rejection reason'
);
select extensions.is(
  (select status from public.voice_webhook_events where event_id = 'evt_bb_voice_1'),
  'rejected',
  'a billing rejection is a rejection, not a failure'
);
select extensions.is(
  (select count(*)::integer from public.calls where external_call_id = 'rtc_bb_1'),
  0,
  'no customer call, conversation, or contact is created for a billing-rejected voice event'
);
select extensions.is(
  (select count(*)::integer from public.voice_webhook_events where event_id = 'evt_bb_voice_1'),
  1,
  'the rejected event exists exactly once'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select is_duplicate from public.bootstrap_inbound_voice_call('evt_bb_voice_1', 'realtime.call.incoming',
    'rtc_bb_1', 'sip_bb_1', '+14155559001', '+14155559101')),
  true,
  'replaying a billing-rejected provider event stays idempotent'
);
reset role;

-- ============================================================================================
-- SMS: inbound truth is preserved, paid execution is not
-- ============================================================================================

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select accepted from public.bootstrap_inbound_sms('SM0000000000000000000000000000bb01',
    '+14155559201', '+14155559001', 'Do you have an opening?', '[]', '{}')),
  true,
  'a customer may keep texting an Avenlyo number while the organization subscription is inactive'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.messages where external_id = 'SM0000000000000000000000000000bb01'),
  1,
  'the inbound customer message is persisted, so customer history stays accurate'
);
select extensions.is(
  (select count(*)::integer from public.message_processing_jobs
   where job_kind = 'inbound_ai' and status = 'queued'),
  1,
  'the ordinary AI job is enqueued: suppression is a claim-time decision, not an ingestion one'
);
-- Captured once, as the migration role.  Later assertions run as authenticated, and the browser
-- deliberately cannot reach messaging tables directly.
create temporary table pg_temp.enforcement_conversation as
select conversation_id from public.messages where external_id = 'SM0000000000000000000000000000bb01';
-- A temporary table belongs to the role that made it, and the operator assertions below run as
-- authenticated.  A transaction-local setting is readable by every role and carries the same fact.
select set_config('avenlyo.enforcement_conversation',
  (select conversation_id::text from pg_temp.enforcement_conversation), true);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_message_processing_jobs('billing-enforcement-worker', 5)),
  0,
  'the claim hands the worker nothing, so the model client is never reached'
);
reset role;
select extensions.is(
  (select status from public.message_processing_jobs where job_kind = 'inbound_ai'),
  'suppressed',
  'the blocked job reaches a terminal disposition rather than queueing or retrying forever'
);
select extensions.is(
  (select last_error_code from public.message_processing_jobs where job_kind = 'inbound_ai'),
  'billing_unavailable',
  'the suppression carries a bounded reason and no billing payload'
);

-- STOP is compliance, not automation.  It is persisted by the ingress before entitlement is ever
-- consulted, so an inactive subscription can never prevent an opt-out from taking effect.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select command from public.bootstrap_inbound_sms('SM0000000000000000000000000000bb02',
    '+14155559201', '+14155559001', 'STOP', '[]', '{}')),
  'stop',
  'STOP is still recognized while billing is unavailable'
);
reset role;
select extensions.is(
  (select status from public.messaging_contact_preferences
   where sender_phone_number_id = 'bb140000-0000-0000-0000-000000000001'),
  'opted_out',
  'the opt-out is durably recorded regardless of billing state'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select command from public.bootstrap_inbound_sms('SM0000000000000000000000000000bb03',
    '+14155559201', '+14155559001', 'START', '[]', '{}')),
  'start',
  'START keeps its deterministic consent semantics while billing is unavailable'
);
select extensions.is(
  (select command from public.bootstrap_inbound_sms('SM0000000000000000000000000000bb04',
    '+14155559201', '+14155559001', 'HELP', '[]', '{}')),
  'help',
  'HELP remains deterministic while billing is unavailable'
);
reset role;
select extensions.is(
  (select status from public.messaging_contact_preferences
   where sender_phone_number_id = 'bb140000-0000-0000-0000-000000000001'),
  'active',
  'START restores consent under the existing rules, independently of billing'
);

-- A staff reply is a new outbound production message and therefore a feature execution.
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'bb000000-0000-0000-0000-000000000001', true);
select extensions.is(
  (select outcome from public.create_my_human_reply(
    current_setting('avenlyo.enforcement_conversation')::uuid,
    'We can help with that.')),
  'billing_unavailable',
  'a human reply returns a stable bounded outcome instead of sending'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.messages where body = 'We can help with that.'),
  0,
  'no outbound message is queued that could send after reactivation'
);

-- An outbound delivery that was queued while entitled is suppressed at the claim, and its delivery
-- records the deliberate non-send so Phase 16 history never shows it as sent.
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type,
  body, metadata, source_channel, author_type, sent_at)
values ('bb180000-0000-0000-0000-000000000001', 'bb100000-0000-0000-0000-000000000001',
  'bb110000-0000-0000-0000-000000000001', (select conversation_id from pg_temp.enforcement_conversation), 'outbound', 'text',
  'Queued while entitled', jsonb_build_object('transport', 'sms'), 'sms', 'system', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider)
values ('bb100000-0000-0000-0000-000000000001', 'bb110000-0000-0000-0000-000000000001',
  'bb180000-0000-0000-0000-000000000001', 'twilio');
insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
values ('bb100000-0000-0000-0000-000000000001', 'bb110000-0000-0000-0000-000000000001',
  (select conversation_id from pg_temp.enforcement_conversation), 'bb180000-0000-0000-0000-000000000001', 'outbound_delivery');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_message_processing_jobs('billing-enforcement-worker', 5)),
  0,
  'a delivery job queued while entitled is not handed to the worker once entitlement is gone'
);
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = 'bb180000-0000-0000-0000-000000000001'),
  'suppressed',
  'the delivery records a deliberate non-send'
);
select extensions.is(
  (select error_code from public.message_deliveries where message_id = 'bb180000-0000-0000-0000-000000000001'),
  'billing_unavailable',
  'the non-send carries a bounded reason and never a Stripe payload'
);
select extensions.is(
  (select count(*)::integer from public.billing_usage_events
   where message_delivery_id = (select id from public.message_deliveries
     where message_id = 'bb180000-0000-0000-0000-000000000001')),
  0,
  'an operation that never executed records no usage'
);

-- The submission claim is checked on its own queued delivery, so this proves the provider boundary
-- refuses independently rather than inheriting the job claim's decision.
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type,
  body, metadata, source_channel, author_type, sent_at)
values ('bb180000-0000-0000-0000-000000000003', 'bb100000-0000-0000-0000-000000000001',
  'bb110000-0000-0000-0000-000000000001', (select conversation_id from pg_temp.enforcement_conversation), 'outbound', 'text',
  'Straight to the submission claim', jsonb_build_object('transport', 'sms'), 'sms', 'system', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider)
values ('bb100000-0000-0000-0000-000000000001', 'bb110000-0000-0000-0000-000000000001',
  'bb180000-0000-0000-0000-000000000003', 'twilio');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_sms_delivery_submission('bb180000-0000-0000-0000-000000000003')),
  0,
  'the authoritative Twilio submission claim refuses on its own, before any provider request'
);
reset role;
select extensions.is(
  (select error_code from public.message_deliveries where message_id = 'bb180000-0000-0000-0000-000000000003'),
  'billing_unavailable',
  'the submission claim records the same bounded deliberate non-send'
);

-- Ambiguous provider truth outranks billing: an unknown submission is never rewritten.
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type,
  body, metadata, source_channel, author_type, sent_at)
values ('bb180000-0000-0000-0000-000000000002', 'bb100000-0000-0000-0000-000000000001',
  'bb110000-0000-0000-0000-000000000001', (select conversation_id from pg_temp.enforcement_conversation), 'outbound', 'text',
  'Possibly already sent', jsonb_build_object('transport', 'sms'), 'sms', 'system', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, error_code)
values ('bb100000-0000-0000-0000-000000000001', 'bb110000-0000-0000-0000-000000000001',
  'bb180000-0000-0000-0000-000000000002', 'twilio', 'unknown', 'submission_unknown');
insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
values ('bb100000-0000-0000-0000-000000000001', 'bb110000-0000-0000-0000-000000000001',
  (select conversation_id from pg_temp.enforcement_conversation), 'bb180000-0000-0000-0000-000000000002', 'outbound_delivery');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.claim_message_processing_jobs('billing-enforcement-worker', 5) $$,
  'the claim runs over an ambiguous delivery without raising'
);
reset role;
select extensions.is(
  (select status from public.message_deliveries where message_id = 'bb180000-0000-0000-0000-000000000002'),
  'unknown',
  'unknown stays unknown: billing cannot erase a submission that may already have happened'
);

-- ============================================================================================
-- Web Chat: sessions fail closed, history stays readable
-- ============================================================================================

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.create_web_chat_session('bb160000-0000-0000-0000-000000000002',
    'https://enforcement.example', repeat('1', 64), repeat('2', 64))
$sql$, '42501', 'Web chat is not available')),
  'a new public web chat session fails closed before any session, conversation, or message exists');
reset role;
select extensions.is(
  (select count(*)::integer from public.web_chat_sessions),
  0,
  'nothing is created for a declined web chat session'
);

-- Reactivate, open a session, then suspend again: an existing visitor keeps reading, and stops
-- being able to start new paid automation.
update public.billing_subscriptions set stripe_status = 'active' where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'active' where stripe_customer_id = 'cus_enforcement_a';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.create_web_chat_session('bb160000-0000-0000-0000-000000000002',
    'https://enforcement.example', repeat('3', 64), repeat('4', 64)) $$,
  'a new web chat session works again once billing is active'
);
reset role;
update public.billing_subscriptions set stripe_status = 'unpaid' where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'inactive' where stripe_customer_id = 'cus_enforcement_a';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok(
  $$ select * from public.get_web_chat_messages(repeat('3', 64), null) $$,
  'an existing authorized session keeps reading its history while billing is unavailable'
);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.append_web_chat_message(repeat('3', 64),
    'bb190000-0000-0000-0000-000000000001', 'Are you open?', repeat('5', 64))
$sql$, '42501', 'Web chat is not available')),
  'a new visitor message on an existing session does not start additional paid automation');
reset role;
select extensions.is(
  (select count(*)::integer from public.web_chat_sessions),
  1,
  'the session token survives a billing suspension and is not destroyed'
);

-- ============================================================================================
-- Reactivation grants only new work
-- ============================================================================================

update public.billing_subscriptions set stripe_status = 'active' where stripe_subscription_id = 'sub_enforcement_a';
update public.billing_accounts set billing_state = 'active' where stripe_customer_id = 'cus_enforcement_a';

select extensions.is(pg_temp.every_feature('bb100000-0000-0000-0000-000000000001'), true,
  'reactivation restores entitlement without the owner reconfiguring anything');
select extensions.is(
  (select count(*)::integer from public.message_processing_jobs where status = 'suppressed'),
  2,
  'work suppressed while billing was unavailable stays suppressed after reactivation'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_message_processing_jobs('billing-enforcement-worker', 5)),
  0,
  'no suppressed job is ever re-claimed, so reactivation cannot surprise a customer with an old reply'
);
select extensions.is(
  (select is_duplicate from public.bootstrap_inbound_voice_call('evt_bb_voice_1', 'realtime.call.incoming',
    'rtc_bb_1', 'sip_bb_1', '+14155559001', '+14155559101')),
  true,
  'a billing-rejected provider event stays a duplicate after reactivation and creates no call'
);
select extensions.is(
  (select accepted from public.bootstrap_inbound_voice_call('evt_bb_voice_2', 'realtime.call.incoming',
    'rtc_bb_2', 'sip_bb_2', '+14155559001', '+14155559101')),
  true,
  'a new provider call after reactivation is accepted normally'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.calls where external_call_id = 'rtc_bb_1'),
  0,
  'the rejected call identity is never resurrected'
);
select extensions.is(
  (select status from public.message_deliveries where message_id = 'bb180000-0000-0000-0000-000000000001'),
  'suppressed',
  'a suppressed delivery is not resurrected by reactivation'
);

-- Owner configuration is never rewritten by a billing transition.
select extensions.is(
  (select enabled from public.voice_configurations
   where location_id = 'bb110000-0000-0000-0000-000000000001'),
  true,
  'voice configuration survives a full suspend and resume cycle untouched'
);
select extensions.is(
  (select enabled from public.web_chat_widgets where id = 'bb160000-0000-0000-0000-000000000001'),
  true,
  'the web chat widget stays enabled through a billing suspension'
);
select extensions.is(
  (select sms_enabled from public.phone_numbers where id = 'bb140000-0000-0000-0000-000000000001'),
  true,
  'SMS routing configuration is not switched off by billing'
);

-- ============================================================================================
-- Every paid claim consults the entitlement authority
-- ============================================================================================

-- Reminders, follow-ups, lead capture, and the booking provider-write claim are exercised
-- behaviourally by their own suites against entitled fixtures.  What is asserted here is that each
-- of their durable claims actually asks the entitlement authority, so a future edit that drops the
-- check fails loudly rather than silently reopening a paid path.
select extensions.ok(
  (select bool_and(pg_catalog.pg_get_functiondef(claim::regprocedure) ~ 'billing_feature_available')
   from unnest(array[
     'public.claim_due_appointment_reminders(text, integer)',
     'public.claim_lead_followup_jobs(text, integer)',
     'public.claim_lead_followup_delivery(uuid)',
     'public.claim_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)',
     'public.capture_conversation_lead(uuid, text, text, text, text, text, jsonb, text, text)',
     'public.get_conversation_scheduling_context(uuid, uuid)',
     'public.get_voice_scheduling_context(text)'
   ]) as claim),
  'every remaining paid execution claim consults the entitlement authority'
);
select extensions.ok(
  strpos(
    pg_catalog.pg_get_functiondef('public.claim_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)'::regprocedure),
    'provider_state_unknown'
  ) < strpos(
    pg_catalog.pg_get_functiondef('public.claim_conversation_scheduling_booking_intent(uuid, uuid, uuid, text)'::regprocedure),
    'billing_feature_available'
  ),
  'the booking claim returns its recovery states before it ever asks about billing'
);

select extensions.finish();
rollback;

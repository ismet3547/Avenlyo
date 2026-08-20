-- Phase 17: billing entitlement enforcement and graceful suspension.
--
-- Phase 12 made billing observational.  This migration turns the durable, Stripe-derived billing
-- projection into the authority for whether an organization may consume a paid product feature,
-- and wires that authority into the execution-claim boundary every paid provider or model
-- operation already passes through.
--
-- Three rules shape everything below.
--
--   1.  Entitlement is evaluated at the durable execution claim, never after a provider write has
--       begun.  A claim taken while entitled runs to completion; once entitlement is gone, no new
--       claim crosses into paid work.
--   2.  Suppression is a deliberate terminal disposition, not a failure.  Suppressed work never
--       replays, so reactivating billing can never surprise a customer with an old message.
--   3.  Ambiguous provider truth always wins.  Nothing here rewrites an unknown delivery, a
--       provider_state_unknown booking, or any state that may already have crossed a boundary.

-- ---------------------------------------------------------------------------------------------
-- Source-controlled feature catalogue
-- ---------------------------------------------------------------------------------------------

-- The exact Avenlyo Core feature set, as data so enforcement can join against it and so an
-- unknown feature name is rejected by construction rather than by a forgotten branch.  This is
-- deliberately not an admin-editable pricing table: it has no policy, no grant, and no write path
-- for any role.  Product entitlements stay source-controlled and change only by migration.
create table public.billing_core_features (
  feature text primary key check (feature ~ '^[a-z][a-z_]{1,40}$')
);
insert into public.billing_core_features (feature) values
  ('voice'),
  ('sms'),
  ('web_chat'),
  ('appointments'),
  ('lead_capture'),
  ('reminders'),
  ('lead_followups');

alter table public.billing_core_features enable row level security;
revoke all on table public.billing_core_features
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Central entitlement truth
-- ---------------------------------------------------------------------------------------------

-- The one predicate every execution boundary asks.  It reads only durable billing projection
-- state: no Stripe call, no reachability check, no freshness clock.  A Stripe outage therefore
-- cannot suspend an otherwise-active customer, and a webhook backlog can only delay a transition.
--
-- Availability requires all of:
--   * a known Core feature name,
--   * a billing account whose normalized state is active or attention,
--   * exactly one current subscription (ambiguous topology fails closed),
--   * that subscription being a supported Core product whose provider status is one this phase
--     recognizes as entitled.
--
-- The subscription conditions are re-derived here rather than trusted from the cached state
-- column alone, so unsupported products, multiple current subscriptions, and unknown provider
-- statuses fail closed even if the projection were momentarily stale.  cancel_at_period_end is
-- deliberately not consulted: a subscription scheduled to cancel stays entitled until the
-- provider actually moves it to a terminal state.
create function public.billing_feature_available(
  target_organization_id uuid,
  target_feature text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account_state text;
  current_count integer;
  entitled_status_count integer;
begin
  if target_organization_id is null then return false; end if;
  if not exists (
    select 1 from public.billing_core_features catalogue
    where catalogue.feature = target_feature
  ) then
    return false;
  end if;

  select account.billing_state into account_state
  from public.billing_accounts account
  where account.organization_id = target_organization_id;
  if account_state is null or account_state not in ('active', 'attention') then
    return false;
  end if;

  select
    count(*),
    count(*) filter (
      where subscription.is_supported
        and subscription.plan_key = 'core'
        and lower(btrim(subscription.stripe_status)) in ('active', 'trialing', 'past_due')
    )
  into current_count, entitled_status_count
  from public.billing_subscriptions subscription
  where subscription.organization_id = target_organization_id
    and public.billing_subscription_is_current(subscription.stripe_status);

  return current_count = 1 and entitled_status_count = 1;
end;
$$;

-- Maps a conversation to the Core feature its channel consumes.  Agent Test reports 'test_mode',
-- which is not a Core feature and is never billing-gated: onboarding, knowledge configuration,
-- and the Phase 3 test agent stay usable without a subscription.  An unrecognized channel returns
-- null so callers fail closed rather than guessing.
create function public.billing_conversation_feature(target_conversation_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when conversation.mode <> 'customer' then 'test_mode'
    when channel.channel_type = 'sms' then 'sms'
    when channel.channel_type = 'web' then 'web_chat'
    when channel.channel_type = 'phone' then 'voice'
    else null
  end
  from public.conversations conversation
  join public.channels channel
    on channel.organization_id = conversation.organization_id
   and channel.id = conversation.channel_id
  where conversation.id = target_conversation_id;
$$;

-- Deterministic keyword classification for a persisted inbound SMS.  It mirrors the inbound
-- bootstrap's own rules and exists so the compliance exception can be derived from stored truth
-- instead of from anything a caller supplies.
create function public.sms_consent_keyword(target_body text, target_opt_out_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(target_opt_out_type, ''))) in ('stop', 'start', 'help')
      then lower(btrim(target_opt_out_type))
    when lower(btrim(coalesce(target_body, '')))
      in ('stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit') then 'stop'
    when lower(btrim(coalesce(target_body, ''))) in ('start', 'unstop') then 'start'
    when lower(btrim(coalesce(target_body, ''))) = 'help' then 'help'
    else null
  end;
$$;

-- The single narrow compliance exception to SMS entitlement.
--
-- Deterministic consent acknowledgements are a regulatory obligation, not billable automation, so
-- they may leave the platform while normal SMS entitlement is unavailable.  Exemption is DERIVED
-- from durable trusted facts and can never be declared: the outbound message must be
-- system-authored (never a model reply, a staff reply, or anything the browser can reach), must
-- be an SMS reply bound to one specific inbound message, and that inbound message must itself be
-- a recognized START or HELP keyword as recorded by the provider or by the persisted customer
-- body.  There is no billing_exempt column and no argument that grants the exception.
--
-- STOP is deliberately absent.  Opt-out truth is persisted by the inbound bootstrap before any
-- entitlement question is asked, so a customer's STOP always takes effect and never depends on
-- this predicate, on SMS entitlement, or on billing state at all.
create function public.billing_sms_compliance_exempt(target_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.messages outbound
    join public.messages inbound
      on inbound.organization_id = outbound.organization_id
     and inbound.id = outbound.in_reply_to_message_id
    where outbound.id = target_message_id
      and outbound.direction = 'outbound'
      and outbound.author_type = 'system'
      and outbound.source_channel = 'sms'
      and inbound.direction = 'inbound'
      and inbound.author_type = 'customer'
      and inbound.source_channel = 'sms'
      and public.sms_consent_keyword(
        inbound.body,
        inbound.metadata #>> '{provider_metadata,opt_out_type}'
      ) in ('start', 'help')
  );
$$;

-- Whether a just-claimed message job must terminate without model or provider execution.
--
-- An inbound AI job is judged against its conversation channel's feature.  An outbound delivery
-- job is judged against SMS entitlement, with the compliance exception applied, and only while
-- its delivery is still queued: anything that already reached submitting or a terminal provider
-- state may have crossed the Twilio boundary, and billing must not rewrite that truth.
create function public.billing_message_job_blocked(target_job_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  job public.message_processing_jobs%rowtype;
  delivery_status text;
  feature text;
begin
  select * into job from public.message_processing_jobs where id = target_job_id;
  if job.id is null then return false; end if;

  if job.job_kind = 'outbound_delivery' then
    select delivery.status into delivery_status
    from public.message_deliveries delivery
    where delivery.message_id = job.message_id and delivery.provider = 'twilio';
    if delivery_status is distinct from 'queued' then return false; end if;
    if public.billing_sms_compliance_exempt(job.message_id) then return false; end if;
    return not public.billing_feature_available(job.organization_id, 'sms');
  end if;

  feature := public.billing_conversation_feature(job.conversation_id);
  if feature = 'test_mode' then return false; end if;
  return not public.billing_feature_available(job.organization_id, coalesce(feature, 'unknown'));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Durable suppression dispositions
-- ---------------------------------------------------------------------------------------------

-- A billing-suppressed job is terminal and deliberate.  It is not queued, not failed, and not
-- retrying, so it is never reclaimed and never replays after billing recovers.  The existing
-- claim index already covers only queued and processing rows, so suppressed work leaves the hot
-- path by construction.
alter table public.message_processing_jobs
  drop constraint message_processing_jobs_status_check,
  add constraint message_processing_jobs_status_check
    check (status in ('queued', 'processing', 'completed', 'failed', 'suppressed'));

-- A bounded reason on the provider event record.  No phone number, Stripe identifier,
-- organization name, provider body, or raw error is stored.
alter table public.voice_webhook_events
  add column if not exists rejection_reason text
    check (rejection_reason is null or rejection_reason in ('billing_unavailable'));

-- ---------------------------------------------------------------------------------------------
-- Message processing: claim-time cutover
-- ---------------------------------------------------------------------------------------------

-- The durable claim is where entitlement is decided.  Work whose feature is unavailable is
-- terminated inside the claim transaction and never handed to the worker, so the model and Twilio
-- clients cannot be reached for it at all.  A worker that receives fewer jobs is healthy: nothing
-- here raises, increments a failure counter, or marks a heartbeat unhealthy.
create or replace function public.claim_message_processing_jobs(target_worker_id text, target_limit integer default 5)
returns table (job_id uuid, job_kind text, message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, attempts integer)
language plpgsql security definer set search_path = '' as $$
declare claimed_ids uuid[]; blocked_ids uuid[];
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Worker claim is invalid';
  end if;
  update public.message_deliveries delivery set status = 'unknown', error_code = 'stale_submission_unknown', updated_at = now()
  from public.message_processing_jobs job
  where job.message_id = delivery.message_id and job.job_kind = 'outbound_delivery' and job.status = 'processing'
    and job.claimed_at < now() - interval '5 minutes' and delivery.provider = 'twilio' and delivery.status = 'submitting';
  update public.message_processing_jobs job set status = 'completed', completed_at = now(), claimed_at = null, claimed_by = null,
    last_error_code = 'stale_submission_unknown', updated_at = now()
  where job.status = 'processing' and job.claimed_at < now() - interval '5 minutes'
    and job.job_kind = 'outbound_delivery' and exists (
      select 1 from public.message_deliveries delivery
      where delivery.message_id = job.message_id and delivery.provider = 'twilio' and delivery.status = 'unknown'
    );
  update public.message_processing_jobs set status = 'queued', claimed_at = null, claimed_by = null, available_at = now(), updated_at = now()
    where status = 'processing' and claimed_at < now() - interval '5 minutes';

  with candidate as (
    select job.id from public.message_processing_jobs as job where job.status = 'queued' and job.available_at <= now()
    order by job.created_at asc for update skip locked limit target_limit
  ), updated as (
    update public.message_processing_jobs job set status = 'processing', attempts = job.attempts + 1, claimed_at = now(),
      claimed_by = btrim(target_worker_id), updated_at = now() from candidate where job.id = candidate.id returning job.id
  ) select array_agg(updated.id) into claimed_ids from updated;
  if claimed_ids is null then return; end if;

  -- The blocked set is decided once, before anything is mutated.  Suppressing a delivery changes
  -- what the predicate would answer next, so re-evaluating it per statement would silently leave
  -- the job claimable.
  select array_agg(job.id) into blocked_ids
  from public.message_processing_jobs job
  where job.id = any(claimed_ids) and public.billing_message_job_blocked(job.id);
  if blocked_ids is null then blocked_ids := array[]::uuid[]; end if;

  -- A blocked outbound delivery records the deliberate non-send on the delivery itself, so Phase
  -- 16 history shows a suppressed message rather than a sent one.  Only queued deliveries are
  -- touched; unknown stays unknown.
  update public.message_deliveries delivery
  set status = 'suppressed', error_code = 'billing_unavailable', updated_at = now()
  from public.message_processing_jobs job
  where job.id = any(blocked_ids) and job.job_kind = 'outbound_delivery'
    and delivery.message_id = job.message_id and delivery.provider = 'twilio' and delivery.status = 'queued';

  update public.message_processing_jobs job
  set status = 'suppressed', completed_at = now(), claimed_at = null, claimed_by = null,
    last_error_code = 'billing_unavailable', updated_at = now()
  where job.id = any(blocked_ids);

  return query select job.id, job.job_kind, job.message_id, job.conversation_id, job.organization_id,
    job.location_id, job.attempts
  from public.message_processing_jobs job
  where job.id = any(claimed_ids) and job.status = 'processing'
  order by job.created_at asc;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- SMS submission boundary
-- ---------------------------------------------------------------------------------------------

create or replace function public.claim_sms_delivery_submission(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language plpgsql security definer set search_path = '' as $$
declare
  delivery public.message_deliveries%rowtype;
  message public.messages%rowtype;
  conversation public.conversations%rowtype;
  phone public.phone_numbers%rowtype;
  reminder public.appointment_reminders%rowtype;
  appointment public.appointments%rowtype;
  settings public.appointment_reminder_settings%rowtype;
  location public.locations%rowtype;
  reminder_enabled boolean;
  expected_scheduled_for timestamptz;
  nominal_scheduled_for timestamptz;
  locked_conversation_id uuid;
begin
  perform public.require_messaging_service_role();

  -- The send boundary reads ownership, so it queues behind ownership mutations on the same
  -- conversation before it takes the delivery row lock. No lock cycle is possible.
  select source_message.conversation_id into locked_conversation_id
  from public.messages source_message where source_message.id = target_message_id;
  if locked_conversation_id is not null then
    perform public.lock_conversation_ownership(locked_conversation_id);
  end if;

  select * into delivery
  from public.message_deliveries as message_delivery
  where message_delivery.message_id = target_message_id and message_delivery.provider = 'twilio'
  for update;
  if delivery.id is null or delivery.status <> 'queued' then return; end if;

  select * into message from public.messages where id = delivery.message_id;

  -- Phase 17: the authoritative Twilio submission claim is the last durable boundary before a
  -- provider request, so entitlement is proven here as well as at the job claim.  A validated
  -- compliance acknowledgement is the only exception, and it is derived from stored inbound truth
  -- rather than declared by any caller.
  if not public.billing_sms_compliance_exempt(message.id)
    and not public.billing_feature_available(message.organization_id, 'sms') then
    update public.message_deliveries
    set status = 'suppressed', error_code = 'billing_unavailable', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  if message.appointment_reminder_id is not null then
    select * into reminder
    from public.appointment_reminders reminder_row
    where reminder_row.organization_id = message.organization_id
      and reminder_row.location_id = message.location_id
      and reminder_row.id = message.appointment_reminder_id
      and reminder_row.message_id = message.id
      and reminder_row.status = 'delivery_pending'
    for share;

    select * into appointment
    from public.appointments appointment_row
    where appointment_row.organization_id = message.organization_id
      and appointment_row.location_id = message.location_id
      and appointment_row.id = reminder.appointment_id
    for share;

    select * into settings
    from public.appointment_reminder_settings settings_row
    where settings_row.organization_id = message.organization_id
      and settings_row.location_id = message.location_id
    for share;

    select * into location
    from public.locations location_row
    where location_row.organization_id = message.organization_id and location_row.id = message.location_id
    for share;

    reminder_enabled := case reminder.reminder_type
      when 'appointment_24h' then settings.reminder_24h_enabled
      when 'appointment_2h' then settings.reminder_2h_enabled
      else false
    end;
    nominal_scheduled_for := appointment.starts_at - case reminder.reminder_type
      when 'appointment_24h' then interval '24 hours'
      when 'appointment_2h' then interval '2 hours'
      else null
    end;
    expected_scheduled_for := public.reminder_local_time(
      nominal_scheduled_for,
      location.timezone,
      settings.quiet_hours_start,
      settings.quiet_hours_end
    );

    if reminder.id is null
      or appointment.id is null
      or appointment.status <> 'confirmed'
      or appointment.starts_at <= now()
      or settings.id is null
      or not settings.sms_enabled
      or not reminder_enabled
      or reminder.schedule_version is distinct from settings.schedule_version
      or expected_scheduled_for is null
      or not public.is_appointment_reminder_send_time(reminder.reminder_type, expected_scheduled_for, appointment.starts_at)
      or expected_scheduled_for is distinct from reminder.scheduled_for
    then
      update public.message_deliveries
      set status = 'suppressed', error_code = 'appointment_reminder_ineligible', updated_at = now()
      where id = delivery.id;
      return;
    end if;
  end if;

  select * into conversation
  from public.conversations
  where organization_id = message.organization_id and id = message.conversation_id;

  -- An automated reply that has not yet crossed the provider boundary loses once a PERSON owns
  -- the conversation: a manual takeover with no handoff, and a resolved handoff whose conversation
  -- is still human-owned, both count.  Ownership is deliberately not inferred from ai_mode alone,
  -- so the intended handoff acknowledgement produced during the request-human turn still sends
  -- while the episode is unclaimed.  Anything already submitted keeps its provider truth untouched.
  if message.author_type = 'ai' and (
    conversation.assigned_user_id is not null
    or exists (
      select 1 from public.handoffs handoff
      where handoff.organization_id = message.organization_id
        and handoff.conversation_id = message.conversation_id
        and handoff.mode = 'customer' and handoff.status in ('open', 'acknowledged')
        and handoff.assigned_user_id is not null
    )
  ) then
    update public.message_deliveries
    set status = 'suppressed', error_code = 'human_ownership_suppressed', updated_at = now()
    where id = delivery.id;
    return;
  end if;
  select * into phone
  from public.phone_numbers
  where organization_id = message.organization_id and id = conversation.transport_phone_number_id;

  if conversation.id is null or phone.id is null or phone.status <> 'active' or not phone.sms_enabled
    or exists (
      select 1 from public.messaging_contact_preferences preference
      where preference.organization_id = message.organization_id
        and preference.location_id = conversation.location_id
        and preference.contact_id = conversation.contact_id
        and preference.channel_type = 'sms'
        and preference.sender_phone_number_id = phone.id
        and preference.status = 'opted_out'
    )
  then
    update public.message_deliveries
    set status = 'suppressed', error_code = 'delivery_suppressed', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  if message.body is null then
    update public.message_deliveries
    set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  if message.appointment_reminder_id is not null then
    select reminder_row.trusted_sms_recipient_e164 into to_e164
    from public.appointment_reminders reminder_row
    where reminder_row.organization_id = message.organization_id
      and reminder_row.location_id = message.location_id
      and reminder_row.id = message.appointment_reminder_id
      and reminder_row.message_id = message.id
      and reminder_row.status = 'delivery_pending';
  else
    select inbound.transport_sender_e164 into to_e164
    from public.messages inbound
    where inbound.organization_id = message.organization_id
      and inbound.conversation_id = message.conversation_id
      and inbound.id = message.in_reply_to_message_id
      and inbound.direction = 'inbound'
      and inbound.source_channel = 'sms'
      and inbound.author_type = 'customer';
  end if;

  if to_e164 is null then
    update public.message_deliveries
    set status = 'failed', error_code = 'delivery_identity_unavailable', updated_at = now()
    where id = delivery.id;
    return;
  end if;

  update public.message_deliveries
  set status = 'submitting', attempted_at = now(), updated_at = now()
  where id = delivery.id;

  return query
  select message.id, delivery.id, to_e164, phone.phone_number, message.body, 'submitting'::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Operator human reply
-- ---------------------------------------------------------------------------------------------

create or replace function public.create_my_human_reply(target_conversation_id uuid, target_body text)
returns table (outcome text, message_id uuid, source_channel text, assigned_display_name text)
language plpgsql security definer set search_path = '' as $$
declare
  conversation_row public.conversations%rowtype;
  channel_row public.channels%rowtype;
  trusted_inbound public.messages%rowtype;
  sms_route public.phone_numbers%rowtype;
  handoff_row public.handoffs%rowtype;
  claim_result record;
  saved_message_id uuid;
  contact_opted_out boolean;
  locked_conversation_id uuid;
begin
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Reply is invalid';
  end if;
  select conversation.id into locked_conversation_id from public.conversations conversation
  where conversation.id = target_conversation_id;
  if locked_conversation_id is null then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;
  perform public.lock_conversation_ownership(locked_conversation_id);

  select * into conversation_row from public.conversations where id = target_conversation_id for update;
  if conversation_row.id is null
    or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then
    raise exception using errcode = '42501', message = 'Conversation is not available';
  end if;
  select * into channel_row from public.channels
  where organization_id = conversation_row.organization_id and id = conversation_row.channel_id;
  if channel_row.channel_type not in ('sms', 'web') then
    raise exception using errcode = '22023', message = 'Text reply is not supported for this conversation';
  end if;

  -- Phase 17: creating a NEW outbound production customer message is a feature execution.  This
  -- is checked before any ownership claim or insert, so a billing-blocked reply has no side
  -- effect at all and nothing is queued that could send after reactivation.
  if not public.billing_feature_available(
    conversation_row.organization_id,
    case when channel_row.channel_type = 'sms' then 'sms' else 'web_chat' end
  ) then
    return query select 'billing_unavailable', null::uuid, channel_row.channel_type, null::text;
    return;
  end if;

  select * into handoff_row from public.handoffs handoff
  where handoff.conversation_id = conversation_row.id and handoff.mode = 'customer'
    and handoff.status in ('open', 'acknowledged')
  order by handoff.created_at asc, handoff.id asc
  limit 1;

  if handoff_row.id is not null then
    select * into claim_result from public.apply_handoff_claim(handoff_row.id, auth.uid());
    if claim_result.claim_outcome <> 'claimed' then
      return query select 'owned_by_other', null::uuid, channel_row.channel_type,
        public.handoff_operator_display_name(claim_result.owner_user_id);
      return;
    end if;
  elsif conversation_row.assigned_user_id is not null and conversation_row.assigned_user_id <> auth.uid() then
    return query select 'owned_by_other', null::uuid, channel_row.channel_type,
      public.handoff_operator_display_name(conversation_row.assigned_user_id);
    return;
  end if;

  if channel_row.channel_type = 'sms' then
    select * into sms_route from public.phone_numbers phone
    where phone.organization_id = conversation_row.organization_id
      and phone.location_id = conversation_row.location_id
      and phone.id = conversation_row.transport_phone_number_id
      and phone.status = 'active' and phone.sms_enabled;
    if conversation_row.status <> 'open' or sms_route.id is null then
      raise exception using errcode = '42501', message = 'SMS route is unavailable';
    end if;
    select * into trusted_inbound from public.messages inbound
    where inbound.organization_id = conversation_row.organization_id
      and inbound.location_id = conversation_row.location_id
      and inbound.conversation_id = conversation_row.id
      and inbound.direction = 'inbound' and inbound.source_channel = 'sms'
      and inbound.author_type = 'customer' and inbound.transport_sender_e164 is not null
    order by inbound.created_at desc, inbound.id desc limit 1;
    if trusted_inbound.id is null then
      raise exception using errcode = '42501', message = 'SMS transport identity is unavailable';
    end if;
    select exists (
      select 1 from public.messaging_contact_preferences preference
      where preference.organization_id = conversation_row.organization_id
        and preference.location_id = conversation_row.location_id
        and preference.contact_id = conversation_row.contact_id
        and preference.channel_type = 'sms'
        and preference.sender_phone_number_id = conversation_row.transport_phone_number_id
        and preference.status = 'opted_out'
    ) into contact_opted_out;
    if contact_opted_out then
      raise exception using errcode = '42501', message = 'SMS contact has opted out';
    end if;
  end if;

  insert into public.messages (
    organization_id, location_id, conversation_id, contact_id, direction, message_type, body,
    metadata, source_channel, author_type, sent_by_user_id, in_reply_to_message_id, sent_at
  ) values (
    conversation_row.organization_id, conversation_row.location_id, conversation_row.id,
    conversation_row.contact_id, 'outbound', 'text', btrim(target_body),
    jsonb_build_object('transport', channel_row.channel_type), channel_row.channel_type, 'human',
    auth.uid(), trusted_inbound.id, now()
  ) returning id into saved_message_id;

  if channel_row.channel_type = 'sms' then
    insert into public.message_deliveries (organization_id, location_id, message_id, provider)
    values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
    values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, saved_message_id, 'outbound_delivery');
  else
    insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, sent_at)
    values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'web_chat', 'sent', now());
  end if;

  -- When an active handoff was just claimed this is a no-op, so claiming is never audited twice.
  perform public.acquire_conversation_ownership(
    conversation_row.id,
    auth.uid(),
    'human_reply',
    public.latest_customer_turn_at(conversation_row.organization_id, conversation_row.id)
  );
  update public.conversations set last_message_at = now(), updated_at = now()
  where id = conversation_row.id;

  return query select 'sent', saved_message_id, channel_row.channel_type,
    public.handoff_operator_display_name(auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Public Web Chat
-- ---------------------------------------------------------------------------------------------

create or replace function public.create_web_chat_session(
  target_widget_public_key uuid,
  target_origin text,
  target_token_hash text,
  target_rate_scope text
)
returns table (session_id uuid, conversation_id uuid, welcome_message text)
language plpgsql security definer set search_path = '' as $$
declare widget public.web_chat_widgets%rowtype; normalized_origin text; channel_row public.channels%rowtype; session_row public.web_chat_sessions%rowtype;
begin
  perform public.require_messaging_service_role();
  if target_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode = '22023', message = 'Web chat session is invalid'; end if;
  normalized_origin := public.normalized_web_chat_origin(target_origin);
  if not public.consume_messaging_rate_limit('web-session:' || target_rate_scope, 10, 60) then
    raise exception using errcode = '42901', message = 'Too many web chat session requests'; end if;
  select * into widget from public.web_chat_widgets where public_key = target_widget_public_key and enabled;
  if widget.id is null or not exists (
    select 1 from jsonb_array_elements_text(widget.allowed_origins) allowed(origin)
    where public.normalized_web_chat_origin(allowed.origin) = normalized_origin
  ) then raise exception using errcode = '42501', message = 'Web chat widget is not available for this origin'; end if;
  select * into channel_row from public.channels
    where organization_id = widget.organization_id and id = widget.channel_id and channel_type = 'web' and status = 'active';
  if channel_row.id is null then raise exception using errcode = '42501', message = 'Web chat channel is not available'; end if;
  -- Phase 17: a new public Web Chat session is a web_chat feature execution.  It fails closed
  -- here, before any session, conversation, contact, or customer message exists.  The public API
  -- turns this into its ordinary generic rejection, so a website visitor is never told anything
  -- about payment, subscription, or Stripe.
  if not public.billing_feature_available(widget.organization_id, 'web_chat') then
    raise exception using errcode = '42501', message = 'Web chat is not available';
  end if;
  insert into public.conversations (organization_id, location_id, channel_id, status, metadata)
  values (widget.organization_id, widget.location_id, widget.channel_id, 'open', jsonb_build_object('transport', 'web_chat'))
  returning id into session_row.conversation_id;
  insert into public.web_chat_sessions (organization_id, location_id, widget_id, conversation_id, token_hash, origin, expires_at)
  values (widget.organization_id, widget.location_id, widget.id, session_row.conversation_id, target_token_hash, normalized_origin, now() + interval '24 hours')
  returning * into session_row;
  return query select session_row.id, session_row.conversation_id, widget.welcome_message;
end;
$$;

create or replace function public.append_web_chat_message(
  target_token_hash text,
  target_client_message_id uuid,
  target_body text,
  target_rate_scope text
)
returns table (message_id uuid, conversation_id uuid, is_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare session_row public.web_chat_sessions%rowtype; saved_message_id uuid;
begin
  perform public.require_messaging_service_role();
  if target_token_hash !~ '^[0-9a-f]{64}$' or target_client_message_id is null
    or length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Web chat message is invalid'; end if;
  if not public.consume_messaging_rate_limit('web-message:' || target_rate_scope, 30, 60) then
    raise exception using errcode = '42901', message = 'Too many web chat messages'; end if;
  select * into session_row from public.web_chat_sessions
    where token_hash = target_token_hash and expires_at > now() for update;
  if session_row.id is null then raise exception using errcode = '42501', message = 'Web chat session is unavailable'; end if;
  -- Phase 17: an existing session keeps its token and its readable history, but a new visitor
  -- message must not start additional paid automation.
  if not public.billing_feature_available(session_row.organization_id, 'web_chat') then
    raise exception using errcode = '42501', message = 'Web chat is not available';
  end if;
  select message.id into saved_message_id from public.messages message
    where message.organization_id = session_row.organization_id and message.conversation_id = session_row.conversation_id and message.client_message_id = target_client_message_id;
  if saved_message_id is not null then return query select saved_message_id, session_row.conversation_id, true; return; end if;
  insert into public.messages (organization_id, location_id, conversation_id, direction, message_type, body, metadata, source_channel, author_type, client_message_id, sent_at)
  values (session_row.organization_id, session_row.location_id, session_row.conversation_id, 'inbound', 'text', btrim(target_body),
    jsonb_build_object('transport', 'web_chat'), 'web', 'customer', target_client_message_id, now()) returning id into saved_message_id;
  insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
  values (session_row.organization_id, session_row.location_id, session_row.conversation_id, saved_message_id, 'inbound_ai');
  update public.web_chat_sessions set last_active_at = now(), expires_at = now() + interval '24 hours', updated_at = now() where id = session_row.id;
  update public.conversations set last_message_at = now(), updated_at = now() where id = session_row.conversation_id;
  return query select saved_message_id, session_row.conversation_id, false;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Automated lead capture
-- ---------------------------------------------------------------------------------------------

create or replace function public.capture_conversation_lead(
  target_inbound_message_id uuid,
  target_tool_call_id text,
  target_service_category text,
  target_urgency text,
  target_customer_goal text,
  target_customer_name text,
  target_details jsonb,
  target_qualification text,
  target_voice_call_id text default null
)
returns table (state text, missing_fields jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  inbound public.messages%rowtype;
  conversation_row public.conversations%rowtype;
  channel_row public.channels%rowtype;
  active_lead public.leads%rowtype;
  saved_lead public.leads%rowtype;
  incoming_details jsonb := coalesce(target_details, '{}'::jsonb);
  merged_details jsonb;
  existing_value text;
  detail_key text;
  detail_value text;
  conflicts text[] := array[]::text[];
  missing text[] := array[]::text[];
  result_state text;
  changed boolean := false;
  created boolean := false;
  urgency_changed boolean := false;
begin
  perform public.require_lead_capture_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) not between 1 and 200
    or target_urgency not in ('routine', 'soon', 'urgent', 'unknown')
    or target_customer_goal is not null and target_customer_goal not in ('appointment', 'estimate', 'information', 'service')
    or target_qualification not in ('needs_human', 'needs_more_information', 'qualified')
    or jsonb_typeof(incoming_details) <> 'object'
    or (select count(*) from jsonb_object_keys(incoming_details)) > 12
    or exists (select 1 from jsonb_each_text(incoming_details) item where item.key !~ '^[a-z][a-z0-9_]{0,63}$' or length(btrim(item.value)) not between 1 and 500)
    or target_service_category is not null and length(btrim(target_service_category)) not between 1 and 80
    or target_customer_name is not null and length(btrim(target_customer_name)) not between 1 and 120
  then raise exception using errcode = '22023', message = 'Lead capture is invalid'; end if;

  select message.* into inbound
  from public.messages message
  join public.conversations conversation on conversation.organization_id = message.organization_id
    and conversation.location_id is not distinct from message.location_id
    and conversation.id = message.conversation_id
  where message.id = target_inbound_message_id
    and message.direction = 'inbound' and message.author_type = 'customer'
    and conversation.ai_mode = 'ai';
  if inbound.id is null then raise exception using errcode = '42501', message = 'Current customer turn is not available'; end if;

  select * into conversation_row from public.conversations
  where organization_id = inbound.organization_id and id = inbound.conversation_id
    and location_id is not distinct from inbound.location_id;
  select * into channel_row from public.channels
  where organization_id = conversation_row.organization_id and id = conversation_row.channel_id
    and location_id is not distinct from conversation_row.location_id;
  if conversation_row.id is null or channel_row.id is null then
    raise exception using errcode = '42501', message = 'Current customer turn is not available';
  end if;

  if (channel_row.channel_type = 'sms' and (inbound.source_channel <> 'sms' or inbound.transport_sender_e164 is null))
    or (channel_row.channel_type = 'phone' and (
      inbound.source_channel <> 'voice' or target_voice_call_id is null
      or inbound.external_id is distinct from 'voice:' || target_voice_call_id || ':' || split_part(inbound.external_id, ':', 3)
      or not exists (
        select 1 from public.calls call
        where call.provider = 'openai-realtime-sip'
          and call.organization_id = conversation_row.organization_id
          and call.location_id is not distinct from conversation_row.location_id
          and call.conversation_id = conversation_row.id
          and call.external_call_id = target_voice_call_id
      )
    ))
    or (channel_row.channel_type = 'web' and inbound.source_channel <> 'web')
    or channel_row.channel_type not in ('sms', 'phone', 'web')
  then raise exception using errcode = '42501', message = 'Trusted customer transport is unavailable'; end if;

  -- Phase 17: production automated lead capture is a lead_capture feature execution, and a
  -- trusted service-role caller does not by itself prove the organization may consume it.  The
  -- Phase 3 test agent runs on a non-customer conversation and is deliberately never gated.
  -- Existing leads keep their Phase 10 read and edit rules; nothing here deletes or rewrites one.
  if conversation_row.mode = 'customer'
    and not public.billing_feature_available(conversation_row.organization_id, 'lead_capture') then
    return query select 'billing_unavailable'::text, '[]'::jsonb;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lead-capture:' || conversation_row.id::text, 0));
  select lead.* into saved_lead
  from public.leads lead
  join public.lead_capture_tool_calls capture on capture.organization_id = lead.organization_id
    and capture.location_id = lead.location_id and capture.lead_id = lead.id
  where capture.organization_id = conversation_row.organization_id and capture.location_id = conversation_row.location_id
    and capture.conversation_id = conversation_row.id and capture.inbound_message_id = inbound.id
    and capture.tool_call_id = target_tool_call_id;
  if saved_lead.id is not null then
    return query select capture.result_state, capture.missing_fields
    from public.lead_capture_tool_calls capture
    where capture.organization_id = conversation_row.organization_id and capture.location_id = conversation_row.location_id
      and capture.conversation_id = conversation_row.id and capture.inbound_message_id = inbound.id
      and capture.tool_call_id = target_tool_call_id;
    return;
  end if;

  if target_customer_name is not null then
    incoming_details := incoming_details || jsonb_build_object('customer_name', btrim(target_customer_name));
  end if;
  select * into active_lead from public.leads
  where organization_id = conversation_row.organization_id and location_id = conversation_row.location_id
    and conversation_id = conversation_row.id and status in ('new', 'qualified') for update;

  if active_lead.id is not null then
    if target_service_category is not null and active_lead.service_category is not null
      and active_lead.service_category <> btrim(target_service_category) then
      conflicts := array_append(conflicts, 'service_category');
    end if;
    if target_customer_goal is not null and active_lead.customer_goal is not null
      and active_lead.customer_goal <> target_customer_goal then
      conflicts := array_append(conflicts, 'customer_goal');
    end if;
    for detail_key, detail_value in select key, value from jsonb_each_text(incoming_details) loop
      existing_value := active_lead.details ->> detail_key;
      if existing_value is not null and existing_value <> detail_value then
        conflicts := array_append(conflicts, detail_key);
      end if;
    end loop;
  end if;

  if active_lead.id is not null then
    urgency_changed := case target_urgency when 'urgent' then 3 when 'soon' then 2 when 'routine' then 1 else 0 end
      > case active_lead.urgency when 'urgent' then 3 when 'soon' then 2 when 'routine' then 1 else 0 end;
  end if;

  if coalesce(array_length(conflicts, 1), 0) > 0 then
    -- A contradiction never replaces durable facts.  A separate urgent fact may only upgrade.
    if urgency_changed then
      update public.leads set urgency = target_urgency, updated_at = now()
      where id = active_lead.id and organization_id = active_lead.organization_id
      returning * into saved_lead;
      changed := true;
    else
      saved_lead := active_lead;
    end if;
    result_state := 'needs_clarification';
    missing := conflicts;
  elsif active_lead.id is null then
    insert into public.leads (
      organization_id, location_id, contact_id, conversation_id, status, source, source_channel,
      service_category, urgency, customer_goal, qualification_reason, qualified_at,
      last_captured_message_id, details
    ) values (
      conversation_row.organization_id, conversation_row.location_id, conversation_row.contact_id,
      conversation_row.id,
      case when target_qualification = 'qualified' then 'qualified' else 'new' end,
      case channel_row.channel_type when 'phone' then 'voice' else channel_row.channel_type end,
      case channel_row.channel_type when 'phone' then 'voice' else channel_row.channel_type end,
      nullif(btrim(target_service_category), ''), target_urgency, target_customer_goal, target_qualification,
      case when target_qualification = 'qualified' then now() else null end, inbound.id, incoming_details
    ) returning * into saved_lead;
    created := true;
    changed := true;
  else
    merged_details := active_lead.details;
    for detail_key, detail_value in select key, value from jsonb_each_text(incoming_details) loop
      if merged_details ->> detail_key is null then
        merged_details := merged_details || jsonb_build_object(detail_key, detail_value);
        changed := true;
      end if;
    end loop;
    update public.leads set
      service_category = coalesce(active_lead.service_category, nullif(btrim(target_service_category), '')),
      customer_goal = coalesce(active_lead.customer_goal, target_customer_goal),
      urgency = case when urgency_changed then target_urgency else active_lead.urgency end,
      details = merged_details,
      last_captured_message_id = inbound.id,
      qualification_reason = case when active_lead.status = 'new' then target_qualification else active_lead.qualification_reason end,
      status = case when active_lead.status = 'new' and target_qualification = 'qualified' then 'qualified' else active_lead.status end,
      qualified_at = case when active_lead.status = 'new' and target_qualification = 'qualified' then now() else active_lead.qualified_at end,
      updated_at = now()
    where id = active_lead.id and organization_id = active_lead.organization_id
    returning * into saved_lead;
    changed := changed
      or (active_lead.service_category is null and target_service_category is not null)
      or (active_lead.customer_goal is null and target_customer_goal is not null)
      or urgency_changed
      or (active_lead.status = 'new' and target_qualification = 'qualified');
  end if;

  -- Conflict is deliberately the first result-state decision, even for an already-qualified lead.
  if coalesce(array_length(conflicts, 1), 0) > 0 then
    result_state := 'needs_clarification';
  elsif target_qualification = 'needs_human' then
    result_state := 'needs_human';
  elsif saved_lead.status = 'qualified' then
    result_state := 'qualified';
  else
    result_state := 'needs_more_information';
    if saved_lead.service_category is null then missing := array_append(missing, 'service_category'); end if;
    if saved_lead.customer_goal is null then missing := array_append(missing, 'customer_goal'); end if;
  end if;

  insert into public.lead_capture_tool_calls (
    organization_id, location_id, conversation_id, inbound_message_id, tool_call_id, lead_id, result_state, missing_fields
  ) values (
    saved_lead.organization_id, saved_lead.location_id, conversation_row.id, inbound.id, target_tool_call_id,
    saved_lead.id, result_state, to_jsonb(missing)
  );

  if created then
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (saved_lead.organization_id, saved_lead.location_id, 'lead.created', 'lead', saved_lead.id,
      jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency));
    if saved_lead.status = 'qualified' then
      insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
      values (saved_lead.organization_id, saved_lead.location_id, 'lead.qualified', 'lead', saved_lead.id,
        jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency));
    end if;
  elsif changed then
    insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
    values (
      saved_lead.organization_id, saved_lead.location_id,
      case when saved_lead.status = 'qualified' and active_lead.status = 'new' then 'lead.qualified' else 'lead.updated' end,
      'lead', saved_lead.id, jsonb_build_object('source_channel', saved_lead.source_channel, 'urgency', saved_lead.urgency)
    );
  end if;
  return query select result_state, to_jsonb(missing);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Booking provider-write claim
-- ---------------------------------------------------------------------------------------------

create or replace function public.claim_conversation_scheduling_booking_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_booking_intent_id uuid, target_tool_call_id text)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; inbound public.messages%rowtype; candidate public.booking_candidates%rowtype; write_eligible boolean;
begin
  perform public.require_scheduling_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) = 0 or length(target_tool_call_id) > 200 then raise exception using errcode = '22023', message = 'Booking tool call is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents where id = target_booking_intent_id and conversation_id = target_conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'booking') then return query select case when intent.status = 'booking' then 'booking_recovery' else intent.status end, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  -- Phase 17: this transition is what authorizes a NEW provider write, so appointments
  -- entitlement is proven exactly here.  It runs AFTER the recovery branches above: an intent
  -- already in booking, provider_success_pending_persistence, or provider_state_unknown has
  -- crossed a provider boundary and must still be able to discover and persist its truth.  A
  -- blocked intent stays in awaiting_confirmation and never reaches 'booking', so the slot lease
  -- claim (which requires 'booking') cannot be taken and no lease is left stranded.
  if not public.billing_feature_available(intent.organization_id, 'appointments') then
    return query select 'billing_unavailable'::text, intent.id, null::uuid; return;
  end if;
  select * into candidate from public.booking_candidates where id = intent.candidate_id and organization_id = intent.organization_id and integration_id = intent.integration_id;
  if candidate.id is null or candidate.expires_at <= now() then update public.booking_intents set status = 'expired', updated_at = now() where id = intent.id; return query select 'expired'::text, intent.id, null::uuid; return; end if;
  select exists(select 1 from public.location_scheduling_settings settings join public.integrations integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id
    join public.scheduling_appointment_types appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
    join public.scheduling_resources resource on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id and resource.integration_id = intent.integration_id
    where settings.organization_id = intent.organization_id and settings.location_id = intent.location_id and settings.active_integration_id = intent.integration_id and integration.status = 'connected' and appointment_type.active and appointment_type.bookable and resource.active and resource.bookable
      and (integration.provider = 'ezyvet' or exists(select 1 from public.scheduling_appointment_type_resources mapping where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = resource.id))) into write_eligible;
  if not write_eligible then update public.booking_intents set failure_category = 'configuration_changed', updated_at = now() where id = intent.id; return query select 'configuration_changed'::text, intent.id, null::uuid; return; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and organization_id = intent.organization_id and location_id = intent.location_id and conversation_id = intent.conversation_id and direction = 'inbound' and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= intent.created_at or not public.is_explicit_booking_confirmation(inbound.body) then return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  update public.booking_intents set status = 'booking', booking_tool_call_id = target_tool_call_id, confirmed_message_id = inbound.id, failure_category = null, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Appointment reminders
-- ---------------------------------------------------------------------------------------------

-- A new outbound reminder needs both reminders and sms.  Entitlement is decided inside the due-
-- work claim, which is strictly before the provider revalidation read, before the customer SMS is
-- materialized, and before Twilio: a blocked reminder performs none of those.  'skipped' is
-- terminal for a reminder, so it is never re-claimed and never sends after billing recovers.
-- Existing stale, due, and freshness semantics are untouched.
create or replace function public.claim_due_appointment_reminders(target_worker_id text, target_limit integer default 4)
returns table (reminder_id uuid) language plpgsql security definer set search_path = '' as $$
declare claimed_ids uuid[];
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Reminder claim is invalid';
  end if;
  update public.appointment_reminders set status = case when message_id is not null then 'delivery_pending' when attempt_count >= 10 then 'failed' else 'scheduled' end,
    claimed_at = null, claimed_by = null,
    last_error_code = case when message_id is not null then last_error_code when attempt_count >= 10 then 'max_attempts_exhausted' else 'stale_claim_recovered' end,
    revalidation_status = case when message_id is not null then revalidation_status else 'pending' end, updated_at = now()
  where status = 'processing' and claimed_at < now() - interval '5 minutes';
  update public.appointment_reminders set status = 'failed', last_error_code = 'max_attempts_exhausted', updated_at = now()
  where status = 'scheduled' and attempt_count >= 10;

  with due as (
    select reminder.id from public.appointment_reminders reminder
    where reminder.status = 'scheduled' and reminder.attempt_count < 10 and reminder.scheduled_for <= now()
    order by reminder.scheduled_for asc for update skip locked limit target_limit
  ), claimed as (
    update public.appointment_reminders reminder set status = 'processing', attempt_count = reminder.attempt_count + 1,
      claimed_at = now(), claimed_by = btrim(target_worker_id), revalidation_status = 'pending', updated_at = now()
    from due where reminder.id = due.id returning reminder.id
  ) select array_agg(claimed.id) into claimed_ids from claimed;
  if claimed_ids is null then return; end if;

  update public.appointment_reminders reminder
  set status = 'skipped', last_error_code = 'billing_unavailable', claimed_at = null, claimed_by = null, updated_at = now()
  where reminder.id = any(claimed_ids)
    and not (
      public.billing_feature_available(reminder.organization_id, 'reminders')
      and public.billing_feature_available(reminder.organization_id, 'sms')
    );

  return query select reminder.id from public.appointment_reminders reminder
  where reminder.id = any(claimed_ids) and reminder.status = 'processing'
  order by reminder.scheduled_for asc;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Lead follow-ups
-- ---------------------------------------------------------------------------------------------

-- A follow-up needs both lead_followups and sms, in addition to everything Phase 11 already
-- requires.  Entitlement never replaces consent: this is an extra condition on top of the
-- existing eligibility rules, and billing reactivation neither reopens a suppressed follow-up nor
-- touches consent truth.  Suppression reuses the existing terminal helper, so a queued delivery
-- becomes a deliberate non-send and the job becomes skipped with a bounded reason.
create or replace function public.claim_lead_followup_jobs(target_worker_id text, target_limit integer default 10)
returns table (job_id uuid, message_id uuid) language plpgsql security definer set search_path = '' as $$
declare claimed_ids uuid[]; blocked_id uuid;
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id,''))) not between 1 and 160 or target_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'Follow-up claim is invalid';
  end if;
  perform public.recover_stale_lead_followup_submissions(least(target_limit, 50));

  with candidate as (
    select job.id from public.lead_followup_jobs job
    where (job.status = 'scheduled' and job.scheduled_for <= now())
      or job.status = 'delivery_pending'
      or (job.status = 'processing' and job.claimed_at <= now() - interval '5 minutes')
    order by coalesce(job.scheduled_for, job.created_at), job.created_at for update skip locked limit target_limit
  ), updated as (
    update public.lead_followup_jobs job set status = 'processing', claimed_at = now(), claimed_by = btrim(target_worker_id), updated_at = now()
    from candidate where job.id = candidate.id returning job.id
  ) select array_agg(updated.id) into claimed_ids from updated;
  if claimed_ids is null then return; end if;

  for blocked_id in
    select job.id from public.lead_followup_jobs job
    where job.id = any(claimed_ids)
      and not (
        public.billing_feature_available(job.organization_id, 'lead_followups')
        and public.billing_feature_available(job.organization_id, 'sms')
      )
  loop
    -- The existing terminal helper is reused deliberately.  It refuses to touch a delivery that
    -- has already left the queued state, so a follow-up whose SMS may already have reached Twilio
    -- keeps its ambiguous truth and is simply declined again at the submission claim below.
    perform public.suppress_lead_followup_job(blocked_id, 'billing_unavailable');
  end loop;

  return query select job.id, job.message_id from public.lead_followup_jobs job
  where job.id = any(claimed_ids) and job.status = 'processing'
  order by coalesce(job.scheduled_for, job.created_at), job.created_at;
end;
$$;

create or replace function public.claim_lead_followup_delivery(target_job_id uuid)
returns table (message_id uuid, to_e164 text, from_e164 text, body text)
language plpgsql security definer set search_path = '' as $$
declare
  job public.lead_followup_jobs%rowtype;
  delivery public.message_deliveries%rowtype;
  lead_row public.leads%rowtype;
  conversation_row public.conversations%rowtype;
  consent public.sms_consents%rowtype;
  sender public.phone_numbers%rowtype;
  message_row public.messages%rowtype;
  settings public.lead_followup_settings%rowtype;
  location_row public.locations%rowtype;
  next_allowed_at timestamptz;
begin
  perform public.require_messaging_service_role();
  select * into job from public.lead_followup_jobs where id = target_job_id for update;
  if job.id is null
    or job.status not in ('processing', 'delivery_pending')
    or job.message_id is null
    or job.delivery_id is null then
    return;
  end if;

  -- Phase 17: the last durable boundary before Twilio.  A follow-up needs lead_followups and sms;
  -- consent and every other Phase 11 condition below still apply independently.
  if not (
    public.billing_feature_available(job.organization_id, 'lead_followups')
    and public.billing_feature_available(job.organization_id, 'sms')
  ) then
    perform public.suppress_lead_followup_job(job.id, 'billing_unavailable');
    return;
  end if;

  select * into delivery from public.message_deliveries where id = job.delivery_id for update;
  select * into lead_row from public.leads where id = job.lead_id;
  select * into conversation_row from public.conversations where id = job.conversation_id;
  select * into consent from public.sms_consents
  where id = job.consent_id
    and status = 'active'
    and recipient_e164 = job.recipient_e164
    and sender_phone_number_id = job.sender_phone_number_id;
  select * into sender from public.phone_numbers
  where id = job.sender_phone_number_id
    and status = 'active'
    and sms_enabled;
  select * into message_row from public.messages where id = job.message_id;
  select * into settings from public.lead_followup_settings
  where organization_id = job.organization_id
    and location_id = job.location_id;
  select * into location_row from public.locations
  where organization_id = job.organization_id
    and id = job.location_id;

  if delivery.id is null
    or delivery.status <> 'queued'
    or not public.lead_followup_settings_sender_is_current(job.organization_id, job.location_id, job.sender_phone_number_id)
    or lead_row.id is null
    or lead_row.status not in ('new', 'qualified')
    or lead_row.urgency = 'urgent'
    or lead_row.qualification_reason = 'needs_human'
    or conversation_row.id is null
    or conversation_row.status <> 'open'
    or conversation_row.ai_mode <> 'ai'
    or consent.id is null
    or sender.id is null
    or sender.phone_number <> job.sender_e164
    or settings.id is null
    or location_row.id is null
    or exists (
      select 1 from public.handoffs handoff
      where handoff.organization_id = job.organization_id
        and handoff.conversation_id = job.conversation_id
        and handoff.status in ('open', 'acknowledged')
    )
    or exists (
      select 1 from public.appointments appointment
      where appointment.organization_id = job.organization_id
        and appointment.location_id = job.location_id
        and appointment.conversation_id = job.conversation_id
        and appointment.status = 'confirmed'
    )
    or exists (
      select 1 from public.booking_intents booking
      where booking.organization_id = job.organization_id
        and booking.location_id = job.location_id
        and booking.conversation_id = job.conversation_id
        and booking.status in ('awaiting_confirmation', 'booking', 'provider_success_pending_persistence', 'provider_state_unknown')
    )
    or exists (
      select 1 from public.appointment_change_intents change_intent
      where change_intent.organization_id = job.organization_id
        and change_intent.location_id = job.location_id
        and change_intent.conversation_id = job.conversation_id
        and change_intent.status in ('awaiting_confirmation', 'executing', 'provider_success_pending_persistence', 'provider_state_unknown', 'handoff_required')
    )
    or exists (
      select 1
      from public.messaging_contact_preferences preference
      join public.messages route_message
        on route_message.organization_id = preference.organization_id
        and route_message.location_id = preference.location_id
        and route_message.contact_id = preference.contact_id
        and route_message.transport_sender_e164 = job.recipient_e164
      where preference.organization_id = job.organization_id
        and preference.location_id = job.location_id
        and preference.sender_phone_number_id = job.sender_phone_number_id
        and preference.channel_type = 'sms'
        and preference.status = 'opted_out'
    )
    or exists (
      select 1
      from public.messages message
      where message.organization_id = job.organization_id
        and message.location_id = job.location_id
        and message.conversation_id = job.conversation_id
        and message.created_at > message_row.created_at
        and (
          message.author_type in ('customer', 'human')
          or (
            message.id <> job.message_id
            and message.direction = 'outbound'
            and message.source_channel = 'sms'
            and message.author_type in ('ai', 'system')
          )
        )
    ) then
    perform public.suppress_lead_followup_job(job.id, 'lead_followup_ineligible');
    return;
  end if;

  if not public.lead_followup_time_is_allowed(
    now(),
    location_row.timezone,
    settings.quiet_hours_start,
    settings.quiet_hours_end,
    location_row.business_hours,
    settings.business_hours_only
  ) then
    next_allowed_at := public.lead_followup_next_allowed_time(
      greatest(now(), coalesce(job.scheduled_for, now())),
      location_row.timezone,
      settings.quiet_hours_start,
      settings.quiet_hours_end,
      location_row.business_hours,
      settings.business_hours_only
    );
    if next_allowed_at is null then
      perform public.suppress_lead_followup_job(job.id, 'no_allowed_window');
    else
      update public.lead_followup_jobs
      set status = 'scheduled',
        scheduled_for = next_allowed_at,
        claimed_at = null,
        claimed_by = null,
        updated_at = now()
      where id = job.id;
    end if;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'lead-followup-frequency:' || job.organization_id::text || ':' || job.location_id::text || ':' || job.sender_phone_number_id::text || ':' || job.recipient_e164,
    0
  ));
  if exists (
    select 1
    from public.lead_followup_jobs existing_job
    join public.message_deliveries existing_delivery
      on existing_delivery.organization_id = existing_job.organization_id
      and existing_delivery.location_id = existing_job.location_id
      and existing_delivery.id = existing_job.delivery_id
    where existing_job.organization_id = job.organization_id
      and existing_job.location_id = job.location_id
      and existing_job.sender_phone_number_id = job.sender_phone_number_id
      and existing_job.recipient_e164 = job.recipient_e164
      and existing_job.id <> job.id
      and existing_delivery.attempted_at is not null
      and existing_delivery.attempted_at > now() - interval '24 hours'
      and existing_delivery.status <> 'suppressed'
  ) then
    perform public.suppress_lead_followup_job(job.id, 'frequency_cap');
    return;
  end if;

  update public.message_deliveries
  set status = 'submitting', attempted_at = now(), updated_at = now()
  where id = delivery.id
    and status = 'queued';
  if not found then
    return;
  end if;

  return query select message_row.id, job.recipient_e164, job.sender_e164, message_row.body;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Customer-facing automated scheduling
-- ---------------------------------------------------------------------------------------------

-- Availability discovery is the step that would call Google Calendar or ezyVet for a NEW customer
-- request, so the scheduling context stops resolving when appointments entitlement is
-- unavailable.  The agent then simply has no scheduling capability for that conversation and
-- returns its ordinary unavailable answer, with no billing detail reaching the model or the
-- customer.  Recovery and persistence read the booking execution context instead, which is
-- deliberately not gated here.
create or replace function public.get_voice_scheduling_context(target_call_id text)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, caller_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select call.organization_id, call.location_id, call.conversation_id, call.contact_id,
    call.transport_caller_e164, nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''),
    integration.id, integration.provider, location.timezone, location.business_hours, settings.minimum_lead_minutes
  from public.calls as call
  join public.locations as location on location.organization_id = call.organization_id and location.id = call.location_id
  join public.location_scheduling_settings as settings on settings.organization_id = call.organization_id and settings.location_id = call.location_id
  join public.integrations as integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id and integration.status = 'connected'
  left join public.contacts as contact on contact.organization_id = call.organization_id and contact.id = call.contact_id
  where call.provider = 'openai-realtime-sip' and call.external_call_id = target_call_id
    and public.billing_feature_available(call.organization_id, 'appointments');
end;
$$;

create or replace function public.get_conversation_scheduling_context(target_conversation_id uuid)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, trusted_transport_phone_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer, channel_type text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select conversation.organization_id, conversation.location_id, conversation.id, conversation.contact_id,
    null::text, nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), integration.id, integration.provider,
    location.timezone, location.business_hours, settings.minimum_lead_minutes, channel.channel_type
  from public.conversations conversation
  join public.locations location on location.organization_id = conversation.organization_id and location.id = conversation.location_id
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  join public.location_scheduling_settings settings on settings.organization_id = conversation.organization_id and settings.location_id = conversation.location_id
  join public.integrations integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id and integration.status = 'connected'
  left join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  where conversation.id = target_conversation_id and conversation.mode = 'customer'
    and public.billing_feature_available(conversation.organization_id, 'appointments');
end;
$$;

create or replace function public.get_conversation_scheduling_context(target_conversation_id uuid, target_inbound_message_id uuid)
returns table (organization_id uuid, location_id uuid, conversation_id uuid, contact_id uuid, trusted_transport_phone_e164 text, contact_display_name text, integration_id uuid, provider text, timezone text, business_hours jsonb, minimum_lead_minutes integer, channel_type text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query
  select conversation.organization_id, conversation.location_id, conversation.id, conversation.contact_id,
    case
      when channel.channel_type = 'sms' then inbound.transport_sender_e164
      when channel.channel_type = 'phone' then voice_call.transport_caller_e164
      else null
    end,
    nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), integration.id, integration.provider,
    location.timezone, location.business_hours, settings.minimum_lead_minutes, channel.channel_type
  from public.conversations conversation
  join public.locations location on location.organization_id = conversation.organization_id and location.id = conversation.location_id
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  join public.location_scheduling_settings settings on settings.organization_id = conversation.organization_id and settings.location_id = conversation.location_id
  join public.integrations integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id and integration.status = 'connected'
  left join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  left join public.messages inbound on inbound.organization_id = conversation.organization_id
    and inbound.conversation_id = conversation.id and inbound.id = target_inbound_message_id
    and inbound.direction = 'inbound' and inbound.author_type = 'customer' and inbound.source_channel = 'sms'
  left join lateral (
    select call.transport_caller_e164
    from public.calls call
    where call.organization_id = conversation.organization_id and call.conversation_id = conversation.id
      and call.direction = 'inbound' and call.provider = 'openai-realtime-sip'
    order by call.created_at desc, call.id desc limit 1
  ) voice_call on channel.channel_type = 'phone'
  where conversation.id = target_conversation_id and conversation.mode = 'customer'
    and public.billing_feature_available(conversation.organization_id, 'appointments');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Inbound voice bootstrap
-- ---------------------------------------------------------------------------------------------

-- Records a provider event that is declined for billing, with the same idempotency guarantees the
-- ordinary bootstrap has and without creating any customer runtime state.  A replay of the same
-- event stays a duplicate forever, so reactivating billing can never resurrect an old call; a NEW
-- provider event after reactivation takes the ordinary path and works.
create function public.reject_inbound_voice_call_for_billing(
  target_event_id text,
  target_event_type text,
  target_external_call_id text,
  target_organization_id uuid,
  target_location_id uuid
)
returns table (is_duplicate boolean, accepted boolean)
language plpgsql security definer set search_path = '' as $$
declare existing public.voice_webhook_events%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_external_call_id, 0)
  );
  select * into existing from public.voice_webhook_events where event_id = target_event_id;
  if existing.event_id is not null then
    return query select true, false; return;
  end if;
  select * into existing from public.voice_webhook_events
  where event_type = target_event_type and external_call_id = target_external_call_id;
  if existing.event_id is not null then
    return query select true, false; return;
  end if;
  insert into public.voice_webhook_events (
    event_id, event_type, external_call_id, organization_id, location_id,
    status, rejection_reason, processed_at
  ) values (
    target_event_id, target_event_type, target_external_call_id, target_organization_id,
    target_location_id, 'rejected', 'billing_unavailable', now()
  ) on conflict do nothing;
  if not found then
    return query select true, false; return;
  end if;
  return query select false, false;
end;
$$;

-- Voice entitlement is enforced in the trusted inbound bootstrap, before Avenlyo accepts the
-- provider call and therefore before any Realtime session, transcript, lead, booking, or handoff
-- automation exists.  The route already declines a call it did not accept, so no application
-- change is required for the model session never to start.
--
-- The routing predicate mirrors the ordinary bootstrap's, so this branch only fires for a number
-- the owner has actually configured and enabled for voice: an unconfigured number still falls
-- through to the ordinary rejection rather than being labelled a billing problem.
create or replace function public.bootstrap_inbound_voice_call(
  target_event_id text,
  target_event_type text,
  target_external_call_id text,
  target_sip_call_id text,
  target_dialed_e164 text,
  target_caller_e164 text default null
)
returns table (
  is_duplicate boolean, accepted boolean, call_record_id uuid, conversation_id uuid, contact_id uuid,
  organization_id uuid, location_id uuid, phone_number_id uuid, primary_industry_id text,
  organization_name text, business_phone text, website_url text, location_name text,
  location_timezone text, location_address jsonb, business_hours jsonb, voice text,
  transfer_enabled boolean, provider_transfer_enabled boolean, transfer_target_e164 text
)
language plpgsql security definer set search_path = '' as $$
declare routed record; rejection record;
begin
  perform public.require_voice_service_role();
  perform set_config(
    'avenlyo.trusted_voice_caller_e164',
    case when target_caller_e164 ~ E'^\\+[1-9][0-9]{7,14}$' then target_caller_e164 else '' end,
    true
  );

  select number.organization_id as routed_organization_id, number.location_id as routed_location_id
  into routed
  from public.phone_numbers as number
  join public.voice_configurations as configuration
    on configuration.organization_id = number.organization_id
   and configuration.location_id = number.location_id
  join public.organizations as organization on organization.id = number.organization_id
  join public.locations as location
    on location.organization_id = number.organization_id and location.id = number.location_id
  where number.provider = 'twilio'
    and number.status = 'active'
    and number.phone_number = target_dialed_e164
    and configuration.enabled
    and organization.primary_industry_id in ('veterinary', 'auto-repair', 'medspa');

  if routed.routed_organization_id is not null
    and not public.billing_feature_available(routed.routed_organization_id, 'voice') then
    select * into rejection from public.reject_inbound_voice_call_for_billing(
      target_event_id, target_event_type, target_external_call_id,
      routed.routed_organization_id, routed.routed_location_id
    );
    return query select rejection.is_duplicate, rejection.accepted, null::uuid, null::uuid, null::uuid,
      null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::jsonb, null::jsonb, null::text, false, false, null::text;
    return;
  end if;

  return query select * from public.bootstrap_inbound_voice_call_legacy(
    target_event_id, target_event_type, target_external_call_id, target_sip_call_id,
    target_dialed_e164, target_caller_e164
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Operational snapshot
-- ---------------------------------------------------------------------------------------------

-- Rebased on the Phase 14 runtime hardening definition, not the original Phase 14 one: freshness,
-- not merely the absence of stopped_at, decides whether a process counts as a live replica.
create or replace function public.get_platform_operational_snapshot()
returns table (metric_group text, metric text, value bigint, oldest_at timestamptz, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare stale_after interval := public.runtime_heartbeat_stale_after();
begin
  perform public.require_platform_service_role();

  return query
  -- Runtime liveness, in three mutually exclusive states.  A running process is not stopped and is
  -- still reporting; a stale one is not stopped and has gone silent; a stopped one exited on
  -- purpose and is neither of the first two.
  select 'runtime'::text, 'active_instances'::text,
    count(*) filter (
      where instance.stopped_at is null and instance.last_heartbeat_at >= now() - stale_after
    )::bigint,
    min(instance.started_at) filter (
      where instance.stopped_at is null and instance.last_heartbeat_at >= now() - stale_after
    ),
    null::text
  from public.runtime_instances instance
  union all
  select 'runtime'::text, 'stale_instances'::text,
    count(*) filter (
      where instance.stopped_at is null and instance.last_heartbeat_at < now() - stale_after
    )::bigint,
    min(instance.last_heartbeat_at) filter (
      where instance.stopped_at is null and instance.last_heartbeat_at < now() - stale_after
    ),
    null::text
  from public.runtime_instances instance
  union all
  select 'runtime'::text, 'stopped_instances'::text,
    count(*) filter (where instance.stopped_at is not null)::bigint,
    min(instance.stopped_at) filter (where instance.stopped_at is not null),
    null::text
  from public.runtime_instances instance
  union all
  select 'runtime'::text, 'release'::text, count(*)::bigint, min(instance.started_at), instance.release
  from public.runtime_instances instance
  where instance.stopped_at is null and instance.last_heartbeat_at >= now() - stale_after
  group by instance.release
  union all
  select 'runtime_component'::text, heartbeat.component, count(*)::bigint,
    min(heartbeat.last_success_at), heartbeat.state
  from public.runtime_component_heartbeats heartbeat
  join public.runtime_instances instance on instance.instance_id = heartbeat.instance_id
  where instance.stopped_at is null and instance.last_heartbeat_at >= now() - stale_after
  group by heartbeat.component, heartbeat.state

  -- Message processing jobs.
  union all
  select 'message_jobs'::text, job.status, count(*)::bigint, min(job.created_at), null::text
  from public.message_processing_jobs job
  where job.status in ('queued', 'processing', 'failed')
  group by job.status
  union all
  select 'message_jobs'::text, 'expired_lease'::text, count(*)::bigint, min(job.claimed_at), null::text
  from public.message_processing_jobs job
  where job.status = 'processing' and job.claimed_at < now() - interval '5 minutes'

  -- Durable SMS delivery truth.  Nothing here changes a provider status.
  union all
  select 'sms_delivery'::text, delivery.status, count(*)::bigint, min(delivery.updated_at), null::text
  from public.message_deliveries delivery
  where delivery.status in ('queued', 'submitting', 'unknown', 'failed', 'undelivered')
  group by delivery.status

  -- Reminders.  Work scheduled for the future is reported separately and is never backlog.
  union all
  select 'reminders'::text, 'due'::text, count(*)::bigint, min(reminder.scheduled_for), null::text
  from public.appointment_reminders reminder
  where reminder.status = 'scheduled' and reminder.scheduled_for <= now()
  union all
  select 'reminders'::text, 'scheduled_future'::text, count(*)::bigint, min(reminder.scheduled_for), null::text
  from public.appointment_reminders reminder
  where reminder.status = 'scheduled' and reminder.scheduled_for > now()
  union all
  select 'reminders'::text, reminder.status, count(*)::bigint, min(reminder.updated_at), null::text
  from public.appointment_reminders reminder
  where reminder.status in ('processing', 'delivery_pending', 'failed')
  group by reminder.status

  -- Lead follow-ups.  Suppressed work is visible but is never reopened by reading it.
  union all
  select 'lead_followups'::text, 'due'::text, count(*)::bigint, min(job.scheduled_for), null::text
  from public.lead_followup_jobs job
  where job.status = 'scheduled' and job.scheduled_for <= now()
  union all
  select 'lead_followups'::text, 'scheduled_future'::text, count(*)::bigint, min(job.scheduled_for), null::text
  from public.lead_followup_jobs job
  where job.status = 'scheduled' and job.scheduled_for > now()
  union all
  select 'lead_followups'::text, job.status, count(*)::bigint, min(job.updated_at), null::text
  from public.lead_followup_jobs job
  where job.status in ('processing', 'delivery_pending', 'failed', 'skipped')
  group by job.status

  -- Stripe webhook worker.  No Stripe identifier is exposed.
  union all
  select 'billing_events'::text, event.status, count(*)::bigint, min(event.received_at), null::text
  from public.stripe_webhook_events event
  where event.status in ('pending', 'processing', 'failed')
  group by event.status

  -- Ambiguous provider write truth.  Reading it never reconciles or invents a provider outcome.
  union all
  select 'booking_intents'::text, 'provider_state_unknown'::text, count(*)::bigint,
    min(intent.updated_at), null::text
  from public.booking_intents intent
  where intent.status = 'provider_state_unknown'
  union all
  select 'appointment_change_intents'::text, intent.status, count(*)::bigint,
    min(intent.updated_at), null::text
  from public.appointment_change_intents intent
  where intent.status in ('provider_state_unknown', 'provider_success_pending_persistence', 'handoff_required')
  group by intent.status

  -- Phase 17 billing suppression.  These are global counts of deliberately declined work and are
  -- a business-state diagnostic, not a failure signal: a non-zero value never means the process,
  -- the database, or a provider is unhealthy.  No organization, location, customer, phone number,
  -- or message reaches this snapshot.
  union all
  select 'billing_suppression'::text, 'message_jobs'::text, count(*)::bigint, min(job.updated_at), null::text
  from public.message_processing_jobs job
  where job.status = 'suppressed' and job.last_error_code = 'billing_unavailable'
  union all
  select 'billing_suppression'::text, 'sms_deliveries'::text, count(*)::bigint, min(delivery.updated_at), null::text
  from public.message_deliveries delivery
  where delivery.status = 'suppressed' and delivery.error_code = 'billing_unavailable'
  union all
  select 'billing_suppression'::text, 'reminders'::text, count(*)::bigint, min(reminder.updated_at), null::text
  from public.appointment_reminders reminder
  where reminder.status = 'skipped' and reminder.last_error_code = 'billing_unavailable'
  union all
  select 'billing_suppression'::text, 'lead_followups'::text, count(*)::bigint, min(job.updated_at), null::text
  from public.lead_followup_jobs job
  where job.status = 'skipped' and job.skip_reason = 'billing_unavailable'
  union all
  select 'billing_suppression'::text, 'voice_rejections'::text, count(*)::bigint, min(event.created_at), null::text
  from public.voice_webhook_events event
  where event.rejection_reason = 'billing_unavailable';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Multi-organization billing actions
-- ---------------------------------------------------------------------------------------------

-- Phase 12 inferred the billing organization from "the caller is owner or admin in exactly one
-- organization".  Phase 15 made multi-organization membership legitimate, so that inference is now
-- wrong: an owner of A who also administers B could not reach billing at all.  Every billing
-- action now takes an explicit organization and the database re-verifies admin authority on it,
-- so the selected workspace decides which billing account is acted on and a guessed identifier
-- from another organization is simply denied.
drop function public.begin_my_billing_checkout(text);
drop function public.begin_my_billing_portal();
drop function public.begin_my_billing_refresh();
drop function public.my_billing_admin_organization();

create function public.begin_my_billing_checkout(
  target_organization_id uuid,
  target_plan_key text default 'core'
)
returns table (checkout_id uuid, action text)
language plpgsql security definer set search_path = '' as $$
declare existing_checkout public.billing_checkout_sessions%rowtype;
begin
  if target_plan_key <> 'core' then
    raise exception using errcode = '22023', message = 'Billing plan is unavailable';
  end if;
  perform public.require_my_billing_admin(target_organization_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('billing-checkout:' || target_organization_id::text, 0)
  );
  insert into public.billing_accounts (organization_id)
  values (target_organization_id)
  on conflict (organization_id) do nothing;
  if exists (
    select 1
    from public.billing_checkout_sessions checkout
    where checkout.organization_id = target_organization_id
      and checkout.status = 'created'
      and checkout.stripe_subscription_id is not null
  ) then
    return query select null::uuid, 'manage_existing_subscription';
    return;
  end if;
  if exists (
    select 1
    from public.billing_subscriptions subscription
    where subscription.organization_id = target_organization_id
      and public.billing_subscription_is_current(subscription.stripe_status)
  ) then
    return query select null::uuid, 'manage_existing_subscription';
    return;
  end if;
  select * into existing_checkout
  from public.billing_checkout_sessions checkout
  where checkout.organization_id = target_organization_id
    and checkout.plan_key = target_plan_key
    and checkout.status = 'created'
  for update;
  if existing_checkout.id is not null
    and existing_checkout.expires_at is not null
    and existing_checkout.expires_at <= now() then
    update public.billing_checkout_sessions
    set status = 'expired', updated_at = now()
    where id = existing_checkout.id;
    existing_checkout := null;
  end if;
  if existing_checkout.id is null then
    insert into public.billing_checkout_sessions (organization_id, plan_key, idempotency_key, created_by)
    values (
      target_organization_id,
      target_plan_key,
      'avenlyo:billing-checkout:' || target_organization_id::text || ':' || extensions.gen_random_uuid()::text,
      auth.uid()
    ) returning * into existing_checkout;
    perform public.write_billing_audit(
      target_organization_id,
      'billing.checkout.created',
      'billing_checkout_session',
      existing_checkout.id,
      '{}'
    );
  end if;
  return query select existing_checkout.id, 'create_checkout';
end;
$$;

create function public.begin_my_billing_portal(target_organization_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare account_row public.billing_accounts%rowtype;
begin
  perform public.require_my_billing_admin(target_organization_id);
  select * into account_row
  from public.billing_accounts
  where organization_id = target_organization_id;
  if account_row.id is null
    or account_row.stripe_customer_id is null
    or not exists (
      select 1 from public.billing_subscriptions subscription
      where subscription.organization_id = target_organization_id
        and public.billing_subscription_is_current(subscription.stripe_status)
    ) then
    raise exception using errcode = '42501', message = 'Billing portal is unavailable';
  end if;
  return account_row.id;
end;
$$;

create function public.begin_my_billing_refresh(target_organization_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare account_id uuid;
begin
  perform public.require_my_billing_admin(target_organization_id);
  select id into account_id from public.billing_accounts
  where organization_id = target_organization_id and stripe_customer_id is not null;
  if account_id is null then
    raise exception using errcode = '42501', message = 'Billing is unavailable';
  end if;
  return account_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Billing execution summary for the product surface
-- ---------------------------------------------------------------------------------------------

-- What the dashboard needs in order to say "automation is paused" honestly, and nothing more.
-- Any authorized member of the organization may read it, because a member who cannot send a reply
-- deserves to know why.  It returns bounded product facts only: no Stripe customer, subscription,
-- product, or price identifier, and no webhook state.  can_manage_billing is included so the
-- surface can decide between a link to Billing and neutral wording, not as an authorization.
create function public.get_my_billing_execution_summary(target_organization_id uuid)
returns table (
  automation_available boolean,
  billing_state text,
  can_manage_billing boolean,
  voice boolean,
  sms boolean,
  web_chat boolean,
  appointments boolean,
  lead_capture boolean,
  reminders boolean,
  lead_followups boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare resolved_state text; every_feature_available boolean;
begin
  if target_organization_id is null or not public.is_organization_member(target_organization_id) then
    raise exception using errcode = '42501', message = 'Organization access is required';
  end if;
  select account.billing_state into resolved_state
  from public.billing_accounts account
  where account.organization_id = target_organization_id;
  resolved_state := coalesce(resolved_state, 'unconfigured');
  -- Core is one subscription, so every feature answers together.  Deriving the headline from the
  -- whole catalogue keeps that true by construction instead of by picking a representative.
  select coalesce(bool_and(public.billing_feature_available(target_organization_id, catalogue.feature)), false)
  into every_feature_available
  from public.billing_core_features catalogue;
  return query select
    every_feature_available,
    resolved_state,
    public.is_organization_admin(target_organization_id),
    public.billing_feature_available(target_organization_id, 'voice'),
    public.billing_feature_available(target_organization_id, 'sms'),
    public.billing_feature_available(target_organization_id, 'web_chat'),
    public.billing_feature_available(target_organization_id, 'appointments'),
    public.billing_feature_available(target_organization_id, 'lead_capture'),
    public.billing_feature_available(target_organization_id, 'reminders'),
    public.billing_feature_available(target_organization_id, 'lead_followups');
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Operational aggregation support
-- ---------------------------------------------------------------------------------------------

-- Narrow partial indexes for the suppression aggregates.  They index status and a timestamp only;
-- nothing here indexes customer or message text.
create index message_processing_jobs_suppressed_idx
  on public.message_processing_jobs (updated_at)
  where status = 'suppressed';
create index message_deliveries_suppressed_idx
  on public.message_deliveries (updated_at)
  where status = 'suppressed';
create index appointment_reminders_skipped_idx
  on public.appointment_reminders (updated_at)
  where status = 'skipped';
create index lead_followup_jobs_skipped_idx
  on public.lead_followup_jobs (updated_at)
  where status = 'skipped';
create index voice_webhook_events_rejection_reason_idx
  on public.voice_webhook_events (created_at)
  where rejection_reason is not null;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

-- Entitlement helpers are shared implementation, not a callable boundary.  Nothing invokes them
-- directly: every caller reaches them through the RPC that already owns its workflow, so a
-- service-role worker cannot ask for an entitlement override and a browser cannot ask at all.
-- Provider or service identity proves a caller may perform backend work; it never proves the
-- organization may consume a paid product feature.
revoke all on function
  public.billing_feature_available(uuid, text),
  public.billing_conversation_feature(uuid),
  public.billing_message_job_blocked(uuid),
  public.billing_sms_compliance_exempt(uuid),
  public.sms_consent_keyword(text, text),
  public.reject_inbound_voice_call_for_billing(text, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Owner/admin billing actions stay browser-callable; the database still proves admin authority on
-- the exact organization supplied.  The execution summary is readable by any authorized member.
revoke all on function
  public.begin_my_billing_checkout(uuid, text),
  public.begin_my_billing_portal(uuid),
  public.begin_my_billing_refresh(uuid),
  public.get_my_billing_execution_summary(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.begin_my_billing_checkout(uuid, text),
  public.begin_my_billing_portal(uuid),
  public.begin_my_billing_refresh(uuid),
  public.get_my_billing_execution_summary(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Schema compatibility
-- ---------------------------------------------------------------------------------------------

-- The Phase 17 application depends on the entitlement and suppression contracts above.  Readiness
-- keeps its >= comparison, so a database migrated ahead of a release still serves traffic.
update public.platform_schema_contract
set schema_version = 17, updated_at = now()
where id;

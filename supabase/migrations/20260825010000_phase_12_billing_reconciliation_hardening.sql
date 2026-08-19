-- Phase 12 follow-up: subscription topology is distinct from service state. Provider snapshots
-- are applied atomically so no intermediate subscription projection can publish account state.

alter table public.billing_checkout_sessions
  add column if not exists stripe_subscription_id text;

create unique index if not exists billing_checkout_sessions_stripe_subscription_id_key
  on public.billing_checkout_sessions (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- This is the sole database classifier used for checkout guarding, snapshot reconciliation,
-- dashboard capabilities, and missing-subscription handling. Unknown future Stripe statuses are
-- deliberately neither silently terminal nor silently serviceable.
create or replace function public.billing_subscription_topology(target_status text)
returns text language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(target_status, '')))
    when 'active' then 'current'
    when 'trialing' then 'current'
    when 'past_due' then 'current'
    when 'incomplete' then 'current'
    when 'unpaid' then 'current'
    when 'paused' then 'current'
    when 'canceled' then 'terminal'
    when 'cancelled' then 'terminal'
    when 'incomplete_expired' then 'terminal'
    when 'ended' then 'terminal'
    else 'unknown'
  end;
$$;

create or replace function public.billing_subscription_is_terminal(target_status text)
returns boolean language sql immutable set search_path = '' as $$
  select public.billing_subscription_topology(target_status) = 'terminal';
$$;

-- Unknown provider statuses still block a new Checkout attempt. They may be an extant Stripe
-- subscription, but need human review before their service semantics are understood.
create function public.billing_subscription_is_current(target_status text)
returns boolean language sql immutable set search_path = '' as $$
  select public.billing_subscription_topology(target_status) <> 'terminal';
$$;

create or replace function public.recalculate_billing_account_state(target_organization_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  account_row public.billing_accounts%rowtype;
  next_state text;
  previous_state text;
  blocking_count integer;
  unknown_count integer;
  unsupported_current_count integer;
  sole_status text;
begin
  select * into account_row
  from public.billing_accounts
  where organization_id = target_organization_id
  for update;
  if account_row.id is null then
    raise exception using errcode = '42501', message = 'Billing account is unavailable';
  end if;

  previous_state := account_row.billing_state;
  select
    count(*),
    count(*) filter (where public.billing_subscription_topology(subscription.stripe_status) = 'unknown'),
    count(*) filter (
      where public.billing_subscription_topology(subscription.stripe_status) = 'current'
        and not subscription.is_supported
    )
  into blocking_count, unknown_count, unsupported_current_count
  from public.billing_subscriptions subscription
  where subscription.organization_id = target_organization_id
    and public.billing_subscription_is_current(subscription.stripe_status);

  select lower(btrim(subscription.stripe_status)) into sole_status
  from public.billing_subscriptions subscription
  where subscription.organization_id = target_organization_id
    and public.billing_subscription_is_current(subscription.stripe_status)
  order by subscription.last_provider_sync_at desc
  limit 1;

  if unknown_count > 0 or unsupported_current_count > 0 or blocking_count > 1 then
    next_state := 'review_required';
  elsif blocking_count = 1 and sole_status in ('active', 'trialing') then
    next_state := 'active';
  elsif blocking_count = 1 and sole_status = 'past_due' then
    next_state := 'attention';
  elsif blocking_count = 1 and sole_status in ('incomplete', 'unpaid', 'paused') then
    next_state := 'inactive';
  elsif exists (
    select 1 from public.billing_subscriptions subscription
    where subscription.organization_id = target_organization_id
  ) then
    -- Historical terminal rows remain useful audit history but never affect an active topology.
    next_state := 'inactive';
  else
    next_state := 'unconfigured';
  end if;

  update public.billing_accounts
  set billing_state = next_state,
      billing_attention = next_state = 'attention',
      last_synced_at = now(),
      updated_at = now()
  where id = account_row.id;

  if previous_state is distinct from next_state then
    perform public.write_billing_audit(
      target_organization_id,
      case
        when next_state = 'active' then 'billing.subscription.activated'
        when next_state = 'attention' then 'billing.payment_attention'
        when next_state = 'inactive' then 'billing.subscription.ended'
        else 'billing.subscription.status_changed'
      end,
      'billing_account',
      account_row.id,
      jsonb_build_object('state', next_state)
    );
  end if;
  return next_state;
end;
$$;

-- The old single-subscription projection RPCs remain only for migration compatibility. New
-- provider code can apply state exclusively through this full, bounded snapshot operation.
create function public.apply_stripe_billing_snapshot(
  target_organization_id uuid,
  target_customer_id text,
  target_livemode boolean,
  target_subscriptions jsonb,
  target_snapshot_complete boolean
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  account_row public.billing_accounts%rowtype;
  existing_subscription public.billing_subscriptions%rowtype;
  snapshot_subscription record;
  saved_subscription_id uuid;
  snapshot_subscription_id text;
  snapshot_status text;
  observed_subscription_ids text[] := '{}'::text[];
  next_state text;
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_customer_id, ''))) not between 3 and 255
    or target_livemode is null
    or target_snapshot_complete is null
    or jsonb_typeof(target_subscriptions) <> 'array'
    or jsonb_array_length(target_subscriptions) > 500 then
    raise exception using errcode = '22023', message = 'Stripe billing snapshot is invalid';
  end if;
  if not target_snapshot_complete and jsonb_array_length(target_subscriptions) <> 1 then
    raise exception using errcode = '22023', message = 'Stripe fallback snapshot is invalid';
  end if;

  select * into account_row
  from public.billing_accounts
  where organization_id = target_organization_id
  for update;
  if account_row.id is null
    or account_row.stripe_customer_id <> target_customer_id
    or account_row.livemode is distinct from target_livemode then
    raise exception using errcode = '42501', message = 'Stripe billing customer is unavailable';
  end if;

  for snapshot_subscription in
    select *
    from jsonb_to_recordset(target_subscriptions) as value(
      subscription_id text,
      product_id text,
      price_id text,
      plan_key text,
      is_supported boolean,
      stripe_status text,
      cancel_at_period_end boolean,
      period_start timestamptz,
      period_end timestamptz,
      trial_end timestamptz,
      ended_at timestamptz
    )
  loop
    snapshot_subscription_id := btrim(coalesce(snapshot_subscription.subscription_id, ''));
    snapshot_status := btrim(coalesce(snapshot_subscription.stripe_status, ''));
    if length(snapshot_subscription_id) not between 3 and 255
      or length(snapshot_status) not between 1 and 120
      or snapshot_subscription.is_supported is null
      or snapshot_subscription.cancel_at_period_end is null
      or snapshot_subscription_id = any(observed_subscription_ids) then
      raise exception using errcode = '22023', message = 'Stripe billing snapshot is invalid';
    end if;
    if snapshot_subscription.is_supported and (
      snapshot_subscription.plan_key <> 'core'
      or nullif(btrim(coalesce(snapshot_subscription.product_id, '')), '') is null
      or nullif(btrim(coalesce(snapshot_subscription.price_id, '')), '') is null
    ) then
      raise exception using errcode = '22023', message = 'Stripe billing snapshot plan is invalid';
    end if;
    if not snapshot_subscription.is_supported and snapshot_subscription.plan_key is not null then
      raise exception using errcode = '22023', message = 'Stripe billing snapshot plan is invalid';
    end if;
    if not target_snapshot_complete
      and not public.billing_subscription_is_terminal(snapshot_status) then
      raise exception using errcode = '22023', message = 'Stripe fallback subscription must be terminal';
    end if;

    select * into existing_subscription
    from public.billing_subscriptions
    where stripe_subscription_id = snapshot_subscription_id
    for update;
    if existing_subscription.id is not null
      and existing_subscription.organization_id <> target_organization_id then
      raise exception using errcode = '42501', message = 'Stripe subscription ownership conflicts';
    end if;

    insert into public.billing_subscriptions (
      organization_id,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_product_id,
      stripe_price_id,
      plan_key,
      is_supported,
      stripe_status,
      cancel_at_period_end,
      current_period_start,
      current_period_end,
      trial_end,
      ended_at,
      livemode,
      last_provider_sync_at
    ) values (
      target_organization_id,
      target_customer_id,
      snapshot_subscription_id,
      nullif(btrim(coalesce(snapshot_subscription.product_id, '')), ''),
      nullif(btrim(coalesce(snapshot_subscription.price_id, '')), ''),
      case when snapshot_subscription.is_supported then 'core' else null end,
      snapshot_subscription.is_supported,
      snapshot_status,
      snapshot_subscription.cancel_at_period_end,
      snapshot_subscription.period_start,
      snapshot_subscription.period_end,
      snapshot_subscription.trial_end,
      snapshot_subscription.ended_at,
      target_livemode,
      now()
    ) on conflict (stripe_subscription_id) do update set
      stripe_product_id = excluded.stripe_product_id,
      stripe_price_id = excluded.stripe_price_id,
      plan_key = excluded.plan_key,
      is_supported = excluded.is_supported,
      stripe_status = excluded.stripe_status,
      cancel_at_period_end = excluded.cancel_at_period_end,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      trial_end = excluded.trial_end,
      ended_at = excluded.ended_at,
      livemode = excluded.livemode,
      last_provider_sync_at = excluded.last_provider_sync_at,
      updated_at = now()
    returning id into saved_subscription_id;

    if snapshot_subscription.cancel_at_period_end
      and (existing_subscription.id is null or not existing_subscription.cancel_at_period_end) then
      perform public.write_billing_audit(
        target_organization_id,
        'billing.subscription.cancel_scheduled',
        'billing_subscription',
        saved_subscription_id,
        '{}'::jsonb
      );
    end if;
    observed_subscription_ids := array_append(observed_subscription_ids, snapshot_subscription_id);
  end loop;

  if target_snapshot_complete then
    update public.billing_subscriptions
    set stripe_status = 'canceled',
        ended_at = coalesce(ended_at, now()),
        last_provider_sync_at = now(),
        updated_at = now()
    where organization_id = target_organization_id
      and stripe_customer_id = target_customer_id
      and public.billing_subscription_is_current(stripe_status)
      and not (stripe_subscription_id = any(observed_subscription_ids));
  end if;

  next_state := public.recalculate_billing_account_state(target_organization_id);
  perform public.write_billing_audit(
    target_organization_id,
    'billing.reconciled',
    'billing_account',
    account_row.id,
    jsonb_build_object('state', next_state)
  );
  return next_state;
end;
$$;

create or replace function public.begin_my_billing_portal()
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_organization_id uuid; account_row public.billing_accounts%rowtype;
begin
  target_organization_id := public.my_billing_admin_organization();
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

create function public.record_billing_portal_opened(target_account_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare account_row public.billing_accounts%rowtype;
begin
  perform public.require_billing_service_role();
  select * into account_row
  from public.billing_accounts
  where id = target_account_id and stripe_customer_id is not null
  for update;
  if account_row.id is null then
    raise exception using errcode = '42501', message = 'Billing portal is unavailable';
  end if;
  perform public.write_billing_audit(
    account_row.organization_id,
    'billing.portal.opened',
    'billing_account',
    account_row.id,
    '{}'::jsonb
  );
end;
$$;

create function public.get_billing_checkout_event_context(
  target_session_id text,
  target_customer_id text,
  target_subscription_id text,
  target_livemode boolean
)
returns table (organization_id uuid, stripe_customer_id text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  return query
  select checkout.organization_id, account.stripe_customer_id
  from public.billing_checkout_sessions checkout
  join public.billing_accounts account on account.organization_id = checkout.organization_id
  where checkout.stripe_checkout_session_id = target_session_id
    and checkout.status in ('created', 'completed')
    and checkout.stripe_customer_id = target_customer_id
    and account.stripe_customer_id = target_customer_id
    and account.livemode is not distinct from target_livemode
    and (checkout.stripe_subscription_id is null or checkout.stripe_subscription_id = target_subscription_id);
end;
$$;

create or replace function public.complete_billing_checkout_from_event(
  target_session_id text,
  target_customer_id text,
  target_subscription_id text,
  target_livemode boolean
)
returns table (organization_id uuid, stripe_customer_id text, stripe_subscription_id text)
language plpgsql security definer set search_path = '' as $$
declare checkout_row public.billing_checkout_sessions%rowtype; account_row public.billing_accounts%rowtype;
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_session_id, ''))) not between 3 and 255
    or length(btrim(coalesce(target_customer_id, ''))) not between 3 and 255
    or length(btrim(coalesce(target_subscription_id, ''))) not between 3 and 255 then
    raise exception using errcode = '22023', message = 'Stripe checkout completion is invalid';
  end if;
  select * into checkout_row
  from public.billing_checkout_sessions
  where stripe_checkout_session_id = target_session_id
  for update;
  if checkout_row.id is null then
    raise exception using errcode = '42501', message = 'Stripe checkout mapping is unavailable';
  end if;
  select * into account_row
  from public.billing_accounts
  where organization_id = checkout_row.organization_id;
  if checkout_row.stripe_customer_id <> target_customer_id
    or account_row.stripe_customer_id <> target_customer_id
    or account_row.livemode is distinct from target_livemode
    or (checkout_row.stripe_subscription_id is not null
      and checkout_row.stripe_subscription_id <> target_subscription_id) then
    raise exception using errcode = '42501', message = 'Stripe checkout session is invalid';
  end if;
  if checkout_row.status = 'completed' then
    return query select checkout_row.organization_id, account_row.stripe_customer_id, checkout_row.stripe_subscription_id;
    return;
  end if;
  if checkout_row.status <> 'created' then
    raise exception using errcode = '42501', message = 'Stripe checkout session is invalid';
  end if;
  update public.billing_checkout_sessions
  set status = 'completed',
      completed_at = now(),
      stripe_subscription_id = target_subscription_id,
      updated_at = now()
  where id = checkout_row.id;
  perform public.write_billing_audit(
    checkout_row.organization_id,
    'billing.checkout.completed',
    'billing_checkout_session',
    checkout_row.id,
    '{}'
  );
  return query select checkout_row.organization_id, account_row.stripe_customer_id, target_subscription_id;
end;
$$;

drop function public.get_my_billing_overview(uuid);
create function public.get_my_billing_overview(target_organization_id uuid)
returns table (
  plan_key text,
  billing_state text,
  billing_attention boolean,
  stripe_status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  trial_end timestamptz,
  has_current_subscription boolean,
  can_subscribe boolean,
  can_manage_billing boolean,
  has_authoritative_period boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare account_row public.billing_accounts%rowtype;
declare current_subscription public.billing_subscriptions%rowtype;
declare current_count integer;
declare authoritative_period boolean;
begin
  perform public.require_my_billing_admin(target_organization_id);
  select * into account_row
  from public.billing_accounts
  where organization_id = target_organization_id;
  if account_row.id is null then
    return query select null::text, 'unconfigured'::text, false, null::text,
      null::timestamptz, null::timestamptz, null::boolean, null::timestamptz,
      false, true, false, false;
    return;
  end if;
  select count(*) into current_count
  from public.billing_subscriptions subscription
  where subscription.organization_id = target_organization_id
    and public.billing_subscription_is_current(subscription.stripe_status);
  select * into current_subscription
  from public.billing_subscriptions subscription
  where subscription.organization_id = target_organization_id
    and public.billing_subscription_is_current(subscription.stripe_status)
  order by subscription.last_provider_sync_at desc
  limit 1;
  authoritative_period := current_count = 1
    and current_subscription.is_supported
    and public.billing_subscription_topology(current_subscription.stripe_status) = 'current'
    and current_subscription.current_period_start is not null
    and current_subscription.current_period_end is not null;
  return query select
    current_subscription.plan_key,
    account_row.billing_state,
    account_row.billing_attention,
    current_subscription.stripe_status,
    case when authoritative_period then current_subscription.current_period_start else null end,
    case when authoritative_period then current_subscription.current_period_end else null end,
    current_subscription.cancel_at_period_end,
    current_subscription.trial_end,
    current_count > 0,
    current_count = 0,
    account_row.stripe_customer_id is not null and current_count > 0,
    authoritative_period;
end;
$$;

drop function public.get_my_billing_usage_summary(uuid);
create function public.get_my_billing_usage_summary(target_organization_id uuid)
returns table (
  period_start timestamptz,
  period_end timestamptz,
  period_kind text,
  voice_seconds bigint,
  outbound_sms bigint,
  ai_text_turns bigint,
  appointments_booked bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare period_start_value timestamptz;
declare period_end_value timestamptz;
declare period_kind_value text := 'current_month_preview';
declare current_subscription public.billing_subscriptions%rowtype;
declare current_count integer;
begin
  perform public.require_my_billing_admin(target_organization_id);
  select count(*) into current_count
  from public.billing_subscriptions subscription
  where subscription.organization_id = target_organization_id
    and public.billing_subscription_is_current(subscription.stripe_status);
  select * into current_subscription
  from public.billing_subscriptions subscription
  where subscription.organization_id = target_organization_id
    and public.billing_subscription_is_current(subscription.stripe_status)
  order by subscription.last_provider_sync_at desc
  limit 1;
  if current_count = 1
    and current_subscription.is_supported
    and public.billing_subscription_topology(current_subscription.stripe_status) = 'current'
    and current_subscription.current_period_start is not null
    and current_subscription.current_period_end is not null then
    period_start_value := current_subscription.current_period_start;
    period_end_value := current_subscription.current_period_end;
    period_kind_value := 'stripe_billing_period';
  else
    period_start_value := date_trunc('month', now());
    period_end_value := period_start_value + interval '1 month';
  end if;
  return query select
    period_start_value,
    period_end_value,
    period_kind_value,
    coalesce(sum(quantity) filter (where metric = 'voice_seconds'), 0)::bigint,
    coalesce(sum(quantity) filter (where metric = 'outbound_sms'), 0)::bigint,
    coalesce(sum(quantity) filter (where metric = 'ai_text_turn'), 0)::bigint,
    coalesce(sum(quantity) filter (where metric = 'appointment_booked'), 0)::bigint
  from public.billing_usage_events
  where organization_id = target_organization_id
    and occurred_at >= period_start_value
    and occurred_at < period_end_value;
end;
$$;

-- Older per-row RPCs are deliberately no longer callable by the trusted backend; only the
-- snapshot RPC can mutate subscription topology going forward.
revoke execute on function public.project_stripe_billing_subscription(uuid, text, text, text, text, text, boolean, text, boolean, timestamptz, timestamptz, timestamptz, timestamptz, boolean),
  public.mark_missing_stripe_billing_subscriptions_terminal(uuid, text, text[], boolean)
  from service_role;

revoke all on function public.billing_subscription_topology(text), public.billing_subscription_is_current(text),
  public.apply_stripe_billing_snapshot(uuid, text, boolean, jsonb, boolean),
  public.record_billing_portal_opened(uuid),
  public.get_billing_checkout_event_context(text, text, text, boolean),
  public.get_my_billing_overview(uuid), public.get_my_billing_usage_summary(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_stripe_billing_snapshot(uuid, text, boolean, jsonb, boolean),
  public.record_billing_portal_opened(uuid),
  public.get_billing_checkout_event_context(text, text, text, boolean)
  to service_role;
grant execute on function public.get_my_billing_overview(uuid), public.get_my_billing_usage_summary(uuid)
  to authenticated;

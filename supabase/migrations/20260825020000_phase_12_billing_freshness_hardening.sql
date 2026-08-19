-- Phase 12 final follow-up: an external Stripe read must never be able to overwrite
-- a newer reconciliation, and a signed Checkout event remains pending until its
-- subscription appears in an applied provider snapshot.

alter table public.billing_accounts
  add column if not exists reconciliation_generation bigint not null default 0
    check (reconciliation_generation >= 0),
  add column if not exists has_current_subscription boolean not null default false;

-- Preserve the true pre-migration topology so the first terminal reconciliation can
-- emit a lifecycle audit exactly once when appropriate.
update public.billing_accounts account
set has_current_subscription = exists (
  select 1
  from public.billing_subscriptions subscription
  where subscription.organization_id = account.organization_id
    and public.billing_subscription_is_current(subscription.stripe_status)
);

create or replace function public.recalculate_billing_account_state(target_organization_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  account_row public.billing_accounts%rowtype;
  next_state text;
  previous_state text;
  previous_has_current boolean;
  next_has_current boolean;
  blocking_count integer;
  unknown_count integer;
  unsupported_current_count integer;
  sole_status text;
begin
  select * into account_row
  from public.billing_accounts account
  where account.organization_id = target_organization_id
  for update;
  if account_row.id is null then
    raise exception using errcode = '42501', message = 'Billing account is unavailable';
  end if;

  previous_state := account_row.billing_state;
  previous_has_current := account_row.has_current_subscription;
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
  next_has_current := blocking_count > 0;

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
    select 1
    from public.billing_subscriptions subscription
    where subscription.organization_id = target_organization_id
  ) then
    next_state := 'inactive';
  else
    next_state := 'unconfigured';
  end if;

  update public.billing_accounts
  set billing_state = next_state,
      billing_attention = next_state = 'attention',
      has_current_subscription = next_has_current,
      last_synced_at = now(),
      updated_at = now()
  where id = account_row.id;

  -- An inactive normalized state can still have current Stripe topology (unpaid,
  -- incomplete, paused). Only loss of current topology is an ended lifecycle event.
  if previous_has_current and not next_has_current then
    perform public.write_billing_audit(
      target_organization_id,
      'billing.subscription.ended',
      'billing_account',
      account_row.id,
      jsonb_build_object('state', next_state)
    );
  elsif previous_state is distinct from next_state then
    perform public.write_billing_audit(
      target_organization_id,
      case
        when next_state = 'active' then 'billing.subscription.activated'
        when next_state = 'attention' then 'billing.payment_attention'
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

-- The monotonically increasing token fences provider reads. The caller must obtain it
-- before any network call and supply it to the later atomic snapshot application.
create function public.begin_stripe_billing_reconciliation(
  target_organization_id uuid,
  target_customer_id text,
  target_livemode boolean
)
returns table (
  billing_account_id uuid,
  organization_id uuid,
  stripe_customer_id text,
  livemode boolean,
  reconciliation_generation bigint
)
language plpgsql security definer set search_path = '' as $$
declare account_row public.billing_accounts%rowtype; next_generation bigint;
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_customer_id, ''))) not between 3 and 255
    or target_livemode is null then
    raise exception using errcode = '22023', message = 'Stripe billing reconciliation is invalid';
  end if;
  select * into account_row
  from public.billing_accounts account
  where account.organization_id = target_organization_id
  for update;
  if account_row.id is null
    or account_row.stripe_customer_id <> target_customer_id
    or account_row.livemode is distinct from target_livemode then
    raise exception using errcode = '42501', message = 'Stripe billing customer is unavailable';
  end if;
  update public.billing_accounts account
  set reconciliation_generation = account.reconciliation_generation + 1,
      updated_at = now()
  where account.id = account_row.id
  returning account.reconciliation_generation into next_generation;
  return query select
    account_row.id,
    account_row.organization_id,
    account_row.stripe_customer_id,
    account_row.livemode,
    next_generation;
end;
$$;

-- The previous five-argument snapshot function remains installed but inaccessible. New
-- execution must carry a fence token and may atomically complete a verified Checkout.
create function public.apply_stripe_billing_snapshot(
  target_organization_id uuid,
  target_customer_id text,
  target_livemode boolean,
  target_reconciliation_generation bigint,
  target_subscriptions jsonb,
  target_snapshot_complete boolean,
  target_checkout_session_id text default null,
  target_checkout_subscription_id text default null
)
returns table (outcome text, billing_state text)
language plpgsql security definer set search_path = '' as $$
declare
  account_row public.billing_accounts%rowtype;
  checkout_row public.billing_checkout_sessions%rowtype;
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
    or target_reconciliation_generation is null
    or target_reconciliation_generation < 1
    or target_snapshot_complete is null
    or jsonb_typeof(target_subscriptions) <> 'array'
    or jsonb_array_length(target_subscriptions) > 500
    or ((target_checkout_session_id is null) <> (target_checkout_subscription_id is null)) then
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
  if account_row.reconciliation_generation <> target_reconciliation_generation then
    return query select 'superseded'::text, null::text;
    return;
  end if;

  if target_checkout_session_id is not null then
    select * into checkout_row
    from public.billing_checkout_sessions checkout
    where checkout.stripe_checkout_session_id = target_checkout_session_id
    for update;
    if checkout_row.id is null
      or checkout_row.status <> 'created'
      or checkout_row.organization_id <> target_organization_id
      or checkout_row.stripe_customer_id <> target_customer_id
      or checkout_row.stripe_subscription_id <> target_checkout_subscription_id then
      raise exception using errcode = '42501', message = 'Stripe checkout session is invalid';
    end if;
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
    from public.billing_subscriptions subscription
    where subscription.stripe_subscription_id = snapshot_subscription_id
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

  if target_checkout_subscription_id is not null
    and not (target_checkout_subscription_id = any(observed_subscription_ids)) then
    raise exception using errcode = 'P0001', message = 'Stripe checkout subscription is not visible in provider truth';
  end if;

  if target_snapshot_complete then
    update public.billing_subscriptions subscription
    set stripe_status = 'canceled',
        ended_at = coalesce(subscription.ended_at, now()),
        last_provider_sync_at = now(),
        updated_at = now()
    where subscription.organization_id = target_organization_id
      and subscription.stripe_customer_id = target_customer_id
      and public.billing_subscription_is_current(subscription.stripe_status)
      and not (subscription.stripe_subscription_id = any(observed_subscription_ids));
  end if;

  next_state := public.recalculate_billing_account_state(target_organization_id);
  perform public.write_billing_audit(
    target_organization_id,
    'billing.reconciled',
    'billing_account',
    account_row.id,
    jsonb_build_object('state', next_state)
  );
  if target_checkout_session_id is not null then
    update public.billing_checkout_sessions
    set status = 'completed',
        completed_at = now(),
        updated_at = now()
    where id = checkout_row.id;
    perform public.write_billing_audit(
      target_organization_id,
      'billing.checkout.completed',
      'billing_checkout_session',
      checkout_row.id,
      '{}'::jsonb
    );
  end if;
  return query select 'applied'::text, next_state;
end;
$$;

-- Persists the verified provider identity while retaining the Checkout row as created.
-- A failed or lagging provider read therefore cannot reopen a second purchase attempt.
create function public.reserve_billing_checkout_subscription_from_event(
  target_session_id text,
  target_customer_id text,
  target_subscription_id text,
  target_livemode boolean
)
returns table (organization_id uuid, stripe_customer_id text, checkout_completed boolean)
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
  from public.billing_checkout_sessions checkout
  where checkout.stripe_checkout_session_id = target_session_id
  for update;
  if checkout_row.id is null then
    return;
  end if;
  select * into account_row
  from public.billing_accounts account
  where account.organization_id = checkout_row.organization_id
  for update;
  if checkout_row.stripe_customer_id <> target_customer_id
    or account_row.stripe_customer_id <> target_customer_id
    or account_row.livemode is distinct from target_livemode
    or (checkout_row.stripe_subscription_id is not null
      and checkout_row.stripe_subscription_id <> target_subscription_id) then
    raise exception using errcode = '42501', message = 'Stripe checkout session is invalid';
  end if;
  if checkout_row.status = 'completed' then
    return query select checkout_row.organization_id, account_row.stripe_customer_id, true;
    return;
  end if;
  if checkout_row.status <> 'created' then
    raise exception using errcode = '42501', message = 'Stripe checkout session is invalid';
  end if;
  update public.billing_checkout_sessions
  set stripe_subscription_id = target_subscription_id,
      updated_at = now()
  where id = checkout_row.id;
  return query select checkout_row.organization_id, account_row.stripe_customer_id, false;
end;
$$;

-- This is the final local eligibility check after provider preflight and immediately
-- before the server creates a new Stripe Checkout Session.
create function public.assert_billing_checkout_eligible(target_checkout_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare checkout_row public.billing_checkout_sessions%rowtype; account_row public.billing_accounts%rowtype;
begin
  perform public.require_billing_service_role();
  select * into checkout_row
  from public.billing_checkout_sessions checkout
  where checkout.id = target_checkout_id
  for update;
  if checkout_row.id is null or checkout_row.status <> 'created' then
    raise exception using errcode = '42501', message = 'Billing checkout is unavailable';
  end if;
  select * into account_row
  from public.billing_accounts account
  where account.organization_id = checkout_row.organization_id
  for update;
  if account_row.id is null then
    raise exception using errcode = '42501', message = 'Billing checkout is unavailable';
  end if;
  if checkout_row.stripe_subscription_id is not null then
    return false;
  end if;
  return not exists (
    select 1
    from public.billing_subscriptions subscription
    where subscription.organization_id = checkout_row.organization_id
      and public.billing_subscription_is_current(subscription.stripe_status)
  );
end;
$$;

create or replace function public.begin_my_billing_checkout(target_plan_key text default 'core')
returns table (checkout_id uuid, action text)
language plpgsql security definer set search_path = '' as $$
declare target_organization_id uuid; existing_checkout public.billing_checkout_sessions%rowtype;
begin
  if target_plan_key <> 'core' then
    raise exception using errcode = '22023', message = 'Billing plan is unavailable';
  end if;
  target_organization_id := public.my_billing_admin_organization();
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

revoke all on function public.begin_stripe_billing_reconciliation(uuid, text, boolean),
  public.apply_stripe_billing_snapshot(uuid, text, boolean, bigint, jsonb, boolean, text, text),
  public.reserve_billing_checkout_subscription_from_event(text, text, text, boolean),
  public.assert_billing_checkout_eligible(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_stripe_billing_reconciliation(uuid, text, boolean),
  public.apply_stripe_billing_snapshot(uuid, text, boolean, bigint, jsonb, boolean, text, text),
  public.reserve_billing_checkout_subscription_from_event(text, text, text, boolean),
  public.assert_billing_checkout_eligible(uuid)
  to service_role;

revoke execute on function public.apply_stripe_billing_snapshot(uuid, text, boolean, jsonb, boolean),
  public.complete_billing_checkout_from_event(text, text, text, boolean),
  public.get_billing_checkout_event_context(text, text, text, boolean)
  from service_role;
revoke all on function public.begin_my_billing_checkout(text)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_my_billing_checkout(text) to authenticated;

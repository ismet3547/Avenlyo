-- Phase 12: organization-scoped Stripe billing authority and prospective usage metering.
-- Billing internals deliberately have no browser table grants. Dashboard reads and owner/admin
-- actions use narrowly scoped RPCs; provider work uses service-role-only RPCs.

create table public.billing_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null unique references public.organizations (id) on delete cascade,
  stripe_customer_id text unique,
  livemode boolean,
  billing_state text not null default 'unconfigured'
    check (billing_state in ('active', 'attention', 'inactive', 'review_required', 'unconfigured')),
  billing_attention boolean not null default false,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_accounts_customer_mode_check check (
    stripe_customer_id is null or livemode is not null
  ),
  constraint billing_accounts_organization_customer_key unique (organization_id, stripe_customer_id)
);

create table public.billing_subscriptions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  stripe_product_id text,
  stripe_price_id text,
  plan_key text,
  is_supported boolean not null default false,
  stripe_status text not null check (char_length(stripe_status) between 1 and 120),
  cancel_at_period_end boolean not null default false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end timestamptz,
  ended_at timestamptz,
  livemode boolean not null,
  last_provider_sync_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_subscriptions_customer_fk foreign key (organization_id, stripe_customer_id)
    references public.billing_accounts (organization_id, stripe_customer_id) on delete cascade,
  constraint billing_subscriptions_plan_key_check check (plan_key is null or plan_key = 'core'),
  constraint billing_subscriptions_provider_ids_check check (
    (is_supported and plan_key = 'core' and stripe_product_id is not null and stripe_price_id is not null)
    or (not is_supported and plan_key is null)
  ),
  constraint billing_subscriptions_organization_id_id_key unique (organization_id, id)
);

create index billing_subscriptions_organization_status_idx
  on public.billing_subscriptions (organization_id, stripe_status, updated_at desc);

create table public.billing_checkout_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_key text not null check (plan_key = 'core'),
  stripe_checkout_session_id text unique,
  stripe_customer_id text,
  status text not null default 'created' check (status in ('created', 'completed', 'expired')),
  idempotency_key text not null unique check (char_length(idempotency_key) between 16 and 240),
  created_by uuid references public.users (id) on delete set null,
  expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_checkout_sessions_customer_fk foreign key (organization_id, stripe_customer_id)
    references public.billing_accounts (organization_id, stripe_customer_id),
  constraint billing_checkout_sessions_organization_id_id_key unique (organization_id, id),
  constraint billing_checkout_sessions_completion_check check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create unique index billing_checkout_sessions_one_open_attempt_key
  on public.billing_checkout_sessions (organization_id, plan_key)
  where status = 'created';

create table public.stripe_webhook_events (
  stripe_event_id text primary key check (char_length(stripe_event_id) between 3 and 255),
  event_type text not null check (char_length(event_type) between 3 and 120),
  stripe_object_id text,
  stripe_created_at timestamptz,
  livemode boolean not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'ignored', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  claimed_at timestamptz,
  claimed_by text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_code text,
  constraint stripe_webhook_events_claim_check check (
    (status = 'processing' and claimed_at is not null and claimed_by is not null)
    or (status <> 'processing')
  )
);

create index stripe_webhook_events_claim_idx
  on public.stripe_webhook_events (received_at)
  where status in ('pending', 'failed', 'processing');

-- All metered sources are location-scoped today. The composite unique constraints used by
-- the source foreign keys below already exist on calls, messages, message_deliveries, and
-- appointments from the Phase 8 and Phase 11 tenant-integrity migrations.

create table public.billing_usage_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  metric text not null check (metric in ('voice_seconds', 'outbound_sms', 'ai_text_turn', 'appointment_booked')),
  quantity integer not null check (quantity > 0),
  occurred_at timestamptz not null,
  call_id uuid,
  message_delivery_id uuid,
  message_id uuid,
  appointment_id uuid,
  created_at timestamptz not null default now(),
  constraint billing_usage_events_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete restrict,
  constraint billing_usage_events_call_fk foreign key (organization_id, location_id, call_id)
    references public.calls (organization_id, location_id, id) on delete restrict,
  constraint billing_usage_events_delivery_fk foreign key (organization_id, location_id, message_delivery_id)
    references public.message_deliveries (organization_id, location_id, id) on delete restrict,
  constraint billing_usage_events_message_fk foreign key (organization_id, location_id, message_id)
    references public.messages (organization_id, location_id, id) on delete restrict,
  constraint billing_usage_events_appointment_fk foreign key (organization_id, location_id, appointment_id)
    references public.appointments (organization_id, location_id, id) on delete restrict,
  constraint billing_usage_events_metric_source_check check (
    (metric = 'voice_seconds' and call_id is not null and message_delivery_id is null and message_id is null and appointment_id is null)
    or (metric = 'outbound_sms' and call_id is null and message_delivery_id is not null and message_id is null and appointment_id is null)
    or (metric = 'ai_text_turn' and call_id is null and message_delivery_id is null and message_id is not null and appointment_id is null)
    or (metric = 'appointment_booked' and call_id is null and message_delivery_id is null and message_id is null and appointment_id is not null)
  )
);

create unique index billing_usage_events_voice_call_key
  on public.billing_usage_events (call_id) where metric = 'voice_seconds';
create unique index billing_usage_events_delivery_key
  on public.billing_usage_events (message_delivery_id) where metric = 'outbound_sms';
create unique index billing_usage_events_message_key
  on public.billing_usage_events (message_id) where metric = 'ai_text_turn';
create unique index billing_usage_events_appointment_key
  on public.billing_usage_events (appointment_id) where metric = 'appointment_booked';
create index billing_usage_events_summary_idx
  on public.billing_usage_events (organization_id, occurred_at desc, metric);

create trigger set_billing_accounts_updated_at
  before update on public.billing_accounts for each row execute function public.set_updated_at();
create trigger set_billing_subscriptions_updated_at
  before update on public.billing_subscriptions for each row execute function public.set_updated_at();
create trigger set_billing_checkout_sessions_updated_at
  before update on public.billing_checkout_sessions for each row execute function public.set_updated_at();

alter table public.billing_accounts enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_checkout_sessions enable row level security;
alter table public.stripe_webhook_events enable row level security;
alter table public.billing_usage_events enable row level security;

revoke all on table public.billing_accounts, public.billing_subscriptions,
  public.billing_checkout_sessions, public.stripe_webhook_events, public.billing_usage_events
  from public, anon, authenticated, service_role;

create function public.require_billing_service_role()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted billing backend access is required';
  end if;
end;
$$;

create function public.my_billing_admin_organization()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare selected_organization_id uuid; membership_count integer;
begin
  select count(*) into membership_count
  from public.organization_members
  where user_id = auth.uid() and role in ('owner', 'admin');
  if membership_count <> 1 then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;
  select organization_id into selected_organization_id from public.organization_members
    where user_id = auth.uid() and role in ('owner', 'admin');
  return selected_organization_id;
end;
$$;

create function public.require_my_billing_admin(target_organization_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if target_organization_id is null or not public.is_organization_admin(target_organization_id) then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;
end;
$$;

create function public.billing_subscription_is_terminal(target_status text)
returns boolean language sql immutable set search_path = '' as $$
  select target_status in ('canceled', 'cancelled', 'unpaid', 'incomplete_expired', 'ended');
$$;

create function public.write_billing_audit(
  target_organization_id uuid,
  target_action text,
  target_entity_type text,
  target_entity_id uuid,
  target_details jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (
    target_organization_id,
    null,
    target_action,
    target_entity_type,
    target_entity_id,
    coalesce(target_details, '{}'::jsonb)
  );
end;
$$;

create function public.recalculate_billing_account_state(target_organization_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare account_row public.billing_accounts%rowtype; next_state text; supported_count integer;
declare active_count integer; current_status text; previous_state text;
begin
  select * into account_row from public.billing_accounts where organization_id = target_organization_id for update;
  if account_row.id is null then raise exception using errcode = '42501', message = 'Billing account is unavailable'; end if;
  previous_state := account_row.billing_state;
  select count(*) into active_count from public.billing_subscriptions subscription
    where subscription.organization_id = target_organization_id
      and not public.billing_subscription_is_terminal(subscription.stripe_status);
  select count(*) into supported_count from public.billing_subscriptions subscription
    where subscription.organization_id = target_organization_id and subscription.is_supported
      and not public.billing_subscription_is_terminal(subscription.stripe_status);
  select stripe_status into current_status
    from public.billing_subscriptions subscription
    where subscription.organization_id = target_organization_id
      and not public.billing_subscription_is_terminal(subscription.stripe_status)
    order by subscription.last_provider_sync_at desc limit 1;

  if exists (select 1 from public.billing_subscriptions where organization_id = target_organization_id and not is_supported) then
    next_state := 'review_required';
  elsif active_count > 1 or supported_count > 1 then
    next_state := 'review_required';
  elsif active_count = 1 and current_status in ('active', 'trialing') then
    next_state := 'active';
  elsif active_count = 1 and current_status = 'past_due' then
    next_state := 'attention';
  elsif exists (select 1 from public.billing_subscriptions where organization_id = target_organization_id) then
    next_state := 'inactive';
  else
    next_state := 'unconfigured';
  end if;

  update public.billing_accounts set billing_state = next_state, billing_attention = next_state = 'attention',
    last_synced_at = now(), updated_at = now() where id = account_row.id;

  if previous_state is distinct from next_state then
    perform public.write_billing_audit(
      target_organization_id,
      case when next_state = 'active' then 'billing.subscription.activated'
           when next_state = 'attention' then 'billing.payment_attention'
           when next_state = 'inactive' then 'billing.subscription.ended'
           else 'billing.subscription.status_changed' end,
      'billing_account', account_row.id, jsonb_build_object('state', next_state)
    );
  end if;
  return next_state;
end;
$$;

create function public.begin_my_billing_checkout(target_plan_key text default 'core')
returns table (checkout_id uuid, action text)
language plpgsql security definer set search_path = '' as $$
declare target_organization_id uuid; existing_checkout public.billing_checkout_sessions%rowtype;
begin
  if target_plan_key <> 'core' then raise exception using errcode = '22023', message = 'Billing plan is unavailable'; end if;
  target_organization_id := public.my_billing_admin_organization();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing-checkout:' || target_organization_id::text, 0));
  insert into public.billing_accounts (organization_id) values (target_organization_id) on conflict (organization_id) do nothing;
  if exists (select 1 from public.billing_subscriptions where organization_id = target_organization_id
    and not public.billing_subscription_is_terminal(stripe_status)) then
    return query select null::uuid, 'manage_existing_subscription'; return;
  end if;
  select * into existing_checkout from public.billing_checkout_sessions
    where organization_id = target_organization_id and plan_key = target_plan_key and status = 'created'
    for update;
  if existing_checkout.id is not null and existing_checkout.expires_at is not null and existing_checkout.expires_at <= now() then
    update public.billing_checkout_sessions set status = 'expired', updated_at = now() where id = existing_checkout.id;
    existing_checkout := null;
  end if;
  if existing_checkout.id is null then
    insert into public.billing_checkout_sessions (organization_id, plan_key, idempotency_key, created_by)
    values (target_organization_id, target_plan_key,
      'avenlyo:billing-checkout:' || target_organization_id::text || ':' || extensions.gen_random_uuid()::text,
      auth.uid()) returning * into existing_checkout;
    perform public.write_billing_audit(target_organization_id, 'billing.checkout.created', 'billing_checkout_session', existing_checkout.id, '{}');
  end if;
  return query select existing_checkout.id, 'create_checkout';
end;
$$;

create function public.get_billing_checkout_execution_context(target_checkout_id uuid)
returns table (checkout_id uuid, organization_id uuid, organization_name text, plan_key text, idempotency_key text,
  stripe_customer_id text, livemode boolean)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  return query select checkout.id, checkout.organization_id, organization.name, checkout.plan_key, checkout.idempotency_key,
    account.stripe_customer_id, account.livemode
  from public.billing_checkout_sessions checkout
  join public.billing_accounts account on account.organization_id = checkout.organization_id
  join public.organizations organization on organization.id = checkout.organization_id
  where checkout.id = target_checkout_id and checkout.status = 'created';
end;
$$;

create function public.record_stripe_billing_customer(
  target_checkout_id uuid, target_stripe_customer_id text, target_livemode boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare checkout_row public.billing_checkout_sessions%rowtype; account_row public.billing_accounts%rowtype;
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_stripe_customer_id, ''))) not between 3 and 255 then
    raise exception using errcode = '22023', message = 'Stripe customer is invalid'; end if;
  select * into checkout_row from public.billing_checkout_sessions where id = target_checkout_id and status = 'created' for update;
  if checkout_row.id is null then raise exception using errcode = '42501', message = 'Billing checkout is unavailable'; end if;
  select * into account_row from public.billing_accounts where organization_id = checkout_row.organization_id for update;
  if account_row.stripe_customer_id is not null and account_row.stripe_customer_id <> target_stripe_customer_id then
    raise exception using errcode = '23505', message = 'Billing customer identity conflicts'; end if;
  if account_row.livemode is not null and account_row.livemode <> target_livemode then
    raise exception using errcode = '22023', message = 'Stripe mode conflicts'; end if;
  update public.billing_accounts set stripe_customer_id = target_stripe_customer_id, livemode = target_livemode,
    updated_at = now() where id = account_row.id;
end;
$$;

create function public.record_stripe_checkout_session(
  target_checkout_id uuid, target_session_id text, target_customer_id text, target_expires_at timestamptz, target_livemode boolean
)
returns void language plpgsql security definer set search_path = '' as $$
declare checkout_row public.billing_checkout_sessions%rowtype; account_row public.billing_accounts%rowtype;
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_session_id, ''))) not between 3 and 255 or length(btrim(coalesce(target_customer_id, ''))) not between 3 and 255 then
    raise exception using errcode = '22023', message = 'Stripe checkout session is invalid'; end if;
  select * into checkout_row from public.billing_checkout_sessions where id = target_checkout_id and status = 'created' for update;
  if checkout_row.id is null then raise exception using errcode = '42501', message = 'Billing checkout is unavailable'; end if;
  select * into account_row from public.billing_accounts where organization_id = checkout_row.organization_id;
  if account_row.stripe_customer_id <> target_customer_id or account_row.livemode is distinct from target_livemode then
    raise exception using errcode = '42501', message = 'Stripe checkout customer is unavailable'; end if;
  if checkout_row.stripe_checkout_session_id is not null and checkout_row.stripe_checkout_session_id <> target_session_id then
    raise exception using errcode = '23505', message = 'Stripe checkout identity conflicts'; end if;
  update public.billing_checkout_sessions set stripe_checkout_session_id = target_session_id, stripe_customer_id = target_customer_id,
    expires_at = target_expires_at, updated_at = now() where id = checkout_row.id;
end;
$$;

create function public.begin_my_billing_portal()
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_organization_id uuid; account_row public.billing_accounts%rowtype;
begin
  target_organization_id := public.my_billing_admin_organization();
  select * into account_row from public.billing_accounts where organization_id = target_organization_id;
  if account_row.id is null or account_row.stripe_customer_id is null then
    raise exception using errcode = '42501', message = 'Billing portal is unavailable'; end if;
  perform public.write_billing_audit(target_organization_id, 'billing.portal.opened', 'billing_account', account_row.id, '{}');
  return account_row.id;
end;
$$;

create function public.get_billing_account_execution_context(target_account_id uuid)
returns table (billing_account_id uuid, organization_id uuid, organization_name text, stripe_customer_id text, livemode boolean)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  return query select account.id, account.organization_id, organization.name, account.stripe_customer_id, account.livemode
  from public.billing_accounts account join public.organizations organization on organization.id = account.organization_id
  where account.id = target_account_id and account.stripe_customer_id is not null and account.livemode is not null;
end;
$$;

create function public.get_billing_customer_execution_context(target_customer_id text, target_livemode boolean)
returns table (billing_account_id uuid, organization_id uuid, organization_name text, stripe_customer_id text, livemode boolean)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  return query select account.id, account.organization_id, organization.name, account.stripe_customer_id, account.livemode
  from public.billing_accounts account join public.organizations organization on organization.id = account.organization_id
  where account.stripe_customer_id = target_customer_id and account.livemode = target_livemode;
end;
$$;

create function public.get_my_billing_overview(target_organization_id uuid)
returns table (plan_key text, billing_state text, billing_attention boolean, stripe_status text,
  current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean, trial_end timestamptz)
language sql stable security definer set search_path = '' as $$
  select subscription.plan_key, account.billing_state, account.billing_attention, subscription.stripe_status,
    subscription.current_period_start, subscription.current_period_end, subscription.cancel_at_period_end, subscription.trial_end
  from public.billing_accounts account
  left join lateral (
    select * from public.billing_subscriptions subscription
    where subscription.organization_id = account.organization_id
    order by not public.billing_subscription_is_terminal(subscription.stripe_status) desc,
      subscription.last_provider_sync_at desc limit 1
  ) subscription on true
  where account.organization_id = target_organization_id and public.is_organization_admin(target_organization_id);
$$;

create function public.get_my_billing_usage_summary(target_organization_id uuid)
returns table (period_start timestamptz, period_end timestamptz, voice_seconds bigint, outbound_sms bigint,
  ai_text_turns bigint, appointments_booked bigint)
language plpgsql stable security definer set search_path = '' as $$
declare period_start_value timestamptz; period_end_value timestamptz;
begin
  perform public.require_my_billing_admin(target_organization_id);
  select subscription.current_period_start, subscription.current_period_end into period_start_value, period_end_value
  from public.billing_subscriptions subscription where subscription.organization_id = target_organization_id
    and not public.billing_subscription_is_terminal(subscription.stripe_status)
  order by subscription.last_provider_sync_at desc limit 1;
  period_start_value := coalesce(period_start_value, date_trunc('month', now()));
  period_end_value := coalesce(period_end_value, period_start_value + interval '1 month');
  return query select period_start_value, period_end_value,
    coalesce(sum(quantity) filter (where metric = 'voice_seconds'), 0)::bigint,
    coalesce(sum(quantity) filter (where metric = 'outbound_sms'), 0)::bigint,
    coalesce(sum(quantity) filter (where metric = 'ai_text_turn'), 0)::bigint,
    coalesce(sum(quantity) filter (where metric = 'appointment_booked'), 0)::bigint
  from public.billing_usage_events where organization_id = target_organization_id
    and occurred_at >= period_start_value and occurred_at < period_end_value;
end;
$$;

create function public.begin_my_billing_refresh()
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_organization_id uuid; account_id uuid;
begin
  target_organization_id := public.my_billing_admin_organization();
  select id into account_id from public.billing_accounts where organization_id = target_organization_id and stripe_customer_id is not null;
  if account_id is null then raise exception using errcode = '42501', message = 'Billing is unavailable'; end if;
  return account_id;
end;
$$;

create function public.record_stripe_webhook_event(
  target_event_id text, target_event_type text, target_object_id text, target_created_at timestamptz, target_livemode boolean
)
returns table (accepted boolean)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_event_id, ''))) not between 3 and 255 or length(btrim(coalesce(target_event_type, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Stripe webhook event is invalid'; end if;
  insert into public.stripe_webhook_events (stripe_event_id, event_type, stripe_object_id, stripe_created_at, livemode)
  values (target_event_id, target_event_type, nullif(btrim(target_object_id), ''), target_created_at, target_livemode)
  on conflict (stripe_event_id) do nothing;
  return query select found;
end;
$$;

create function public.claim_stripe_webhook_events(target_worker_id text, target_limit integer default 10)
returns table (stripe_event_id text, event_type text, stripe_object_id text, livemode boolean, attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 25 then
    raise exception using errcode = '22023', message = 'Billing worker claim is invalid'; end if;
  update public.stripe_webhook_events set status = 'failed', claimed_at = null, claimed_by = null,
    last_error_code = 'lease_expired' where status = 'processing' and claimed_at < now() - interval '5 minutes';
  return query with claimed as (
    select event.stripe_event_id from public.stripe_webhook_events event
    where event.status in ('pending', 'failed') and event.attempt_count < 8
    order by event.received_at asc for update skip locked limit target_limit
  ), updated as (
    update public.stripe_webhook_events event set status = 'processing', attempt_count = event.attempt_count + 1,
      claimed_at = now(), claimed_by = btrim(target_worker_id), last_error_code = null
    from claimed where event.stripe_event_id = claimed.stripe_event_id returning event.*
  ) select stripe_event_id, event_type, stripe_object_id, livemode, attempt_count from updated;
end;
$$;

create function public.complete_stripe_webhook_event(target_event_id text, target_status text default 'processed')
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  if target_status not in ('processed', 'ignored') then raise exception using errcode = '22023', message = 'Stripe event status is invalid'; end if;
  update public.stripe_webhook_events set status = target_status, processed_at = now(), claimed_at = null, claimed_by = null,
    last_error_code = null where stripe_event_id = target_event_id and status = 'processing';
end;
$$;

create function public.fail_stripe_webhook_event(target_event_id text, target_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_billing_service_role();
  update public.stripe_webhook_events set status = case when attempt_count >= 8 then 'failed' else 'pending' end,
    claimed_at = null, claimed_by = null, last_error_code = left(nullif(btrim(target_error_code), ''), 120)
  where stripe_event_id = target_event_id and status = 'processing';
end;
$$;

create function public.complete_billing_checkout_from_event(
  target_session_id text, target_customer_id text, target_subscription_id text, target_livemode boolean
)
returns table (organization_id uuid, stripe_customer_id text, stripe_subscription_id text)
language plpgsql security definer set search_path = '' as $$
declare checkout_row public.billing_checkout_sessions%rowtype; account_row public.billing_accounts%rowtype;
begin
  perform public.require_billing_service_role();
  select * into checkout_row from public.billing_checkout_sessions where stripe_checkout_session_id = target_session_id for update;
  if checkout_row.id is null then raise exception using errcode = '42501', message = 'Stripe checkout mapping is unavailable'; end if;
  select * into account_row from public.billing_accounts where organization_id = checkout_row.organization_id;
  if checkout_row.status = 'completed' then
    return query select checkout_row.organization_id, account_row.stripe_customer_id, target_subscription_id; return;
  end if;
  if checkout_row.status <> 'created' or checkout_row.stripe_customer_id <> target_customer_id
    or account_row.stripe_customer_id <> target_customer_id or account_row.livemode is distinct from target_livemode then
    raise exception using errcode = '42501', message = 'Stripe checkout session is invalid'; end if;
  update public.billing_checkout_sessions set status = 'completed', completed_at = now(), updated_at = now() where id = checkout_row.id;
  perform public.write_billing_audit(checkout_row.organization_id, 'billing.checkout.completed', 'billing_checkout_session', checkout_row.id, '{}');
  return query select checkout_row.organization_id, account_row.stripe_customer_id, target_subscription_id;
end;
$$;

create function public.project_stripe_billing_subscription(
  target_organization_id uuid, target_customer_id text, target_subscription_id text,
  target_product_id text, target_price_id text, target_plan_key text, target_is_supported boolean,
  target_status text, target_cancel_at_period_end boolean, target_period_start timestamptz,
  target_period_end timestamptz, target_trial_end timestamptz, target_ended_at timestamptz, target_livemode boolean
)
returns text language plpgsql security definer set search_path = '' as $$
declare account_row public.billing_accounts%rowtype; existing_subscription public.billing_subscriptions%rowtype;
declare saved_subscription_id uuid; next_state text;
begin
  perform public.require_billing_service_role();
  if length(btrim(coalesce(target_subscription_id, ''))) not between 3 and 255
    or length(btrim(coalesce(target_customer_id, ''))) not between 3 and 255
    or length(btrim(coalesce(target_status, ''))) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Stripe subscription projection is invalid'; end if;
  if target_is_supported and (target_plan_key <> 'core' or target_product_id is null or target_price_id is null) then
    raise exception using errcode = '22023', message = 'Stripe plan projection is invalid'; end if;
  if not target_is_supported and target_plan_key is not null then
    raise exception using errcode = '22023', message = 'Stripe plan projection is invalid'; end if;
  select * into account_row from public.billing_accounts where organization_id = target_organization_id for update;
  if account_row.id is null or account_row.stripe_customer_id <> target_customer_id or account_row.livemode is distinct from target_livemode then
    raise exception using errcode = '42501', message = 'Stripe subscription customer is unavailable'; end if;
  select * into existing_subscription from public.billing_subscriptions where stripe_subscription_id = target_subscription_id for update;
  if existing_subscription.id is not null and existing_subscription.organization_id <> target_organization_id then
    raise exception using errcode = '42501', message = 'Stripe subscription ownership conflicts'; end if;
  insert into public.billing_subscriptions (
    organization_id, stripe_customer_id, stripe_subscription_id, stripe_product_id, stripe_price_id, plan_key,
    is_supported, stripe_status, cancel_at_period_end, current_period_start, current_period_end, trial_end,
    ended_at, livemode, last_provider_sync_at
  ) values (
    target_organization_id, target_customer_id, target_subscription_id, nullif(target_product_id, ''), nullif(target_price_id, ''),
    case when target_is_supported then target_plan_key else null end, target_is_supported, btrim(target_status), target_cancel_at_period_end,
    target_period_start, target_period_end, target_trial_end, target_ended_at, target_livemode, now()
  ) on conflict (stripe_subscription_id) do update set stripe_product_id = excluded.stripe_product_id,
    stripe_price_id = excluded.stripe_price_id, plan_key = excluded.plan_key, is_supported = excluded.is_supported,
    stripe_status = excluded.stripe_status, cancel_at_period_end = excluded.cancel_at_period_end,
    current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
    trial_end = excluded.trial_end, ended_at = excluded.ended_at, livemode = excluded.livemode,
    last_provider_sync_at = excluded.last_provider_sync_at, updated_at = now()
  returning id into saved_subscription_id;
  if target_cancel_at_period_end and (existing_subscription.id is null or not existing_subscription.cancel_at_period_end) then
    perform public.write_billing_audit(target_organization_id, 'billing.subscription.cancel_scheduled',
      'billing_subscription', saved_subscription_id, '{}'::jsonb);
  end if;
  next_state := public.recalculate_billing_account_state(target_organization_id);
  perform public.write_billing_audit(target_organization_id, 'billing.reconciled', 'billing_account', account_row.id,
    jsonb_build_object('state', next_state));
  return next_state;
end;
$$;

create function public.mark_missing_stripe_billing_subscriptions_terminal(
  target_organization_id uuid, target_customer_id text, target_subscription_ids text[], target_livemode boolean
)
returns text language plpgsql security definer set search_path = '' as $$
declare account_row public.billing_accounts%rowtype;
begin
  perform public.require_billing_service_role();
  select * into account_row from public.billing_accounts where organization_id = target_organization_id for update;
  if account_row.id is null or account_row.stripe_customer_id <> target_customer_id or account_row.livemode is distinct from target_livemode then
    raise exception using errcode = '42501', message = 'Stripe billing customer is unavailable'; end if;
  update public.billing_subscriptions set stripe_status = 'canceled', ended_at = coalesce(ended_at, now()),
    last_provider_sync_at = now(), updated_at = now()
  where organization_id = target_organization_id and stripe_customer_id = target_customer_id
    and not public.billing_subscription_is_terminal(stripe_status)
    and not (stripe_subscription_id = any(coalesce(target_subscription_ids, '{}'::text[])));
  return public.recalculate_billing_account_state(target_organization_id);
end;
$$;

-- Usage is recorded only when durable operational state crosses the named source-of-truth boundary.
create function public.record_billing_voice_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare duration_seconds integer;
begin
  if new.status <> 'completed' or new.location_id is null or new.answered_at is null or new.ended_at is null then return new; end if;
  duration_seconds := floor(extract(epoch from (new.ended_at - new.answered_at)))::integer;
  if duration_seconds <= 0 then return new; end if;
  insert into public.billing_usage_events (organization_id, location_id, metric, quantity, occurred_at, call_id)
  values (new.organization_id, new.location_id, 'voice_seconds', duration_seconds, new.ended_at, new.id)
  on conflict (call_id) where metric = 'voice_seconds' do nothing;
  return new;
end;
$$;

create function public.record_billing_outbound_sms_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.provider <> 'twilio' or new.status <> 'submitting' or new.location_id is null then return new; end if;
  insert into public.billing_usage_events (organization_id, location_id, metric, quantity, occurred_at, message_delivery_id)
  values (new.organization_id, new.location_id, 'outbound_sms', 1, coalesce(new.attempted_at, now()), new.id)
  on conflict (message_delivery_id) where metric = 'outbound_sms' do nothing;
  return new;
end;
$$;

create function public.record_billing_ai_text_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.direction <> 'outbound' or new.author_type <> 'ai' or new.source_channel not in ('sms', 'web') or new.location_id is null then return new; end if;
  insert into public.billing_usage_events (organization_id, location_id, metric, quantity, occurred_at, message_id)
  values (new.organization_id, new.location_id, 'ai_text_turn', 1, coalesce(new.sent_at, new.created_at), new.id)
  on conflict (message_id) where metric = 'ai_text_turn' do nothing;
  return new;
end;
$$;

create function public.record_billing_appointment_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.booking_intent_id is null or new.location_id is null then return new; end if;
  insert into public.billing_usage_events (organization_id, location_id, metric, quantity, occurred_at, appointment_id)
  values (new.organization_id, new.location_id, 'appointment_booked', 1, new.created_at, new.id)
  on conflict (appointment_id) where metric = 'appointment_booked' do nothing;
  return new;
end;
$$;

create trigger record_billing_voice_usage_after_call
  after insert or update of status, answered_at, ended_at on public.calls
  for each row execute function public.record_billing_voice_usage();
create trigger record_billing_outbound_sms_usage_after_delivery
  after insert or update of status on public.message_deliveries
  for each row execute function public.record_billing_outbound_sms_usage();
create trigger record_billing_ai_text_usage_after_message
  after insert on public.messages for each row execute function public.record_billing_ai_text_usage();
create trigger record_billing_appointment_usage_after_appointment
  after insert or update of booking_intent_id on public.appointments
  for each row execute function public.record_billing_appointment_usage();

-- Helpers are not a browser boundary. Explicit grants below are the complete callable surface.
revoke all on function public.require_billing_service_role(), public.my_billing_admin_organization(),
  public.require_my_billing_admin(uuid), public.billing_subscription_is_terminal(text),
  public.write_billing_audit(uuid, text, text, uuid, jsonb), public.recalculate_billing_account_state(uuid),
  public.get_billing_checkout_execution_context(uuid), public.record_stripe_billing_customer(uuid, text, boolean),
  public.record_stripe_checkout_session(uuid, text, text, timestamptz, boolean),
  public.get_billing_account_execution_context(uuid), public.get_billing_customer_execution_context(text, boolean),
  public.record_stripe_webhook_event(text, text, text, timestamptz, boolean),
  public.claim_stripe_webhook_events(text, integer), public.complete_stripe_webhook_event(text, text),
  public.fail_stripe_webhook_event(text, text), public.complete_billing_checkout_from_event(text, text, text, boolean),
  public.project_stripe_billing_subscription(uuid, text, text, text, text, text, boolean, text, boolean, timestamptz, timestamptz, timestamptz, timestamptz, boolean),
  public.mark_missing_stripe_billing_subscriptions_terminal(uuid, text, text[], boolean),
  public.record_billing_voice_usage(), public.record_billing_outbound_sms_usage(), public.record_billing_ai_text_usage(),
  public.record_billing_appointment_usage(), public.begin_my_billing_checkout(text), public.begin_my_billing_portal(),
  public.get_my_billing_overview(uuid), public.get_my_billing_usage_summary(uuid), public.begin_my_billing_refresh()
  from public, anon, authenticated, service_role;

grant execute on function public.begin_my_billing_checkout(text), public.begin_my_billing_portal(),
  public.get_my_billing_overview(uuid), public.get_my_billing_usage_summary(uuid), public.begin_my_billing_refresh()
  to authenticated;
grant execute on function public.get_billing_checkout_execution_context(uuid),
  public.record_stripe_billing_customer(uuid, text, boolean),
  public.record_stripe_checkout_session(uuid, text, text, timestamptz, boolean),
  public.get_billing_account_execution_context(uuid),
  public.get_billing_customer_execution_context(text, boolean),
  public.record_stripe_webhook_event(text, text, text, timestamptz, boolean),
  public.claim_stripe_webhook_events(text, integer), public.complete_stripe_webhook_event(text, text),
  public.fail_stripe_webhook_event(text, text), public.complete_billing_checkout_from_event(text, text, text, boolean),
  public.project_stripe_billing_subscription(uuid, text, text, text, text, text, boolean, text, boolean, timestamptz, timestamptz, timestamptz, timestamptz, boolean),
  public.mark_missing_stripe_billing_subscriptions_terminal(uuid, text, text[], boolean)
  to service_role;

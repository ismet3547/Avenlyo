-- Phase 25: cost-aware text-agent routing and durable, privacy-bounded AI usage telemetry.
--
-- Usage rows are observability, not billing truth. They contain no customer text, source content,
-- contact identifiers, or provider credentials. Tenant/location/conversation scope is always
-- derived inside trusted RPC boundaries rather than accepted from the caller.

create table public.ai_usage_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  agent_test_run_id uuid unique references public.agent_test_runs (id) on delete cascade,
  inbound_message_id uuid unique references public.messages (id) on delete cascade,
  mode text not null check (mode in ('customer', 'test')),
  provider text not null check (provider in ('deterministic', 'openai-responses')),
  model text not null check (length(btrim(model)) between 1 and 120),
  model_tier text not null check (model_tier in ('deterministic', 'luna', 'terra', 'sol')),
  route_reason text not null check (
    route_reason in (
      'deterministic_safety',
      'deterministic_human_request',
      'deterministic_business_hours',
      'luna_default',
      'terra_pending_mutation',
      'terra_consequential_request',
      'terra_complex_conversation',
      'sol_complex_conversation'
    )
  ),
  input_tokens integer not null default 0 check (input_tokens between 0 and 10000000),
  cached_input_tokens integer not null default 0
    check (cached_input_tokens between 0 and input_tokens),
  output_tokens integer not null default 0 check (output_tokens between 0 and 1000000),
  estimated_cost_microusd bigint check (
    estimated_cost_microusd is null
    or estimated_cost_microusd between 0 and 1000000000000
  ),
  pricing_version text not null check (length(btrim(pricing_version)) between 1 and 40),
  created_at timestamptz not null default now(),
  constraint ai_usage_events_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint ai_usage_events_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint ai_usage_events_source_mode_check check (
    (mode = 'test' and agent_test_run_id is not null and inbound_message_id is null)
    or (mode = 'customer' and inbound_message_id is not null and agent_test_run_id is null)
  ),
  constraint ai_usage_events_provider_tier_check check (
    (model_tier = 'deterministic' and provider = 'deterministic' and model = 'deterministic'
      and input_tokens = 0 and cached_input_tokens = 0 and output_tokens = 0
      and estimated_cost_microusd = 0)
    or (model_tier <> 'deterministic' and provider = 'openai-responses' and model <> 'deterministic')
  ),
  constraint ai_usage_events_route_tier_check check (
    (model_tier = 'deterministic' and route_reason in (
      'deterministic_safety', 'deterministic_human_request', 'deterministic_business_hours'
    ))
    or (model_tier = 'luna' and route_reason = 'luna_default')
    or (model_tier = 'terra' and route_reason in (
      'terra_pending_mutation', 'terra_consequential_request', 'terra_complex_conversation'
    ))
    or (model_tier = 'sol' and route_reason = 'sol_complex_conversation')
  )
);

create index ai_usage_events_organization_created_at_idx
  on public.ai_usage_events (organization_id, created_at desc);
create index ai_usage_events_location_created_at_idx
  on public.ai_usage_events (location_id, created_at desc);
create index ai_usage_events_conversation_created_at_idx
  on public.ai_usage_events (conversation_id, created_at desc);

alter table public.ai_usage_events enable row level security;
-- Supabase's hosted-compatible auto-exposure grants new public tables to API roles. Usage is
-- backend-owned observability; dashboard access is only through the scoped summary RPC below.
revoke all on public.ai_usage_events from anon, authenticated, service_role;

create function public.record_agent_test_ai_usage(
  target_run_id uuid,
  target_model_tier text,
  target_route_reason text,
  target_input_tokens integer,
  target_cached_input_tokens integer,
  target_output_tokens integer,
  target_estimated_cost_microusd bigint,
  target_pricing_version text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_run public.agent_test_runs%rowtype;
begin
  select run.* into target_run
  from public.agent_test_runs as run
  where run.id = target_run_id
    and run.status in ('completed', 'failed')
    and public.is_organization_admin(run.organization_id);

  if target_run.id is null then
    raise exception using errcode = '42501', message = 'Agent test usage target is not available';
  end if;

  insert into public.ai_usage_events (
    organization_id,
    location_id,
    conversation_id,
    agent_test_run_id,
    mode,
    provider,
    model,
    model_tier,
    route_reason,
    input_tokens,
    cached_input_tokens,
    output_tokens,
    estimated_cost_microusd,
    pricing_version
  ) values (
    target_run.organization_id,
    target_run.location_id,
    target_run.conversation_id,
    target_run.id,
    'test',
    case when target_model_tier = 'deterministic' then 'deterministic' else 'openai-responses' end,
    target_run.model,
    target_model_tier,
    target_route_reason,
    target_input_tokens,
    target_cached_input_tokens,
    target_output_tokens,
    target_estimated_cost_microusd,
    btrim(target_pricing_version)
  )
  on conflict (agent_test_run_id) do nothing;
end;
$$;

create function public.record_message_ai_usage(
  target_inbound_message_id uuid,
  target_model text,
  target_model_tier text,
  target_route_reason text,
  target_input_tokens integer,
  target_cached_input_tokens integer,
  target_output_tokens integer,
  target_estimated_cost_microusd bigint,
  target_pricing_version text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_message public.messages%rowtype;
begin
  perform public.require_messaging_service_role();
  select message.* into target_message
  from public.messages as message
  join public.conversations as conversation
    on conversation.organization_id = message.organization_id
   and conversation.id = message.conversation_id
  where message.id = target_inbound_message_id
    and message.direction = 'inbound'
    and message.location_id is not null
    and conversation.mode = 'customer';

  if target_message.id is null then
    raise exception using errcode = '42501', message = 'Message usage target is not available';
  end if;

  insert into public.ai_usage_events (
    organization_id,
    location_id,
    conversation_id,
    inbound_message_id,
    mode,
    provider,
    model,
    model_tier,
    route_reason,
    input_tokens,
    cached_input_tokens,
    output_tokens,
    estimated_cost_microusd,
    pricing_version
  ) values (
    target_message.organization_id,
    target_message.location_id,
    target_message.conversation_id,
    target_message.id,
    'customer',
    case when target_model_tier = 'deterministic' then 'deterministic' else 'openai-responses' end,
    btrim(target_model),
    target_model_tier,
    target_route_reason,
    target_input_tokens,
    target_cached_input_tokens,
    target_output_tokens,
    target_estimated_cost_microusd,
    btrim(target_pricing_version)
  )
  on conflict (inbound_message_id) do nothing;
end;
$$;

create function public.get_my_ai_usage_summary(
  target_location_id uuid,
  lookback_days integer default 30
)
returns table (
  model_tier text,
  turn_count bigint,
  input_tokens bigint,
  cached_input_tokens bigint,
  output_tokens bigint,
  estimated_cost_microusd bigint,
  unknown_cost_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
begin
  if lookback_days is null or lookback_days < 1 or lookback_days > 365 then
    raise exception using errcode = '22023', message = 'AI usage lookback is invalid';
  end if;

  select location.organization_id into workspace_id
  from public.locations as location
  where location.id = target_location_id
    and public.is_organization_admin(location.organization_id);

  if workspace_id is null then
    raise exception using errcode = '42501', message = 'AI usage access is not permitted';
  end if;

  return query
  select
    usage.model_tier,
    count(*)::bigint,
    sum(usage.input_tokens)::bigint,
    sum(usage.cached_input_tokens)::bigint,
    sum(usage.output_tokens)::bigint,
    coalesce(sum(usage.estimated_cost_microusd), 0)::bigint,
    count(*) filter (where usage.estimated_cost_microusd is null)::bigint
  from public.ai_usage_events as usage
  where usage.organization_id = workspace_id
    and usage.location_id = target_location_id
    and usage.mode = 'customer'
    and usage.created_at >= now() - pg_catalog.make_interval(days => lookback_days)
  group by usage.model_tier
  order by case usage.model_tier
    when 'deterministic' then 1
    when 'luna' then 2
    when 'terra' then 3
    when 'sol' then 4
    else 5
  end;
end;
$$;

-- New public functions are executable by PUBLIC by default, and hosted-compatible Supabase local
-- posture can also auto-grant API roles. Reset every callable role explicitly before granting only
-- the two intended boundaries.
revoke all on function public.record_agent_test_ai_usage(uuid, text, text, integer, integer, integer, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_message_ai_usage(uuid, text, text, text, integer, integer, integer, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_my_ai_usage_summary(uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.record_agent_test_ai_usage(uuid, text, text, integer, integer, integer, bigint, text)
  to authenticated;
grant execute on function public.record_message_ai_usage(uuid, text, text, text, integer, integer, integer, bigint, text)
  to service_role;
grant execute on function public.get_my_ai_usage_summary(uuid, integer)
  to authenticated;

update public.platform_schema_contract
set schema_version = 24, updated_at = now()
where id;

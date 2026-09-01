-- Phase 23 closure: once a consequential claim enters a provider-write state, an unclassified
-- application/database transport failure must never downgrade that durable state to an ordinary
-- `failed/internal` result. The external provider may already have accepted the mutation.
--
-- This migration also exposes unresolved provider-crossed work as a trusted message-runtime fact.
-- If the first attempt cannot persist its human handoff (for example during the same DB outage), a
-- retry of the original inbound turn must re-enter human review instead of looking like normal AI
-- work with zero pending confirmations. The stable v1 work-state shape is hardened too so a rollback
-- binary on the newer additive schema fails closed rather than losing that review requirement.

alter function public.fail_scheduling_booking_intent(uuid, text, text)
  rename to fail_scheduling_booking_intent_without_uncertainty_guard;

create function public.fail_scheduling_booking_intent(
  target_booking_intent_id uuid,
  target_status text,
  target_error_category text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  guarded_status text := target_status;
begin
  perform public.require_scheduling_service_role();

  -- `internal` is deliberately conservative after the booking claim. It includes transport-level
  -- failures while recording provider success, where absence of a local record is not evidence that
  -- the provider write did not happen. Explicitly classified deterministic failures retain their
  -- historical status supplied by the caller.
  if target_status = 'failed' and target_error_category = 'internal' then
    guarded_status := 'provider_state_unknown';
  end if;

  perform public.fail_scheduling_booking_intent_without_uncertainty_guard(
    target_booking_intent_id,
    guarded_status,
    target_error_category
  );
end;
$$;

alter function public.fail_appointment_change_intent(uuid, text, text)
  rename to fail_appointment_change_intent_without_uncertainty_guard;

create function public.fail_appointment_change_intent(
  target_change_intent_id uuid,
  target_status text,
  target_error_category text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  guarded_status text := target_status;
begin
  perform public.require_appointment_lifecycle_service_role();

  -- The lifecycle service uses `internal` for an unclassified exception. Once the intent is in its
  -- executing state, that exception can occur after cancel/reschedule reached the provider or while
  -- provider success is being persisted. Preserve reconciliation truth instead of making a future
  -- fresh mutation possible.
  if target_status = 'failed' and target_error_category = 'internal' then
    guarded_status := 'provider_state_unknown';
  end if;

  perform public.fail_appointment_change_intent_without_uncertainty_guard(
    target_change_intent_id,
    guarded_status,
    target_error_category
  );
end;
$$;

-- Internal predicate shared by the stable rollback work-state shape and the richer current-runtime
-- shape. It is exact-message scoped only to derive the durable conversation identity; no model or
-- caller-provided action identifier participates in this decision.
create function public.customer_message_provider_review_required(target_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.messages inbound
    where inbound.id = target_message_id
      and inbound.direction = 'inbound'
      and inbound.author_type = 'customer'
      and (
        exists (
          select 1
          from public.booking_intents booking
          where booking.organization_id = inbound.organization_id
            and booking.location_id = inbound.location_id
            and booking.conversation_id = inbound.conversation_id
            and booking.status in (
              'booking', 'provider_success_pending_persistence', 'provider_state_unknown'
            )
        )
        or exists (
          select 1
          from public.appointment_change_intents change_intent
          where change_intent.organization_id = inbound.organization_id
            and change_intent.location_id = inbound.location_id
            and change_intent.conversation_id = inbound.conversation_id
            and change_intent.actor_category = 'customer'
            and change_intent.status in (
              'executing', 'provider_success_pending_persistence',
              'provider_state_unknown', 'handoff_required'
            )
        )
      )
  );
$$;

-- Keep the stable v1 RPC safe for rollback binaries. Its return shape cannot grow, so an unresolved
-- provider-crossed action is encoded as a conflict (`pending_mutation_count >= 2`). The historical
-- loader already treats that as fail-closed and requests durable human review. The current binary
-- uses v2 below so it can distinguish the exact reason without overloading the count semantically.
alter function public.get_message_agent_work_state(uuid)
  rename to get_message_agent_work_state_without_provider_review;

create function public.get_message_agent_work_state(target_message_id uuid)
returns table (
  control_state text,
  pending_mutation_intent_id uuid,
  pending_mutation_intent_type text,
  pending_mutation_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  state record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted messaging backend access is required';
  end if;

  select * into state
  from public.get_message_agent_work_state_without_provider_review(target_message_id);
  if state.control_state is null then
    raise exception using errcode = '42501', message = 'Trusted customer message is required';
  end if;

  if public.customer_message_provider_review_required(target_message_id) then
    return query select
      state.control_state::text,
      null::uuid,
      null::text,
      greatest(coalesce(state.pending_mutation_count, 0), 2)::integer;
    return;
  end if;

  return query select
    state.control_state::text,
    state.pending_mutation_intent_id::uuid,
    state.pending_mutation_intent_type::text,
    state.pending_mutation_count::integer;
end;
$$;

create function public.get_message_agent_work_state_v2(target_message_id uuid)
returns table (
  control_state text,
  pending_mutation_intent_id uuid,
  pending_mutation_intent_type text,
  pending_mutation_count integer,
  review_required boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted messaging backend access is required';
  end if;

  return query
  select state.control_state,
    state.pending_mutation_intent_id,
    state.pending_mutation_intent_type,
    state.pending_mutation_count,
    public.customer_message_provider_review_required(target_message_id)
  from public.get_message_agent_work_state(target_message_id) state;
end;
$$;

-- Renamed implementations/helpers are internal only. Stable public names preserve rollback call
-- shapes while enforcing the uncertainty/review guards for every service caller.
revoke all on function public.fail_scheduling_booking_intent_without_uncertainty_guard(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_appointment_change_intent_without_uncertainty_guard(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_scheduling_booking_intent(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.fail_appointment_change_intent(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_scheduling_booking_intent(uuid, text, text)
  to service_role;
grant execute on function public.fail_appointment_change_intent(uuid, text, text)
  to service_role;

revoke all on function public.customer_message_provider_review_required(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_message_agent_work_state_without_provider_review(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_message_agent_work_state(uuid)
  from public, anon, authenticated;
grant execute on function public.get_message_agent_work_state(uuid)
  to service_role;
revoke all on function public.get_message_agent_work_state_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.get_message_agent_work_state_v2(uuid)
  to service_role;

-- Schema 22 is declared only after the provider-uncertainty downgrade guard and retry-visible
-- human-review facts exist for both current and rollback binaries. A current binary must never
-- report ready against schema 21 without them.
update public.platform_schema_contract
set schema_version = 22, updated_at = now()
where id;

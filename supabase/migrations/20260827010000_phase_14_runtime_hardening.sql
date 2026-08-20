-- Phase 14 runtime hardening.  Additive follow-up to 20260827000000_phase_14_platform_operations:
-- that migration is already merged and is not rewritten here.  Three defects are corrected.
--
-- 1. A process heartbeat existed only as a side effect of a component heartbeat, so a core-only API
--    deployment with zero configured background workers never advanced last_heartbeat_at and was
--    reported silent while it was serving traffic.
-- 2. The operational snapshot counted every not-stopped row as active.  Silent rows are retained on
--    purpose -- silence is the diagnosis -- so a process that died ninety minutes ago still counted
--    as a live replica.
-- 3. last_error_code accepted any text up to sixty characters.  Length is not a safety property: a
--    phone number, a customer fragment, or a provider response is short enough to fit.

-- Approved operational error codes.  This is the same closed set the application enforces in
-- apps/api/src/observability/errors.ts, restated at the storage boundary so a backend bug cannot
-- persist free-form text into an operational table that operators read.
create function public.is_approved_runtime_error_code(candidate text)
returns boolean language sql immutable set search_path = '' as $$
  select candidate in (
    'provider_timeout',
    'provider_unauthorized',
    'provider_rate_limited',
    'provider_rejected',
    'provider_unavailable',
    'database_unavailable',
    'lease_conflict',
    'invalid_webhook',
    'configuration_invalid',
    'unexpected_error'
  );
$$;

-- Any row written before this migration that would not satisfy the new constraint becomes the
-- deliberate unknown code rather than blocking the migration.  Operational history is diagnostic,
-- never billing or customer state, so normalising it is safe.
update public.runtime_component_heartbeats
set last_error_code = 'unexpected_error'
where last_error_code is not null
  and not public.is_approved_runtime_error_code(last_error_code);

alter table public.runtime_component_heartbeats
  add constraint runtime_component_heartbeats_error_code_approved
  check (last_error_code is null or public.is_approved_runtime_error_code(last_error_code));

-- Heartbeat staleness is a technical liveness threshold, not a customer service level.  It is a
-- fixed multiple of the runtime heartbeat interval, and both numbers match the application
-- constants: DEFAULT_HEARTBEAT_INTERVAL_MS (25s) x STALE_HEARTBEAT_INTERVAL_MULTIPLE (4) = 100s.
-- A guard test asserts the two definitions stay in agreement.
create function public.runtime_heartbeat_stale_after()
returns interval language sql immutable set search_path = '' as $$
  select interval '100 seconds';
$$;

-- Process liveness, independent of any component.  Deliberately narrower than
-- register_runtime_instance: it updates one named row and never inserts, so it cannot create an
-- instance, and its predicate excludes stopped_at, so it can never resurrect a process that
-- deliberately stopped.  No tenant data, no host or container identity, and no table-level write
-- grant is involved -- the definer function is the entire write surface.
create function public.heartbeat_runtime_instance(target_instance_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_platform_service_role();
  if target_instance_id is null then
    raise exception using errcode = '22023', message = 'Runtime instance heartbeat is invalid';
  end if;
  update public.runtime_instances
  set last_heartbeat_at = now()
  where instance_id = target_instance_id and stopped_at is null;
end;
$$;

-- Replaced to correct the active count.  Freshness, not merely the absence of stopped_at, decides
-- whether a process is a live replica.  Stale rows are still counted and still readable through
-- get_platform_runtime_status: they are kept for diagnosis, not deleted to tidy up a number.
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
  group by intent.status;
end;
$$;

-- The new functions follow the same rule as the rest of Phase 14: nothing is callable until it is
-- explicitly granted, and the grant is exactly one narrow boundary.  is_approved_runtime_error_code
-- and runtime_heartbeat_stale_after are constraint and policy helpers, not a callable surface, so
-- they are revoked from everyone including service_role.  No table-level insert, update, or delete
-- grant on any runtime table is added.
revoke all on function
  public.is_approved_runtime_error_code(text),
  public.runtime_heartbeat_stale_after(),
  public.heartbeat_runtime_instance(uuid),
  public.get_platform_operational_snapshot()
  from public, anon, authenticated, service_role;

grant execute on function
  public.heartbeat_runtime_instance(uuid),
  public.get_platform_operational_snapshot()
  to service_role;

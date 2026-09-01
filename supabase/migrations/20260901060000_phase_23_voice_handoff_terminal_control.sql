-- Phase 23: a durable Voice handoff is a distinct terminal call outcome when no live transfer
-- succeeds. The realtime runtime gives one bounded acknowledgement and then hangs up; the durable
-- call record must preserve that truth instead of collapsing it into the generic `unknown` reason.

alter table public.calls drop constraint if exists calls_end_reason_check;
alter table public.calls
  add constraint calls_end_reason_check
    check (end_reason is null or end_reason in (
      'caller_hangup', 'handoff', 'hard_duration_limit', 'idle_timeout', 'provider_error',
      'sideband_closed', 'transfer', 'unknown'
    ));

create or replace function public.finalize_inbound_voice_call(
  target_call_id text,
  target_status text,
  target_end_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_voice_service_role();
  if target_status not in ('transferred', 'completed', 'failed', 'rejected')
    or target_end_reason not in (
      'caller_hangup', 'handoff', 'hard_duration_limit', 'idle_timeout', 'provider_error',
      'sideband_closed', 'transfer', 'unknown'
    ) then
    raise exception using errcode = '22023', message = 'Voice finalization is invalid';
  end if;
  update public.calls
  set status = target_status,
      end_reason = target_end_reason,
      ended_at = coalesce(ended_at, now())
  where provider = 'openai-realtime-sip'
    and external_call_id = target_call_id
    and status not in ('transferred', 'completed', 'failed', 'rejected');
  update public.voice_webhook_events
  set status = case when target_status = 'failed' then 'failed' else 'processed' end,
      processed_at = now()
  where external_call_id = target_call_id
    and event_type = 'realtime.call.incoming';
end;
$$;

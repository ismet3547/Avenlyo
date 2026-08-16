-- Phase 3 reliability: conversation-scoped idempotency and recoverable test turns.
-- A running turn older than 10 minutes is considered abandoned. This is substantially longer
-- than the 15 second provider timeout and bounded six-round tool loop.

alter table public.agent_test_runs
  drop constraint agent_test_runs_organization_idempotency_key_key,
  add column assistant_message_id uuid,
  add constraint agent_test_runs_organization_conversation_idempotency_key_key
    unique (organization_id, conversation_id, idempotency_key),
  add constraint agent_test_runs_assistant_message_fk
    foreign key (organization_id, assistant_message_id)
    references public.messages (organization_id, id);

create unique index agent_test_runs_one_running_conversation_idx
  on public.agent_test_runs (organization_id, conversation_id)
  where status = 'running';

create or replace function public.begin_agent_test_turn(
  target_conversation_id uuid,
  target_idempotency_key uuid,
  customer_message text,
  provider_name text,
  model_name text
)
returns table (run_id uuid, is_existing boolean, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
  workspace_location_id uuid;
  existing_run_id uuid;
  existing_status text;
begin
  select organization_id, location_id into workspace_id, workspace_location_id
  from public.require_agent_test_admin(target_conversation_id);
  if length(btrim(coalesce(customer_message, ''))) = 0 or length(customer_message) > 4000
    or provider_name is distinct from 'openai-responses'
    or length(btrim(coalesce(model_name, ''))) = 0 or length(model_name) > 120 then
    raise exception using errcode = '22023', message = 'Agent test input is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_conversation_id::text, 0));
  -- Recover only clearly abandoned work; never recreate its inbound message.
  update public.agent_test_runs as run
  set status = 'failed', failure_code = 'provider_error'
  where run.organization_id = workspace_id and run.conversation_id = target_conversation_id
    and run.status = 'running' and run.updated_at < now() - interval '10 minutes';

  select run.id, run.status into existing_run_id, existing_status
  from public.agent_test_runs as run
  where run.organization_id = workspace_id and run.conversation_id = target_conversation_id
    and run.idempotency_key = target_idempotency_key;
  if existing_run_id is not null then
    return query select existing_run_id, true, existing_status;
    return;
  end if;

  -- A different key cannot overtake a still-running logical turn.
  select run.id, run.status into existing_run_id, existing_status
  from public.agent_test_runs as run
  where run.organization_id = workspace_id and run.conversation_id = target_conversation_id
    and run.status = 'running';
  if existing_run_id is not null then
    return query select existing_run_id, true, existing_status;
    return;
  end if;

  insert into public.agent_test_runs (
    organization_id, location_id, conversation_id, initiated_by_user_id, idempotency_key, provider, model
  ) values (
    workspace_id, workspace_location_id, target_conversation_id, auth.uid(), target_idempotency_key,
    provider_name, btrim(model_name)
  ) returning id into existing_run_id;
  insert into public.messages (
    organization_id, location_id, conversation_id, direction, message_type, body, metadata, sent_at
  ) values (
    workspace_id, workspace_location_id, target_conversation_id, 'inbound', 'text', btrim(customer_message),
    jsonb_build_object('mode', 'test', 'sender', 'customer'), now()
  );
  update public.conversations set last_message_at = now()
  where id = target_conversation_id and organization_id = workspace_id;
  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (workspace_id, workspace_location_id, auth.uid(), 'agent.test.turn.started', 'conversation',
    target_conversation_id, jsonb_build_object('mode', 'test'));
  return query select existing_run_id, false, 'running'::text;
end;
$$;

create or replace function public.complete_agent_test_turn(
  target_run_id uuid, assistant_body text, source_references jsonb, tool_executions jsonb,
  handoff_requested boolean, safe_failure_code text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  target_run public.agent_test_runs%rowtype;
  safe_sources jsonb := '[]'::jsonb;
  safe_tools jsonb := '[]'::jsonb;
  assistant_id uuid;
  final_status text;
begin
  select run.* into target_run from public.agent_test_runs as run
  where run.id = target_run_id and run.status = 'running'
    and public.is_organization_admin(run.organization_id);
  if target_run.id is null then raise exception using errcode = '42501', message = 'Agent test run is not available'; end if;
  if length(btrim(coalesce(assistant_body, ''))) = 0 or length(assistant_body) > 8000 then
    raise exception using errcode = '22023', message = 'Agent response is invalid'; end if;
  if safe_failure_code is not null and safe_failure_code not in ('invalid_tool_call', 'provider_error', 'loop_limit', 'tool_failure') then
    raise exception using errcode = '22023', message = 'Agent failure code is invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('title', left(btrim(item.value ->> 'title'), 240), 'source_url', left(btrim(item.value ->> 'source_url'), 1000))), '[]'::jsonb)
  into safe_sources from (select value from jsonb_array_elements(case when jsonb_typeof(source_references) = 'array' then source_references else '[]'::jsonb end)
    where jsonb_typeof(value) = 'object' and length(btrim(coalesce(value ->> 'title', ''))) > 0
      and length(btrim(coalesce(value ->> 'source_url', ''))) > 0 limit 3) as item;
  select coalesce(jsonb_agg(jsonb_build_object('name', item.value ->> 'name', 'status', item.value ->> 'status')), '[]'::jsonb)
  into safe_tools from (select value from jsonb_array_elements(case when jsonb_typeof(tool_executions) = 'array' then tool_executions else '[]'::jsonb end)
    where jsonb_typeof(value) = 'object' and value ->> 'name' in ('search_business_knowledge', 'request_human_help')
      and value ->> 'status' in ('succeeded', 'failed', 'rejected') limit 8) as item;
  final_status := case when safe_failure_code is null then 'completed' else 'failed' end;
  insert into public.messages (organization_id, location_id, conversation_id, direction, message_type, body, metadata, sent_at)
  values (target_run.organization_id, target_run.location_id, target_run.conversation_id, 'outbound', 'text', btrim(assistant_body),
    jsonb_build_object('mode', 'test', 'model', target_run.model, 'sources', safe_sources, 'tools', safe_tools,
      'handoff_requested', coalesce(handoff_requested, false)), now()) returning id into assistant_id;
  update public.agent_test_runs set status = final_status, tool_call_count = jsonb_array_length(safe_tools),
    failure_code = safe_failure_code, assistant_message_id = assistant_id
  where id = target_run.id and status = 'running';
  if not found then raise exception using errcode = '40001', message = 'Agent test run changed; refresh and try again'; end if;
  update public.conversations set last_message_at = now()
    where id = target_run.conversation_id and organization_id = target_run.organization_id;
  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (target_run.organization_id, target_run.location_id, auth.uid(), 'agent.test.turn.completed', 'agent_test_run', target_run.id,
    jsonb_build_object('mode', 'test', 'failure_code', safe_failure_code, 'handoff_requested', coalesce(handoff_requested, false)));
end;
$$;

create function public.get_agent_test_turn_result(target_run_id uuid)
returns table (run_id uuid, status text, failure_code text, model text, assistant_body text, source_references jsonb, tool_executions jsonb, handoff_requested boolean)
language sql stable security definer set search_path = ''
as $$
  select run.id, run.status, run.failure_code, run.model, message.body,
    coalesce(message.metadata -> 'sources', '[]'::jsonb), coalesce(message.metadata -> 'tools', '[]'::jsonb),
    coalesce((message.metadata ->> 'handoff_requested')::boolean, false)
  from public.agent_test_runs run
  left join public.messages message on message.organization_id = run.organization_id and message.id = run.assistant_message_id
  where run.id = target_run_id and public.is_organization_admin(run.organization_id);
$$;

create function public.fail_agent_test_turn(target_run_id uuid, safe_failure_code text default 'provider_error')
returns void language plpgsql security definer set search_path = ''
as $$
declare target_run public.agent_test_runs%rowtype;
begin
  select run.* into target_run from public.agent_test_runs run
  where run.id = target_run_id and public.is_organization_admin(run.organization_id);
  if target_run.id is null then raise exception using errcode = '42501', message = 'Agent test run is not available'; end if;
  if safe_failure_code not in ('invalid_tool_call', 'provider_error', 'loop_limit', 'tool_failure') then
    raise exception using errcode = '22023', message = 'Agent failure code is invalid'; end if;
  update public.agent_test_runs set status = 'failed', failure_code = safe_failure_code
    where id = target_run.id and status = 'running';
end;
$$;

revoke all on function public.get_agent_test_turn_result(uuid) from public;
revoke all on function public.fail_agent_test_turn(uuid, text) from public;
grant execute on function public.get_agent_test_turn_result(uuid) to authenticated;
grant execute on function public.fail_agent_test_turn(uuid, text) to authenticated;

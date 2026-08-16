-- Phase 3 keeps test-mode agent activity separate from customer operations.  Authenticated
-- clients can read only authorized rows; test state is mutated solely by the RPCs below.

alter table public.conversations
  add column mode text not null default 'customer'
    check (mode in ('customer', 'test')),
  add column test_owner_user_id uuid,
  add constraint conversations_test_owner_member_fk
    foreign key (organization_id, test_owner_user_id)
    references public.organization_members (organization_id, user_id),
  add constraint conversations_test_owner_check
    check ((mode = 'customer' and test_owner_user_id is null) or (mode = 'test' and test_owner_user_id is not null));

alter table public.handoffs
  add column mode text not null default 'customer'
    check (mode in ('customer', 'test')),
  add column urgency text not null default 'normal'
    check (urgency in ('normal', 'urgent')),
  add column idempotency_key text;

create unique index handoffs_organization_idempotency_key_idx
  on public.handoffs (organization_id, idempotency_key)
  where idempotency_key is not null;

create table public.agent_test_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  conversation_id uuid not null,
  initiated_by_user_id uuid not null,
  idempotency_key uuid not null,
  provider text not null check (provider in ('openai-responses')),
  model text not null check (length(btrim(model)) between 1 and 120),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  tool_call_count integer not null default 0 check (tool_call_count between 0 and 8),
  failure_code text check (failure_code is null or failure_code in ('invalid_tool_call', 'provider_error', 'loop_limit', 'tool_failure')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_test_runs_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint agent_test_runs_conversation_fk
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint agent_test_runs_initiator_member_fk
    foreign key (organization_id, initiated_by_user_id)
    references public.organization_members (organization_id, user_id),
  constraint agent_test_runs_organization_idempotency_key_key unique (organization_id, idempotency_key)
);

create index agent_test_runs_conversation_created_at_idx
  on public.agent_test_runs (conversation_id, created_at);

create trigger set_agent_test_runs_updated_at
  before update on public.agent_test_runs
  for each row execute procedure public.set_updated_at();

alter table public.agent_test_runs enable row level security;
revoke all on public.agent_test_runs from anon, authenticated;
grant select on public.agent_test_runs to authenticated;

create policy agent_test_runs_select_admin on public.agent_test_runs
  for select to authenticated
  using (public.is_organization_admin(organization_id));

-- Test conversations are intentionally invisible to normal location-scoped members.  Existing
-- customer operational access is retained without granting a direct test-mode write path.
drop policy conversations_select_member on public.conversations;
drop policy conversations_insert_member on public.conversations;
drop policy conversations_update_member on public.conversations;
drop policy conversations_delete_admin on public.conversations;
drop policy messages_select_member on public.messages;
drop policy messages_insert_member on public.messages;
drop policy messages_update_member on public.messages;
drop policy messages_delete_admin on public.messages;
drop policy handoffs_select_member on public.handoffs;
drop policy handoffs_insert_member on public.handoffs;
drop policy handoffs_update_member on public.handoffs;
drop policy handoffs_delete_admin on public.handoffs;
drop policy action_logs_select_member on public.action_logs;

create policy conversations_select_member on public.conversations
  for select to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and (mode = 'customer' or public.is_organization_admin(organization_id))
  );
create policy conversations_insert_member on public.conversations
  for insert to authenticated
  with check (
    public.has_location_write_access(organization_id, location_id)
    and mode = 'customer'
    and test_owner_user_id is null
  );
create policy conversations_update_member on public.conversations
  for update to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and mode = 'customer'
  )
  with check (
    public.has_location_write_access(organization_id, location_id)
    and mode = 'customer'
    and test_owner_user_id is null
  );
create policy conversations_delete_admin on public.conversations
  for delete to authenticated
  using (public.is_organization_admin(organization_id) and mode = 'customer');

create policy messages_select_member on public.messages
  for select to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and exists (
      select 1 from public.conversations as conversation
      where conversation.organization_id = messages.organization_id
        and conversation.id = messages.conversation_id
        and (conversation.mode = 'customer' or public.is_organization_admin(messages.organization_id))
    )
  );
create policy messages_insert_member on public.messages
  for insert to authenticated
  with check (
    public.has_location_write_access(organization_id, location_id)
    and exists (
      select 1 from public.conversations as conversation
      where conversation.organization_id = messages.organization_id
        and conversation.id = messages.conversation_id
        and conversation.mode = 'customer'
    )
  );
create policy messages_update_member on public.messages
  for update to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and exists (
      select 1 from public.conversations as conversation
      where conversation.organization_id = messages.organization_id
        and conversation.id = messages.conversation_id
        and conversation.mode = 'customer'
    )
  )
  with check (
    public.has_location_write_access(organization_id, location_id)
    and exists (
      select 1 from public.conversations as conversation
      where conversation.organization_id = messages.organization_id
        and conversation.id = messages.conversation_id
        and conversation.mode = 'customer'
    )
  );
create policy messages_delete_admin on public.messages
  for delete to authenticated
  using (
    public.is_organization_admin(organization_id)
    and exists (
      select 1 from public.conversations as conversation
      where conversation.organization_id = messages.organization_id
        and conversation.id = messages.conversation_id
        and conversation.mode = 'customer'
    )
  );

create policy handoffs_select_member on public.handoffs
  for select to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and exists (
      select 1 from public.conversations as conversation
      where conversation.organization_id = handoffs.organization_id
        and conversation.id = handoffs.conversation_id
        and (conversation.mode = 'customer' or public.is_organization_admin(handoffs.organization_id))
    )
  );
create policy handoffs_insert_member on public.handoffs
  for insert to authenticated
  with check (
    public.has_location_write_access(organization_id, location_id)
    and mode = 'customer'
    and exists (
      select 1 from public.conversations as conversation
      where conversation.organization_id = handoffs.organization_id
        and conversation.id = handoffs.conversation_id
        and conversation.mode = 'customer'
    )
  );
create policy handoffs_update_member on public.handoffs
  for update to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and mode = 'customer'
  )
  with check (
    public.has_location_write_access(organization_id, location_id)
    and mode = 'customer'
  );
create policy handoffs_delete_admin on public.handoffs
  for delete to authenticated
  using (public.is_organization_admin(organization_id) and mode = 'customer');

create policy action_logs_select_member on public.action_logs
  for select to authenticated
  using (
    public.has_location_access(organization_id, location_id)
    and (
      coalesce(details ->> 'mode', 'customer') <> 'test'
      or public.is_organization_admin(organization_id)
    )
  );

create function public.require_agent_test_admin(target_conversation_id uuid)
returns table (organization_id uuid, location_id uuid, initiated_by_user_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select conversation.organization_id, conversation.location_id, conversation.test_owner_user_id
  from public.conversations as conversation
  where conversation.id = target_conversation_id
    and conversation.mode = 'test'
    and public.is_organization_admin(conversation.organization_id);

  if not found then
    raise exception using errcode = '42501', message = 'Agent test access is not permitted';
  end if;
end;
$$;

create function public.create_agent_test_conversation(target_location_id uuid)
returns table (conversation_id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  select location.organization_id into workspace_id
  from public.locations as location
  where location.id = target_location_id
    and public.is_organization_admin(location.organization_id);

  if workspace_id is null then
    raise exception using errcode = '42501', message = 'An organization owner or admin is required';
  end if;

  return query
  insert into public.conversations (
    organization_id, location_id, status, mode, test_owner_user_id, metadata
  )
  values (
    workspace_id,
    target_location_id,
    'open',
    'test',
    auth.uid(),
    jsonb_build_object('mode', 'test')
  )
  returning conversations.id, conversations.created_at;
end;
$$;

create function public.get_agent_test_conversation(target_conversation_id uuid)
returns table (
  message_id uuid,
  body text,
  direction text,
  metadata jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select message.id, message.body, message.direction, message.metadata, message.created_at
  from public.messages as message
  join public.conversations as conversation
    on conversation.organization_id = message.organization_id
    and conversation.id = message.conversation_id
  where message.conversation_id = target_conversation_id
    and conversation.mode = 'test'
    and public.is_organization_admin(conversation.organization_id)
  order by message.created_at asc, message.id asc;
$$;

create function public.begin_agent_test_turn(
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
  select organization_id, location_id
    into workspace_id, workspace_location_id
  from public.require_agent_test_admin(target_conversation_id);

  if length(btrim(coalesce(customer_message, ''))) = 0
    or length(customer_message) > 4000
    or provider_name is distinct from 'openai-responses'
    or length(btrim(coalesce(model_name, ''))) = 0
    or length(model_name) > 120
  then
    raise exception using errcode = '22023', message = 'Agent test input is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_conversation_id::text, 0)
  );

  select run.id, run.status into existing_run_id, existing_status
  from public.agent_test_runs as run
  where run.organization_id = workspace_id
    and run.idempotency_key = target_idempotency_key;

  if existing_run_id is not null then
    return query select existing_run_id, true, existing_status;
    return;
  end if;

  insert into public.agent_test_runs (
    organization_id, location_id, conversation_id, initiated_by_user_id, idempotency_key, provider, model
  )
  values (
    workspace_id, workspace_location_id, target_conversation_id, auth.uid(), target_idempotency_key,
    provider_name, btrim(model_name)
  )
  returning id into existing_run_id;

  insert into public.messages (
    organization_id, location_id, conversation_id, direction, message_type, body, metadata, sent_at
  )
  values (
    workspace_id, workspace_location_id, target_conversation_id, 'inbound', 'text',
    btrim(customer_message), jsonb_build_object('mode', 'test', 'sender', 'customer'), now()
  );

  update public.conversations
  set last_message_at = now()
  where id = target_conversation_id and organization_id = workspace_id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    workspace_id, workspace_location_id, auth.uid(), 'agent.test.turn.started', 'conversation',
    target_conversation_id, jsonb_build_object('mode', 'test')
  );

  return query select existing_run_id, false, 'running'::text;
end;
$$;

create function public.complete_agent_test_turn(
  target_run_id uuid,
  assistant_body text,
  source_references jsonb,
  tool_executions jsonb,
  handoff_requested boolean,
  safe_failure_code text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_run public.agent_test_runs%rowtype;
  safe_sources jsonb := '[]'::jsonb;
  safe_tools jsonb := '[]'::jsonb;
  final_status text;
begin
  select run.* into target_run
  from public.agent_test_runs as run
  where run.id = target_run_id
    and run.status = 'running'
    and public.is_organization_admin(run.organization_id);

  if target_run.id is null then
    raise exception using errcode = '42501', message = 'Agent test run is not available';
  end if;
  if length(btrim(coalesce(assistant_body, ''))) = 0 or length(assistant_body) > 8000 then
    raise exception using errcode = '22023', message = 'Agent response is invalid';
  end if;
  if safe_failure_code is not null and safe_failure_code not in ('invalid_tool_call', 'provider_error', 'loop_limit', 'tool_failure') then
    raise exception using errcode = '22023', message = 'Agent failure code is invalid';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'title', left(btrim(item.value ->> 'title'), 240),
    'source_url', left(btrim(item.value ->> 'source_url'), 1000)
  )), '[]'::jsonb)
  into safe_sources
  from (
    select value
    from jsonb_array_elements(
      case when jsonb_typeof(source_references) = 'array' then source_references else '[]'::jsonb end
    )
    where jsonb_typeof(value) = 'object'
      and length(btrim(coalesce(value ->> 'title', ''))) > 0
      and length(btrim(coalesce(value ->> 'source_url', ''))) > 0
    limit 3
  ) as item;

  select coalesce(jsonb_agg(jsonb_build_object(
    'name', item.value ->> 'name',
    'status', item.value ->> 'status'
  )), '[]'::jsonb)
  into safe_tools
  from (
    select value
    from jsonb_array_elements(
      case when jsonb_typeof(tool_executions) = 'array' then tool_executions else '[]'::jsonb end
    )
    where jsonb_typeof(value) = 'object'
      and value ->> 'name' in ('search_business_knowledge', 'request_human_help')
      and value ->> 'status' in ('succeeded', 'failed', 'rejected')
    limit 8
  ) as item;

  final_status := case when safe_failure_code is null then 'completed' else 'failed' end;
  update public.agent_test_runs
  set
    status = final_status,
    tool_call_count = jsonb_array_length(safe_tools),
    failure_code = safe_failure_code
  where id = target_run.id
    and status = 'running';

  if not found then
    raise exception using errcode = '40001', message = 'Agent test run changed; refresh and try again';
  end if;

  insert into public.messages (
    organization_id, location_id, conversation_id, direction, message_type, body, metadata, sent_at
  )
  values (
    target_run.organization_id, target_run.location_id, target_run.conversation_id,
    'outbound', 'text', btrim(assistant_body),
    jsonb_build_object(
      'mode', 'test',
      'model', target_run.model,
      'sources', safe_sources,
      'tools', safe_tools,
      'handoff_requested', coalesce(handoff_requested, false)
    ),
    now()
  );

  update public.conversations
  set last_message_at = now()
  where id = target_run.conversation_id and organization_id = target_run.organization_id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    target_run.organization_id, target_run.location_id, auth.uid(), 'agent.test.turn.completed',
    'agent_test_run', target_run.id,
    jsonb_build_object('mode', 'test', 'failure_code', safe_failure_code, 'handoff_requested', coalesce(handoff_requested, false))
  );
end;
$$;

create function public.record_agent_test_knowledge_search(
  target_conversation_id uuid,
  tool_call_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
  workspace_location_id uuid;
begin
  select organization_id, location_id into workspace_id, workspace_location_id
  from public.require_agent_test_admin(target_conversation_id);
  if length(btrim(coalesce(tool_call_id, ''))) = 0 or length(tool_call_id) > 128 then
    raise exception using errcode = '22023', message = 'Tool call is invalid';
  end if;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    workspace_id, workspace_location_id, auth.uid(), 'agent.knowledge.searched', 'conversation',
    target_conversation_id, jsonb_build_object('mode', 'test', 'tool_call_id', btrim(tool_call_id))
  );
end;
$$;

create function public.request_agent_test_handoff(
  target_conversation_id uuid,
  tool_call_id text,
  handoff_reason text,
  handoff_urgency text
)
returns table (handoff_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
  workspace_location_id uuid;
  persisted_handoff_id uuid;
  inserted boolean := false;
  key text;
begin
  select organization_id, location_id into workspace_id, workspace_location_id
  from public.require_agent_test_admin(target_conversation_id);
  if length(btrim(coalesce(tool_call_id, ''))) = 0 or length(tool_call_id) > 128
    or length(btrim(coalesce(handoff_reason, ''))) < 3 or length(handoff_reason) > 500
    or handoff_urgency is null
    or handoff_urgency not in ('normal', 'urgent')
  then
    raise exception using errcode = '22023', message = 'Handoff input is invalid';
  end if;

  key := 'agent-test:' || target_conversation_id::text || ':' || btrim(tool_call_id);
  insert into public.handoffs (
    organization_id, location_id, conversation_id, reason, mode, urgency, idempotency_key
  )
  values (
    workspace_id, workspace_location_id, target_conversation_id, btrim(handoff_reason),
    'test', handoff_urgency, key
  )
  on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into persisted_handoff_id;

  if persisted_handoff_id is not null then
    inserted := true;
  else
    select id into persisted_handoff_id
    from public.handoffs
    where organization_id = workspace_id and idempotency_key = key;
  end if;

  if persisted_handoff_id is null then
    raise exception using errcode = '40001', message = 'Agent handoff could not be persisted';
  end if;

  if inserted then
    insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id, details)
    values (
      workspace_id, workspace_location_id, auth.uid(), 'agent.handoff.requested', 'handoff',
      persisted_handoff_id, jsonb_build_object('mode', 'test', 'urgency', handoff_urgency)
    );
  end if;

  return query select persisted_handoff_id, true;
end;
$$;

revoke all on function public.require_agent_test_admin(uuid) from public;
revoke all on function public.create_agent_test_conversation(uuid) from public;
revoke all on function public.get_agent_test_conversation(uuid) from public;
revoke all on function public.begin_agent_test_turn(uuid, uuid, text, text, text) from public;
revoke all on function public.complete_agent_test_turn(uuid, text, jsonb, jsonb, boolean, text) from public;
revoke all on function public.record_agent_test_knowledge_search(uuid, text) from public;
revoke all on function public.request_agent_test_handoff(uuid, text, text, text) from public;

grant execute on function public.create_agent_test_conversation(uuid) to authenticated;
grant execute on function public.get_agent_test_conversation(uuid) to authenticated;
grant execute on function public.begin_agent_test_turn(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.complete_agent_test_turn(uuid, text, jsonb, jsonb, boolean, text) to authenticated;
grant execute on function public.record_agent_test_knowledge_search(uuid, text) to authenticated;
grant execute on function public.request_agent_test_handoff(uuid, text, text, text) to authenticated;

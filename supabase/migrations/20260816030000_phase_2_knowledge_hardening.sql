-- Phase 2 hardening: publishing reservations, location isolation, and immutable snapshots.
-- This migration intentionally supersedes only Phase 2 function definitions.

create or replace function public.fail_knowledge_import(
  target_import_id uuid,
  safe_error_code text default 'import_failed',
  safe_error_message text default 'Knowledge import could not be completed.'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
begin
  update public.knowledge_imports
  set
    status = 'failed',
    error_code = left(coalesce(safe_error_code, 'import_failed'), 64),
    error_message = left(coalesce(safe_error_message, 'Knowledge import could not be completed.'), 240),
    finished_at = now()
  where id = target_import_id
    and organization_id = workspace_id
    and status in ('pending', 'running');

  if not found then
    raise exception using errcode = '23514', message = 'Knowledge import cannot be failed';
  end if;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    workspace_id,
    auth.uid(),
    'knowledge.import.failed',
    'knowledge_import',
    target_import_id,
    jsonb_build_object('code', left(coalesce(safe_error_code, 'import_failed'), 64))
  );
end;
$$;

create or replace function public.update_knowledge_document_draft(
  target_document_id uuid,
  draft_title text,
  draft_content text,
  is_included boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
begin
  select knowledge_document.organization_id
    into workspace_id
  from public.knowledge_documents as knowledge_document
  join public.knowledge_imports as knowledge_import
    on knowledge_import.organization_id = knowledge_document.organization_id
    and knowledge_import.id = knowledge_document.import_id
  where knowledge_document.id = target_document_id
    and knowledge_document.status = 'draft'
    and knowledge_import.status = 'awaiting_review'
    and public.is_organization_admin(knowledge_document.organization_id);

  if workspace_id is null then
    raise exception using errcode = '42501', message = 'Knowledge draft access is not permitted';
  end if;
  if length(btrim(coalesce(draft_title, ''))) = 0
    or length(btrim(draft_title)) > 240
    or length(btrim(coalesce(draft_content, ''))) < 40
    or length(draft_content) > 1000000
  then
    raise exception using errcode = '22023', message = 'Knowledge draft content is invalid';
  end if;

  -- Recheck the import state in the mutating statement. A concurrent publish reservation
  -- cannot be followed by a late draft edit that changes the embedding snapshot.
  update public.knowledge_documents as knowledge_document
  set
    title = btrim(draft_title),
    content = btrim(draft_content),
    content_hash = encode(extensions.digest(btrim(draft_content), 'sha256'), 'hex'),
    included = is_included
  where knowledge_document.id = target_document_id
    and knowledge_document.organization_id = workspace_id
    and knowledge_document.status = 'draft'
    and exists (
      select 1
      from public.knowledge_imports as knowledge_import
      where knowledge_import.organization_id = knowledge_document.organization_id
        and knowledge_import.id = knowledge_document.import_id
        and knowledge_import.status = 'awaiting_review'
    );

  if not found then
    raise exception using errcode = '40001', message = 'Knowledge import changed; refresh and try again';
  end if;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id)
  values (workspace_id, auth.uid(), 'knowledge.document.edited', 'knowledge_document', target_document_id);
end;
$$;

create function public.begin_knowledge_publish(target_import_id uuid)
returns table (document_id uuid, title text, content text, content_hash text, source_url text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
begin
  if not exists (
    select 1
    from public.knowledge_documents as knowledge_document
    where knowledge_document.organization_id = workspace_id
      and knowledge_document.import_id = target_import_id
      and knowledge_document.status = 'draft'
      and knowledge_document.included
  ) then
    raise exception using errcode = '23514', message = 'Include at least one knowledge page before publishing';
  end if;

  -- This single state transition is the publication reservation. It commits before any
  -- network work happens, so only one caller receives the immutable draft snapshot.
  update public.knowledge_imports
  set status = 'publishing', error_code = null, error_message = null
  where id = target_import_id
    and organization_id = workspace_id
    and status = 'awaiting_review';

  if not found then
    raise exception using errcode = '23514', message = 'Knowledge import is already publishing or unavailable';
  end if;

  return query
  select
    knowledge_document.id,
    knowledge_document.title,
    knowledge_document.content,
    knowledge_document.content_hash,
    knowledge_document.canonical_url
  from public.knowledge_documents as knowledge_document
  where knowledge_document.organization_id = workspace_id
    and knowledge_document.import_id = target_import_id
    and knowledge_document.status = 'draft'
    and knowledge_document.included
  order by knowledge_document.created_at, knowledge_document.id;
end;
$$;

create function public.complete_knowledge_publish(
  target_import_id uuid,
  document_versions jsonb,
  generated_chunks jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
  target_location_id uuid;
  persisted_chunks integer;
begin
  if jsonb_typeof(document_versions) <> 'array' or jsonb_typeof(generated_chunks) <> 'array' then
    raise exception using errcode = '22023', message = 'Knowledge publication data is invalid';
  end if;

  select knowledge_import.location_id
    into target_location_id
  from public.knowledge_imports as knowledge_import
  where knowledge_import.id = target_import_id
    and knowledge_import.organization_id = workspace_id
    and knowledge_import.status = 'publishing'
  for update;

  if not found then
    raise exception using errcode = '23514', message = 'Knowledge import is not reserved for publishing';
  end if;
  if exists (
    select 1
    from public.knowledge_documents as knowledge_document
    left join jsonb_to_recordset(document_versions) as version(document_id uuid, content_hash text)
      on version.document_id = knowledge_document.id
    where knowledge_document.organization_id = workspace_id
      and knowledge_document.import_id = target_import_id
      and knowledge_document.status = 'draft'
      and knowledge_document.included
      and (version.document_id is null or version.content_hash <> knowledge_document.content_hash)
  ) then
    raise exception using errcode = '40001', message = 'Knowledge drafts changed; review and publish again';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(generated_chunks) as chunk(
      chunk_index integer,
      content text,
      content_hash text,
      document_id uuid,
      embedding text,
      embedding_model text,
      embedding_provider text
    )
    left join public.knowledge_documents as knowledge_document
      on knowledge_document.id = chunk.document_id
      and knowledge_document.organization_id = workspace_id
      and knowledge_document.import_id = target_import_id
      and knowledge_document.status = 'draft'
      and knowledge_document.included
    where knowledge_document.id is null
      or chunk.chunk_index < 0
      or length(btrim(coalesce(chunk.content, ''))) < 40
      or chunk.content_hash !~ '^[0-9a-f]{64}$'
      or chunk.content_hash <> encode(extensions.digest(chunk.content, 'sha256'), 'hex')
      or length(btrim(coalesce(chunk.embedding_provider, ''))) = 0
      or length(btrim(coalesce(chunk.embedding_model, ''))) = 0
      or extensions.vector_dims(chunk.embedding::extensions.vector) <> 1536
  ) then
    raise exception using errcode = '22023', message = 'Knowledge embeddings are invalid';
  end if;
  if exists (
    select 1
    from public.knowledge_documents as knowledge_document
    where knowledge_document.organization_id = workspace_id
      and knowledge_document.import_id = target_import_id
      and knowledge_document.status = 'draft'
      and knowledge_document.included
      and not exists (
        select 1
        from jsonb_to_recordset(generated_chunks) as chunk(document_id uuid)
        where chunk.document_id = knowledge_document.id
      )
  ) then
    raise exception using errcode = '22023', message = 'Every included document requires embeddings';
  end if;

  insert into public.knowledge_chunks (
    organization_id, location_id, document_id, content, chunk_index, embedding,
    content_hash, embedding_provider, embedding_model, embedded_at
  )
  select
    workspace_id,
    knowledge_document.location_id,
    chunk.document_id,
    chunk.content,
    chunk.chunk_index,
    chunk.embedding::extensions.vector,
    chunk.content_hash,
    chunk.embedding_provider,
    chunk.embedding_model,
    now()
  from jsonb_to_recordset(generated_chunks) as chunk(
    chunk_index integer,
    content text,
    content_hash text,
    document_id uuid,
    embedding text,
    embedding_model text,
    embedding_provider text
  )
  join public.knowledge_documents as knowledge_document
    on knowledge_document.organization_id = workspace_id
    and knowledge_document.id = chunk.document_id
    and knowledge_document.import_id = target_import_id;

  get diagnostics persisted_chunks = row_count;
  if persisted_chunks = 0 then
    raise exception using errcode = '22023', message = 'Knowledge publication has no chunks';
  end if;

  update public.knowledge_documents
  set status = 'ready'
  where organization_id = workspace_id
    and import_id = target_import_id
    and status = 'draft'
    and included;

  update public.knowledge_documents
  set status = 'archived'
  where organization_id = workspace_id
    and source_type = 'website'
    and import_id = target_import_id
    and status = 'draft'
    and not included;

  -- A location replacement only retires ready website documents in the same source scope.
  -- `is not distinct from` safely treats two organization-wide (NULL) sources as equal.
  update public.knowledge_documents
  set status = 'archived'
  where organization_id = workspace_id
    and source_type = 'website'
    and import_id <> target_import_id
    and location_id is not distinct from target_location_id
    and status = 'ready';

  update public.knowledge_imports
  set status = 'completed', finished_at = now(), error_code = null, error_message = null
  where id = target_import_id and organization_id = workspace_id and status = 'publishing';

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    workspace_id,
    auth.uid(),
    'knowledge.published',
    'knowledge_import',
    target_import_id,
    jsonb_build_object('chunk_count', persisted_chunks)
  );
  return persisted_chunks;
end;
$$;

create function public.release_knowledge_publish(
  target_import_id uuid,
  safe_error_code text default 'publication_failed',
  safe_error_message text default 'Knowledge could not be published right now. Please try again.'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
begin
  update public.knowledge_imports
  set
    status = 'awaiting_review',
    error_code = left(coalesce(safe_error_code, 'publication_failed'), 64),
    error_message = left(coalesce(safe_error_message, 'Knowledge could not be published right now. Please try again.'), 240)
  where id = target_import_id
    and organization_id = workspace_id
    and status = 'publishing';

  if not found then
    raise exception using errcode = '23514', message = 'Knowledge import is not publishing';
  end if;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    workspace_id,
    auth.uid(),
    'knowledge.publish.released',
    'knowledge_import',
    target_import_id,
    jsonb_build_object('code', left(coalesce(safe_error_code, 'publication_failed'), 64))
  );
end;
$$;

create function public.recover_stale_knowledge_publish(target_import_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
begin
  update public.knowledge_imports
  set
    status = 'awaiting_review',
    error_code = 'publication_recovered',
    error_message = 'A stalled publication was returned to review. Please publish again.'
  where id = target_import_id
    and organization_id = workspace_id
    and status = 'publishing'
    and updated_at <= now() - interval '15 minutes';

  if not found then
    raise exception using errcode = '23514', message = 'Knowledge publication is still active or unavailable';
  end if;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id)
  values (workspace_id, auth.uid(), 'knowledge.publish.recovered', 'knowledge_import', target_import_id);
end;
$$;

create or replace function public.get_my_knowledge_overview()
returns table (
  import_id uuid,
  root_url text,
  status text,
  pages_discovered integer,
  pages_imported integer,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  draft_documents integer,
  ready_documents integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    knowledge_import.id,
    knowledge_import.root_url,
    knowledge_import.status,
    knowledge_import.pages_discovered,
    knowledge_import.pages_imported,
    knowledge_import.error_message,
    knowledge_import.started_at,
    knowledge_import.finished_at,
    count(*) filter (where knowledge_document.status = 'draft')::integer,
    count(*) filter (where knowledge_document.status = 'ready')::integer
  from public.knowledge_imports as knowledge_import
  left join public.knowledge_documents as knowledge_document
    on knowledge_document.organization_id = knowledge_import.organization_id
    and knowledge_document.import_id = knowledge_import.id
  where public.is_organization_member(knowledge_import.organization_id)
    and public.has_location_access(knowledge_import.organization_id, knowledge_import.location_id)
  group by knowledge_import.id
  order by knowledge_import.created_at desc;
$$;

revoke all on function public.get_knowledge_import_publication_snapshot(uuid) from authenticated;
revoke all on function public.publish_knowledge_import(uuid, jsonb, jsonb) from authenticated;
revoke all on function public.begin_knowledge_publish(uuid) from public;
revoke all on function public.complete_knowledge_publish(uuid, jsonb, jsonb) from public;
revoke all on function public.release_knowledge_publish(uuid, text, text) from public;
revoke all on function public.recover_stale_knowledge_publish(uuid) from public;

grant execute on function public.begin_knowledge_publish(uuid) to authenticated;
grant execute on function public.complete_knowledge_publish(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.release_knowledge_publish(uuid, text, text) to authenticated;
grant execute on function public.recover_stale_knowledge_publish(uuid) to authenticated;

-- Phase 2: reviewed website knowledge, embedding metadata, and tenant-safe retrieval.
-- This migration is additive; the Phase 0 and Phase 1 migrations remain immutable.

create table public.knowledge_imports (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  source_type text not null default 'website' check (source_type = 'website'),
  root_url text not null check (length(btrim(root_url)) between 1 and 2_048),
  status text not null default 'pending' check (
    status in ('pending', 'running', 'awaiting_review', 'publishing', 'completed', 'failed')
  ),
  pages_discovered integer not null default 0 check (pages_discovered >= 0),
  pages_imported integer not null default 0 check (pages_imported >= 0),
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_imports_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint knowledge_imports_state_check check (
    (status in ('pending', 'running', 'awaiting_review', 'publishing') and finished_at is null)
    or (status in ('completed', 'failed') and finished_at is not null)
  ),
  constraint knowledge_imports_organization_id_id_key unique (organization_id, id)
);

create trigger set_knowledge_imports_updated_at
  before update on public.knowledge_imports
  for each row execute procedure public.set_updated_at();

create unique index knowledge_imports_active_root_url_key
  on public.knowledge_imports (organization_id, root_url)
  where status in ('pending', 'running');

alter table public.knowledge_documents
  add column import_id uuid,
  add column content text,
  add column content_hash text,
  add column canonical_url text,
  add column included boolean not null default true,
  add column last_crawled_at timestamptz,
  add constraint knowledge_documents_import_fk
    foreign key (organization_id, import_id)
    references public.knowledge_imports (organization_id, id) on delete cascade,
  add constraint knowledge_documents_website_fields_check check (
    source_type <> 'website'
    or (
      import_id is not null
      and content is not null
      and content_hash is not null
      and canonical_url is not null
    )
  );

create unique index knowledge_documents_import_canonical_url_key
  on public.knowledge_documents (import_id, canonical_url)
  where import_id is not null;
create unique index knowledge_documents_import_content_hash_key
  on public.knowledge_documents (import_id, content_hash)
  where import_id is not null;
create index knowledge_documents_import_status_idx
  on public.knowledge_documents (import_id, status);

alter table public.knowledge_chunks
  add column content_hash text,
  add column embedding_provider text,
  add column embedding_model text,
  add column embedded_at timestamptz;

create index knowledge_chunks_organization_location_idx
  on public.knowledge_chunks (organization_id, location_id);

alter table public.knowledge_imports enable row level security;

create policy knowledge_imports_select_member on public.knowledge_imports
  for select to authenticated
  using (public.has_location_access(organization_id, location_id));

-- Existing foundational policies allowed direct administration of generic knowledge tables. In
-- Phase 2, document review and chunk persistence must flow through the narrow RPCs below.
drop policy knowledge_documents_insert_admin on public.knowledge_documents;
drop policy knowledge_documents_update_admin on public.knowledge_documents;
drop policy knowledge_documents_delete_admin on public.knowledge_documents;
drop policy knowledge_chunks_select_member on public.knowledge_chunks;
drop policy knowledge_chunks_insert_admin on public.knowledge_chunks;
drop policy knowledge_chunks_update_admin on public.knowledge_chunks;
drop policy knowledge_chunks_delete_admin on public.knowledge_chunks;

revoke insert, update, delete on public.knowledge_documents from authenticated;
revoke all on public.knowledge_chunks from authenticated;
grant select on public.knowledge_documents, public.knowledge_imports to authenticated;

create function public.require_knowledge_manager_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
begin
  select member.organization_id
    into workspace_id
  from public.organization_members as member
  join public.organization_onboarding as onboarding
    on onboarding.organization_id = member.organization_id
  where member.user_id = auth.uid()
    and member.role in ('owner', 'admin')
    and onboarding.status = 'completed'
  order by member.created_at, member.id
  limit 1;

  if workspace_id is null then
    raise exception using errcode = '42501', message = 'An organization owner or admin is required';
  end if;

  return workspace_id;
end;
$$;

create function public.require_knowledge_import_manager(target_import_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
begin
  select knowledge_import.organization_id
    into workspace_id
  from public.knowledge_imports as knowledge_import
  where knowledge_import.id = target_import_id
    and public.is_organization_admin(knowledge_import.organization_id);

  if workspace_id is null then
    raise exception using errcode = '42501', message = 'Knowledge import access is not permitted';
  end if;

  return workspace_id;
end;
$$;

create function public.create_knowledge_import(
  root_url_input text,
  requested_location_id uuid default null
)
returns table (import_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_manager_organization();
  new_import_id uuid;
begin
  if length(btrim(coalesce(root_url_input, ''))) = 0 then
    raise exception using errcode = '22023', message = 'Website URL is required';
  end if;

  if requested_location_id is not null and not exists (
    select 1 from public.locations as location
    where location.organization_id = workspace_id and location.id = requested_location_id
  ) then
    raise exception using errcode = '23503', message = 'Knowledge import location is unavailable';
  end if;

  insert into public.knowledge_imports (organization_id, location_id, root_url)
  values (workspace_id, requested_location_id, btrim(root_url_input))
  returning id into new_import_id;

  insert into public.action_logs (organization_id, location_id, actor_user_id, action, entity_type, entity_id)
  values (workspace_id, requested_location_id, auth.uid(), 'knowledge.import.started', 'knowledge_import', new_import_id);

  return query select new_import_id, 'pending'::text;
end;
$$;

create function public.start_knowledge_import(target_import_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
begin
  update public.knowledge_imports
  set status = 'running', started_at = now(), error_code = null, error_message = null
  where id = target_import_id
    and organization_id = workspace_id
    and status = 'pending';

  if not found then
    raise exception using errcode = '23514', message = 'Knowledge import is not ready to start';
  end if;
end;
$$;

create function public.save_knowledge_import_pages(
  target_import_id uuid,
  crawled_pages jsonb,
  discovered_count integer,
  skipped_count integer,
  final_root_url text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
  imported_count integer;
begin
  if jsonb_typeof(crawled_pages) <> 'array'
    or jsonb_array_length(crawled_pages) > 20
    or discovered_count < 0
    or skipped_count < 0
  then
    raise exception using errcode = '22023', message = 'Knowledge import results are invalid';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(crawled_pages) as page(
      canonical_url text,
      content text,
      content_hash text,
      title text
    )
    where length(btrim(coalesce(page.canonical_url, ''))) = 0
      or length(btrim(coalesce(page.title, ''))) = 0
      or length(btrim(coalesce(page.content, ''))) < 40
      or length(page.content) > 1000000
      or page.content_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = '22023', message = 'Knowledge import page data is invalid';
  end if;

  with page_rows as (
    select distinct on (page.content_hash)
      page.canonical_url,
      page.content,
      page.content_hash,
      page.title
    from jsonb_to_recordset(crawled_pages) as page(
      canonical_url text,
      content text,
      content_hash text,
      title text
    )
    order by page.content_hash, page.canonical_url
  )
  insert into public.knowledge_documents (
    organization_id, location_id, import_id, title, source_type, source_reference,
    status, content, content_hash, canonical_url, included, last_crawled_at
  )
  select
    knowledge_import.organization_id,
    knowledge_import.location_id,
    knowledge_import.id,
    btrim(page_rows.title),
    'website',
    page_rows.canonical_url,
    'draft',
    page_rows.content,
    page_rows.content_hash,
    page_rows.canonical_url,
    true,
    now()
  from page_rows
  join public.knowledge_imports as knowledge_import on knowledge_import.id = target_import_id
  on conflict (import_id, content_hash) where import_id is not null do nothing;

  select count(*)::integer into imported_count
  from public.knowledge_documents
  where import_id = target_import_id;

  update public.knowledge_imports
  set
    root_url = btrim(final_root_url),
    pages_discovered = discovered_count,
    pages_imported = imported_count,
    status = 'awaiting_review'
  where id = target_import_id
    and organization_id = workspace_id
    and status = 'running';

  if not found then
    raise exception using errcode = '23514', message = 'Knowledge import is not running';
  end if;

  return imported_count;
end;
$$;

create function public.fail_knowledge_import(
  target_import_id uuid,
  safe_error_code text,
  safe_error_message text
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
    and status in ('pending', 'running', 'publishing');

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

create function public.update_knowledge_document_draft(
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

  update public.knowledge_documents
  set
    title = btrim(draft_title),
    content = btrim(draft_content),
    content_hash = encode(extensions.digest(btrim(draft_content), 'sha256'), 'hex'),
    included = is_included
  where id = target_document_id and organization_id = workspace_id;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id)
  values (workspace_id, auth.uid(), 'knowledge.document.edited', 'knowledge_document', target_document_id);
end;
$$;

create function public.get_knowledge_import_publication_snapshot(target_import_id uuid)
returns table (document_id uuid, title text, content text, content_hash text, source_url text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
begin
  if not exists (
    select 1 from public.knowledge_imports as knowledge_import
    where knowledge_import.id = target_import_id
      and knowledge_import.organization_id = workspace_id
      and knowledge_import.status = 'awaiting_review'
  ) then
    raise exception using errcode = '23514', message = 'Knowledge import is not ready to publish';
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

create function public.archive_knowledge_document(target_document_id uuid)
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
  where knowledge_document.id = target_document_id
    and knowledge_document.status in ('draft', 'ready')
    and public.is_organization_admin(knowledge_document.organization_id);

  if workspace_id is null then
    raise exception using errcode = '42501', message = 'Knowledge document access is not permitted';
  end if;

  update public.knowledge_documents
  set status = 'archived'
  where id = target_document_id and organization_id = workspace_id;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id)
  values (workspace_id, auth.uid(), 'knowledge.document.archived', 'knowledge_document', target_document_id);
end;
$$;

create function public.publish_knowledge_import(
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
  persisted_chunks integer;
begin
  if jsonb_typeof(document_versions) <> 'array' or jsonb_typeof(generated_chunks) <> 'array' then
    raise exception using errcode = '22023', message = 'Knowledge publication data is invalid';
  end if;
  if not exists (
    select 1 from public.knowledge_imports as knowledge_import
    where knowledge_import.id = target_import_id
      and knowledge_import.organization_id = workspace_id
      and knowledge_import.status = 'awaiting_review'
  ) then
    raise exception using errcode = '23514', message = 'Knowledge import is not ready to publish';
  end if;
  if not exists (
    select 1 from public.knowledge_documents as knowledge_document
    where knowledge_document.organization_id = workspace_id
      and knowledge_document.import_id = target_import_id
      and knowledge_document.status = 'draft'
      and knowledge_document.included
  ) then
    raise exception using errcode = '23514', message = 'Include at least one knowledge page before publishing';
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
    and knowledge_document.id = chunk.document_id;

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

  -- Previous ready knowledge remains queryable until all replacement chunks above are persisted.
  update public.knowledge_documents
  set status = 'archived'
  where organization_id = workspace_id
    and source_type = 'website'
    and import_id <> target_import_id
    and status = 'ready';

  update public.knowledge_imports
  set status = 'completed', finished_at = now(), error_code = null, error_message = null
  where id = target_import_id and organization_id = workspace_id;

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

create function public.get_my_knowledge_overview()
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
  group by knowledge_import.id
  order by knowledge_import.created_at desc;
$$;

create function public.get_knowledge_import_review(target_import_id uuid)
returns table (
  document_id uuid,
  title text,
  canonical_url text,
  content text,
  included boolean,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_knowledge_import_manager(target_import_id);
begin
  return query
  select
    knowledge_document.id,
    knowledge_document.title,
    knowledge_document.canonical_url,
    knowledge_document.content,
    knowledge_document.included,
    knowledge_document.status
  from public.knowledge_documents as knowledge_document
  where knowledge_document.organization_id = workspace_id
    and knowledge_document.import_id = target_import_id
  order by knowledge_document.created_at, knowledge_document.id;
end;
$$;

create function public.match_my_knowledge(
  query_embedding_text text,
  requested_match_count integer default 5,
  requested_location_id uuid default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  title text,
  source_url text,
  content text,
  similarity double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  query_embedding extensions.vector(1536);
begin
  if requested_match_count < 1 or requested_match_count > 10 then
    raise exception using errcode = '22023', message = 'Match count is invalid';
  end if;
  query_embedding := query_embedding_text::extensions.vector;
  if extensions.vector_dims(query_embedding) <> 1536 then
    raise exception using errcode = '22023', message = 'Query embedding dimensions are invalid';
  end if;

  return query
  select
    knowledge_chunk.id,
    knowledge_document.id,
    knowledge_document.title,
    knowledge_document.canonical_url,
    knowledge_chunk.content,
    1 - (knowledge_chunk.embedding <=> query_embedding)
  from public.knowledge_chunks as knowledge_chunk
  join public.knowledge_documents as knowledge_document
    on knowledge_document.organization_id = knowledge_chunk.organization_id
    and knowledge_document.id = knowledge_chunk.document_id
  where knowledge_document.status = 'ready'
    and knowledge_chunk.embedding is not null
    and public.has_location_access(knowledge_chunk.organization_id, knowledge_chunk.location_id)
    and (requested_location_id is null or knowledge_chunk.location_id = requested_location_id)
  order by knowledge_chunk.embedding <=> query_embedding
  limit requested_match_count;
end;
$$;

revoke all on function public.require_knowledge_manager_organization() from public;
revoke all on function public.require_knowledge_import_manager(uuid) from public;
revoke all on function public.create_knowledge_import(text, uuid) from public;
revoke all on function public.start_knowledge_import(uuid) from public;
revoke all on function public.save_knowledge_import_pages(uuid, jsonb, integer, integer, text) from public;
revoke all on function public.fail_knowledge_import(uuid, text, text) from public;
revoke all on function public.update_knowledge_document_draft(uuid, text, text, boolean) from public;
revoke all on function public.get_knowledge_import_publication_snapshot(uuid) from public;
revoke all on function public.archive_knowledge_document(uuid) from public;
revoke all on function public.publish_knowledge_import(uuid, jsonb, jsonb) from public;
revoke all on function public.get_my_knowledge_overview() from public;
revoke all on function public.get_knowledge_import_review(uuid) from public;
revoke all on function public.match_my_knowledge(text, integer, uuid) from public;

grant execute on function public.create_knowledge_import(text, uuid) to authenticated;
grant execute on function public.start_knowledge_import(uuid) to authenticated;
grant execute on function public.save_knowledge_import_pages(uuid, jsonb, integer, integer, text) to authenticated;
grant execute on function public.fail_knowledge_import(uuid, text, text) to authenticated;
grant execute on function public.update_knowledge_document_draft(uuid, text, text, boolean) to authenticated;
grant execute on function public.get_knowledge_import_publication_snapshot(uuid) to authenticated;
grant execute on function public.archive_knowledge_document(uuid) to authenticated;
grant execute on function public.publish_knowledge_import(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.get_my_knowledge_overview() to authenticated;
grant execute on function public.get_knowledge_import_review(uuid) to authenticated;
grant execute on function public.match_my_knowledge(text, integer, uuid) to authenticated;

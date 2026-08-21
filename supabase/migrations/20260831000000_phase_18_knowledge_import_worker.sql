-- Phase 18: website imports become durable background work.
--
-- Until now the web request crawled the site itself. That was tolerable for a bounded static
-- fetch and is not tolerable for a headless browser: a request cannot own a browser process, and a
-- deploy or a closed tab must not decide whether an import finishes.
--
-- The authenticated user still establishes the only facts that matter — organization, location,
-- root URL — by creating a pending import through the existing owner/admin RPC. A trusted worker
-- then claims that row and consumes those persisted values. Nothing here accepts an organization,
-- a location, or a URL from the worker, so a compromised worker can execute existing work and can
-- never invent or retarget any.

alter table public.knowledge_imports
  add column if not exists claimed_by text
    check (claimed_by is null or char_length(claimed_by) between 3 and 160),
  -- The claim token, not the worker name, is the authority. A worker identifier is guessable and
  -- reused across restarts; a fresh random token per claim means a stale process cannot act on an
  -- import that has since been recovered and re-claimed by someone else.
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0
    check (attempt_count between 0 and 100),
  add column if not exists strategy text
    check (strategy is null or strategy in ('static', 'rendered')),
  -- Distinguishes work that may be retried from work that never should be.
  add column if not exists failure_kind text
    check (failure_kind is null or failure_kind in ('policy', 'transient', 'capability'));

-- The claim scan reads pending rows in creation order, and recovery reads expired leases. Both are
-- narrow predicates over status and time; nothing indexes a URL or any customer text.
create index if not exists knowledge_imports_claimable_idx
  on public.knowledge_imports (created_at)
  where status = 'pending';
create index if not exists knowledge_imports_lease_idx
  on public.knowledge_imports (lease_expires_at)
  where status = 'running';

-- How many times one import may be attempted before it is abandoned deliberately. A crawl that
-- fails transiently three times is not going to succeed on the fourth, and an unbounded retry loop
-- is how one bad site consumes a worker forever.
create function public.knowledge_import_max_attempts()
returns integer language sql immutable set search_path = '' as $$
  select 3;
$$;

create function public.require_knowledge_worker_role()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted knowledge worker access is required';
  end if;
end;
$$;

/**
 * Claims one pending import for exactly one worker.
 *
 * `for update skip locked` is what makes concurrent workers safe: a row another transaction is
 * already claiming is stepped over rather than waited on, so two workers cannot leave with the same
 * import and no worker blocks behind another. The transaction ends the moment the claim is written
 * — none of the crawling, rendering, or embedding that follows happens with a database transaction
 * open.
 */
create function public.claim_pending_knowledge_import(
  target_worker_id text,
  target_lease_seconds integer default 300
)
returns table (
  import_id uuid,
  organization_id uuid,
  location_id uuid,
  root_url text,
  attempt_count integer,
  claim_token uuid
)
language plpgsql security definer set search_path = '' as $$
declare claimed_id uuid; issued_token uuid;
begin
  perform public.require_knowledge_worker_role();
  if char_length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160
    or target_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Knowledge worker claim is invalid';
  end if;

  issued_token := extensions.gen_random_uuid();
  with candidate as (
    select knowledge_import.id
    from public.knowledge_imports knowledge_import
    where knowledge_import.status = 'pending'
      and knowledge_import.attempt_count < public.knowledge_import_max_attempts()
    order by knowledge_import.created_at asc
    for update skip locked
    limit 1
  ), claimed as (
    update public.knowledge_imports knowledge_import
    set status = 'running',
        started_at = coalesce(knowledge_import.started_at, now()),
        claimed_by = btrim(target_worker_id),
        claim_token = issued_token,
        lease_expires_at = now() + make_interval(secs => target_lease_seconds),
        attempt_count = knowledge_import.attempt_count + 1,
        error_code = null,
        error_message = null,
        failure_kind = null,
        updated_at = now()
    from candidate
    where knowledge_import.id = candidate.id
    returning knowledge_import.id
  ) select claimed.id into claimed_id from claimed;

  if claimed_id is null then return; end if;
  return query
  select knowledge_import.id, knowledge_import.organization_id, knowledge_import.location_id,
    knowledge_import.root_url, knowledge_import.attempt_count, knowledge_import.claim_token
  from public.knowledge_imports knowledge_import
  where knowledge_import.id = claimed_id;
end;
$$;

/** Extends a lease for the current claimant only. A stale worker cannot hold work it lost. */
create function public.renew_knowledge_import_lease(
  target_import_id uuid,
  target_claim_token uuid,
  target_lease_seconds integer default 300
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_knowledge_worker_role();
  if target_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Knowledge worker lease is invalid';
  end if;
  update public.knowledge_imports
  set lease_expires_at = now() + make_interval(secs => target_lease_seconds), updated_at = now()
  where id = target_import_id
    and claim_token = target_claim_token
    and status = 'running';
  return found;
end;
$$;

/**
 * Persists a completed crawl for the current claimant, atomically.
 *
 * Page validation is the same contract the owner/admin path enforces — at most twenty pages, forty
 * characters minimum, a megabyte maximum, a real SHA-256 — because a rendered document has to be
 * indistinguishable from a static one downstream. Insertion is idempotent on `(import_id,
 * content_hash)`, so a recovered attempt that repeats work cannot duplicate a knowledge document.
 */
create function public.complete_knowledge_import_crawl(
  target_import_id uuid,
  target_claim_token uuid,
  crawled_pages jsonb,
  discovered_count integer,
  skipped_count integer,
  final_root_url text,
  target_strategy text
)
returns integer language plpgsql security definer set search_path = '' as $$
declare import_row public.knowledge_imports%rowtype; imported_count integer;
begin
  perform public.require_knowledge_worker_role();
  if jsonb_typeof(crawled_pages) <> 'array'
    or jsonb_array_length(crawled_pages) > 20
    or discovered_count < 0
    or skipped_count < 0
    or target_strategy not in ('static', 'rendered') then
    raise exception using errcode = '22023', message = 'Knowledge import results are invalid';
  end if;

  -- The claim token gates the write. A worker whose lease was recovered holds a token nobody
  -- recognises any more, so its late completion changes nothing.
  select * into import_row
  from public.knowledge_imports
  where id = target_import_id and claim_token = target_claim_token and status = 'running'
  for update;
  if import_row.id is null then
    raise exception using errcode = '42501', message = 'Knowledge import claim is no longer valid';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(crawled_pages) as page(
      canonical_url text, content text, content_hash text, title text
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
      page.canonical_url, page.content, page.content_hash, page.title
    from jsonb_to_recordset(crawled_pages) as page(
      canonical_url text, content text, content_hash text, title text
    )
    order by page.content_hash, page.canonical_url
  )
  insert into public.knowledge_documents (
    organization_id, location_id, import_id, title, source_type, source_reference,
    status, content, content_hash, canonical_url, included, last_crawled_at
  )
  select import_row.organization_id, import_row.location_id, import_row.id,
    btrim(page_rows.title), 'website', page_rows.canonical_url, 'draft', page_rows.content,
    page_rows.content_hash, page_rows.canonical_url, true, now()
  from page_rows
  on conflict (import_id, content_hash) where import_id is not null do nothing;

  select count(*)::integer into imported_count
  from public.knowledge_documents where import_id = target_import_id;

  update public.knowledge_imports
  set root_url = btrim(final_root_url),
      pages_discovered = discovered_count,
      pages_imported = imported_count,
      strategy = target_strategy,
      status = 'awaiting_review',
      claim_token = null,
      claimed_by = null,
      lease_expires_at = null,
      updated_at = now()
  where id = target_import_id;
  return imported_count;
end;
$$;

/**
 * Ends an attempt for the current claimant.
 *
 * A policy or capability answer is final: re-running a robots refusal or a missing browser would
 * produce the same answer and waste another attempt. A transient failure returns the import to
 * pending until the attempt budget is spent, and then stops for good.
 */
create function public.fail_knowledge_import_as_worker(
  target_import_id uuid,
  target_claim_token uuid,
  safe_error_code text,
  safe_error_message text,
  target_failure_kind text default 'transient'
)
returns text language plpgsql security definer set search_path = '' as $$
declare import_row public.knowledge_imports%rowtype; next_status text;
begin
  perform public.require_knowledge_worker_role();
  if target_failure_kind not in ('policy', 'transient', 'capability') then
    raise exception using errcode = '22023', message = 'Knowledge failure kind is invalid';
  end if;
  select * into import_row
  from public.knowledge_imports
  where id = target_import_id and claim_token = target_claim_token and status = 'running'
  for update;
  if import_row.id is null then
    raise exception using errcode = '42501', message = 'Knowledge import claim is no longer valid';
  end if;

  next_status := case
    when target_failure_kind = 'transient'
      and import_row.attempt_count < public.knowledge_import_max_attempts() then 'pending'
    else 'failed'
  end;

  update public.knowledge_imports
  set status = next_status,
      error_code = left(coalesce(safe_error_code, 'import_failed'), 64),
      error_message = left(coalesce(safe_error_message, 'Knowledge import could not be completed.'), 500),
      failure_kind = target_failure_kind,
      finished_at = case when next_status = 'failed' then now() else null end,
      claim_token = null,
      claimed_by = null,
      lease_expires_at = null,
      updated_at = now()
  where id = target_import_id;
  return next_status;
end;
$$;

/**
 * Returns work whose worker died to the queue, or abandons it once the budget is spent.
 *
 * A crashed process leaves a running row nobody owns. Without this an import would sit in `running`
 * for ever, which is the failure mode the whole lease exists to prevent. Recovery clears the token,
 * so the dead worker's late completion is refused if it ever arrives.
 */
create function public.recover_stale_knowledge_imports(target_limit integer default 10)
returns integer language plpgsql security definer set search_path = '' as $$
declare recovered integer;
begin
  perform public.require_knowledge_worker_role();
  if target_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Knowledge recovery limit is invalid';
  end if;
  with stale as (
    select knowledge_import.id, knowledge_import.attempt_count
    from public.knowledge_imports knowledge_import
    where knowledge_import.status = 'running'
      and knowledge_import.lease_expires_at is not null
      and knowledge_import.lease_expires_at < now()
    order by knowledge_import.lease_expires_at asc
    for update skip locked
    limit target_limit
  ), updated as (
    update public.knowledge_imports knowledge_import
    set status = case
          when stale.attempt_count < public.knowledge_import_max_attempts() then 'pending'
          else 'failed'
        end,
        error_code = case
          when stale.attempt_count < public.knowledge_import_max_attempts() then null
          else 'import_abandoned'
        end,
        error_message = case
          when stale.attempt_count < public.knowledge_import_max_attempts() then null
          else 'Knowledge import could not be completed.'
        end,
        failure_kind = case
          when stale.attempt_count < public.knowledge_import_max_attempts() then null
          else 'transient'
        end,
        finished_at = case
          when stale.attempt_count < public.knowledge_import_max_attempts() then null
          else now()
        end,
        claim_token = null,
        claimed_by = null,
        lease_expires_at = null,
        updated_at = now()
    from stale
    where knowledge_import.id = stale.id
    returning knowledge_import.id
  ) select count(*)::integer into recovered from updated;
  return recovered;
end;
$$;

-- Worker RPCs are the trusted backend's only knowledge-import surface, and no table grant is added
-- anywhere: `service_role` still cannot read or write knowledge tables directly, so a compromised
-- worker is confined to executing already-created imports through these functions.
revoke all on function
  public.require_knowledge_worker_role(),
  public.knowledge_import_max_attempts(),
  public.claim_pending_knowledge_import(text, integer),
  public.renew_knowledge_import_lease(uuid, uuid, integer),
  public.complete_knowledge_import_crawl(uuid, uuid, jsonb, integer, integer, text, text),
  public.fail_knowledge_import_as_worker(uuid, uuid, text, text, text),
  public.recover_stale_knowledge_imports(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.claim_pending_knowledge_import(text, integer),
  public.renew_knowledge_import_lease(uuid, uuid, integer),
  public.complete_knowledge_import_crawl(uuid, uuid, jsonb, integer, integer, text, text),
  public.fail_knowledge_import_as_worker(uuid, uuid, text, text, text),
  public.recover_stale_knowledge_imports(integer)
  to service_role;

-- The new worker reports its own heartbeat, so the component domain has to admit it. Readiness
-- reads these rows, and a component that cannot be recorded would be a scheduler nobody can see.
alter table public.runtime_component_heartbeats
  drop constraint runtime_component_heartbeats_component_check,
  add constraint runtime_component_heartbeats_component_check check (component in (
    'message_processing', 'appointment_reminders', 'lead_followups', 'billing_events',
    'knowledge_imports'
  ));

-- The Phase 18 application depends on the claim contract above.
update public.platform_schema_contract
set schema_version = 18, updated_at = now()
where id;

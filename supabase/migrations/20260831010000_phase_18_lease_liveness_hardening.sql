-- Phase 18 lease liveness hardening.  Additive follow-up to 20260831000000_phase_18_knowledge_import_worker:
-- that migration is already reviewed and is not rewritten here.
--
-- One defect, in three places.  The worker RPCs authorized a caller by
--
--   status = 'running' and claim_token = target_claim_token
--
-- and never asked whether the lease that granted that token was still alive.  The token is cleared
-- by recovery, so the check is sound *after* recovery runs -- and recovery is a periodic sweep, not
-- an instant.  In the window between a lease expiring and the next recovery pass clearing it, the
-- expired claimant still held a token the database recognised, so it could renew itself back to
-- life, complete, or fail an import that had already become somebody else's to run.
--
-- That is the wrong owner.  The lease, not the sweep, is what grants authority, and it stops
-- granting it at `lease_expires_at`.  Recovery's job is to return the work to the queue, not to be
-- the thing that revokes a claim; a sweep that has not run yet must not leave a stale worker
-- holding write access to a live import.
--
-- The lease contract is therefore written down once, in `knowledge_import_claim_is_live`, and the
-- three claimant-authorized functions all ask it the same question.  Row locking is unchanged and
-- still does the serialising: liveness narrows who may act, and `for update` decides who acts first
-- when two callers race.  Exactly-once document insertion is untouched -- the same
-- `on conflict (import_id, content_hash) do nothing` still absorbs a repeated crawl.

/**
 * The lease contract, as one expression.
 *
 * A claim authorizes a write only while all four things hold: the import is still running, the
 * caller presents the token the claim issued, a lease exists, and that lease has not expired.
 *
 * `now()` is transaction start time, which is deliberate and matches recovery's own predicate: a
 * row can never be both live here and stale to recovery within one transaction, so the two can
 * never both believe they own it.  Concurrency across transactions is settled by the row lock the
 * callers take, not by the clock.
 */
create function public.knowledge_import_claim_is_live(
  claim_status text,
  current_claim_token uuid,
  current_lease_expires_at timestamptz,
  expected_claim_token uuid
)
returns boolean language sql stable set search_path = '' as $$
  select claim_status = 'running'
    and current_claim_token is not null
    and expected_claim_token is not null
    and current_claim_token = expected_claim_token
    and current_lease_expires_at is not null
    and current_lease_expires_at > now();
$$;

/**
 * Extends a lease for the current claimant only, and only while it still has one.
 *
 * An expired claimant renewing itself is the case this exists to refuse: it would resurrect a claim
 * the recovery worker was about to take away, and the resurrection would look exactly like a
 * healthy long-running import.  A worker that has already lost its lease has to be recovered, not
 * renewed -- so `false` here is the signal that the import is gone, and the worker reports it.
 */
create or replace function public.renew_knowledge_import_lease(
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
    and public.knowledge_import_claim_is_live(
      status, claim_token, lease_expires_at, target_claim_token);
  return found;
end;
$$;

/**
 * Persists a completed crawl for the current claimant, atomically, while its lease is still live.
 *
 * Unchanged from the reviewed version except for the liveness predicate: the same page validation,
 * the same tenancy taken from the persisted import row rather than from worker input, and the same
 * idempotent insert, so a recovered attempt that repeats work still cannot duplicate a document.
 *
 * The predicate sits inside the `for update` select on purpose.  Under read committed PostgreSQL
 * re-evaluates it against the row version it actually locked, so a completion that arrives while
 * recovery holds the row waits, re-checks, and finds a claim that no longer matches -- rather than
 * reading a stale snapshot and writing over the recovery that just happened.
 */
create or replace function public.complete_knowledge_import_crawl(
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

  -- A live lease gates the write. A worker holding a token whose lease has lapsed is refused here
  -- whether or not the recovery sweep has reached the row yet.
  select * into import_row
  from public.knowledge_imports
  where id = target_import_id
    and public.knowledge_import_claim_is_live(
      status, claim_token, lease_expires_at, target_claim_token)
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
 * Ends an attempt for the current claimant, while its lease is still live.
 *
 * Recording a failure is a write like any other, and an expired claimant must not make it.  It
 * spends one of three attempts and can move an import to `failed` for good, so a worker that
 * overran its lease could otherwise terminate an import that recovery had already handed to a
 * healthy worker mid-crawl.
 */
create or replace function public.fail_knowledge_import_as_worker(
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
  where id = target_import_id
    and public.knowledge_import_claim_is_live(
      status, claim_token, lease_expires_at, target_claim_token)
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
 * Unchanged except for one addition, which the liveness rule makes necessary: a `running` row with
 * no `lease_expires_at` is now recoverable.  Nothing creates that state -- claiming always writes a
 * lease -- but before this migration such a row was merely odd, and now it is unactionable by every
 * claimant, so without this it would sit in `running` for ever.  Recovery owns anything no live
 * claim can reach, which is exactly what "no lease" means.
 */
create or replace function public.recover_stale_knowledge_imports(target_limit integer default 10)
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
      and (knowledge_import.lease_expires_at is null
        or knowledge_import.lease_expires_at < now())
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

-- `create or replace` keeps the grants the reviewed migration set, so the four replaced functions
-- need nothing here. The new helper is reachable only from inside them and is granted to nobody:
-- it is a predicate, not a surface, and `service_role` still has no table access of its own.
revoke all on function
  public.knowledge_import_claim_is_live(text, uuid, timestamptz, uuid)
  from public, anon, authenticated, service_role;

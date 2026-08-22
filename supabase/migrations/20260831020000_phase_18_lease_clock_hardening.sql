-- Phase 18 lease clock hardening.  Additive follow-up to 20260831010000_phase_18_lease_liveness_hardening:
-- neither that migration nor 20260831000000_phase_18_knowledge_import_worker is rewritten here.
--
-- The previous migration made lease expiry end claim authority.  It judged expiry with `now()`, and
-- `now()` is transaction-start time, not wall clock.  That leaves a window the contract does not
-- survive:
--
--   1. a claimant with a live lease issues renew / complete / fail
--   2. the statement blocks on the import row lock, held by another transaction
--   3. real time passes the lease expiry while it waits
--   4. the lock is acquired
--   5. `lease_expires_at > now()` is re-evaluated against the *old* snapshot and is still true
--
-- So the write is authorized by a lease that expired before it was ever performed.  The predicate
-- was asking "was this claim live when my transaction began", and the question the contract needs
-- answered is "is this claim live now that I hold the lock".
--
-- Two changes fix that, and they have to go together.
--
-- First, the lock is taken on identity, status, and claim token alone -- criteria that carry no
-- timestamp, so no snapshot can make them stale.  Read committed re-evaluates that predicate
-- against the row version the statement actually locked, which is what keeps token fencing exact:
-- a recovery that committed while the caller waited has already cleared the token, and the caller
-- matches nothing.
--
-- Second, the lease is judged only after the lock is held, with `clock_timestamp()`, which is
-- volatile and reads the real clock at the moment it is called.  Nothing between the lock and the
-- write can move time backwards, and nothing else can touch the row while the lock is held, so the
-- answer is true for the whole write.
--
-- Recovery has the same asymmetry and the fix is the same expression.  With `now()` recovery could
-- only ever be *late* -- a row that expired after its transaction began looked live to it, and it
-- was picked up on the following sweep -- so it was never a safety defect the way the claimant side
-- was.  It was still a gap: between `now()` and the real clock a row could be too expired to act on
-- and not yet expired enough to recover.  Recovery is now defined as the exact complement of
-- liveness, by calling the same predicate, so the two can never drift apart or leave a row
-- unreachable by both.
--
-- Claim-token fencing, the bounded attempt budget, and exactly-once document insertion are all
-- unchanged.

/**
 * Does this caller hold the claim, ignoring time entirely.
 *
 * Deliberately has no timestamp in it. This is the predicate the row lock is taken on, and a
 * predicate containing `now()` is precisely what let a stale snapshot authorize a write: read
 * committed re-checks the qual against the locked row version, so anything time-based in it is
 * re-checked against a clock that has not moved. Identity, status, and token do not have that
 * problem -- they are re-read from the row, and the row is current.
 */
create function public.knowledge_import_claim_matches(
  claim_status text,
  current_claim_token uuid,
  expected_claim_token uuid
)
returns boolean language sql immutable set search_path = '' as $$
  select claim_status = 'running'
    and current_claim_token is not null
    and expected_claim_token is not null
    and current_claim_token = expected_claim_token;
$$;

/**
 * Is the lease still live, right now.
 *
 * `clock_timestamp()` rather than `now()`, and volatile rather than stable, both on purpose: this
 * has to observe the clock at the instant it is called, after the caller has waited however long
 * it waited for the row lock. A stable function reading `now()` would answer for a moment that has
 * already passed.
 *
 * Recovery calls the negation of this, so "expired" and "recoverable" are the same boundary rather
 * than two definitions that happen to agree.
 */
create function public.knowledge_import_lease_is_live(lease_expires_at timestamptz)
returns boolean language sql volatile set search_path = '' as $$
  select lease_expires_at is not null and lease_expires_at > clock_timestamp();
$$;

/**
 * Claims one pending import for exactly one worker.
 *
 * Unchanged except that the lease it grants is measured from `clock_timestamp()`. With `now()` a
 * claim transaction that took a moment to commit handed out a lease already partly spent, because
 * liveness is judged against the real clock. Shorter than requested is the safe direction, but it
 * is still not the lease the caller asked for, and the whole point of this migration is that the
 * lease means one thing.
 */
create or replace function public.claim_pending_knowledge_import(
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
        lease_expires_at = clock_timestamp() + make_interval(secs => target_lease_seconds),
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

/**
 * Extends a lease for the current claimant, if it still has one at the moment it is asked.
 *
 * Now takes the row lock before deciding, rather than deciding inside the `update` predicate. The
 * old single-statement form could not express "check the clock after the lock" at all: there is no
 * point in an `update ... where` at which the caller can observe having waited.
 */
create or replace function public.renew_knowledge_import_lease(
  target_import_id uuid,
  target_claim_token uuid,
  target_lease_seconds integer default 300
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare import_row public.knowledge_imports%rowtype;
begin
  perform public.require_knowledge_worker_role();
  if target_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Knowledge worker lease is invalid';
  end if;

  select * into import_row
  from public.knowledge_imports
  where id = target_import_id
    and public.knowledge_import_claim_matches(status, claim_token, target_claim_token)
  for update;
  -- The lock is held. Only now is the clock consulted, so a caller that waited here across its own
  -- expiry cannot renew itself back to life on the strength of when it started asking.
  if import_row.id is null
    or not public.knowledge_import_lease_is_live(import_row.lease_expires_at) then
    return false;
  end if;

  update public.knowledge_imports
  set lease_expires_at = clock_timestamp() + make_interval(secs => target_lease_seconds),
      updated_at = now()
  where id = target_import_id;
  return true;
end;
$$;

/**
 * Persists a completed crawl for the current claimant, atomically, if its lease is live when the
 * write actually begins.
 *
 * Page validation, tenancy taken from the persisted import row rather than from worker input, and
 * the idempotent insert are all unchanged; only the authorization step moved. Holding the row lock
 * for the rest of the function is what makes the single liveness check sufficient: recovery uses
 * `skip locked`, so it steps over this row until the transaction ends, and no second claimant can
 * appear underneath the write.
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

  -- Lock on criteria no snapshot can staledate: a recovery that committed while this statement
  -- waited has already cleared the token, so the re-checked predicate matches nothing.
  select * into import_row
  from public.knowledge_imports
  where id = target_import_id
    and public.knowledge_import_claim_matches(status, claim_token, target_claim_token)
  for update;
  if import_row.id is null
    or not public.knowledge_import_lease_is_live(import_row.lease_expires_at) then
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
 * Ends an attempt for the current claimant, if its lease is live when the write begins.
 *
 * Recording a failure spends one of three attempts and can move an import to `failed` for good, so
 * an expired claimant reaching this after a long wait could terminate work recovery had already
 * handed to a healthy worker.
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
    and public.knowledge_import_claim_matches(status, claim_token, target_claim_token)
  for update;
  if import_row.id is null
    or not public.knowledge_import_lease_is_live(import_row.lease_expires_at) then
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
 * Recovery is now defined as exactly "not live", by calling the liveness predicate itself. Writing
 * the boundary twice is how the two sides drift: with `now()` here and the real clock there, a row
 * could be too expired for its claimant to touch and not yet expired enough to be recovered. One
 * expression, negated, cannot develop that gap -- and a `running` row with no lease at all, which
 * no claimant can reach, falls out of the same definition rather than needing its own branch.
 *
 * `skip locked` is unchanged and still does the real work of not fighting a claimant mid-write: a
 * row locked by a completion in progress is stepped over, and that completion is the one that
 * decides the outcome.
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
      and not public.knowledge_import_lease_is_live(knowledge_import.lease_expires_at)
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

-- The snapshot-based predicate has no callers left. Leaving it would leave a second, wrong
-- definition of the lease boundary sitting next to the right one, which is how the next change
-- reintroduces this defect.
drop function public.knowledge_import_claim_is_live(text, uuid, timestamptz, uuid);

-- `create or replace` preserves the grants the earlier migrations set, so the five replaced
-- functions need nothing here. The two predicates are internal rules rather than surfaces: they are
-- reachable only from inside the security definer functions that enforce them, and `service_role`
-- still has no table access of its own.
revoke all on function
  public.knowledge_import_claim_matches(text, uuid, uuid),
  public.knowledge_import_lease_is_live(timestamptz)
  from public, anon, authenticated, service_role;

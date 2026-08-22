-- Phase 18 durable knowledge import worker: claim, lease, recovery, and tenant boundaries.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(66);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

insert into auth.users (id, email) values
  ('dd000000-0000-4000-8000-000000000001', 'knowledge-owner-a@example.test'),
  ('dd000000-0000-4000-8000-000000000002', 'knowledge-owner-b@example.test'),
  ('dd000000-0000-4000-8000-000000000003', 'knowledge-member-a@example.test');
insert into public.users (id, email)
select id, email from auth.users where id::text like 'dd000000%' on conflict (id) do nothing;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('dd100000-0000-4000-8000-000000000001', 'Knowledge A', 'knowledge-a',
   'dd000000-0000-4000-8000-000000000001', 'veterinary'),
  ('dd200000-0000-4000-8000-000000000001', 'Knowledge B', 'knowledge-b',
   'dd000000-0000-4000-8000-000000000002', 'veterinary');
insert into public.locations (id, organization_id, name) values
  ('dd110000-0000-4000-8000-000000000001', 'dd100000-0000-4000-8000-000000000001', 'A clinic'),
  ('dd210000-0000-4000-8000-000000000001', 'dd200000-0000-4000-8000-000000000001', 'B clinic');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('dd130000-0000-4000-8000-000000000001', 'dd100000-0000-4000-8000-000000000001',
   'dd000000-0000-4000-8000-000000000001', 'owner'),
  ('dd130000-0000-4000-8000-000000000002', 'dd100000-0000-4000-8000-000000000001',
   'dd000000-0000-4000-8000-000000000003', 'member'),
  ('dd230000-0000-4000-8000-000000000001', 'dd200000-0000-4000-8000-000000000001',
   'dd000000-0000-4000-8000-000000000002', 'owner');

insert into public.knowledge_imports (id, organization_id, location_id, root_url, status) values
  ('dd140000-0000-4000-8000-000000000001', 'dd100000-0000-4000-8000-000000000001',
   'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/', 'pending');

-- ============================================================================================
-- Only a trusted worker may reach the claim surface at all
-- ============================================================================================

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'dd000000-0000-4000-8000-000000000001', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.claim_pending_knowledge_import('browser-worker', 300)
$sql$, '42501', 'permission denied')), 'a browser cannot claim an import');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.recover_stale_knowledge_imports(10)
$sql$, '42501', 'permission denied')), 'a browser cannot run recovery');
select extensions.ok((select pg_temp.error_matches($sql$
  update public.knowledge_imports set status = 'awaiting_review'
$sql$, '42501', 'permission denied')), 'a browser cannot move an import by hand');
reset role;

-- The trusted backend gets the RPCs and no table grant, so it cannot reach knowledge rows directly.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select * from public.knowledge_imports
$sql$, '42501', 'permission denied')), 'the worker role has no direct import table read');
select extensions.ok((select pg_temp.error_matches($sql$
  update public.knowledge_imports set status = 'completed'
$sql$, '42501', 'permission denied')), 'the worker role cannot mutate imports directly');
select extensions.ok((select pg_temp.error_matches($sql$
  insert into public.knowledge_documents (organization_id, location_id, title, source_type, status, content, content_hash, canonical_url)
  values ('dd100000-0000-4000-8000-000000000001', 'dd110000-0000-4000-8000-000000000001', 'x', 'website', 'draft', 'y', repeat('a', 64), 'https://x.example/')
$sql$, '42501', 'permission denied')), 'the worker role cannot write knowledge documents directly');
reset role;

-- ============================================================================================
-- Claiming
-- ============================================================================================

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.is(
  (select count(*)::integer from public.claim_pending_knowledge_import('worker-one', 300)),
  1,
  'a pending import is claimable'
);
reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001'),
  'running',
  'claiming moves the import to running'
);
select extensions.is(
  (select attempt_count from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001'),
  1,
  'claiming counts the attempt'
);
select extensions.ok(
  (select claim_token is not null and claimed_by = 'worker-one' and lease_expires_at > now()
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001'),
  'the claim records a token, an owner, and a live lease'
);
select extensions.ok(
  (select claim_token <> 'dd140000-0000-4000-8000-000000000001'::uuid
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001'),
  'the claim token is generated rather than derived from the import identity'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
-- The load-bearing case: a second worker polling at the same moment must leave with nothing.
select extensions.is(
  (select count(*)::integer from public.claim_pending_knowledge_import('worker-two', 300)),
  0,
  'a second worker cannot claim an import that is already owned'
);
reset role;

-- ============================================================================================
-- Only the current claimant may act
-- ============================================================================================

create temporary table pg_temp.claim as
select claim_token from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001';
select set_config('avenlyo.claim', (select claim_token::text from pg_temp.claim), true);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  public.renew_knowledge_import_lease('dd140000-0000-4000-8000-000000000001',
    current_setting('avenlyo.claim')::uuid, 300),
  true,
  'the current claimant can renew its lease'
);
select extensions.is(
  public.renew_knowledge_import_lease('dd140000-0000-4000-8000-000000000001',
    'dd999999-0000-4000-8000-000000000009', 300),
  false,
  'a wrong token cannot renew someone else lease'
);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.complete_knowledge_import_crawl('dd140000-0000-4000-8000-000000000001',
    'dd999999-0000-4000-8000-000000000009', '[]'::jsonb, 1, 0, 'https://clinic-a.example/', 'static')
$sql$, '42501', 'claim is no longer valid')), 'a wrong token cannot complete another worker import');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.fail_knowledge_import_as_worker('dd140000-0000-4000-8000-000000000001',
    'dd999999-0000-4000-8000-000000000009', 'nope', 'nope', 'transient')
$sql$, '42501', 'claim is no longer valid')), 'a wrong token cannot fail another worker import');

-- ============================================================================================
-- Completion is exactly once, and retries never duplicate a document
-- ============================================================================================

select extensions.is(
  public.complete_knowledge_import_crawl(
    'dd140000-0000-4000-8000-000000000001',
    current_setting('avenlyo.claim')::uuid,
    jsonb_build_array(jsonb_build_object(
      'canonical_url', 'https://clinic-a.example/',
      'content', repeat('Clinic A wellness and vaccination information. ', 3),
      'content_hash', repeat('a', 64),
      'title', 'Clinic A'
    )),
    1, 0, 'https://clinic-a.example/', 'rendered'
  ),
  1,
  'the claimant persists its crawl'
);
reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001'),
  'awaiting_review',
  'a completed crawl becomes reviewable'
);
select extensions.is(
  (select strategy from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001'),
  'rendered',
  'the strategy that produced the pages is recorded'
);
select extensions.ok(
  (select claim_token is null and claimed_by is null and lease_expires_at is null
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000001'),
  'completion releases the claim'
);
select extensions.is(
  (select count(*)::integer from public.knowledge_documents
   where import_id = 'dd140000-0000-4000-8000-000000000001'),
  1,
  'one page becomes one document'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.complete_knowledge_import_crawl('dd140000-0000-4000-8000-000000000001',
    current_setting('avenlyo.claim')::uuid, '[]'::jsonb, 1, 0, 'https://clinic-a.example/', 'static')
$sql$, '42501', 'claim is no longer valid')),
  'a released claim cannot complete the same import twice');
reset role;

-- A recovered attempt that re-crawls the same site must not create a second copy of a page.
insert into public.knowledge_imports (id, organization_id, location_id, root_url, status) values
  ('dd140000-0000-4000-8000-000000000002', 'dd100000-0000-4000-8000-000000000001',
   'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/again', 'pending');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('avenlyo.claim2',
  (select claim_token::text from public.claim_pending_knowledge_import('worker-three', 300)), true);
select extensions.is(
  public.complete_knowledge_import_crawl(
    'dd140000-0000-4000-8000-000000000002', current_setting('avenlyo.claim2')::uuid,
    jsonb_build_array(
      jsonb_build_object('canonical_url', 'https://clinic-a.example/again', 'content',
        repeat('Repeated clinic content for the retry case. ', 3), 'content_hash', repeat('b', 64),
        'title', 'Again'),
      jsonb_build_object('canonical_url', 'https://clinic-a.example/again', 'content',
        repeat('Repeated clinic content for the retry case. ', 3), 'content_hash', repeat('b', 64),
        'title', 'Again')
    ),
    2, 0, 'https://clinic-a.example/again', 'static'
  ),
  1,
  'the same page twice in one payload is one document'
);
reset role;

-- ============================================================================================
-- Lease recovery
-- ============================================================================================

insert into public.knowledge_imports (id, organization_id, location_id, root_url, status) values
  ('dd140000-0000-4000-8000-000000000003', 'dd100000-0000-4000-8000-000000000001',
   'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/stale', 'pending');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('avenlyo.claim3',
  (select claim_token::text from public.claim_pending_knowledge_import('worker-crashed', 60)), true);
reset role;
-- Simulate the process dying: the lease simply stops being renewed.
update public.knowledge_imports set lease_expires_at = now() - interval '1 minute'
where id = 'dd140000-0000-4000-8000-000000000003';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  public.recover_stale_knowledge_imports(10), 1, 'an expired lease is recovered');
reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000003'),
  'pending',
  'recovered work returns to the queue rather than staying stuck in running'
);
select extensions.ok(
  (select claim_token is null from public.knowledge_imports
   where id = 'dd140000-0000-4000-8000-000000000003'),
  'recovery clears the dead worker claim'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
-- The crashed worker comes back and tries to finish work it no longer owns.
select extensions.ok((select pg_temp.error_matches($sql$
  select public.complete_knowledge_import_crawl('dd140000-0000-4000-8000-000000000003',
    current_setting('avenlyo.claim3')::uuid, '[]'::jsonb, 1, 0, 'https://clinic-a.example/stale', 'static')
$sql$, '42501', 'claim is no longer valid')),
  'a recovered import refuses its previous claimant');

-- An active lease is not stealable, however long the worker has held it.
select extensions.is(
  (select count(*)::integer from public.claim_pending_knowledge_import('worker-four', 300)), 1,
  'the recovered import can be claimed again');
select extensions.is(
  (select count(*)::integer from public.claim_pending_knowledge_import('worker-five', 300)), 0,
  'a live lease cannot be stolen by another worker');
select extensions.is(
  public.recover_stale_knowledge_imports(10), 0, 'a live lease is not recovered');
reset role;

-- ============================================================================================
-- Lease expiry ends claim authority
--
-- The lease, not the recovery sweep, is what grants a worker the right to write. These cases run
-- entirely inside the window the old contract left open: the lease has expired, recovery has not
-- run yet, and the expired worker still holds a token the row still carries. Under the old rule
-- (status = 'running' and claim_token = target) every one of these writes was accepted.
-- ============================================================================================

insert into public.knowledge_imports (id, organization_id, location_id, root_url, status) values
  ('dd140000-0000-4000-8000-000000000006', 'dd100000-0000-4000-8000-000000000001',
   'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/expired', 'pending');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('avenlyo.claim6',
  (select claim_token::text from public.claim_pending_knowledge_import('worker-nine', 300)), true);
reset role;
-- The worker overran its lease: still alive, still holding its token, simply too slow.
update public.knowledge_imports set lease_expires_at = now() - interval '1 second'
where id = 'dd140000-0000-4000-8000-000000000006';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  public.renew_knowledge_import_lease('dd140000-0000-4000-8000-000000000006',
    current_setting('avenlyo.claim6')::uuid, 300),
  false,
  'an expired claimant cannot renew itself back to life'
);
reset role;
-- The refusal has to come from the lease contract itself. If recovery had already cleared the
-- token, these cases would prove nothing about the window they exist to close.
select extensions.ok(
  (select status = 'running' and claim_token = current_setting('avenlyo.claim6')::uuid
     and lease_expires_at < now()
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000006'),
  'the expired claim is refused while its token is still on the row and recovery has not run'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.complete_knowledge_import_crawl('dd140000-0000-4000-8000-000000000006',
    current_setting('avenlyo.claim6')::uuid,
    jsonb_build_array(jsonb_build_object(
      'canonical_url', 'https://clinic-a.example/expired',
      'content', repeat('Content crawled after the lease had already lapsed. ', 3),
      'content_hash', repeat('c', 64),
      'title', 'Expired')),
    1, 0, 'https://clinic-a.example/expired', 'static')
$sql$, '42501', 'claim is no longer valid')), 'an expired claimant cannot complete');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.fail_knowledge_import_as_worker('dd140000-0000-4000-8000-000000000006',
    current_setting('avenlyo.claim6')::uuid, 'request_failed', 'The website could not be fetched.',
    'transient')
$sql$, '42501', 'claim is no longer valid')), 'an expired claimant cannot fail');

select extensions.is(
  public.recover_stale_knowledge_imports(10), 1, 'recovery owns the expired work');
reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000006'),
  'pending',
  'the expired import returns to the queue'
);
select extensions.is(
  (select count(*)::integer from public.knowledge_documents
   where import_id = 'dd140000-0000-4000-8000-000000000006'),
  0,
  'nothing the expired claimant tried to write survived'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('avenlyo.claim7',
  (select claim_token::text from public.claim_pending_knowledge_import('worker-ten', 300)), true);
select extensions.ok(
  current_setting('avenlyo.claim7') is not null
    and current_setting('avenlyo.claim7') <> current_setting('avenlyo.claim6'),
  'the re-claim issues a token the previous claimant never held'
);
select extensions.is(
  public.renew_knowledge_import_lease('dd140000-0000-4000-8000-000000000006',
    current_setting('avenlyo.claim7')::uuid, 300),
  true,
  'an active token with a live lease can renew'
);

-- The original worker finally wakes up. Its token was valid, its work may even have succeeded, and
-- none of that matters any more: the import belongs to worker-ten.
select extensions.is(
  public.renew_knowledge_import_lease('dd140000-0000-4000-8000-000000000006',
    current_setting('avenlyo.claim6')::uuid, 300),
  false,
  'the old token cannot renew after the work was re-claimed'
);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.complete_knowledge_import_crawl('dd140000-0000-4000-8000-000000000006',
    current_setting('avenlyo.claim6')::uuid, '[]'::jsonb, 1, 0,
    'https://clinic-a.example/expired', 'static')
$sql$, '42501', 'claim is no longer valid')),
  'the old token cannot complete after the work was re-claimed');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.fail_knowledge_import_as_worker('dd140000-0000-4000-8000-000000000006',
    current_setting('avenlyo.claim6')::uuid, 'request_failed', 'stale', 'transient')
$sql$, '42501', 'claim is no longer valid')),
  'the old token cannot fail after the work was re-claimed');

select extensions.is(
  (select count(*)::integer from public.claim_pending_knowledge_import('worker-eleven', 300)), 0,
  'the live lease of the new claimant cannot be stolen');
select extensions.is(
  public.recover_stale_knowledge_imports(10), 0,
  'recovery leaves a live claimant alone');
reset role;

-- A running row with no lease at all can no longer be acted on by any claimant, so recovery has to
-- own it too. Nothing creates this state -- claiming always writes a lease -- but before liveness
-- was enforced it was merely odd, and now it would be stranded in running for ever.
insert into public.knowledge_imports
  (id, organization_id, location_id, root_url, status, attempt_count, claimed_by, claim_token)
values ('dd140000-0000-4000-8000-000000000007', 'dd100000-0000-4000-8000-000000000001',
  'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/leaseless', 'running', 3,
  'worker-vanished', 'dd999999-0000-4000-8000-000000000007');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  public.recover_stale_knowledge_imports(10), 1,
  'a running import with no lease at all is recoverable');
reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000007'),
  'failed',
  'a leaseless import out of attempts is abandoned rather than stranded'
);

-- The two predicates are internal rules, not surfaces. The worker role reaches them only through
-- the functions that enforce them.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.knowledge_import_claim_matches('running', null::uuid, null::uuid)
$sql$, '42501', 'permission denied')),
  'the claim predicate is not callable by the worker role');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.knowledge_import_lease_is_live(null::timestamptz)
$sql$, '42501', 'permission denied')),
  'the lease predicate is not callable by the worker role');
reset role;

-- ============================================================================================
-- Lease expiry is judged by the wall clock, not by the transaction snapshot
--
-- The case the previous section could not reach. Those tests call in *after* expiry, so a
-- transaction-start snapshot and the real clock agree and the predicate is never asked to tell
-- them apart. The dangerous shape is an operation that was authorized when it began and is not by
-- the time it writes -- a claimant that blocked on the import row lock while its lease ran out.
--
-- A second connection is what would produce that block, and pg_prove runs one file in one session
-- inside one transaction, so the harness cannot hold a competing lock while this session waits on
-- it. Every mechanism that could (dblink, an async second connection) either adds an extension the
-- database does not otherwise need or risks hanging the whole suite on a lock that is never
-- released.
--
-- The lock wait is not the property, though; it is only one way to spend wall-clock time inside a
-- transaction. `pg_sleep` spends it deterministically, and produces the exact state the race
-- produces: `now()` still says the lease is live, `clock_timestamp()` says it expired. Every write
-- below was authorized under the old predicate and is refused under the new one, which is what the
-- race turns on. Token fencing across a concurrent committed recovery is proved separately, in the
-- section above.
-- ============================================================================================

insert into public.knowledge_imports (id, organization_id, location_id, root_url, status) values
  ('dd140000-0000-4000-8000-000000000008', 'dd100000-0000-4000-8000-000000000001',
   'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/slowlock', 'pending');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('avenlyo.claim8',
  (select claim_token::text from public.claim_pending_knowledge_import('worker-twelve', 300)), true);
reset role;

-- A lease that is live right now and about to lapse. This is the moment the claimant issues its
-- statement and blocks.
update public.knowledge_imports
set lease_expires_at = clock_timestamp() + interval '1 second'
where id = 'dd140000-0000-4000-8000-000000000008';
select extensions.ok(
  (select lease_expires_at > clock_timestamp() and lease_expires_at > now()
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000008'),
  'the lease is live under both the wall clock and the transaction snapshot when the wait begins'
);

-- The wait. In production this is time spent blocked on the row lock; here it is time spent in
-- pg_sleep. What matters is that it is real time inside a transaction that has already started.
select pg_sleep(1.5);

-- The state the whole race turns on, asserted rather than assumed: the snapshot has not moved and
-- still reports a live lease, while the real clock has passed expiry.
select extensions.ok(
  (select lease_expires_at > now()
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000008'),
  'the transaction snapshot still reports the lease as live after the wait'
);
select extensions.ok(
  (select lease_expires_at <= clock_timestamp()
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000008'),
  'the wall clock has passed the lease expiry after the wait'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  public.renew_knowledge_import_lease('dd140000-0000-4000-8000-000000000008',
    current_setting('avenlyo.claim8')::uuid, 300),
  false,
  'a claimant whose lease lapsed during the wait cannot renew'
);
select extensions.ok((select pg_temp.error_matches($sql$
  select public.complete_knowledge_import_crawl('dd140000-0000-4000-8000-000000000008',
    current_setting('avenlyo.claim8')::uuid,
    jsonb_build_array(jsonb_build_object(
      'canonical_url', 'https://clinic-a.example/slowlock',
      'content', repeat('Content written after the lease lapsed during the wait. ', 3),
      'content_hash', repeat('d', 64),
      'title', 'Slow lock')),
    1, 0, 'https://clinic-a.example/slowlock', 'static')
$sql$, '42501', 'claim is no longer valid')),
  'a claimant whose lease lapsed during the wait cannot complete');
select extensions.ok((select pg_temp.error_matches($sql$
  select public.fail_knowledge_import_as_worker('dd140000-0000-4000-8000-000000000008',
    current_setting('avenlyo.claim8')::uuid, 'request_failed', 'The website could not be fetched.',
    'transient')
$sql$, '42501', 'claim is no longer valid')),
  'a claimant whose lease lapsed during the wait cannot fail');
reset role;

-- The refusals came from the clock, not from recovery having already taken the row: the token the
-- caller presented is still the token on the row, and the import is still running.
select extensions.ok(
  (select status = 'running' and claim_token = current_setting('avenlyo.claim8')::uuid
   from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000008'),
  'the lapsed claimant still holds the token it was refused on'
);
select extensions.is(
  (select count(*)::integer from public.knowledge_documents
   where import_id = 'dd140000-0000-4000-8000-000000000008'),
  0,
  'nothing the lapsed claimant tried to write survived'
);

-- Recovery reads the same clock, so there is no window where a row is too expired for its claimant
-- and not yet expired for recovery. Under a transaction-snapshot predicate this returns zero.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  public.recover_stale_knowledge_imports(10), 1,
  'recovery agrees the lease lapsed during the wait and reclaims it'
);
reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000008'),
  'pending',
  'the reclaimed import returns to the queue'
);

-- Parked, so the sections below keep their single-candidate assumption. Every row in this file is
-- inserted in one transaction and therefore shares one `created_at`, and the claim orders by it --
-- so leaving a second claimable row here would make which import a later claim returns arbitrary.
update public.knowledge_imports
set status = 'failed', finished_at = now(), error_code = 'import_abandoned'
where id = 'dd140000-0000-4000-8000-000000000008';

-- ============================================================================================
-- Bounded attempts
-- ============================================================================================

insert into public.knowledge_imports (id, organization_id, location_id, root_url, status, attempt_count)
values ('dd140000-0000-4000-8000-000000000004', 'dd100000-0000-4000-8000-000000000001',
  'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/doomed', 'pending', 2);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('avenlyo.claim4',
  (select claim_token::text from public.claim_pending_knowledge_import('worker-six', 300)), true);
select extensions.is(
  public.fail_knowledge_import_as_worker('dd140000-0000-4000-8000-000000000004',
    current_setting('avenlyo.claim4')::uuid, 'request_failed', 'The website could not be fetched.',
    'transient'),
  'failed',
  'a transient failure on the last attempt stops for good rather than retrying forever'
);
reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is(
  (select count(*)::integer from public.claim_pending_knowledge_import('worker-seven', 300)), 0,
  'a terminally failed import is never claimed again');
reset role;

insert into public.knowledge_imports (id, organization_id, location_id, root_url, status) values
  ('dd140000-0000-4000-8000-000000000005', 'dd100000-0000-4000-8000-000000000001',
   'dd110000-0000-4000-8000-000000000001', 'https://clinic-a.example/policy', 'pending');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('avenlyo.claim5',
  (select claim_token::text from public.claim_pending_knowledge_import('worker-eight', 300)), true);
select extensions.is(
  public.fail_knowledge_import_as_worker('dd140000-0000-4000-8000-000000000005',
    current_setting('avenlyo.claim5')::uuid, 'robots_disallowed',
    'This website does not allow automated crawling.', 'policy'),
  'failed',
  'a policy answer is final and is not retried'
);
reset role;
select extensions.is(
  (select error_message from public.knowledge_imports where id = 'dd140000-0000-4000-8000-000000000005'),
  'This website does not allow automated crawling.',
  'the operator sees the bounded reason and nothing else'
);

-- ============================================================================================
-- Tenant boundaries
-- ============================================================================================

select extensions.ok(
  (select bool_and(document.organization_id = 'dd100000-0000-4000-8000-000000000001')
   from public.knowledge_documents document
   where document.import_id in ('dd140000-0000-4000-8000-000000000001', 'dd140000-0000-4000-8000-000000000002')),
  'worker-created documents inherit the organization from the persisted import, never from input'
);
select extensions.ok(
  (select bool_and(document.location_id = 'dd110000-0000-4000-8000-000000000001')
   from public.knowledge_documents document
   where document.import_id = 'dd140000-0000-4000-8000-000000000001'),
  'worker-created documents inherit the selected location'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'dd000000-0000-4000-8000-000000000002', true);
select extensions.is(
  (select count(*)::integer from public.knowledge_imports
   where organization_id = 'dd100000-0000-4000-8000-000000000001'),
  0,
  'another organization owner cannot see these imports at all'
);
select extensions.is(
  (select count(*)::integer from public.knowledge_documents
   where organization_id = 'dd100000-0000-4000-8000-000000000001'),
  0,
  'another organization owner cannot see the documents the worker created'
);
reset role;

select extensions.finish();
rollback;

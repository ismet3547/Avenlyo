-- Phase 18 durable knowledge import worker: claim, lease, recovery, and tenant boundaries.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(38);

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

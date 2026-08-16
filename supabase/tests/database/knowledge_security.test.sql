-- Phase 2 reviewed knowledge state, tenant isolation, and retrieval checks.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(16);

insert into auth.users (id, email)
values
  ('40000000-0000-0000-0000-000000000001', 'knowledge-owner-a@example.test'),
  ('40000000-0000-0000-0000-000000000002', 'knowledge-owner-b@example.test'),
  ('40000000-0000-0000-0000-000000000003', 'knowledge-admin-a@example.test'),
  ('40000000-0000-0000-0000-000000000004', 'knowledge-member-a@example.test');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok($$ select * from public.bootstrap_workspace() $$, 'owner A can bootstrap');

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select extensions.lives_ok($$ select * from public.bootstrap_workspace() $$, 'owner B can bootstrap');

reset role;

select set_config(
  'avenlyo.knowledge_org_a',
  (select organization_id::text from public.organization_members where user_id = '40000000-0000-0000-0000-000000000001'),
  true
);
select set_config(
  'avenlyo.knowledge_org_b',
  (select organization_id::text from public.organization_members where user_id = '40000000-0000-0000-0000-000000000002'),
  true
);

update public.organization_onboarding
set status = 'completed', current_step = 'completed', completed_at = now()
where organization_id in (
  current_setting('avenlyo.knowledge_org_a')::uuid,
  current_setting('avenlyo.knowledge_org_b')::uuid
);

insert into public.organization_members (organization_id, user_id, role)
values
  (current_setting('avenlyo.knowledge_org_a')::uuid, '40000000-0000-0000-0000-000000000003', 'admin'),
  (current_setting('avenlyo.knowledge_org_a')::uuid, '40000000-0000-0000-0000-000000000004', 'member');

select set_config(
  'avenlyo.knowledge_location_a',
  (select location_id::text from public.organization_onboarding where organization_id = current_setting('avenlyo.knowledge_org_a')::uuid),
  true
);

insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
select
  current_setting('avenlyo.knowledge_org_a')::uuid,
  member.id,
  current_setting('avenlyo.knowledge_location_a')::uuid
from public.organization_members as member
where member.organization_id = current_setting('avenlyo.knowledge_org_a')::uuid
  and member.user_id = '40000000-0000-0000-0000-000000000004';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);

select extensions.lives_ok(
  $$ select * from public.create_knowledge_import('https://clinic-a.example', null) $$,
  'owner can create a website knowledge import through the RPC'
);
select set_config(
  'avenlyo.knowledge_import_a',
  (select id::text from public.knowledge_imports where organization_id = current_setting('avenlyo.knowledge_org_a')::uuid),
  true
);

select extensions.throws_ok(
  $$ update public.knowledge_imports set status = 'completed' where id = current_setting('avenlyo.knowledge_import_a')::uuid $$,
  '42501',
  'permission denied for table knowledge_imports',
  'owner cannot forge internal import state directly'
);

select extensions.lives_ok(
  $$ select public.start_knowledge_import(current_setting('avenlyo.knowledge_import_a')::uuid) $$,
  'owner can start an import through the state RPC'
);
select extensions.lives_ok(
  $$
    select public.save_knowledge_import_pages(
      current_setting('avenlyo.knowledge_import_a')::uuid,
      '[{
        "canonical_url":"https://clinic-a.example/services",
        "title":"Services",
        "content":"North Star clinic offers preventive services and detailed customer information for every appointment.",
        "content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }]'::jsonb,
      1,
      0,
      'https://clinic-a.example/'
    )
  $$,
  'owner can persist crawled pages as reviewable drafts through the RPC'
);

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000004', true);
select extensions.is(
  (select count(*)::integer from public.knowledge_imports where id = current_setting('avenlyo.knowledge_import_a')::uuid),
  1,
  'organization member can read permitted import state'
);
select extensions.throws_ok(
  $$ select * from public.create_knowledge_import('https://member.example', null) $$,
  '42501',
  'An organization owner or admin is required',
  'normal member cannot start knowledge imports'
);
select extensions.throws_ok(
  $$
    select public.update_knowledge_document_draft(
      (select id from public.knowledge_documents where import_id = current_setting('avenlyo.knowledge_import_a')::uuid),
      'Changed', 'This is a sufficiently long but unauthorized draft edit for a normal member user.', true
    )
  $$,
  '42501',
  'Knowledge draft access is not permitted',
  'normal member cannot edit knowledge drafts'
);
select extensions.throws_ok(
  $$ select * from public.get_knowledge_import_publication_snapshot(current_setting('avenlyo.knowledge_import_a')::uuid) $$,
  '42501',
  'Knowledge import access is not permitted',
  'normal member cannot publish knowledge'
);

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000003', true);
select extensions.lives_ok(
  $$ select public.update_knowledge_document_draft(
    (select id from public.knowledge_documents where import_id = current_setting('avenlyo.knowledge_import_a')::uuid),
    'Approved services',
    'North Star clinic offers preventive services and detailed customer information for every appointment and customer.',
    true
  ) $$,
  'admin can manage a draft through the RPC'
);

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select set_config(
  'avenlyo.knowledge_import_b',
  (select import_id::text from public.create_knowledge_import('https://clinic-b.example', null)),
  true
);
select extensions.is(
  (select count(*)::integer from public.knowledge_imports where id = current_setting('avenlyo.knowledge_import_a')::uuid),
  0,
  'organization B cannot read organization A import data'
);
select extensions.throws_ok(
  $$ select public.start_knowledge_import(current_setting('avenlyo.knowledge_import_a')::uuid) $$,
  '42501',
  'Knowledge import access is not permitted',
  'organization B cannot mutate organization A import state'
);

reset role;

select extensions.throws_ok(
  format(
    'insert into public.knowledge_documents (organization_id, import_id, title, source_type, status, content, content_hash, canonical_url) values (%L, %L, ''bad'', ''website'', ''draft'', ''This content is long enough to satisfy the reviewed knowledge document constraint.'', ''bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'', ''https://bad.example'')',
    current_setting('avenlyo.knowledge_org_a'),
    current_setting('avenlyo.knowledge_import_b')
  ),
  '23503',
  'insert or update on table "knowledge_documents" violates foreign key constraint "knowledge_documents_import_fk"',
  'knowledge import/document relationships reject cross-tenant references'
);

insert into public.knowledge_documents (organization_id, location_id, title, source_type, status, content)
values (
  current_setting('avenlyo.knowledge_org_a')::uuid,
  current_setting('avenlyo.knowledge_location_a')::uuid,
  'Published services', 'manual', 'ready', 'Published services include dental cleaning and preventive care for customer pets.'
);
select set_config(
  'avenlyo.knowledge_ready_document',
  (select id::text from public.knowledge_documents where title = 'Published services'),
  true
);
insert into public.knowledge_chunks (organization_id, location_id, document_id, content, chunk_index, embedding)
select
  current_setting('avenlyo.knowledge_org_a')::uuid,
  current_setting('avenlyo.knowledge_location_a')::uuid,
  current_setting('avenlyo.knowledge_ready_document')::uuid,
  'Published services include dental cleaning and preventive care for customer pets.',
  0,
  ('[' || array_to_string(array_fill(0.1::real, array[1536]), ',') || ']')::extensions.vector;

insert into public.locations (organization_id, name)
values (current_setting('avenlyo.knowledge_org_a')::uuid, 'Unrelated location');
insert into public.knowledge_documents (organization_id, location_id, title, source_type, status, content)
select current_setting('avenlyo.knowledge_org_a')::uuid, id, 'Hidden secondary knowledge', 'manual', 'ready', 'Secondary knowledge must not leak.'
from public.locations
where organization_id = current_setting('avenlyo.knowledge_org_a')::uuid and name = 'Unrelated location';
insert into public.knowledge_chunks (organization_id, location_id, document_id, content, chunk_index, embedding)
select
  document.organization_id, document.location_id, document.id, document.content, 0,
  ('[' || array_to_string(array_fill(0.1::real, array[1536]), ',') || ']')::extensions.vector
from public.knowledge_documents as document where document.title = 'Hidden secondary knowledge';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000004', true);
select extensions.is(
  (
    select count(*)::integer from public.match_my_knowledge(
      '[' || array_to_string(array_fill(0.1::real, array[1536]), ',') || ']',
      5,
      null
    )
  ),
  1,
  'retrieval returns ready local chunks but excludes drafts and unrelated locations'
);

reset role;
insert into public.knowledge_imports (organization_id, root_url, status, started_at, finished_at, error_code, error_message)
values (
  current_setting('avenlyo.knowledge_org_a')::uuid,
  'https://failed-rescan.example',
  'failed', now(), now(), 'request_failed', 'Knowledge import could not be completed.'
);
select extensions.is(
  (select status from public.knowledge_documents where id = current_setting('avenlyo.knowledge_ready_document')::uuid),
  'ready',
  'a failed new import does not remove previously published knowledge'
);

select * from extensions.finish();
rollback;

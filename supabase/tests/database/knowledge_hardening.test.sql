-- Phase 2 publication reservation, hash integrity, and location-scope regression tests.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(16);

insert into auth.users (id, email)
values
  ('50000000-0000-0000-0000-000000000001', 'knowledge-hardening-owner@example.test'),
  ('50000000-0000-0000-0000-000000000002', 'knowledge-hardening-member@example.test');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok($$ select * from public.bootstrap_workspace() $$, 'owner can bootstrap hardening fixture');

reset role;

select set_config(
  'avenlyo.hardening_org',
  (select organization_id::text from public.organization_members where user_id = '50000000-0000-0000-0000-000000000001'),
  true
);
select set_config(
  'avenlyo.hardening_location_a',
  (select location_id::text from public.organization_onboarding where organization_id = current_setting('avenlyo.hardening_org')::uuid),
  true
);

update public.organization_onboarding
set status = 'completed', current_step = 'completed', completed_at = now()
where organization_id = current_setting('avenlyo.hardening_org')::uuid;

insert into public.organization_members (organization_id, user_id, role)
values (current_setting('avenlyo.hardening_org')::uuid, '50000000-0000-0000-0000-000000000002', 'member');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
select current_setting('avenlyo.hardening_org')::uuid, member.id, current_setting('avenlyo.hardening_location_a')::uuid
from public.organization_members as member
where member.organization_id = current_setting('avenlyo.hardening_org')::uuid
  and member.user_id = '50000000-0000-0000-0000-000000000002';

insert into public.locations (organization_id, name)
values (current_setting('avenlyo.hardening_org')::uuid, 'Location B');
select set_config(
  'avenlyo.hardening_location_b',
  (select id::text from public.locations where organization_id = current_setting('avenlyo.hardening_org')::uuid and name = 'Location B'),
  true
);

insert into public.knowledge_imports (organization_id, location_id, root_url, status, finished_at)
values
  (current_setting('avenlyo.hardening_org')::uuid, current_setting('avenlyo.hardening_location_a')::uuid, 'https://location-a-old.example', 'completed', now()),
  (current_setting('avenlyo.hardening_org')::uuid, current_setting('avenlyo.hardening_location_b')::uuid, 'https://location-b-old.example', 'completed', now()),
  (current_setting('avenlyo.hardening_org')::uuid, current_setting('avenlyo.hardening_location_a')::uuid, 'https://location-a-new.example', 'awaiting_review');

select set_config('avenlyo.hardening_import_a_old', (select id::text from public.knowledge_imports where root_url = 'https://location-a-old.example'), true);
select set_config('avenlyo.hardening_import_b_old', (select id::text from public.knowledge_imports where root_url = 'https://location-b-old.example'), true);
select set_config('avenlyo.hardening_import_a_new', (select id::text from public.knowledge_imports where root_url = 'https://location-a-new.example'), true);

insert into public.knowledge_documents (
  organization_id, location_id, import_id, title, source_type, status, content, content_hash, canonical_url
)
values
  (
    current_setting('avenlyo.hardening_org')::uuid,
    current_setting('avenlyo.hardening_location_a')::uuid,
    current_setting('avenlyo.hardening_import_a_old')::uuid,
    'Old Location A', 'website', 'ready',
    'Old Location A website content remains available until a replacement is safely published.',
    encode(extensions.digest('Old Location A website content remains available until a replacement is safely published.', 'sha256'), 'hex'),
    'https://location-a-old.example/services'
  ),
  (
    current_setting('avenlyo.hardening_org')::uuid,
    current_setting('avenlyo.hardening_location_b')::uuid,
    current_setting('avenlyo.hardening_import_b_old')::uuid,
    'Old Location B', 'website', 'ready',
    'Location B website content must remain ready when Location A publishes a replacement.',
    encode(extensions.digest('Location B website content must remain ready when Location A publishes a replacement.', 'sha256'), 'hex'),
    'https://location-b-old.example/services'
  ),
  (
    current_setting('avenlyo.hardening_org')::uuid,
    current_setting('avenlyo.hardening_location_a')::uuid,
    current_setting('avenlyo.hardening_import_a_new')::uuid,
    'New Location A', 'website', 'draft',
    'New Location A replacement content is reviewed before it becomes ready for semantic retrieval.',
    encode(extensions.digest('New Location A replacement content is reviewed before it becomes ready for semantic retrieval.', 'sha256'), 'hex'),
    'https://location-a-new.example/services'
  );
select set_config(
  'avenlyo.hardening_new_document',
  (select id::text from public.knowledge_documents where import_id = current_setting('avenlyo.hardening_import_a_new')::uuid),
  true
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select * from public.begin_knowledge_publish(current_setting('avenlyo.hardening_import_a_new')::uuid) $$,
  'owner atomically reserves a reviewed import before embedding work'
);
select extensions.throws_ok(
  $$ select * from public.begin_knowledge_publish(current_setting('avenlyo.hardening_import_a_new')::uuid) $$,
  '23514',
  'Knowledge import is already publishing or unavailable',
  'a second publisher cannot claim the same import'
);
select extensions.throws_ok(
  $$ select public.update_knowledge_document_draft(
    current_setting('avenlyo.hardening_new_document')::uuid,
    'Late edit',
    'This late edit must not change the reserved snapshot while embedding generation is in progress.',
    true
  ) $$,
  '42501',
  'Knowledge draft access is not permitted',
  'draft edits are blocked after publication reservation'
);
select extensions.throws_ok(
  $$
    select public.complete_knowledge_publish(
      current_setting('avenlyo.hardening_import_a_new')::uuid,
      (
        select jsonb_agg(jsonb_build_object('document_id', id, 'content_hash', content_hash))
        from public.knowledge_documents
        where import_id = current_setting('avenlyo.hardening_import_a_new')::uuid
      ),
      (
        select jsonb_agg(jsonb_build_object(
          'document_id', id,
          'chunk_index', 0,
          'content', content,
          'content_hash', repeat('0', 64),
          'embedding', '[' || array_to_string(array_fill(0.1::real, array[1536]), ',') || ']',
          'embedding_provider', 'test',
          'embedding_model', 'test-1536'
        ))
        from public.knowledge_documents
        where import_id = current_setting('avenlyo.hardening_import_a_new')::uuid
      )
    )
  $$,
  '22023',
  'Knowledge embeddings are invalid',
  'publication rejects a caller-supplied chunk hash that does not match its content'
);
select extensions.lives_ok(
  $$
    select public.complete_knowledge_publish(
      current_setting('avenlyo.hardening_import_a_new')::uuid,
      (
        select jsonb_agg(jsonb_build_object('document_id', id, 'content_hash', content_hash))
        from public.knowledge_documents
        where import_id = current_setting('avenlyo.hardening_import_a_new')::uuid
      ),
      (
        select jsonb_agg(jsonb_build_object(
          'document_id', id,
          'chunk_index', 0,
          'content', content,
          'content_hash', encode(extensions.digest(content, 'sha256'), 'hex'),
          'embedding', '[' || array_to_string(array_fill(0.1::real, array[1536]), ',') || ']',
          'embedding_provider', 'test',
          'embedding_model', 'test-1536'
        ))
        from public.knowledge_documents
        where import_id = current_setting('avenlyo.hardening_import_a_new')::uuid
      )
    )
  $$,
  'reserved publication persists valid chunks and completes atomically'
);

reset role;
select extensions.is(
  (select status from public.knowledge_documents where id = current_setting('avenlyo.hardening_new_document')::uuid),
  'ready',
  'the new Location A document becomes ready'
);
select extensions.is(
  (select status from public.knowledge_documents where import_id = current_setting('avenlyo.hardening_import_a_old')::uuid),
  'archived',
  'a Location A replacement archives only old Location A website knowledge'
);
select extensions.is(
  (select status from public.knowledge_documents where import_id = current_setting('avenlyo.hardening_import_b_old')::uuid),
  'ready',
  'publishing Location A preserves ready website knowledge for Location B'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000002', true);
select extensions.is(
  (select count(*)::integer from public.get_my_knowledge_overview() where root_url like 'https://location-a-%'),
  2,
  'a Location A member sees Location A import metadata'
);
select extensions.is(
  (select count(*)::integer from public.get_my_knowledge_overview() where root_url = 'https://location-b-old.example'),
  0,
  'a Location A member cannot receive Location B metadata from the overview RPC'
);

reset role;
insert into public.knowledge_imports (organization_id, location_id, root_url, status)
values (current_setting('avenlyo.hardening_org')::uuid, current_setting('avenlyo.hardening_location_a')::uuid, 'https://location-a-recovery.example', 'awaiting_review');
select set_config('avenlyo.hardening_recovery_import', (select id::text from public.knowledge_imports where root_url = 'https://location-a-recovery.example'), true);
insert into public.knowledge_documents (
  organization_id, location_id, import_id, title, source_type, status, content, content_hash, canonical_url
)
values (
  current_setting('avenlyo.hardening_org')::uuid,
  current_setting('avenlyo.hardening_location_a')::uuid,
  current_setting('avenlyo.hardening_recovery_import')::uuid,
  'Recoverable draft', 'website', 'draft',
  'This reviewed draft proves a temporary embedding failure returns publication to a recoverable state.',
  encode(extensions.digest('This reviewed draft proves a temporary embedding failure returns publication to a recoverable state.', 'sha256'), 'hex'),
  'https://location-a-recovery.example/services'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select * from public.begin_knowledge_publish(current_setting('avenlyo.hardening_recovery_import')::uuid) $$,
  'a second reviewed import can be reserved'
);
select extensions.lives_ok(
  $$ select public.release_knowledge_publish(current_setting('avenlyo.hardening_recovery_import')::uuid) $$,
  'a failed embedding attempt returns the reservation to review'
);

reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = current_setting('avenlyo.hardening_recovery_import')::uuid),
  'awaiting_review',
  'publication failure recovery preserves review drafts'
);

insert into public.knowledge_imports (organization_id, location_id, root_url, status, updated_at)
values (
  current_setting('avenlyo.hardening_org')::uuid,
  current_setting('avenlyo.hardening_location_a')::uuid,
  'https://location-a-stale.example',
  'publishing',
  now() - interval '16 minutes'
);
select set_config('avenlyo.hardening_stale_import', (select id::text from public.knowledge_imports where root_url = 'https://location-a-stale.example'), true);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '50000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok(
  $$ select public.recover_stale_knowledge_publish(current_setting('avenlyo.hardening_stale_import')::uuid) $$,
  'an owner can recover a stalled publishing reservation'
);

reset role;
select extensions.is(
  (select status from public.knowledge_imports where id = current_setting('avenlyo.hardening_stale_import')::uuid),
  'awaiting_review',
  'a stale publication is returned to review without deleting drafts'
);

select * from extensions.finish();
rollback;

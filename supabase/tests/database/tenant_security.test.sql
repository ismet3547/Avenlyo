-- Executed by `supabase test db` against a clean local Supabase database. These pgTAP tests exercise
-- PostgreSQL RLS and foreign-key behavior; they are not part of the Vitest suite.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(9);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000001', 'admin-a@example.test'),
  ('00000000-0000-0000-0000-000000000002', 'member-a@example.test'),
  ('00000000-0000-0000-0000-000000000003', 'owner-b@example.test');

insert into public.organizations (id, name, slug, created_by)
values
  (
    '10000000-0000-0000-0000-000000000001',
    'Organization A',
    'organization-a',
    '00000000-0000-0000-0000-000000000001'
  ),
  (
    '20000000-0000-0000-0000-000000000001',
    'Organization B',
    'organization-b',
    '00000000-0000-0000-0000-000000000003'
  );

insert into public.locations (id, organization_id, name)
values
  (
    '11000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Organization A - Location One'
  ),
  (
    '11000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    'Organization A - Location Two'
  ),
  (
    '21000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Organization B - Location One'
  );

insert into public.organization_members (id, organization_id, user_id, role)
values
  (
    '12000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'admin'
  ),
  (
    '12000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    'member'
  ),
  (
    '22000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000003',
    'owner'
  );

insert into public.organization_member_locations (
  id,
  organization_id,
  organization_member_id,
  location_id
)
values (
  '13000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000002',
  '11000000-0000-0000-0000-000000000001'
);

insert into public.contacts (id, organization_id, location_id, first_name)
values
  (
    '14000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001',
    'Permitted'
  ),
  (
    '14000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000002',
    'Other Location'
  ),
  (
    '24000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '21000000-0000-0000-0000-000000000001',
    'Other Organization'
  );

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);

select extensions.is(
  (
    select count(*)::integer
    from public.contacts
    where organization_id = '10000000-0000-0000-0000-000000000001'
  ),
  1,
  'location-scoped member can read permitted operational data'
);

select extensions.results_eq(
  $$
    with deleted as (
      delete from public.locations
      where id = '11000000-0000-0000-0000-000000000001'
      returning 1
    )
    select count(*)::integer from deleted
  $$,
  array[0],
  'member cannot delete protected configuration'
);

select extensions.throws_ok(
  $$
    insert into public.ai_agents (organization_id, location_id, name)
    values (
      '10000000-0000-0000-0000-000000000001',
      '11000000-0000-0000-0000-000000000001',
      'Unauthorized agent'
    )
  $$,
  '42501'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);

select extensions.results_eq(
  $$
    with updated as (
      update public.locations
      set timezone = 'Europe/Istanbul'
      where id = '11000000-0000-0000-0000-000000000002'
      returning 1
    )
    select count(*)::integer from updated
  $$,
  array[1],
  'admin can manage protected configuration'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);

select extensions.is(
  (
    select count(*)::integer
    from public.contacts
    where organization_id = '20000000-0000-0000-0000-000000000001'
  ),
  0,
  'organization A member cannot read organization B data'
);

select extensions.is(
  (
    select count(*)::integer
    from public.locations
    where organization_id = '10000000-0000-0000-0000-000000000001'
  ),
  1,
  'location-scoped member cannot read an unrelated location'
);

select extensions.throws_ok(
  $$
    insert into public.conversations (id, organization_id, location_id, contact_id)
    values (
      '15000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      '11000000-0000-0000-0000-000000000001',
      '24000000-0000-0000-0000-000000000001'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "conversations"',
  'direct conversation writes are denied before a client can probe cross-tenant foreign keys'
);

reset role;

select extensions.throws_ok(
  $$
    insert into public.industry_templates (industry_id, name, is_system)
    values ('veterinary', 'Ambiguous global template', false)
  $$,
  '23514'
);

insert into public.industry_templates (
  id,
  organization_id,
  industry_id,
  name,
  is_system
)
values (
  '25000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'veterinary',
  'Organization B template',
  false
);

select extensions.throws_ok(
  $$
    insert into public.ai_agents (organization_id, industry_template_id, name)
    values (
      '10000000-0000-0000-0000-000000000001',
      '25000000-0000-0000-0000-000000000001',
      'Cross-tenant template agent'
    )
  $$,
  '23503'
);

select * from extensions.finish();
rollback;

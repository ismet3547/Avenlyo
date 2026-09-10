-- Dental V1 vertical: additive industry support and onboarding authorization.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(5);

select extensions.is(
  (
    select count(*)::integer
    from public.industry_templates
    where industry_id = 'dental' and is_system
  ),
  1,
  'the dental system industry template is installed exactly once'
);

select extensions.ok(
  (
    select schema_version >= 23
    from public.platform_schema_contract
    where id
  ),
  'dental V1 requires schema version 23 or newer'
);

insert into auth.users (id, email)
values ('39000000-0000-0000-0000-000000000001', 'dental-owner@example.test');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '39000000-0000-0000-0000-000000000001', true);

select extensions.lives_ok(
  $$ select * from public.bootstrap_workspace() $$,
  'a dental owner can bootstrap an authenticated workspace'
);

select extensions.lives_ok(
  $$ select public.save_onboarding_industry('dental') $$,
  'the authenticated onboarding RPC accepts dental'
);

select extensions.is(
  (
    select organization.primary_industry_id
    from public.organizations as organization
    join public.organization_members as member on member.organization_id = organization.id
    where member.user_id = '39000000-0000-0000-0000-000000000001'
  ),
  'dental',
  'dental selection is persisted only through the owner-derived workspace boundary'
);

select * from extensions.finish();
rollback;

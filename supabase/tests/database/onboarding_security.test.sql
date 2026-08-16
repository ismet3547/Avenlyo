-- Phase 1 onboarding security and state tests. Executed by `supabase test db` after a clean reset.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(14);

insert into auth.users (id, email)
values
  ('30000000-0000-0000-0000-000000000001', 'owner-one@example.test'),
  ('30000000-0000-0000-0000-000000000002', 'owner-two@example.test'),
  ('30000000-0000-0000-0000-000000000003', 'scoped-member@example.test');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);

select extensions.lives_ok(
  $$ select * from public.bootstrap_workspace() $$,
  'authenticated user can atomically create a first workspace'
);

select extensions.is(
  (
    select role
    from public.organization_members
    where user_id = '30000000-0000-0000-0000-000000000001'
  ),
  'owner',
  'workspace bootstrap creates the owner membership'
);

select extensions.lives_ok(
  $$ select * from public.bootstrap_workspace() $$,
  'workspace bootstrap is idempotent for an existing owner'
);

select extensions.is(
  (
    select count(*)::integer
    from public.organization_members
    where user_id = '30000000-0000-0000-0000-000000000001'
  ),
  1,
  'idempotent bootstrap does not create a duplicate workspace'
);

select set_config(
  'avenlyo.test_org_a',
  (
    select organization_id::text
    from public.organization_members
    where user_id = '30000000-0000-0000-0000-000000000001'
  ),
  true
);

select extensions.throws_ok(
  $$ select public.save_onboarding_industry('dentistry') $$,
  '22023',
  'Unsupported industry identifier',
  'unsupported industry identifiers are rejected by the database'
);

select extensions.lives_ok(
  $$ select public.save_onboarding_industry('veterinary') $$,
  'an owner can save a supported onboarding industry'
);

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000002', true);

select extensions.lives_ok(
  $$ select * from public.bootstrap_workspace() $$,
  'a second authenticated user can bootstrap their own workspace'
);

select set_config(
  'avenlyo.test_org_b',
  (
    select organization_id::text
    from public.organization_members
    where user_id = '30000000-0000-0000-0000-000000000002'
  ),
  true
);

select extensions.results_eq(
  $$
    with changed as (
      update public.organization_onboarding
      set current_step = 'review'
      where organization_id = current_setting('avenlyo.test_org_a')::uuid
      returning 1
    )
    select count(*)::integer from changed
  $$,
  array[0],
  'a second user cannot mutate the first organization onboarding row'
);

select extensions.is(
  (
    select count(*)::integer
    from public.organization_onboarding
    where organization_id = current_setting('avenlyo.test_org_a')::uuid
  ),
  0,
  'a second user cannot read the first organization onboarding row'
);

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);

select extensions.throws_ok(
  $$
    update public.organization_onboarding
    set
      status = 'completed',
      current_step = 'completed',
      completed_at = now()
    where organization_id = current_setting('avenlyo.test_org_a')::uuid
  $$,
  '42501',
  'permission denied for table organization_onboarding',
  'an organization owner cannot directly complete onboarding'
);

reset role;

-- onboarding cannot reference a location from another tenant
select extensions.throws_ok(
  format(
    'update public.organization_onboarding set location_id = %L where organization_id = %L',
    (
      select location_id
      from public.organization_onboarding
      where organization_id = current_setting('avenlyo.test_org_b')::uuid
    ),
    current_setting('avenlyo.test_org_a')
  ),
  '23503'
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);

select extensions.lives_ok(
  $onboarding$
    do $setup$
    begin
      perform public.save_onboarding_business(
        'North Star Veterinary',
        'https://northstar.example',
        '+905551234567'
      );
      perform public.save_onboarding_location(
        'Istanbul Clinic',
        'Europe/Istanbul',
        '{
          "street": "123 Main Street",
          "city": "Istanbul",
          "region": "Istanbul",
          "postal_code": "34000",
          "country_code": "TR"
        }'::jsonb,
        '{
          "monday": {"closed": false, "open": "09:00", "close": "17:00"},
          "tuesday": {"closed": false, "open": "09:00", "close": "17:00"},
          "wednesday": {"closed": false, "open": "09:00", "close": "17:00"},
          "thursday": {"closed": false, "open": "09:00", "close": "17:00"},
          "friday": {"closed": false, "open": "09:00", "close": "17:00"},
          "saturday": {"closed": true, "open": null, "close": null},
          "sunday": {"closed": true, "open": null, "close": null}
        }'::jsonb
      );
      perform public.advance_onboarding_website();
      perform public.complete_onboarding();
    end
    $setup$
  $onboarding$,
  'trusted onboarding RPCs persist valid steps and complete the workflow'
);

select extensions.is(
  (
    select status
    from public.organization_onboarding
    where organization_id = current_setting('avenlyo.test_org_a')::uuid
  ),
  'completed',
  'onboarding completion is persisted in the database'
);

reset role;

insert into public.locations (organization_id, name)
values (current_setting('avenlyo.test_org_a')::uuid, 'Secondary location');

insert into public.organization_members (organization_id, user_id, role)
values (
  current_setting('avenlyo.test_org_a')::uuid,
  '30000000-0000-0000-0000-000000000003',
  'member'
);

insert into public.organization_member_locations (
  organization_id,
  organization_member_id,
  location_id
)
select
  current_setting('avenlyo.test_org_a')::uuid,
  member.id,
  onboarding.location_id
from public.organization_members as member
join public.organization_onboarding as onboarding
  on onboarding.organization_id = member.organization_id
where member.user_id = '30000000-0000-0000-0000-000000000003';

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000003', true);

select extensions.is(
  (
    select count(*)::integer
    from public.locations
    where organization_id = current_setting('avenlyo.test_org_a')::uuid
  ),
  1,
  'Phase 0 location-scoped RLS still hides unrelated locations'
);

select * from extensions.finish();
rollback;

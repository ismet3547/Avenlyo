-- Phase 26: hosted secret-key role compatibility and operator business-context isolation.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(8);

insert into auth.users (id, email)
values ('96000000-0000-0000-0000-000000000001', 'backend-role-owner@example.test');

insert into public.users (id, email)
select id, email from auth.users
where id = '96000000-0000-0000-0000-000000000001'
on conflict (id) do nothing;

insert into public.organizations (
  id, name, slug, created_by, primary_industry_id, website_url, business_phone
)
values (
  '96100000-0000-0000-0000-000000000001',
  'Backend role dental clinic',
  'backend-role-dental-clinic',
  '96000000-0000-0000-0000-000000000001',
  'dental',
  'https://clinic.example',
  '+905551112233'
);

insert into public.locations (
  id, organization_id, name, timezone, address, business_hours
)
values (
  '96200000-0000-0000-0000-000000000001',
  '96100000-0000-0000-0000-000000000001',
  'Istanbul',
  'Europe/Istanbul',
  '{"city":"Istanbul","country_code":"TR"}'::jsonb,
  '{"monday":{"open":"09:00","close":"18:00","closed":false},"tuesday":{"open":"09:00","close":"18:00","closed":false},"wednesday":{"open":"09:00","close":"18:00","closed":false},"thursday":{"open":"09:00","close":"18:00","closed":false},"friday":{"open":"09:00","close":"18:00","closed":false},"saturday":{"open":"10:00","close":"15:00","closed":false},"sunday":{"open":null,"close":null,"closed":true}}'::jsonb
);

select extensions.ok(
  not has_function_privilege('anon', 'public.get_agent_location_business_context(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_agent_location_business_context(uuid)', 'EXECUTE'),
  'browser roles cannot execute the operator business-context RPC'
);
select extensions.ok(
  has_function_privilege('service_role', 'public.get_agent_location_business_context(uuid)', 'EXECUTE'),
  'service role can execute the operator business-context RPC'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"96000000-0000-0000-0000-000000000001"}', true);
select set_config('request.jwt.claim.role', '', true);
select extensions.throws_ok(
  $$ select * from public.get_agent_location_business_context('96200000-0000-0000-0000-000000000001') $$,
  '42501',
  'permission denied for function get_agent_location_business_context',
  'authenticated clients cannot call the backend business-context RPC even with a valid user identity'
);

reset role;
set local role service_role;
-- Reproduce current hosted secret-key semantics: the canonical claims object carries the role while
-- the legacy request.jwt.claim.role scalar is absent/empty.
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.is(
  auth.role(),
  'service_role'::text,
  'auth.role resolves service_role from the canonical hosted claims object'
);
select extensions.lives_ok(
  $$ select * from public.match_inbound_voice_knowledge(
       '96100000-0000-0000-0000-000000000001',
       '96200000-0000-0000-0000-000000000001',
       ('[' || repeat('0,', 1535) || '0]')::text,
       1
     ) $$,
  'knowledge RPC accepts hosted service-role semantics without the legacy scalar claim'
);
select extensions.is(
  (select primary_industry_id
   from public.get_agent_location_business_context('96200000-0000-0000-0000-000000000001')),
  'dental'::text,
  'operator context returns the location industry through the trusted RPC'
);
select extensions.is(
  (select location_timezone
   from public.get_agent_location_business_context('96200000-0000-0000-0000-000000000001')),
  'Europe/Istanbul'::text,
  'operator context returns front-office location configuration without raw table access'
);
select extensions.is(
  (select schema_version from public.platform_readiness_probe()),
  25,
  'Phase 26 advances the additive platform schema contract to 25 through the backend readiness RPC'
);

reset role;
rollback;

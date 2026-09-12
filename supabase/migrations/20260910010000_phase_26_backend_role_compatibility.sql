-- Phase 26 fixes the last backend role guard that still depended on the legacy
-- request.jwt.claim.role GUC. Hosted Supabase secret keys authenticate service-role requests through
-- auth.role(), which is already the contract used by every other Avenlyo backend guard.
--
-- The same migration adds one read-only, service-role-only business-context RPC for trusted operator
-- acceptance. It exposes only organization/location front-office configuration, never users,
-- contacts, conversations, credentials, provider state, or customer content. Raw table grants remain
-- unchanged: the backend still reaches protected tables only through SECURITY DEFINER RPCs.

create or replace function public.require_voice_service_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Voice backend access is required';
  end if;
end;
$$;

create function public.get_agent_location_business_context(target_location_id uuid)
returns table (
  organization_id uuid,
  organization_name text,
  primary_industry_id text,
  website_url text,
  business_phone text,
  location_id uuid,
  location_name text,
  location_timezone text,
  location_address jsonb,
  business_hours jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_platform_service_role();

  return query
  select
    organization.id,
    organization.name,
    organization.primary_industry_id,
    organization.website_url,
    organization.business_phone,
    location.id,
    location.name,
    location.timezone,
    location.address,
    location.business_hours
  from public.locations as location
  join public.organizations as organization
    on organization.id = location.organization_id
  where location.id = target_location_id;
end;
$$;

-- New public functions are executable by PUBLIC by default and hosted-compatible local Supabase can
-- auto-grant API roles. Reset the callable surface explicitly, then grant only the trusted backend.
revoke all on function public.get_agent_location_business_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_agent_location_business_context(uuid)
  to service_role;

update public.platform_schema_contract
set schema_version = 25, updated_at = now()
where id;

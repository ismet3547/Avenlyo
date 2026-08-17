-- Phase 6: an immutable ezyVet booking intent remains recoverable after a disconnect.
-- The current scheduling policy still controls new writes; this only permits the trusted
-- backend to obtain the vaulted credentials required to reconcile an existing intent.

create or replace function public.get_ezyvet_execution_credentials(target_integration_id uuid)
returns table (
  organization_id uuid,
  location_id uuid,
  environment text,
  site_uid text,
  site_timezone text,
  client_id text,
  client_secret text,
  credential_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare decrypted text;
begin
  perform public.require_ezyvet_service_role();

  select vault_secret.decrypted_secret into decrypted
  from public.integration_credentials as credential
  join public.integrations as integration
    on integration.organization_id = credential.organization_id
    and integration.location_id = credential.location_id
    and integration.id = credential.integration_id
  join vault.decrypted_secrets as vault_secret on vault_secret.id = credential.vault_secret_id
  where credential.integration_id = target_integration_id
    and integration.provider = 'ezyvet';

  if decrypted is null then
    raise exception using errcode = '42501', message = 'ezyVet credentials are not available';
  end if;

  return query
  select integration.organization_id, integration.location_id, integration.environment,
    credential_secret.value ->> 'site_uid', integration.site_timezone,
    credential_secret.value ->> 'client_id', credential_secret.value ->> 'client_secret',
    credential.credential_version
  from public.integration_credentials as credential
  join public.integrations as integration
    on integration.organization_id = credential.organization_id
    and integration.location_id = credential.location_id
    and integration.id = credential.integration_id
  cross join lateral (select decrypted::jsonb as value) as credential_secret
  where credential.integration_id = target_integration_id
    and integration.provider = 'ezyvet';
end;
$$;

create or replace function public.disable_ezyvet_integration(
  target_organization_id uuid,
  target_location_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare target_integration_id uuid;
begin
  perform public.require_ezyvet_service_role();

  select id into target_integration_id
  from public.integrations
  where organization_id = target_organization_id
    and location_id = target_location_id
    and provider = 'ezyvet';

  if target_integration_id is null then
    return;
  end if;

  update public.integrations
  set status = 'disabled', updated_at = now()
  where id = target_integration_id
    and organization_id = target_organization_id
    and location_id = target_location_id;

  update public.location_scheduling_settings
  set active_integration_id = null, updated_at = now()
  where organization_id = target_organization_id
    and location_id = target_location_id
    and active_integration_id = target_integration_id;

  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (
    target_organization_id,
    target_location_id,
    'integration.ezyvet.disabled',
    'integration',
    target_integration_id,
    '{}'
  );
end;
$$;

revoke all on function public.get_ezyvet_execution_credentials(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_ezyvet_execution_credentials(uuid) to service_role;

revoke all on function public.disable_ezyvet_integration(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.disable_ezyvet_integration(uuid, uuid) to service_role;

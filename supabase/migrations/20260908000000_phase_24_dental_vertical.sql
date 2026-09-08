-- Phase 24: dental-first V1 vertical.
--
-- Existing tenant industries remain valid for rollback/backward compatibility. New acquisition
-- onboarding is dental-only in the application, while the database accepts dental as an additional
-- source-controlled industry and provides its system template to the existing onboarding RPC.

alter table public.organizations
  drop constraint organizations_primary_industry_check;

alter table public.organizations
  add constraint organizations_primary_industry_check check (
    primary_industry_id is null
    or primary_industry_id in ('veterinary', 'auto-repair', 'medspa', 'dental')
  );

alter table public.industry_templates
  drop constraint industry_templates_supported_industry_check;

alter table public.industry_templates
  add constraint industry_templates_supported_industry_check check (
    industry_id in ('veterinary', 'auto-repair', 'medspa', 'dental')
  );

insert into public.industry_templates (
  industry_id,
  name,
  description,
  configuration,
  is_system
)
values (
  'dental',
  'Dental Clinic',
  'Patient questions, implant and cosmetic leads, appointment scheduling and front-desk follow-up.',
  '{"pack_version": 1, "vertical": "dental"}'::jsonb,
  true
)
on conflict (industry_id) where is_system do update
set
  name = excluded.name,
  description = excluded.description,
  configuration = excluded.configuration;

create or replace function public.save_onboarding_industry(selected_industry_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_owned_onboarding_organization();
  next_step text;
begin
  if selected_industry_id not in ('veterinary', 'auto-repair', 'medspa', 'dental') then
    raise exception using errcode = '22023', message = 'Unsupported industry identifier';
  end if;

  if not exists (
    select 1
    from public.industry_templates as template
    where template.industry_id = selected_industry_id
      and template.is_system
  ) then
    raise exception using errcode = '23503', message = 'Industry template is unavailable';
  end if;

  update public.organizations
  set primary_industry_id = selected_industry_id
  where id = workspace_id;

  update public.organization_onboarding
  set current_step = public.advance_onboarding_step(current_step, 'industry')
  where organization_id = workspace_id
  returning current_step into next_step;

  return next_step;
end;
$$;

revoke all on function public.save_onboarding_industry(text) from public;
grant execute on function public.save_onboarding_industry(text) to authenticated;

update public.platform_schema_contract
set schema_version = 23, updated_at = now()
where id;

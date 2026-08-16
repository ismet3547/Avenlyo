-- Avenlyo Phase 1 authenticated onboarding. This migration is intentionally additive to the
-- merged Phase 0 foundation and keeps tenant identity inside auth.uid()-derived database functions.

alter table public.organizations
  add column primary_industry_id text,
  add column website_url text,
  add column business_phone text,
  add constraint organizations_primary_industry_check check (
    primary_industry_id is null
    or primary_industry_id in ('veterinary', 'auto-repair', 'medspa')
  ),
  add constraint organizations_website_url_check check (
    website_url is null or website_url ~* '^https?://[^[:space:]]+$'
  ),
  add constraint organizations_business_phone_check check (
    business_phone is null or business_phone ~ '^\+?[1-9][0-9]{6,14}$'
  );

alter table public.industry_templates
  add constraint industry_templates_supported_industry_check check (
    industry_id in ('veterinary', 'auto-repair', 'medspa')
  );

create unique index industry_templates_system_industry_key
  on public.industry_templates (industry_id)
  where is_system;

insert into public.industry_templates (
  industry_id,
  name,
  description,
  configuration,
  is_system
)
values
  (
    'veterinary',
    'Veterinary Clinic',
    'Appointments, client questions, pet information and front-desk communication.',
    '{"pack_version": 1}'::jsonb,
    true
  ),
  (
    'auto-repair',
    'Auto Repair',
    'Service inquiries, estimates, bookings and customer follow-up.',
    '{"pack_version": 1}'::jsonb,
    true
  ),
  (
    'medspa',
    'Medspa / Aesthetics',
    'Treatment inquiries, lead qualification and appointment scheduling.',
    '{"pack_version": 1}'::jsonb,
    true
  )
on conflict (industry_id) where is_system do nothing;

create function public.is_valid_business_hours(value jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  day_name text;
  day_value jsonb;
  expected_days constant text[] := array[
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
  ];
begin
  if jsonb_typeof(value) <> 'object'
    or (select count(*) from jsonb_object_keys(value)) <> 7
  then
    return false;
  end if;

  foreach day_name in array expected_days
  loop
    day_value := value -> day_name;

    if day_value is null
      or jsonb_typeof(day_value) <> 'object'
      or day_value ->> 'closed' not in ('true', 'false')
    then
      return false;
    end if;

    if (day_value ->> 'closed')::boolean then
      if coalesce(jsonb_typeof(day_value -> 'open'), 'missing') <> 'null'
        or coalesce(jsonb_typeof(day_value -> 'close'), 'missing') <> 'null'
      then
        return false;
      end if;
    else
      if coalesce(day_value ->> 'open', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or coalesce(day_value ->> 'close', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (day_value ->> 'close')::time <= (day_value ->> 'open')::time
      then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;

create function public.is_valid_location_address(value jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select jsonb_typeof(value) = 'object'
    and length(btrim(coalesce(value ->> 'street', ''))) > 0
    and length(btrim(coalesce(value ->> 'city', ''))) > 0
    and length(btrim(coalesce(value ->> 'region', ''))) > 0
    and length(btrim(coalesce(value ->> 'postal_code', ''))) > 0
    and coalesce(value ->> 'country_code', '') ~ '^[A-Z]{2}$';
$$;

alter table public.locations
  add column business_hours jsonb not null default '{
    "monday": {"closed": true, "open": null, "close": null},
    "tuesday": {"closed": true, "open": null, "close": null},
    "wednesday": {"closed": true, "open": null, "close": null},
    "thursday": {"closed": true, "open": null, "close": null},
    "friday": {"closed": true, "open": null, "close": null},
    "saturday": {"closed": true, "open": null, "close": null},
    "sunday": {"closed": true, "open": null, "close": null}
  }'::jsonb,
  add constraint locations_business_hours_check check (
    public.is_valid_business_hours(business_hours)
  );

create table public.organization_onboarding (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  location_id uuid not null,
  current_step text not null default 'industry' check (
    current_step in ('industry', 'business', 'location', 'website', 'review', 'completed')
  ),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_onboarding_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint organization_onboarding_completion_state_check check (
    (status = 'in_progress' and current_step <> 'completed' and completed_at is null)
    or (status = 'completed' and current_step = 'completed' and completed_at is not null)
  )
);

create trigger set_organization_onboarding_updated_at
  before update on public.organization_onboarding
  for each row execute procedure public.set_updated_at();

alter table public.organization_onboarding enable row level security;

create policy organization_onboarding_select_member
  on public.organization_onboarding
  for select to authenticated
  using (public.is_organization_member(organization_id));

create policy organization_onboarding_update_owner
  on public.organization_onboarding
  for update to authenticated
  using (public.is_organization_owner(organization_id))
  with check (public.is_organization_owner(organization_id));

grant select, update on public.organization_onboarding to authenticated;

-- Workspace creation is now exclusively atomic. Authenticated clients can no longer create an
-- organization and its first privileged membership as separate, partially valid writes.
drop policy organizations_insert_authenticated on public.organizations;
drop policy organization_members_insert_admin on public.organization_members;

create policy organization_members_insert_admin
  on public.organization_members
  for insert to authenticated
  with check (
    public.is_organization_owner(organization_id)
    or (public.is_organization_admin(organization_id) and role <> 'owner')
  );

create function public.bootstrap_workspace()
returns table (
  organization_id uuid,
  location_id uuid,
  current_step text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  workspace_id uuid;
  primary_location_id uuid;
  onboarding_step text;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(current_user_id::text, 0)
  );

  insert into public.users (id, email)
  select auth_user.id, auth_user.email
  from auth.users as auth_user
  where auth_user.id = current_user_id
  on conflict (id) do nothing;

  select member.organization_id, onboarding.location_id, onboarding.current_step
  into workspace_id, primary_location_id, onboarding_step
  from public.organization_members as member
  join public.organization_onboarding as onboarding
    on onboarding.organization_id = member.organization_id
  where member.user_id = current_user_id
    and member.role = 'owner'
  order by member.created_at, member.id
  limit 1;

  if workspace_id is not null then
    return query select workspace_id, primary_location_id, onboarding_step;
    return;
  end if;

  if exists (
    select 1
    from public.organization_members as member
    where member.user_id = current_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'Only an organization owner can bootstrap onboarding';
  end if;

  workspace_id := extensions.gen_random_uuid();
  primary_location_id := extensions.gen_random_uuid();
  onboarding_step := 'industry';

  insert into public.organizations (id, name, slug, created_by)
  values (
    workspace_id,
    'New Avenlyo workspace',
    'workspace-' || replace(workspace_id::text, '-', ''),
    current_user_id
  );

  insert into public.organization_members (organization_id, user_id, role)
  values (workspace_id, current_user_id, 'owner');

  insert into public.locations (id, organization_id, name)
  values (primary_location_id, workspace_id, 'Main location');

  insert into public.organization_onboarding (
    organization_id,
    location_id,
    current_step
  )
  values (workspace_id, primary_location_id, onboarding_step);

  return query select workspace_id, primary_location_id, onboarding_step;
end;
$$;

create function public.require_owned_onboarding_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  workspace_id uuid;
begin
  select member.organization_id
  into workspace_id
  from public.organization_members as member
  join public.organization_onboarding as onboarding
    on onboarding.organization_id = member.organization_id
  where member.user_id = auth.uid()
    and member.role = 'owner'
    and onboarding.status = 'in_progress'
  order by member.created_at, member.id
  limit 1;

  if workspace_id is null then
    raise exception using
      errcode = '42501',
      message = 'An in-progress owner workspace is required';
  end if;

  return workspace_id;
end;
$$;

create function public.advance_onboarding_step(current_step text, completed_step text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when current_step = completed_step then case completed_step
      when 'industry' then 'business'
      when 'business' then 'location'
      when 'location' then 'website'
      when 'website' then 'review'
      else current_step
    end
    else current_step
  end;
$$;

create function public.save_onboarding_industry(selected_industry_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_owned_onboarding_organization();
  next_step text;
begin
  if selected_industry_id not in ('veterinary', 'auto-repair', 'medspa') then
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

create function public.save_onboarding_business(
  business_name text,
  business_website_url text,
  normalized_business_phone text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_owned_onboarding_organization();
  next_step text;
begin
  if length(btrim(coalesce(business_name, ''))) < 1
    or length(btrim(business_name)) > 120
  then
    raise exception using errcode = '22023', message = 'Business name is invalid';
  end if;

  if business_website_url is not null
    and business_website_url !~* '^https?://[^[:space:]]+$'
  then
    raise exception using errcode = '22023', message = 'Website URL is invalid';
  end if;

  if normalized_business_phone is not null
    and normalized_business_phone !~ '^\+?[1-9][0-9]{6,14}$'
  then
    raise exception using errcode = '22023', message = 'Business phone is invalid';
  end if;

  update public.organizations
  set
    name = btrim(business_name),
    website_url = business_website_url,
    business_phone = normalized_business_phone
  where id = workspace_id;

  update public.organization_onboarding
  set current_step = public.advance_onboarding_step(current_step, 'business')
  where organization_id = workspace_id
  returning current_step into next_step;

  return next_step;
end;
$$;

create function public.save_onboarding_location(
  location_name text,
  location_timezone text,
  location_address jsonb,
  location_business_hours jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_owned_onboarding_organization();
  next_step text;
begin
  if length(btrim(coalesce(location_name, ''))) < 1
    or length(btrim(location_name)) > 120
  then
    raise exception using errcode = '22023', message = 'Location name is invalid';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = location_timezone
  ) then
    raise exception using errcode = '22023', message = 'Timezone is invalid';
  end if;

  if not public.is_valid_location_address(location_address) then
    raise exception using errcode = '22023', message = 'Location address is invalid';
  end if;

  if not public.is_valid_business_hours(location_business_hours) then
    raise exception using errcode = '22023', message = 'Business hours are invalid';
  end if;

  update public.locations as location
  set
    name = btrim(location_name),
    timezone = location_timezone,
    address = location_address,
    business_hours = location_business_hours
  from public.organization_onboarding as onboarding
  where onboarding.organization_id = workspace_id
    and location.organization_id = onboarding.organization_id
    and location.id = onboarding.location_id;

  if not found then
    raise exception using errcode = '23503', message = 'Onboarding location is unavailable';
  end if;

  update public.organization_onboarding
  set current_step = public.advance_onboarding_step(current_step, 'location')
  where organization_id = workspace_id
  returning current_step into next_step;

  return next_step;
end;
$$;

create function public.advance_onboarding_website()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_owned_onboarding_organization();
  next_step text;
begin
  update public.organization_onboarding
  set current_step = public.advance_onboarding_step(current_step, 'website')
  where organization_id = workspace_id
  returning current_step into next_step;

  return next_step;
end;
$$;

create function public.complete_onboarding()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace_id uuid := public.require_owned_onboarding_organization();
  completion_time timestamptz := now();
begin
  if not exists (
    select 1
    from public.organizations as organization
    join public.organization_onboarding as onboarding
      on onboarding.organization_id = organization.id
    join public.locations as location
      on location.organization_id = onboarding.organization_id
      and location.id = onboarding.location_id
    where organization.id = workspace_id
      and onboarding.current_step = 'review'
      and organization.primary_industry_id is not null
      and organization.name <> 'New Avenlyo workspace'
      and public.is_valid_location_address(location.address)
      and public.is_valid_business_hours(location.business_hours)
      and exists (
        select 1 from pg_catalog.pg_timezone_names where name = location.timezone
      )
  ) then
    raise exception using errcode = '23514', message = 'Onboarding details are incomplete';
  end if;

  update public.organization_onboarding
  set
    status = 'completed',
    current_step = 'completed',
    completed_at = completion_time
  where organization_id = workspace_id;

  return completion_time;
end;
$$;

create function public.get_my_tenant_context()
returns table (
  organization_id uuid,
  organization_name text,
  primary_industry_id text,
  website_url text,
  business_phone text,
  membership_id uuid,
  membership_role text,
  location_id uuid,
  location_name text,
  location_timezone text,
  location_address jsonb,
  business_hours jsonb,
  onboarding_status text,
  onboarding_step text,
  onboarding_completed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    organization.id,
    organization.name,
    organization.primary_industry_id,
    organization.website_url,
    organization.business_phone,
    member.id,
    member.role,
    selected_location.id,
    selected_location.name,
    selected_location.timezone,
    selected_location.address,
    selected_location.business_hours,
    onboarding.status,
    onboarding.current_step,
    onboarding.completed_at
  from public.organization_members as member
  join public.organizations as organization
    on organization.id = member.organization_id
  left join public.organization_onboarding as onboarding
    on onboarding.organization_id = organization.id
  left join lateral (
    select location.*
    from public.locations as location
    where location.organization_id = organization.id
      and (
        member.role in ('owner', 'admin')
        or exists (
          select 1
          from public.organization_member_locations as member_location
          where member_location.organization_id = member.organization_id
            and member_location.organization_member_id = member.id
            and member_location.location_id = location.id
        )
      )
    order by
      (location.id = onboarding.location_id) desc nulls last,
      location.created_at,
      location.id
    limit 1
  ) as selected_location on true
  where member.user_id = auth.uid()
  order by member.created_at, member.id;
$$;

revoke all on function public.is_valid_business_hours(jsonb) from public;
revoke all on function public.is_valid_location_address(jsonb) from public;
revoke all on function public.bootstrap_workspace() from public;
revoke all on function public.require_owned_onboarding_organization() from public;
revoke all on function public.advance_onboarding_step(text, text) from public;
revoke all on function public.save_onboarding_industry(text) from public;
revoke all on function public.save_onboarding_business(text, text, text) from public;
revoke all on function public.save_onboarding_location(text, text, jsonb, jsonb) from public;
revoke all on function public.advance_onboarding_website() from public;
revoke all on function public.complete_onboarding() from public;
revoke all on function public.get_my_tenant_context() from public;

grant execute on function public.bootstrap_workspace() to authenticated;
grant execute on function public.save_onboarding_industry(text) to authenticated;
grant execute on function public.save_onboarding_business(text, text, text) to authenticated;
grant execute on function public.save_onboarding_location(text, text, jsonb, jsonb) to authenticated;
grant execute on function public.advance_onboarding_website() to authenticated;
grant execute on function public.complete_onboarding() to authenticated;
grant execute on function public.get_my_tenant_context() to authenticated;

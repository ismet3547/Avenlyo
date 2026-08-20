-- Phase 15: team access, secure invitations, and workspace selection.
--
-- Three things happen here, in order, because each depends on the previous one.
--
-- 1. Membership gains a durable revocation model.  Access removal must be soft: action_logs,
--    handoffs, and appointment intents all carry foreign keys to organization_members, so deleting
--    a membership row would destroy historical attribution for work that really happened.
--
-- 2. Every authorization helper that reads membership is replaced so it only counts active
--    membership.  A revoked person has to lose authorization at the database boundary, not by the
--    UI hiding a button.  This is the whole security value of the phase, so the audit is exhaustive
--    rather than limited to the obvious helpers.
--
-- 3. Invitations become durable relational rows with a hashed bearer token, and every team mutation
--    moves behind a narrow authenticated RPC.  Direct client mutation of membership tables, which
--    Phase 1 allowed because no team-management boundary existed yet, is withdrawn.

-- ============================================================================
-- 1. Durable membership revocation
-- ============================================================================

alter table public.organization_members
  add column revoked_at timestamptz,
  add column revoked_by_user_id uuid;

alter table public.organization_members
  add constraint organization_members_revoked_by_fk
    foreign key (revoked_by_user_id) references public.users (id);

-- Both columns move together: a revocation always records who performed it, and an active
-- membership carries neither.  This is what stops a partial write from producing a row that is
-- revoked but unattributable, or attributed but still active.
alter table public.organization_members
  add constraint organization_members_revocation_consistent
    check (
      (revoked_at is null and revoked_by_user_id is null)
      or (revoked_at is not null and revoked_by_user_id is not null)
    );

-- The owner role is never revoked in Phase 15.  Ownership transfer is a deliberate future workflow,
-- and until it exists this constraint guarantees at least one owner row survives every team
-- operation, so an organization can never be left with nobody who can administer it.
alter table public.organization_members
  add constraint organization_members_owner_not_revoked
    check (role <> 'owner' or revoked_at is null);

-- Team listing and every authorization helper filter on active membership, so the partial index
-- covers the only predicate they use.
create index organization_members_active_idx
  on public.organization_members (organization_id, role)
  where revoked_at is null;

-- ============================================================================
-- 2. Active-membership semantics across every authorization helper
-- ============================================================================
--
-- Each function below previously matched any organization_members row.  They are replaced rather
-- than patched in place, because editing a merged migration would change history a deployed
-- database has already applied.  Bodies are otherwise unchanged: the only difference is that a
-- revoked row no longer counts.

create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.revoked_at is null
  );
$$;

create or replace function public.is_organization_admin(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.revoked_at is null
      and member.role in ('owner', 'admin')
  );
$$;

create or replace function public.is_organization_owner(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.revoked_at is null
      and member.role = 'owner'
  );
$$;

-- Guards the one-time owner bootstrap: an organization with only revoked members has no active
-- administrator, so it must not become claimable by a new self-inserted owner row.
create or replace function public.organization_has_members(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
  );
$$;

create or replace function public.has_location_access(
  target_organization_id uuid,
  target_location_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.revoked_at is null
      and (
        member.role in ('owner', 'admin')
        or target_location_id is null
        or exists (
          select 1
          from public.organization_member_locations as member_location
          where member_location.organization_id = target_organization_id
            and member_location.organization_member_id = member.id
            and member_location.location_id = target_location_id
        )
      )
  );
$$;

create or replace function public.has_location_write_access(
  target_organization_id uuid,
  target_location_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members as member
    where member.organization_id = target_organization_id
      and member.user_id = auth.uid()
      and member.revoked_at is null
      and (
        member.role in ('owner', 'admin')
        or (
          target_location_id is not null
          and exists (
            select 1
            from public.organization_member_locations as member_location
            where member_location.organization_id = target_organization_id
              and member_location.organization_member_id = member.id
              and member_location.location_id = target_location_id
          )
        )
      )
  );
$$;

-- The same rule applied to every remaining function that resolves authority from a membership row.
-- These were found by auditing all thirty-seven merged migrations for direct reads of
-- organization_members and organization_member_locations, not by inspecting the obvious helpers.

create or replace function public.require_knowledge_manager_organization()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  workspace_id uuid;
begin
  select member.organization_id
    into workspace_id
  from public.organization_members as member
  join public.organization_onboarding as onboarding
    on onboarding.organization_id = member.organization_id
  where member.user_id = auth.uid()
    and member.revoked_at is null
    and member.role in ('owner', 'admin')
    and onboarding.status = 'completed'
  order by member.created_at, member.id
  limit 1;

  if workspace_id is null then
    raise exception using errcode = '42501', message = 'An organization owner or admin is required';
  end if;

  return workspace_id;
end;
$$;

-- Trusted backend lookups resolve a named user rather than auth.uid(), so a revoked operator would
-- otherwise keep a provider authorization boundary the organization has already taken away.
create or replace function public.get_ezyvet_backend_authorization(
  target_user_id uuid,
  target_location_id uuid
)
returns table (organization_id uuid, location_id uuid, location_timezone text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_ezyvet_service_role();
  return query
  select member.organization_id, location.id, location.timezone
  from public.organization_members as member
  join public.organizations as organization on organization.id = member.organization_id
  join public.locations as location on location.organization_id = member.organization_id
  where member.user_id = target_user_id
    and member.revoked_at is null
    and member.role in ('owner', 'admin')
    and location.id = target_location_id
    and organization.primary_industry_id = 'veterinary';
end;
$$;

create or replace function public.get_google_backend_authorization(
  target_user_id uuid,
  target_location_id uuid
)
returns table (organization_id uuid, location_id uuid, location_timezone text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_scheduling_service_role();
  return query select member.organization_id, location.id, location.timezone
  from public.organization_members as member
  join public.locations as location on location.organization_id = member.organization_id
  where member.user_id = target_user_id
    and member.revoked_at is null
    and member.role in ('owner', 'admin')
    and location.id = target_location_id;
end;
$$;

-- The whole Phase 9 staff appointment path funnels through this one membership check, and it
-- resolves a named user rather than auth.uid(), so a revoked admin would otherwise keep the power
-- to cancel and reschedule real customer appointments. Body copied verbatim from
-- 20260821110000_phase_9_completed_intent_sequencing.sql; the added predicate is the only change.
create or replace function public.get_or_resume_staff_appointment_change_intent(
  target_user_id uuid,
  target_location_id uuid,
  target_appointment_id uuid,
  target_operation text,
  target_starts_at timestamptz default null,
  target_ends_at timestamptz default null
)
returns table (change_intent_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_org uuid;
  appointment_row public.appointments%rowtype;
  booking public.booking_intents%rowtype;
  appointment_type public.scheduling_appointment_types%rowtype;
  active_intent public.appointment_change_intents%rowtype;
  completed_intent public.appointment_change_intents%rowtype;
  resource_id uuid;
  created_intent_id uuid;
begin
  perform public.require_appointment_lifecycle_service_role();

  if target_operation not in ('cancel', 'reschedule') then
    raise exception using errcode = '22023', message = 'Appointment change operation is invalid';
  end if;
  if target_operation = 'reschedule'
    and (target_starts_at is null or target_ends_at is null or target_ends_at <= target_starts_at or target_starts_at <= now()) then
    raise exception using errcode = '22023', message = 'Reschedule time is invalid';
  end if;

  select location.organization_id into target_org
  from public.locations location
  where location.id = target_location_id;
  if target_org is null or not exists (
    select 1
    from public.organization_members member
    where member.organization_id = target_org
      and member.user_id = target_user_id
      and member.revoked_at is null
      and member.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('appointment-change-appointment:' || target_appointment_id::text, 0)
  );

  -- In-progress and recovery state is the only history that can block a later operation.
  select * into active_intent
  from public.appointment_change_intents intent
  where intent.organization_id = target_org
    and intent.location_id = target_location_id
    and intent.appointment_id = target_appointment_id
    and intent.actor_category = 'staff'
    and intent.status in (
      'executing',
      'provider_success_pending_persistence',
      'provider_state_unknown',
      'handoff_required'
    )
  order by intent.created_at desc
  limit 1
  for update;

  if active_intent.id is not null then
    if active_intent.operation <> target_operation then
      raise exception using errcode = '22023', message = 'A different appointment change is already in progress';
    end if;
    if target_operation = 'reschedule'
      and (active_intent.target_starts_at is distinct from target_starts_at or active_intent.target_ends_at is distinct from target_ends_at) then
      raise exception using errcode = '22023', message = 'The in-progress reschedule does not match this retry';
    end if;
    return query select active_intent.id;
    return;
  end if;

  -- The latest completed row may only serve the exact operation it completed. Earlier completed
  -- rows deliberately do not shadow a more recent lifecycle outcome.
  select * into completed_intent
  from public.appointment_change_intents intent
  where intent.organization_id = target_org
    and intent.location_id = target_location_id
    and intent.appointment_id = target_appointment_id
    and intent.actor_category = 'staff'
    and intent.status = 'completed'
  order by intent.completed_at desc nulls last, intent.created_at desc
  limit 1
  for update;

  if completed_intent.id is not null
    and completed_intent.operation = target_operation
    and (
      target_operation = 'cancel'
      or (
        completed_intent.target_starts_at is not distinct from target_starts_at
        and completed_intent.target_ends_at is not distinct from target_ends_at
      )
    ) then
    return query select completed_intent.id;
    return;
  end if;

  if exists (
    select 1
    from public.appointment_change_intents intent
    where intent.appointment_id = target_appointment_id
      and intent.status in (
        'awaiting_confirmation',
        'executing',
        'provider_success_pending_persistence',
        'provider_state_unknown',
        'handoff_required'
      )
  ) then
    raise exception using errcode = '22023', message = 'A different appointment change is already in progress';
  end if;

  select * into appointment_row
  from public.appointments appointment
  where appointment.organization_id = target_org
    and appointment.location_id = target_location_id
    and appointment.id = target_appointment_id
    and appointment.status = 'confirmed'
    and appointment.starts_at > now()
    and appointment.integration_id is not null;
  if appointment_row.id is null then
    raise exception using errcode = '42501', message = 'Appointment cannot be changed safely';
  end if;

  -- ezyVet supports durable cancellation only. Reject before an intent or provider target exists.
  if target_operation = 'reschedule' and appointment_row.provider = 'ezyvet' then
    raise exception using errcode = '22023', message = 'Provider reschedule is unsupported';
  end if;

  select * into booking
  from public.booking_intents intent
  where intent.organization_id = target_org
    and intent.id = appointment_row.booking_intent_id;
  resource_id := coalesce(
    appointment_row.scheduling_resource_id,
    (
      select candidate.resource_id
      from public.booking_candidates candidate
      where candidate.organization_id = target_org
        and candidate.id = booking.candidate_id
    )
  );
  if appointment_row.id is null
    or booking.id is null
    or resource_id is null
    or nullif(btrim(appointment_row.external_appointment_id), '') is null then
    raise exception using errcode = '42501', message = 'Appointment cannot be changed safely';
  end if;

  if target_operation = 'reschedule' then
    select type_row.* into appointment_type
    from public.booking_candidates candidate
    join public.scheduling_appointment_types type_row
      on type_row.organization_id = candidate.organization_id
      and type_row.id = candidate.appointment_type_id
    where candidate.organization_id = target_org
      and candidate.id = booking.candidate_id;
    if appointment_type.id is null
      or target_ends_at - target_starts_at <> make_interval(mins => appointment_type.default_duration_minutes) then
      raise exception using errcode = '42501', message = 'Appointment cannot be rescheduled safely';
    end if;
  end if;

  insert into public.appointment_change_intents (
    organization_id,
    location_id,
    conversation_id,
    appointment_id,
    booking_intent_id,
    integration_id,
    provider,
    operation,
    actor_category,
    original_external_appointment_id,
    original_starts_at,
    original_ends_at,
    original_resource_id,
    target_starts_at,
    target_ends_at,
    target_resource_id,
    status,
    mutation_attempt_count,
    expires_at
  )
  values (
    target_org,
    target_location_id,
    appointment_row.conversation_id,
    appointment_row.id,
    booking.id,
    appointment_row.integration_id,
    appointment_row.provider,
    target_operation,
    'staff',
    appointment_row.external_appointment_id,
    appointment_row.starts_at,
    appointment_row.ends_at,
    resource_id,
    target_starts_at,
    target_ends_at,
    case when target_operation = 'reschedule' then resource_id else null end,
    'executing',
    1,
    now() + interval '10 minutes'
  )
  returning id into created_intent_id;

  insert into public.action_logs (organization_id, location_id, action, entity_type, entity_id, details)
  values (
    target_org,
    target_location_id,
    'appointment.' || target_operation || '.prepared',
    'appointment_change_intent',
    created_intent_id,
    jsonb_build_object('actor', 'staff')
  );
  return query select created_intent_id;
end;
$$;

-- Messaging number administration is owner/admin only, resolved for a named user by the trusted
-- backend. Body copied verbatim from 20260817010000_phase_7_messaging_hardening.sql.
create or replace function public.set_sms_phone_number_enabled_for_user(target_user_id uuid, target_phone_number_id uuid, target_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare number_row public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into number_row from public.phone_numbers where id = target_phone_number_id for update;
  if number_row.id is null or not exists (
    select 1 from public.organization_members member
    where member.organization_id = number_row.organization_id and member.user_id = target_user_id and member.revoked_at is null and member.role in ('owner', 'admin')
  ) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  update public.phone_numbers set sms_enabled = target_enabled, updated_at = now() where id = number_row.id;
end;
$$;

-- Same boundary on the read side.
create or replace function public.get_sms_phone_number_for_user(target_user_id uuid, target_phone_number_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare number_row public.phone_numbers%rowtype;
begin
  perform public.require_messaging_service_role();
  select * into number_row from public.phone_numbers where id = target_phone_number_id;
  if number_row.id is null or not exists (
    select 1 from public.organization_members member
    where member.organization_id = number_row.organization_id and member.user_id = target_user_id and member.revoked_at is null and member.role in ('owner', 'admin')
  ) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  return number_row.phone_number;
end;
$$;

-- Billing stays exactly as Phase 12 designed it, including its deliberate single-organization
-- requirement. Only revoked membership stops counting, so a removed admin cannot reach a billing
-- boundary the organization has already taken away.
create or replace function public.my_billing_admin_organization()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare selected_organization_id uuid; membership_count integer;
begin
  select count(*) into membership_count
  from public.organization_members
  where user_id = auth.uid() and revoked_at is null and role in ('owner', 'admin');
  if membership_count <> 1 then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;
  select organization_id into selected_organization_id from public.organization_members
    where user_id = auth.uid() and revoked_at is null and role in ('owner', 'admin');
  return selected_organization_id;
end;
$$;

-- Onboarding bootstrap. Resuming an owner workspace and deciding who may bootstrap are separate
-- questions, and both are now asked about active membership only. Counting revoked rows in the
-- second would permanently strand a person removed from the only organization they belonged to.
create or replace function public.bootstrap_workspace()
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
    and member.revoked_at is null
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
      and member.revoked_at is null
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

-- In-progress owner onboarding, active membership only.
create or replace function public.require_owned_onboarding_organization()
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
    and member.revoked_at is null
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

-- The tenant context read model. Its shape is unchanged -- onboarding and every dashboard page
-- depend on it -- and it already returned one row per membership, so multiple organizations were
-- never a database limitation. Only the application refused to handle more than one.
create or replace function public.get_my_tenant_context()
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
    and member.revoked_at is null
  order by member.created_at, member.id;
$$;

-- ============================================================================
-- 3. Secure invitations
-- ============================================================================
--
-- The invitation is a bearer credential: whoever holds the link can present it. Three properties
-- contain that risk. The token is generated at the database boundary with 256 bits of entropy, so
-- the browser never chooses it. Only its SHA-256 digest is stored, so a database disclosure does
-- not yield working links. And it is bound to one normalized email, so a leaked link is useless to
-- anyone who cannot authenticate as that identity.

create table public.organization_invitations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Lowercased and trimmed. Deliberately no provider-specific rewriting: silently treating
  -- a.b@gmail.com and ab@gmail.com as one identity would be a security decision made on a guess
  -- about someone else's mail routing.
  email_normalized text not null
    check (char_length(email_normalized) between 3 and 320)
    check (email_normalized = lower(btrim(email_normalized)))
    check (position('@' in email_normalized) > 1),
  -- Never owner. Ownership transfer is a deliberate future workflow, not an invitation side effect.
  role text not null check (role in ('admin', 'member')),
  -- Hex SHA-256 of the plaintext token. The plaintext is returned exactly once, to the creator.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_by_user_id uuid not null references public.users (id),
  accepted_at timestamptz,
  accepted_by_user_id uuid references public.users (id),
  revoked_at timestamptz,
  revoked_by_user_id uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_invitations_organization_id_id_key unique (organization_id, id),
  -- State is derived from timestamps rather than a mutable status column, so the two can never
  -- disagree. These constraints keep the derivation total.
  constraint organization_invitations_accepted_consistent
    check (
      (accepted_at is null and accepted_by_user_id is null)
      or (accepted_at is not null and accepted_by_user_id is not null)
    ),
  constraint organization_invitations_revoked_consistent
    check (
      (revoked_at is null and revoked_by_user_id is null)
      or (revoked_at is not null and revoked_by_user_id is not null)
    ),
  -- An invitation cannot be both accepted and revoked: acceptance is terminal, and removing an
  -- already-joined member is a membership operation, not an invitation one.
  constraint organization_invitations_single_terminal_state
    check (accepted_at is null or revoked_at is null)
);

-- Acceptance is a token lookup, and the unique constraint above already provides that index.
-- Team listing reads by organization, newest first.
create index organization_invitations_organization_idx
  on public.organization_invitations (organization_id, created_at desc);

-- At most one live link per organization and email at any moment. Reissuing revokes the previous
-- invitation in the same transaction, so two working bearer links for one identity cannot coexist.
create unique index organization_invitations_pending_email_key
  on public.organization_invitations (organization_id, email_normalized)
  where accepted_at is null and revoked_at is null;

-- Location scope is relational, not JSON, so tenant integrity is a foreign key rather than a
-- validation someone can forget to run.
create table public.organization_invitation_locations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  invitation_id uuid not null,
  location_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The composite keys are what make a cross-organization location impossible: the invitation and
  -- the location must agree on organization_id before either row can exist.
  constraint organization_invitation_locations_invitation_fk
    foreign key (organization_id, invitation_id)
    references public.organization_invitations (organization_id, id) on delete cascade,
  constraint organization_invitation_locations_location_fk
    foreign key (organization_id, location_id)
    references public.locations (organization_id, id) on delete cascade,
  constraint organization_invitation_locations_invitation_location_key
    unique (invitation_id, location_id)
);

create index organization_invitation_locations_invitation_idx
  on public.organization_invitation_locations (invitation_id);

alter table public.organization_invitations enable row level security;
alter table public.organization_invitation_locations enable row level security;

-- No direct client access at all. Invitation rows carry a bearer credential digest and staff email
-- addresses, and every legitimate read or write has a narrow RPC. There is deliberately no policy:
-- absent policy plus enabled RLS means no row is reachable except through a definer function.
revoke all on table public.organization_invitations, public.organization_invitation_locations
  from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. Team management helpers
-- ============================================================================

-- Security lifetime, not a service level: a bearer link that never expires is a permanent
-- credential sitting in somebody's inbox.
create function public.team_invitation_lifetime()
returns interval language sql immutable set search_path = '' as $$
  select interval '7 days';
$$;

create function public.normalize_team_email(candidate text)
returns text language sql immutable set search_path = '' as $$
  select lower(btrim(coalesce(candidate, '')));
$$;

-- The caller's own active role in one organization, or null when they are not an active member.
-- Every mutation below derives authority from this rather than from anything the browser sent.
create function public.my_team_role(target_organization_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select member.role
  from public.organization_members as member
  where member.organization_id = target_organization_id
    and member.user_id = auth.uid()
    and member.revoked_at is null;
$$;

-- The permission matrix, in one place.
--
-- Owner may act on admin and member. Admin may act on member only. Nobody may act on an owner
-- through team management, because ownership transfer is a separate future workflow and an
-- organization must never be left without an administrator.
create function public.team_role_may_manage(actor_role text, target_role text)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when actor_role = 'owner' then target_role in ('admin', 'member')
    when actor_role = 'admin' then target_role = 'member'
    else false
  end;
$$;

-- Onboarding must be finished before anyone else is let in: a half-created workspace has no
-- industry, no business details, and possibly no usable location to scope a member to.
create function public.team_organization_is_ready(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_onboarding as onboarding
    where onboarding.organization_id = target_organization_id
      and onboarding.status = 'completed'
  );
$$;

-- Deduplicates, rejects foreign locations, and returns the verified set. Returning the array rather
-- than a boolean means a caller cannot validate one set and then insert a different one.
create function public.team_verified_locations(
  target_organization_id uuid,
  requested_location_ids uuid[]
)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare
  verified uuid[];
  requested_count integer;
begin
  select array_agg(distinct candidate) into verified
  from unnest(coalesce(requested_location_ids, array[]::uuid[])) as candidate
  where candidate is not null
    and exists (
      select 1
      from public.locations as location
      where location.organization_id = target_organization_id
        and location.id = candidate
    );

  select count(distinct candidate) into requested_count
  from unnest(coalesce(requested_location_ids, array[]::uuid[])) as candidate
  where candidate is not null;

  -- Fail closed on any unrecognised location rather than silently narrowing the request: silently
  -- dropping one would grant access to a set the operator did not choose.
  if requested_count <> coalesce(array_length(verified, 1), 0) then
    raise exception using errcode = '22023', message = 'Location scope is invalid';
  end if;

  return coalesce(verified, array[]::uuid[]);
end;
$$;

-- ============================================================================
-- 5. Invitation creation
-- ============================================================================

create function public.create_my_organization_invitation(
  target_organization_id uuid,
  target_email text,
  target_role text,
  target_location_ids uuid[] default array[]::uuid[]
)
returns table (
  invitation_id uuid,
  invitation_token text,
  email_normalized text,
  role text,
  expires_at timestamptz,
  outcome text
)
language plpgsql security definer set search_path = '' as $$
declare
  actor_role text;
  normalized_email text;
  verified_locations uuid[];
  plaintext_token text;
  created_id uuid;
  invitation_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  actor_role := public.my_team_role(target_organization_id);
  if actor_role is null then
    raise exception using errcode = '42501', message = 'Organization membership is required';
  end if;
  if target_role is null or target_role not in ('admin', 'member') then
    raise exception using errcode = '22023', message = 'Invitation role is invalid';
  end if;
  -- An admin inviting another admin would be self-escalation by proxy.
  if not public.team_role_may_manage(actor_role, target_role) then
    raise exception using errcode = '42501', message = 'Insufficient team management authority';
  end if;
  if not public.team_organization_is_ready(target_organization_id) then
    raise exception using errcode = '22023', message = 'Organization onboarding is not complete';
  end if;

  normalized_email := public.normalize_team_email(target_email);
  if char_length(normalized_email) < 3 or position('@' in normalized_email) < 2 then
    raise exception using errcode = '22023', message = 'Invitation email is invalid';
  end if;

  -- A member with no location has access to nothing, which is a silent failure rather than a
  -- restriction. An admin is organization-wide, so location rows would be meaningless authority.
  if target_role = 'member' then
    verified_locations := public.team_verified_locations(target_organization_id, target_location_ids);
    if coalesce(array_length(verified_locations, 1), 0) = 0 then
      raise exception using errcode = '22023', message = 'A member invitation requires at least one location';
    end if;
  else
    verified_locations := array[]::uuid[];
  end if;

  -- Serialize every invitation decision for this organization and email. Two administrators
  -- clicking Invite at the same moment must not produce two live bearer links for one person.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('team-invitation:' || target_organization_id::text || ':' || normalized_email, 0)
  );

  -- An existing active member does not need an invitation, and saying so plainly avoids using the
  -- invitation flow as a probe for who already belongs to the organization.
  if exists (
    select 1
    from public.organization_members as member
    join public.users as profile on profile.id = member.user_id
    where member.organization_id = target_organization_id
      and member.revoked_at is null
      and public.normalize_team_email(profile.email) = normalized_email
  ) then
    return query select null::uuid, null::text, normalized_email, target_role,
      null::timestamptz, 'already_member'::text;
    return;
  end if;

  -- Reissue revokes the previous link in the same transaction. The old token stops working the
  -- moment this commits, so a forwarded or intercepted earlier link is dead.
  update public.organization_invitations as invitation
  set revoked_at = now(), revoked_by_user_id = auth.uid(), updated_at = now()
  where invitation.organization_id = target_organization_id
    and invitation.email_normalized = normalized_email
    and invitation.accepted_at is null
    and invitation.revoked_at is null;

  -- 32 random bytes from pgcrypto, encoded hex. The browser contributes no entropy.
  plaintext_token := encode(extensions.gen_random_bytes(32), 'hex');
  invitation_expires_at := now() + public.team_invitation_lifetime();

  insert into public.organization_invitations (
    organization_id, email_normalized, role, token_hash, expires_at, created_by_user_id
  )
  values (
    target_organization_id,
    normalized_email,
    target_role,
    encode(extensions.digest(plaintext_token, 'sha256'), 'hex'),
    invitation_expires_at,
    auth.uid()
  )
  returning id into created_id;

  insert into public.organization_invitation_locations (organization_id, invitation_id, location_id)
  select target_organization_id, created_id, location
  from unnest(verified_locations) as location;

  -- Role and scope size only. The email is the invited person's identity and the token is a
  -- credential; neither belongs in an audit row that many people can read.
  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    target_organization_id, auth.uid(), 'team.invitation_created', 'organization_invitation', created_id,
    jsonb_build_object('role', target_role, 'location_count', coalesce(array_length(verified_locations, 1), 0))
  );

  -- The only time the plaintext token ever leaves the database.
  return query select created_id, plaintext_token, normalized_email, target_role,
    invitation_expires_at, 'created'::text;
end;
$$;

-- ============================================================================
-- 6. Invitation acceptance
-- ============================================================================
--
-- The browser supplies exactly one thing: the bearer token. Identity comes from auth.uid() and the
-- verified email on auth.users; role and location scope come from the durable invitation row. A
-- caller who could submit their own email, role, or locations here could grant themselves anything.

create function public.accept_my_organization_invitation(target_token text)
returns table (
  organization_id uuid,
  organization_name text,
  membership_role text,
  outcome text
)
language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  caller_email text;
  supplied_hash text;
  invitation public.organization_invitations%rowtype;
  organization public.organizations%rowtype;
  membership_id uuid;
  scope_count integer;
  invited_locations uuid[];
  was_reactivation boolean := false;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  if coalesce(btrim(target_token), '') = '' then
    raise exception using errcode = '22023', message = 'Invitation is invalid';
  end if;

  select public.normalize_team_email(auth_user.email) into caller_email
  from auth.users as auth_user
  where auth_user.id = current_user_id;

  if coalesce(caller_email, '') = '' then
    raise exception using errcode = '42501', message = 'A verified account email is required';
  end if;

  supplied_hash := encode(extensions.digest(btrim(target_token), 'sha256'), 'hex');

  -- Serialize on the token itself. Two concurrent attempts must produce exactly one acceptance
  -- transition, and an advisory lock taken before the row read makes the check-then-act atomic.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('team-invitation-accept:' || supplied_hash, 0)
  );

  select * into invitation
  from public.organization_invitations as candidate
  where candidate.token_hash = supplied_hash
  for update;

  if invitation.id is null then
    return query select null::uuid, null::text, null::text, 'invalid'::text;
    return;
  end if;

  -- Replay by the same person is a success, not a second membership. Replay by anyone else is a
  -- stolen link being used, and gets the same answer as any unusable token.
  if invitation.accepted_at is not null then
    if invitation.accepted_by_user_id = current_user_id then
      select * into organization from public.organizations where id = invitation.organization_id;
      return query select invitation.organization_id, organization.name, invitation.role,
        'already_accepted'::text;
      return;
    end if;
    return query select null::uuid, null::text, null::text, 'invalid'::text;
    return;
  end if;

  if invitation.revoked_at is not null then
    return query select null::uuid, null::text, null::text, 'revoked'::text;
    return;
  end if;
  if invitation.expires_at <= now() then
    return query select null::uuid, null::text, null::text, 'expired'::text;
    return;
  end if;

  -- The identity binding. A leaked link is worthless to anyone who cannot authenticate as the
  -- invited address, and the outcome deliberately says nothing about who was invited.
  if invitation.email_normalized <> caller_email then
    return query select null::uuid, null::text, null::text, 'wrong_account'::text;
    return;
  end if;

  if not public.team_organization_is_ready(invitation.organization_id) then
    return query select null::uuid, null::text, null::text, 'invalid'::text;
    return;
  end if;

  select * into organization from public.organizations where id = invitation.organization_id;
  if organization.id is null then
    return query select null::uuid, null::text, null::text, 'invalid'::text;
    return;
  end if;

  select array_agg(scope.location_id) into invited_locations
  from public.organization_invitation_locations as scope
  where scope.invitation_id = invitation.id;
  invited_locations := coalesce(invited_locations, array[]::uuid[]);

  -- A member invitation whose locations were deleted between creation and acceptance has no valid
  -- scope left. Fail closed and require a fresh invitation rather than silently widening access to
  -- the whole organization, which is the one outcome nobody intended.
  if invitation.role = 'member' and coalesce(array_length(invited_locations, 1), 0) = 0 then
    return query select null::uuid, null::text, null::text, 'invalid_scope'::text;
    return;
  end if;

  -- A profile row is required by the membership foreign key. Onboarding creates it for owners; an
  -- invited person may never have had one.
  insert into public.users (id, email)
  select auth_user.id, auth_user.email
  from auth.users as auth_user
  where auth_user.id = current_user_id
  on conflict (id) do nothing;

  -- Reactivation rather than a second row: the unique (organization_id, user_id) constraint means a
  -- previously revoked person already has a membership carrying their historical attribution.
  select member.id, member.revoked_at is not null
  into membership_id, was_reactivation
  from public.organization_members as member
  where member.organization_id = invitation.organization_id
    and member.user_id = current_user_id
  for update;

  if membership_id is null then
    insert into public.organization_members (organization_id, user_id, role)
    values (invitation.organization_id, current_user_id, invitation.role)
    returning id into membership_id;
    was_reactivation := false;
  else
    update public.organization_members as member
    set role = invitation.role,
        revoked_at = null,
        revoked_by_user_id = null,
        updated_at = now()
    where member.id = membership_id;
  end if;

  -- Scope comes from the invitation, exactly. Old assignments are replaced rather than merged, so
  -- a reactivated person never silently regains a location the current invitation did not grant.
  delete from public.organization_member_locations as assignment
  where assignment.organization_id = invitation.organization_id
    and assignment.organization_member_id = membership_id;

  insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
  select invitation.organization_id, membership_id, location
  from unnest(invited_locations) as location;

  update public.organization_invitations as accepted
  set accepted_at = now(), accepted_by_user_id = current_user_id, updated_at = now()
  where accepted.id = invitation.id;

  scope_count := coalesce(array_length(invited_locations, 1), 0);
  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    invitation.organization_id,
    current_user_id,
    case when was_reactivation then 'team.member_reactivated' else 'team.member_joined' end,
    'organization_member',
    membership_id,
    jsonb_build_object('role', invitation.role, 'location_count', scope_count)
  );

  return query select invitation.organization_id, organization.name, invitation.role, 'accepted'::text;
end;
$$;

-- ============================================================================
-- 7. Invitation revocation
-- ============================================================================

create function public.revoke_my_organization_invitation(target_invitation_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  actor_role text;
  invitation public.organization_invitations%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  select * into invitation
  from public.organization_invitations as candidate
  where candidate.id = target_invitation_id
  for update;

  if invitation.id is null then
    return query select 'invalid'::text;
    return;
  end if;

  actor_role := public.my_team_role(invitation.organization_id);
  if actor_role is null or not public.team_role_may_manage(actor_role, invitation.role) then
    raise exception using errcode = '42501', message = 'Insufficient team management authority';
  end if;

  -- An accepted invitation is history. Removing that person is a membership revocation, and
  -- pretending otherwise would leave them with access while the invitation looked withdrawn.
  if invitation.accepted_at is not null then
    return query select 'already_accepted'::text;
    return;
  end if;

  -- Replay is a success with no second audit row.
  if invitation.revoked_at is not null then
    return query select 'already_revoked'::text;
    return;
  end if;

  update public.organization_invitations as revoked
  set revoked_at = now(), revoked_by_user_id = auth.uid(), updated_at = now()
  where revoked.id = invitation.id;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    invitation.organization_id, auth.uid(), 'team.invitation_revoked', 'organization_invitation',
    invitation.id, jsonb_build_object('role', invitation.role)
  );

  return query select 'revoked'::text;
end;
$$;

-- ============================================================================
-- 8. Member access update
-- ============================================================================
--
-- Role change and location scope are one atomic operation. Splitting them across requests would
-- create a window where a demoted admin is a member with no scope, or with the scope they had as
-- something else.

create function public.update_my_organization_member_access(
  target_membership_id uuid,
  target_role text,
  target_location_ids uuid[] default array[]::uuid[]
)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  actor_role text;
  membership public.organization_members%rowtype;
  verified_locations uuid[];
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  if target_role is null or target_role not in ('admin', 'member') then
    raise exception using errcode = '22023', message = 'Member role is invalid';
  end if;

  select * into membership
  from public.organization_members as member
  where member.id = target_membership_id
  for update;

  if membership.id is null or membership.revoked_at is not null then
    raise exception using errcode = '42501', message = 'Active membership was not found';
  end if;

  actor_role := public.my_team_role(membership.organization_id);
  if actor_role is null then
    raise exception using errcode = '42501', message = 'Organization membership is required';
  end if;
  -- Covers both directions: an admin cannot touch an admin or an owner, and nobody manages an owner.
  if not public.team_role_may_manage(actor_role, membership.role)
    or not public.team_role_may_manage(actor_role, target_role) then
    raise exception using errcode = '42501', message = 'Insufficient team management authority';
  end if;
  -- Self-service role changes are how privilege escalation usually happens.
  if membership.user_id = auth.uid() then
    raise exception using errcode = '42501', message = 'Managing your own access is not permitted';
  end if;

  if target_role = 'member' then
    verified_locations := public.team_verified_locations(membership.organization_id, target_location_ids);
    -- Demotion has to name the scope in the same call. A member with no locations can see nothing,
    -- which looks like a bug rather than a decision.
    if coalesce(array_length(verified_locations, 1), 0) = 0 then
      raise exception using errcode = '22023', message = 'A member requires at least one location';
    end if;
  else
    -- Admin is organization-wide, so any retained rows would be stale authority waiting to be
    -- silently reapplied if the person is later demoted.
    verified_locations := array[]::uuid[];
  end if;

  update public.organization_members as member
  set role = target_role, updated_at = now()
  where member.id = membership.id;

  delete from public.organization_member_locations as assignment
  where assignment.organization_id = membership.organization_id
    and assignment.organization_member_id = membership.id;

  insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
  select membership.organization_id, membership.id, location
  from unnest(verified_locations) as location;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    membership.organization_id, auth.uid(), 'team.member_access_updated', 'organization_member',
    membership.id,
    jsonb_build_object(
      'from_role', membership.role,
      'to_role', target_role,
      'location_count', coalesce(array_length(verified_locations, 1), 0)
    )
  );

  return query select 'updated'::text;
end;
$$;

-- ============================================================================
-- 9. Membership revocation
-- ============================================================================

create function public.revoke_my_organization_member(target_membership_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  actor_role text;
  membership public.organization_members%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;

  select * into membership
  from public.organization_members as member
  where member.id = target_membership_id
  for update;

  if membership.id is null then
    return query select 'invalid'::text;
    return;
  end if;

  actor_role := public.my_team_role(membership.organization_id);
  if actor_role is null or not public.team_role_may_manage(actor_role, membership.role) then
    raise exception using errcode = '42501', message = 'Insufficient team management authority';
  end if;
  if membership.user_id = auth.uid() then
    raise exception using errcode = '42501', message = 'Revoking your own access is not permitted';
  end if;

  -- Replay is a success with no second audit row.
  if membership.revoked_at is not null then
    return query select 'already_revoked'::text;
    return;
  end if;

  -- Soft, always. action_logs, handoffs, and appointment change intents all carry foreign keys to
  -- this row, and deleting it would erase who actually did that work.
  update public.organization_members as member
  set revoked_at = now(), revoked_by_user_id = auth.uid(), updated_at = now()
  where member.id = membership.id;

  -- Location assignments are current authority rather than history, so they go. Nothing else is
  -- touched: no handoff is resolved, no conversation is moved, and no AI is resumed. Operational
  -- ownership stays where it is, and Phase 13 Release then Claim is how an owner or admin recovers
  -- work the revoked person was holding.
  delete from public.organization_member_locations as assignment
  where assignment.organization_id = membership.organization_id
    and assignment.organization_member_id = membership.id;

  insert into public.action_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
  values (
    membership.organization_id, auth.uid(), 'team.member_revoked', 'organization_member',
    membership.id, jsonb_build_object('role', membership.role)
  );

  return query select 'revoked'::text;
end;
$$;

-- ============================================================================
-- 10. Team read model
-- ============================================================================
--
-- One call returns everything the Team page renders. A per-member or per-location query would be an
-- N+1 against tables the browser is no longer allowed to read directly anyway.

create function public.get_my_organization_team(target_organization_id uuid)
returns table (
  record_kind text,
  record_id uuid,
  member_user_id uuid,
  display_name text,
  email text,
  role text,
  is_active boolean,
  joined_at timestamptz,
  expires_at timestamptz,
  invitation_state text,
  location_ids uuid[],
  location_names text[],
  active_work_count integer
)
language plpgsql stable security definer set search_path = '' as $$
declare
  actor_role text;
begin
  actor_role := public.my_team_role(target_organization_id);
  -- Team email and display names are staff data. A normal member has no management authority and
  -- therefore no reason to enumerate colleagues here.
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'Organization owner or admin access is required';
  end if;

  return query
  select
    'member'::text,
    member.id,
    member.user_id,
    profile.display_name,
    profile.email,
    member.role,
    member.revoked_at is null,
    member.created_at,
    null::timestamptz,
    null::text,
    coalesce(scope.location_ids, array[]::uuid[]),
    coalesce(scope.location_names, array[]::text[]),
    -- How much live human work this person is holding. A count only: the Team page must never
    -- become a way to read customer conversations.
    coalesce(work.active_count, 0)::integer
  from public.organization_members as member
  join public.users as profile on profile.id = member.user_id
  left join lateral (
    select
      array_agg(location.id order by location.name) as location_ids,
      array_agg(location.name order by location.name) as location_names
    from public.organization_member_locations as assignment
    join public.locations as location
      on location.organization_id = assignment.organization_id
      and location.id = assignment.location_id
    where assignment.organization_id = member.organization_id
      and assignment.organization_member_id = member.id
  ) as scope on true
  left join lateral (
    select count(*) as active_count
    from public.handoffs as handoff
    where handoff.organization_id = member.organization_id
      and handoff.assigned_user_id = member.user_id
      and handoff.status <> 'resolved'
  ) as work on true
  where member.organization_id = target_organization_id
    -- Revoked members stay listed so their historical presence is visible, but the read model
    -- reports them as inactive rather than hiding the fact that they existed.
    and (member.revoked_at is null or member.revoked_at > now() - interval '30 days')

  union all

  select
    'invitation'::text,
    invitation.id,
    null::uuid,
    null::text,
    invitation.email_normalized,
    invitation.role,
    invitation.accepted_at is null and invitation.revoked_at is null and invitation.expires_at > now(),
    invitation.created_at,
    invitation.expires_at,
    case
      when invitation.accepted_at is not null then 'accepted'
      when invitation.revoked_at is not null then 'revoked'
      when invitation.expires_at <= now() then 'expired'
      else 'pending'
    end,
    coalesce(scope.location_ids, array[]::uuid[]),
    coalesce(scope.location_names, array[]::text[]),
    0
  from public.organization_invitations as invitation
  left join lateral (
    select
      array_agg(location.id order by location.name) as location_ids,
      array_agg(location.name order by location.name) as location_names
    from public.organization_invitation_locations as assignment
    join public.locations as location
      on location.organization_id = assignment.organization_id
      and location.id = assignment.location_id
    where assignment.invitation_id = invitation.id
  ) as scope on true
  where invitation.organization_id = target_organization_id
    and (
      (invitation.accepted_at is null and invitation.revoked_at is null)
      or invitation.updated_at > now() - interval '30 days'
    )
  order by 1, 8 desc;
  -- token_hash is deliberately absent from the projection, and the plaintext token exists only in
  -- the creation response. A pending invitation's link can never be recovered by reading it back;
  -- the operator reissues, which invalidates the old token.
end;
$$;

-- ============================================================================
-- 11. Workspace selection read model
-- ============================================================================
--
-- The selection cookie is a preference, never authority. This function is the trusted set a
-- selection is validated against: if a context is not returned here, the caller cannot work in it,
-- whatever their cookie says.

create function public.get_my_workspace_contexts()
returns table (
  organization_id uuid,
  organization_name text,
  membership_id uuid,
  membership_role text,
  location_id uuid,
  location_name text,
  onboarding_status text,
  onboarding_step text
)
language sql stable security definer set search_path = '' as $$
  select
    organization.id,
    organization.name,
    member.id,
    member.role,
    location.id,
    location.name,
    onboarding.status,
    onboarding.current_step
  from public.organization_members as member
  join public.organizations as organization
    on organization.id = member.organization_id
  left join public.organization_onboarding as onboarding
    on onboarding.organization_id = organization.id
  -- Owner and admin are organization-wide, so every location is selectable. A member sees exactly
  -- the locations assigned to them, which is what makes a manufactured location id useless.
  left join public.locations as location
    on location.organization_id = organization.id
    and (
      member.role in ('owner', 'admin')
      or exists (
        select 1
        from public.organization_member_locations as assignment
        where assignment.organization_id = member.organization_id
          and assignment.organization_member_id = member.id
          and assignment.location_id = location.id
      )
    )
  where member.user_id = auth.uid()
    and member.revoked_at is null
  order by organization.name, location.name nulls first;
$$;

-- The full context for one explicitly selected, authorized location. Returns no rows when the
-- selection is not permitted, so a caller cannot distinguish "not yours" from "does not exist".
create function public.get_my_workspace_context(
  target_organization_id uuid,
  target_location_id uuid
)
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
language sql stable security definer set search_path = '' as $$
  select
    organization.id,
    organization.name,
    organization.primary_industry_id,
    organization.website_url,
    organization.business_phone,
    member.id,
    member.role,
    location.id,
    location.name,
    location.timezone,
    location.address,
    location.business_hours,
    onboarding.status,
    onboarding.current_step,
    onboarding.completed_at
  from public.organization_members as member
  join public.organizations as organization
    on organization.id = member.organization_id
  left join public.organization_onboarding as onboarding
    on onboarding.organization_id = organization.id
  left join public.locations as location
    on location.organization_id = organization.id
    and location.id = target_location_id
    and (
      member.role in ('owner', 'admin')
      or exists (
        select 1
        from public.organization_member_locations as assignment
        where assignment.organization_id = member.organization_id
          and assignment.organization_member_id = member.id
          and assignment.location_id = location.id
      )
    )
  where member.user_id = auth.uid()
    and member.revoked_at is null
    and member.organization_id = target_organization_id
    -- A selection naming a location must resolve to one the caller may use. Without this a member
    -- could pass any location id and fall through to a context with a null location.
    and (target_location_id is null or location.id is not null)
  limit 1;
$$;

-- ============================================================================
-- 12. Direct membership mutation is withdrawn
-- ============================================================================
--
-- Phase 1 allowed authenticated clients to write these tables because no team-management boundary
-- existed yet. It does now, and every one of those writes has a narrow RPC that revalidates the
-- caller. Leaving the privilege in place would mean the permission matrix is advisory: a browser
-- could insert its own owner row, clear its own revoked_at, or assign itself a location.
revoke insert, update, delete on table public.organization_members from authenticated, anon;
revoke insert, update, delete on table public.organization_member_locations from authenticated, anon;

-- The mutation policies are now unreachable, because a policy cannot grant a privilege that was
-- never granted. They are dropped rather than left in place so the next person reading this schema
-- does not have to work out which of two mechanisms is actually in force.
drop policy if exists organization_members_insert_admin on public.organization_members;
drop policy if exists organization_members_update_admin on public.organization_members;
drop policy if exists organization_members_delete_admin on public.organization_members;
drop policy if exists organization_member_locations_insert_admin on public.organization_member_locations;
drop policy if exists organization_member_locations_update_admin on public.organization_member_locations;
drop policy if exists organization_member_locations_delete_admin on public.organization_member_locations;

-- SELECT stays. Existing reads legitimately join membership for tenant scoping, and the surviving
-- select policies already restrict rows to the caller's own organizations.

-- ============================================================================
-- 13. Function boundary
-- ============================================================================

-- Internal helpers are not a callable surface for anyone, including the trusted backend. They exist
-- to be composed by the definer functions above.
revoke all on function
  public.team_invitation_lifetime(),
  public.normalize_team_email(text),
  public.my_team_role(uuid),
  public.team_role_may_manage(text, text),
  public.team_organization_is_ready(uuid),
  public.team_verified_locations(uuid, uuid[])
  from public, anon, authenticated, service_role;

-- Team management is an authenticated-user workflow throughout. Deliberately not service-role:
-- a backend role standing in for auth.uid() would bypass the entire permission matrix, and there
-- is no server-side caller that needs to create or accept an invitation on someone's behalf.
revoke all on function
  public.create_my_organization_invitation(uuid, text, text, uuid[]),
  public.accept_my_organization_invitation(text),
  public.revoke_my_organization_invitation(uuid),
  public.update_my_organization_member_access(uuid, text, uuid[]),
  public.revoke_my_organization_member(uuid),
  public.get_my_organization_team(uuid),
  public.get_my_workspace_contexts(),
  public.get_my_workspace_context(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.create_my_organization_invitation(uuid, text, text, uuid[]),
  public.accept_my_organization_invitation(text),
  public.revoke_my_organization_invitation(uuid),
  public.update_my_organization_member_access(uuid, text, uuid[]),
  public.revoke_my_organization_member(uuid),
  public.get_my_organization_team(uuid),
  public.get_my_workspace_contexts(),
  public.get_my_workspace_context(uuid, uuid)
  to authenticated;

-- ============================================================================
-- 14. Schema compatibility
-- ============================================================================
--
-- Phase 15 code cannot work against a Phase 14 database: the invitation tables, the revocation
-- columns, and the workspace selection functions do not exist there. The Phase 14 contract says a
-- release with a schema dependency advertises it, so readiness now requires >= 15. A newer additive
-- schema still serves, which is what keeps an application rollback possible.
update public.platform_schema_contract
set schema_version = 15, updated_at = now()
where id = true;

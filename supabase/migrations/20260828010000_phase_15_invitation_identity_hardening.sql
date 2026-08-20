-- Phase 15 invitation identity hardening.  Additive follow-up to 20260828000000_phase_15_team_access:
-- that migration is already reviewed and is not rewritten here.
--
-- Three identity defects are corrected, all of which share one root cause: the invitation flow
-- trusted something other than the current canonical auth account.
--
-- 1. Acceptance proved which email an account claims, not that the account had proved it owns that
--    address.  An unconfirmed signup could therefore accept an invitation addressed to somebody
--    else simply by typing their address.
--
-- 2. Existing-member detection read public.users.email, which is a profile mirror.  After an auth
--    email change it goes stale, and a stale mirror used as identity authority is a way to issue an
--    invitation to someone who is already a member under their real address.
--
-- 3. Acceptance rewrote whatever membership it found.  Presenting an invitation is not an access
--    change, so an active admin could be demoted -- or an active member's location scope replaced --
--    by a token rather than by the access-update RPC that checks the permission matrix.

-- ============================================================================
-- 1. Canonical identity helpers
-- ============================================================================

-- The current confirmed email for an account, or null when the address has not been confirmed.
--
-- Returning null rather than raising is what lets every caller fail closed on the same condition.
-- auth.users is never exposed through an RPC: this helper is revoked from every role and is only
-- composed by the definer functions below, which return no auth metadata of any kind.
create function public.confirmed_account_email(target_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select public.normalize_team_email(account.email)
  from auth.users as account
  where account.id = target_user_id
    and account.email_confirmed_at is not null
    and coalesce(btrim(account.email), '') <> '';
$$;

-- Whether this organization already has an active member whose current auth address matches.
--
-- Deliberately reads auth.users rather than the public.users mirror. The mirror exists for display
-- and can lag an address change; identity has to come from the account itself.
create function public.organization_has_active_member_email(
  target_organization_id uuid,
  target_email text
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members as member
    join auth.users as account on account.id = member.user_id
    where member.organization_id = target_organization_id
      and member.revoked_at is null
      and public.normalize_team_email(account.email) = target_email
  );
$$;

-- ============================================================================
-- 2. Invitation creation resolves identity from the account, not the mirror
-- ============================================================================

create or replace function public.create_my_organization_invitation(
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

  -- Identity comes from the account, not from public.users. The mirror can lag an address change,
  -- and a stale mirror would let an invitation be issued to someone who is already a member under
  -- the address they actually use now.
  if public.organization_has_active_member_email(target_organization_id, normalized_email) then
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
-- 3. Acceptance requires a confirmed address and never rewrites active membership
-- ============================================================================
--
-- Lock order, unchanged from the reviewed version and stated here because a second row lock is now
-- taken: token advisory lock, then the invitation row, then the membership row. Invitation creation
-- takes a different advisory key (organization + email) and never locks organization_members, so
-- the two paths share no lock and cannot invert.

create or replace function public.accept_my_organization_invitation(target_token text)
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
  membership_revoked boolean;
  scope_count integer;
  invited_locations uuid[];
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication is required';
  end if;
  if coalesce(btrim(target_token), '') = '' then
    raise exception using errcode = '22023', message = 'Invitation is invalid';
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

  -- The identity binding, and the whole reason a leaked link is not a takeover.
  --
  -- Proving which address an account claims is not enough: without confirmation anyone can sign up
  -- typing somebody else's address, so the invitation would be accepted by whoever holds the link
  -- rather than by whoever holds the mailbox. A null result here means unconfirmed or absent, and
  -- both fail closed. This does not depend on a project setting being enabled somewhere.
  caller_email := public.confirmed_account_email(current_user_id);
  if caller_email is null then
    return query select null::uuid, null::text, null::text, 'verified_email_required'::text;
    return;
  end if;

  if invitation.email_normalized <> caller_email then
    -- Deliberately says nothing about who was invited.
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

  -- Current membership truth, re-evaluated inside this transaction and under a row lock.
  --
  -- Creation refuses to invite an existing active member, but membership can change between
  -- creation and acceptance, so acceptance cannot lean on "creation would have rejected this".
  select member.id, member.revoked_at is not null
  into membership_id, membership_revoked
  from public.organization_members as member
  where member.organization_id = invitation.organization_id
    and member.user_id = current_user_id
  for update;

  -- An active member gains nothing from presenting an invitation, and must lose nothing either.
  -- Rewriting the row here would make a bearer token an alternate access-update path that skips the
  -- permission matrix: an active admin could be demoted to member, an owner could be demoted, and a
  -- member's location scope could be replaced, all by whoever holds a link. The invitation is left
  -- pending rather than marked accepted, because nobody joined; it expires on its own, and an
  -- owner or admin can revoke it.
  if membership_id is not null and not membership_revoked then
    return query select invitation.organization_id, organization.name, null::text,
      'already_member'::text;
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
  -- invited person may never have had one. The email stored here is display data, never authority.
  insert into public.users (id, email)
  select account.id, account.email
  from auth.users as account
  where account.id = current_user_id
  on conflict (id) do update set email = excluded.email;

  if membership_id is null then
    insert into public.organization_members (organization_id, user_id, role)
    values (invitation.organization_id, current_user_id, invitation.role)
    returning id into membership_id;
  else
    -- Only a revoked membership reaches this branch, so reactivation cannot touch a live role.
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
    case when membership_revoked then 'team.member_reactivated' else 'team.member_joined' end,
    'organization_member',
    membership_id,
    jsonb_build_object('role', invitation.role, 'location_count', scope_count)
  );

  return query select invitation.organization_id, organization.name, invitation.role, 'accepted'::text;
end;
$$;

-- ============================================================================
-- 4. The Team read model shows the address the account actually uses
-- ============================================================================
--
-- The profile mirror stays for display fallback, but reading it alone would show an operator a
-- stale address after an email change and make "invite that person" behave confusingly. Resolving
-- from auth.users inside the definer keeps the page current by construction rather than by an
-- eventual sync, and still returns nothing but the address itself: no confirmation timestamp, no
-- provider metadata, no auth identity.

create or replace function public.get_my_organization_team(target_organization_id uuid)
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
    coalesce(account.email, profile.email),
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
  left join auth.users as account on account.id = member.user_id
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
  -- the creation response.
end;
$$;

-- ============================================================================
-- 5. Function boundary
-- ============================================================================

-- Identity helpers read auth.users, so they are not a callable surface for anyone. They exist only
-- to be composed by the definer functions above, which return no auth metadata.
revoke all on function
  public.confirmed_account_email(uuid),
  public.organization_has_active_member_email(uuid, text)
  from public, anon, authenticated, service_role;

-- Replacing a function preserves its grants; these are restated so the boundary is visible in one
-- place rather than inferred from a previous migration.
revoke all on function
  public.create_my_organization_invitation(uuid, text, text, uuid[]),
  public.accept_my_organization_invitation(text),
  public.get_my_organization_team(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.create_my_organization_invitation(uuid, text, text, uuid[]),
  public.accept_my_organization_invitation(text),
  public.get_my_organization_team(uuid)
  to authenticated;

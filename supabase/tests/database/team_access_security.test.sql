-- Phase 15 team access: invitations, membership revocation, and the permission matrix.
--
-- Everything here is authorization. Each assertion runs as a real role with a real auth.uid()
-- claim, because the whole point of the phase is that the database refuses what the UI merely
-- declines to render.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(108);

-- Captures the one-time creation response so later assertions can use the plaintext token. Created
-- and granted as the session owner, because the authenticated role has no CREATE TEMP privilege.
create temporary table issued_invitations (
  label text primary key,
  invitation_id uuid,
  invitation_token text,
  email_normalized text,
  role text,
  expires_at timestamptz,
  outcome text
);
grant select, insert on issued_invitations to public;

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

-- Acts as one authenticated user for a single statement.
create function pg_temp.as_user(target_user_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', target_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', target_user_id, 'role', 'authenticated')::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture: one completed organization with an owner, an admin, two members,
-- two locations, plus a second organization to prove tenant isolation.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'owner@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'admin@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'member@example.test'),
  ('a0000000-0000-4000-8000-000000000004', 'second@example.test'),
  ('a0000000-0000-4000-8000-000000000005', 'invited@example.test'),
  ('a0000000-0000-4000-8000-000000000006', 'stranger@example.test'),
  ('a0000000-0000-4000-8000-000000000007', 'otherowner@example.test');

-- The local stack mirrors auth.users into public.users, so this upserts rather than assuming
-- the profile row does not exist yet. display_name is what the Inbox renders for an assignee.
insert into public.users (id, email, display_name)
select id, email, split_part(email, '@', 1) from auth.users
where id::text like 'a0000000-0000-4000-8000-%'
on conflict (id) do update set email = excluded.email, display_name = excluded.display_name;

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('b0000000-0000-4000-8000-000000000001', 'Team Org', 'team-org',
   'a0000000-0000-4000-8000-000000000001', 'veterinary'),
  ('b0000000-0000-4000-8000-000000000002', 'Other Org', 'other-org',
   'a0000000-0000-4000-8000-000000000007', 'veterinary');

insert into public.locations (id, organization_id, name) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'North'),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'South'),
  ('c0000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000002', 'Foreign');

insert into public.organization_onboarding (organization_id, location_id, current_step, status, completed_at) values
  ('b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'completed', 'completed', now()),
  ('b0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000009', 'completed', 'completed', now());

insert into public.organization_members (id, organization_id, user_id, role) values
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'owner'),
  ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'admin'),
  ('d0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'member'),
  ('d0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000004', 'member'),
  ('d0000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000007', 'owner');

insert into public.organization_member_locations (organization_id, organization_member_id, location_id) values
  ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002');

-- ---------------------------------------------------------------------------
-- Direct mutation is withdrawn (the privilege, not merely the policy)
-- ---------------------------------------------------------------------------
select extensions.ok(
  not has_table_privilege('authenticated', 'public.organization_members', 'insert'),
  'a browser client cannot insert a membership row'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.organization_members', 'update'),
  'a browser client cannot update a membership row'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.organization_members', 'delete'),
  'a browser client cannot delete a membership row'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.organization_member_locations', 'insert'),
  'a browser client cannot assign itself a location'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.organization_member_locations', 'update'),
  'a browser client cannot update a location assignment'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.organization_member_locations', 'delete'),
  'a browser client cannot delete a location assignment'
);
select extensions.ok(
  has_table_privilege('authenticated', 'public.organization_members', 'select'),
  'membership reads survive, because tenant scoping legitimately joins them'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.organization_invitations', 'select'),
  'invitation rows are unreachable from the browser'
);
select extensions.ok(
  not has_table_privilege('anon', 'public.organization_invitations', 'select'),
  'invitation rows are unreachable anonymously'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.organization_invitations', 'insert'),
  'no broad service-role write grant stands in for the permission matrix'
);
select extensions.ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('organization_members', 'organization_member_locations')
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ),
  'the unreachable mutation policies are gone rather than left to confuse the next reader'
);
select extensions.ok(
  not exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname in (
        'create_my_organization_invitation', 'accept_my_organization_invitation',
        'revoke_my_organization_invitation', 'update_my_organization_member_access',
        'revoke_my_organization_member', 'get_my_organization_team',
        'get_my_workspace_contexts', 'get_my_workspace_context', 'my_team_role',
        'team_verified_locations', 'team_organization_is_ready'
      )
      and (
        proc.proconfig is null
        or not exists (select 1 from unnest(proc.proconfig) as setting where setting like 'search_path=%')
      )
  ),
  'every team function pins an empty search path'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.my_team_role(uuid)', 'execute'),
  'internal helpers are not a callable boundary'
);
select extensions.ok(
  has_function_privilege('authenticated', 'public.create_my_organization_invitation(uuid,text,text,uuid[])', 'execute'),
  'invitation creation is an authenticated-user workflow'
);
select extensions.ok(
  not has_function_privilege('service_role', 'public.accept_my_organization_invitation(text)', 'execute'),
  'a backend role cannot stand in for auth.uid() during acceptance'
);

-- ---------------------------------------------------------------------------
-- Invitation creation and the permission matrix
-- ---------------------------------------------------------------------------
set local role authenticated;

select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
select extensions.is(
  (select outcome from public.create_my_organization_invitation(
    'b0000000-0000-4000-8000-000000000001', 'New.Member@Example.TEST ', 'member',
    array['c0000000-0000-4000-8000-000000000001']::uuid[])),
  'created',
  'an owner invites a member'
);
select extensions.is(
  (select outcome from public.create_my_organization_invitation(
    'b0000000-0000-4000-8000-000000000001', 'newadmin@example.test', 'admin')),
  'created',
  'an owner invites an admin'
);

select pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
select extensions.is(
  (select outcome from public.create_my_organization_invitation(
    'b0000000-0000-4000-8000-000000000001', 'admin-invited-member@example.test', 'member',
    array['c0000000-0000-4000-8000-000000000002']::uuid[])),
  'created',
  'an admin invites a member'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.create_my_organization_invitation(
      'b0000000-0000-4000-8000-000000000001', 'escalation@example.test', 'admin')
  $sql$, '42501', 'Insufficient team management authority')),
  'an admin cannot invite another admin'
);

select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.create_my_organization_invitation(
      'b0000000-0000-4000-8000-000000000001', 'member-invite@example.test', 'member',
      array['c0000000-0000-4000-8000-000000000001']::uuid[])
  $sql$, '42501', 'Insufficient team management authority')),
  'a member has no invitation authority'
);

select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.create_my_organization_invitation(
      'b0000000-0000-4000-8000-000000000001', 'newowner@example.test', 'owner',
      array['c0000000-0000-4000-8000-000000000001']::uuid[])
  $sql$, '22023', 'Invitation role is invalid')),
  'no invitation can create an owner'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.create_my_organization_invitation(
      'b0000000-0000-4000-8000-000000000002', 'foreign@example.test', 'member',
      array['c0000000-0000-4000-8000-000000000009']::uuid[])
  $sql$, '42501', 'Organization membership is required')),
  'an owner of one organization cannot invite into another'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.create_my_organization_invitation(
      'b0000000-0000-4000-8000-000000000001', 'crossorg@example.test', 'member',
      array['c0000000-0000-4000-8000-000000000009']::uuid[])
  $sql$, '22023', 'Location scope is invalid')),
  'a location belonging to another organization is refused'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.create_my_organization_invitation(
      'b0000000-0000-4000-8000-000000000001', 'noscope@example.test', 'member')
  $sql$, '22023', 'A member invitation requires at least one location')),
  'a member invitation requires at least one location'
);
select extensions.is(
  (select outcome from public.create_my_organization_invitation(
    'b0000000-0000-4000-8000-000000000001', 'member@example.test', 'member',
    array['c0000000-0000-4000-8000-000000000001']::uuid[])),
  'already_member',
  'an existing active member is reported rather than invited twice'
);
reset role;

select extensions.is(
  (select email_normalized from public.organization_invitations
   where token_hash = (select token_hash from public.organization_invitations
     order by created_at limit 1)),
  'new.member@example.test',
  'the invitation email is lowercased and trimmed'
);
select extensions.ok(
  (select count(*) = 0 from public.organization_invitation_locations scope
   join public.organization_invitations invitation on invitation.id = scope.invitation_id
   where invitation.role = 'admin'),
  'an admin invitation carries no location rows, because admin is organization-wide'
);

-- ---------------------------------------------------------------------------
-- Token handling
-- ---------------------------------------------------------------------------
-- The fixture token is deliberately unmistakable so a leak search cannot produce a false negative.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
insert into issued_invitations
select 'invited', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'b0000000-0000-4000-8000-000000000001', 'invited@example.test', 'member',
  array['c0000000-0000-4000-8000-000000000001']::uuid[]);
reset role;

select extensions.ok(
  (select char_length(invitation_token) = 64 from issued_invitations where label = 'invited'),
  'the token carries 32 random bytes, hex encoded'
);
select extensions.ok(
  (select invitation_token ~ '^[0-9a-f]{64}$' from issued_invitations where label = 'invited'),
  'the token is generated at the database boundary, not supplied by a caller'
);
select extensions.ok(
  not exists (
    select 1 from public.organization_invitations invitation, issued_invitations issued
    where invitation.token_hash = issued.invitation_token
  ),
  'the plaintext token is never what is stored'
);
select extensions.ok(
  exists (
    select 1 from public.organization_invitations invitation, issued_invitations issued
    where invitation.id = issued.invitation_id
      and invitation.token_hash = encode(extensions.digest(issued.invitation_token, 'sha256'), 'hex')
  ),
  'the stored value is the SHA-256 digest of the token'
);
select extensions.ok(
  (select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute'
   from issued_invitations where label = 'invited'),
  'the invitation expires seven days after it was created'
);
select extensions.ok(
  (select count(distinct token_hash) = count(*) from public.organization_invitations),
  'token hashes are unique'
);

-- The audit must carry the shape of the decision, never the identity or the credential.
select extensions.ok(
  not exists (
    select 1 from public.action_logs log, issued_invitations issued
    where log.action like 'team.%'
      and log.details::text like '%' || issued.invitation_token || '%'
  ),
  'no action log contains the plaintext invitation token'
);
select extensions.ok(
  not exists (
    select 1 from public.action_logs log
    where log.action like 'team.%' and log.details::text like '%@example.test%'
  ),
  'no action log contains an invitation email address'
);
select extensions.ok(
  not exists (
    select 1 from public.action_logs log
    join public.organization_invitations invitation on invitation.id = log.entity_id
    where log.action like 'team.%' and log.details::text like '%' || invitation.token_hash || '%'
  ),
  'no action log contains the token hash'
);
select extensions.ok(
  exists (
    select 1 from public.action_logs log
    where log.action = 'team.invitation_created'
      and log.details ? 'role' and log.details ? 'location_count'
  ),
  'the invitation audit records role and scope size only'
);

-- ---------------------------------------------------------------------------
-- Acceptance
-- ---------------------------------------------------------------------------
set local role authenticated;

-- Wrong identity: the link works, the account does not match.
select pg_temp.as_user('a0000000-0000-4000-8000-000000000006');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued_invitations where label = 'invited'))),
  'wrong_account',
  'acceptance is refused when the authenticated email is not the invited one'
);
reset role;
select extensions.ok(
  not exists (
    select 1 from public.organization_members
    where organization_id = 'b0000000-0000-4000-8000-000000000001'
      and user_id = 'a0000000-0000-4000-8000-000000000006'
  ),
  'a refused acceptance creates no membership'
);

set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000005');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued_invitations where label = 'invited'))),
  'accepted',
  'the invited account accepts successfully'
);
-- Replay by the same person is a success, not a second membership.
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued_invitations where label = 'invited'))),
  'already_accepted',
  'replay by the accepted user is idempotent'
);
reset role;

select extensions.is(
  (select count(*)::integer from public.organization_members
   where organization_id = 'b0000000-0000-4000-8000-000000000001'
     and user_id = 'a0000000-0000-4000-8000-000000000005'),
  1,
  'replay does not duplicate the membership'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
   where action in ('team.member_joined', 'team.member_reactivated')
     and organization_id = 'b0000000-0000-4000-8000-000000000001'),
  1,
  'replay does not duplicate the lifecycle audit'
);
select extensions.is(
  (select role from public.organization_members
   where organization_id = 'b0000000-0000-4000-8000-000000000001'
     and user_id = 'a0000000-0000-4000-8000-000000000005'),
  'member',
  'the role comes from the durable invitation row'
);
select extensions.is(
  (select count(*)::integer from public.organization_member_locations assignment
   join public.organization_members member on member.id = assignment.organization_member_id
   where member.user_id = 'a0000000-0000-4000-8000-000000000005'),
  1,
  'the location scope comes from the durable invitation row'
);

-- An accepted token cannot be reused by anyone else.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000006');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued_invitations where label = 'invited'))),
  'invalid',
  'an accepted token is useless to a different user'
);
select extensions.is(
  (select outcome from public.accept_my_organization_invitation('not-a-real-token')),
  'invalid',
  'an unknown token is refused without revealing anything'
);
reset role;

-- ---------------------------------------------------------------------------
-- Expiry, revocation, and token rotation
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
insert into issued_invitations
select 'expired', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'b0000000-0000-4000-8000-000000000001', 'stranger@example.test', 'member',
  array['c0000000-0000-4000-8000-000000000001']::uuid[]);
reset role;

update public.organization_invitations
set expires_at = now() - interval '1 minute'
where id = (select invitation_id from issued_invitations where label = 'expired');

set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000006');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued_invitations where label = 'expired'))),
  'expired',
  'an expired invitation cannot be accepted'
);
reset role;

-- Reissuing for the same organization and email must kill the previous link.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
insert into issued_invitations
select 'rotated_old', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'b0000000-0000-4000-8000-000000000001', 'rotate@example.test', 'member',
  array['c0000000-0000-4000-8000-000000000001']::uuid[]);
insert into issued_invitations
select 'rotated_new', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'b0000000-0000-4000-8000-000000000001', 'rotate@example.test', 'member',
  array['c0000000-0000-4000-8000-000000000002']::uuid[]);
reset role;

select extensions.ok(
  (select revoked_at is not null from public.organization_invitations
   where id = (select invitation_id from issued_invitations where label = 'rotated_old')),
  'reissuing revokes the previous invitation'
);
select extensions.ok(
  (select revoked_at is null from public.organization_invitations
   where id = (select invitation_id from issued_invitations where label = 'rotated_new')),
  'the replacement invitation is live'
);
select extensions.is(
  (select count(*)::integer from public.organization_invitations
   where organization_id = 'b0000000-0000-4000-8000-000000000001'
     and email_normalized = 'rotate@example.test'
     and accepted_at is null and revoked_at is null),
  1,
  'exactly one live bearer link exists per organization and email'
);

set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
-- Revocation is idempotent and audits once.
select extensions.is(
  (select outcome from public.revoke_my_organization_invitation(
    (select invitation_id from issued_invitations where label = 'rotated_new'))),
  'revoked',
  'a pending invitation is revoked'
);
select extensions.is(
  (select outcome from public.revoke_my_organization_invitation(
    (select invitation_id from issued_invitations where label = 'rotated_new'))),
  'already_revoked',
  'revocation replay is idempotent'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.action_logs
   where action = 'team.invitation_revoked'
     and entity_id = (select invitation_id from issued_invitations where label = 'rotated_new')),
  1,
  'revocation replay writes no second audit'
);

-- ---------------------------------------------------------------------------
-- Membership lifecycle and the revocation contract
-- ---------------------------------------------------------------------------
set local role authenticated;

-- Owner promotes a member to admin. Member-only location rows must not survive.
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
select extensions.is(
  (select outcome from public.update_my_organization_member_access(
    'd0000000-0000-4000-8000-000000000004', 'admin')),
  'updated',
  'an owner promotes a member to admin'
);
reset role;
select extensions.is(
  (select role from public.organization_members where id = 'd0000000-0000-4000-8000-000000000004'),
  'admin',
  'the promotion applied'
);
select extensions.is(
  (select count(*)::integer from public.organization_member_locations
   where organization_member_id = 'd0000000-0000-4000-8000-000000000004'),
  0,
  'promotion clears member-only location scope so it cannot be silently reapplied later'
);

set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
-- Demotion must name the new scope in the same call.
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.update_my_organization_member_access(
      'd0000000-0000-4000-8000-000000000004', 'member')
  $sql$, '22023', 'A member requires at least one location')),
  'demotion without an explicit location is refused'
);
select extensions.is(
  (select outcome from public.update_my_organization_member_access(
    'd0000000-0000-4000-8000-000000000004', 'member',
    array['c0000000-0000-4000-8000-000000000002']::uuid[])),
  'updated',
  'an owner demotes an admin to member with an explicit location'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.update_my_organization_member_access(
      'd0000000-0000-4000-8000-000000000003', 'member',
      array['c0000000-0000-4000-8000-000000000009']::uuid[])
  $sql$, '22023', 'Location scope is invalid')),
  'a cross-organization location is refused on update'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.update_my_organization_member_access(
      'd0000000-0000-4000-8000-000000000001', 'member',
      array['c0000000-0000-4000-8000-000000000001']::uuid[])
  $sql$, '42501', 'Insufficient team management authority')),
  'an owner cannot be demoted through team management'
);

-- Admin authority stops at members.
select pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
select extensions.is(
  (select outcome from public.update_my_organization_member_access(
    'd0000000-0000-4000-8000-000000000003', 'member',
    array['c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002']::uuid[])),
  'updated',
  'an admin updates a member location scope'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.update_my_organization_member_access(
      'd0000000-0000-4000-8000-000000000003', 'admin',
      array[]::uuid[])
  $sql$, '42501', 'Insufficient team management authority')),
  'an admin cannot promote a member to admin'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.revoke_my_organization_member('d0000000-0000-4000-8000-000000000001')
  $sql$, '42501', 'Insufficient team management authority')),
  'an admin cannot revoke an owner'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.organization_member_locations
   where organization_member_id = 'd0000000-0000-4000-8000-000000000003'),
  2,
  'the member location set is replaced atomically with exactly what was submitted'
);

-- ---------------------------------------------------------------------------
-- Revocation takes effect at the database boundary, immediately
-- ---------------------------------------------------------------------------
-- Before revocation the member holds real authorization. This is the control.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select extensions.ok(
  public.is_organization_member('b0000000-0000-4000-8000-000000000001'),
  'an active member is an organization member'
);
select extensions.ok(
  public.has_location_write_access(
    'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001'),
  'an active member can write at an assigned location'
);
select extensions.ok(
  (select count(*) > 0 from public.get_my_tenant_context()),
  'an active member appears in their own tenant context'
);

select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
select extensions.is(
  (select outcome from public.revoke_my_organization_member('d0000000-0000-4000-8000-000000000003')),
  'revoked',
  'an owner revokes a member'
);
select extensions.is(
  (select outcome from public.revoke_my_organization_member('d0000000-0000-4000-8000-000000000003')),
  'already_revoked',
  'member revocation replay is idempotent'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.revoke_my_organization_member('d0000000-0000-4000-8000-000000000001')
  $sql$, '42501', 'Insufficient team management authority')),
  'an owner cannot be revoked, so an organization always keeps an administrator'
);

-- The same helpers, same user, immediately after. No sign-out, no token refresh.
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select extensions.ok(
  not public.is_organization_member('b0000000-0000-4000-8000-000000000001'),
  'a revoked member immediately loses organization membership'
);
select extensions.ok(
  not public.has_location_access(
    'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001'),
  'a revoked member immediately loses location read access'
);
select extensions.ok(
  not public.has_location_write_access(
    'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001'),
  'a revoked member immediately loses location write access, which is what stops Phase 13 actions'
);
select extensions.is(
  (select count(*)::integer from public.get_my_tenant_context()),
  0,
  'a revoked member disappears from tenant context'
);
select extensions.is(
  (select count(*)::integer from public.get_my_workspace_contexts()),
  0,
  'a revoked member has no selectable workspace, so a stale cookie resolves to nothing'
);
reset role;

select extensions.ok(
  exists (select 1 from public.organization_members where id = 'd0000000-0000-4000-8000-000000000003'),
  'the membership row survives, so historical attribution keeps its foreign key'
);
select extensions.is(
  (select count(*)::integer from public.organization_member_locations
   where organization_member_id = 'd0000000-0000-4000-8000-000000000003'),
  0,
  'revocation clears location assignments rather than leaving stale future access'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
   where action = 'team.member_revoked' and entity_id = 'd0000000-0000-4000-8000-000000000003'),
  1,
  'revocation replay writes no second audit'
);
select extensions.ok(
  (select revoked_by_user_id = 'a0000000-0000-4000-8000-000000000001'
   from public.organization_members where id = 'd0000000-0000-4000-8000-000000000003'),
  'the revocation records who performed it'
);

-- An admin who loses access loses admin authority too, not just member authority.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
select extensions.is(
  (select outcome from public.revoke_my_organization_member('d0000000-0000-4000-8000-000000000002')),
  'revoked',
  'an owner revokes an admin'
);
select pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
select extensions.ok(
  not public.is_organization_admin('b0000000-0000-4000-8000-000000000001'),
  'a revoked admin immediately loses admin authorization'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.get_my_organization_team('b0000000-0000-4000-8000-000000000001')
  $sql$, '42501', 'Organization owner or admin access is required')),
  'a revoked admin can no longer read the team'
);
reset role;

-- ---------------------------------------------------------------------------
-- Reactivation replaces scope rather than restoring it
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
insert into issued_invitations
select 'reactivate', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'b0000000-0000-4000-8000-000000000001', 'member@example.test', 'member',
  array['c0000000-0000-4000-8000-000000000002']::uuid[]);

select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued_invitations where label = 'reactivate'))),
  'accepted',
  'a previously revoked person can be invited back'
);
select extensions.ok(
  public.is_organization_member('b0000000-0000-4000-8000-000000000001'),
  'reactivation restores authorization'
);
reset role;

select extensions.is(
  (select count(*)::integer from public.organization_members
   where organization_id = 'b0000000-0000-4000-8000-000000000001'
     and user_id = 'a0000000-0000-4000-8000-000000000003'),
  1,
  'reactivation reuses the existing membership row rather than duplicating it'
);
select extensions.ok(
  (select revoked_at is null and revoked_by_user_id is null
   from public.organization_members where id = 'd0000000-0000-4000-8000-000000000003'),
  'reactivation clears the revocation record'
);
select extensions.is(
  (select array_agg(location_id::text order by location_id::text)
   from public.organization_member_locations
   where organization_member_id = 'd0000000-0000-4000-8000-000000000003'),
  array['c0000000-0000-4000-8000-000000000002'],
  'reactivation applies exactly the new invitation scope, not the old assignments'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
   where action = 'team.member_reactivated' and entity_id = 'd0000000-0000-4000-8000-000000000003'),
  1,
  'reactivation is audited distinctly from a first join'
);

-- ---------------------------------------------------------------------------
-- Constraints hold independently of the RPCs
-- ---------------------------------------------------------------------------
select extensions.ok(
  (select pg_temp.error_matches($sql$
    update public.organization_members set revoked_at = now()
    where id = 'd0000000-0000-4000-8000-000000000003'
  $sql$, '23514', 'organization_members_revocation_consistent')),
  'a revocation without an actor is rejected by the database'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    update public.organization_members
    set revoked_at = now(), revoked_by_user_id = 'a0000000-0000-4000-8000-000000000002'
    where id = 'd0000000-0000-4000-8000-000000000001'
  $sql$, '23514', 'organization_members_owner_not_revoked')),
  'an owner cannot be revoked even by a direct write'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    insert into public.organization_invitations
      (organization_id, email_normalized, role, token_hash, expires_at, created_by_user_id)
    values ('b0000000-0000-4000-8000-000000000001', 'Mixed@Example.test', 'member',
      repeat('a', 64), now() + interval '1 day', 'a0000000-0000-4000-8000-000000000001')
  $sql$, '23514', 'email_normalized')),
  'an unnormalized invitation email is rejected by the database'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    insert into public.organization_invitations
      (organization_id, email_normalized, role, token_hash, expires_at, created_by_user_id)
    values ('b0000000-0000-4000-8000-000000000001', 'owner-invite@example.test', 'owner',
      repeat('b', 64), now() + interval '1 day', 'a0000000-0000-4000-8000-000000000001')
  $sql$, '23514', 'organization_invitations_role_check')),
  'the database refuses an owner invitation regardless of caller'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    insert into public.organization_invitation_locations (organization_id, invitation_id, location_id)
    select 'b0000000-0000-4000-8000-000000000001', invitation_id, 'c0000000-0000-4000-8000-000000000009'
    from issued_invitations where label = 'reactivate'
  $sql$, '23503', 'organization_invitation_locations_location_fk')),
  'a foreign location cannot be attached to an invitation'
);
select extensions.is(
  (select schema_version from public.platform_schema_contract),
  15,
  'the deployed schema advertises the Phase 15 compatibility version'
);

-- ---------------------------------------------------------------------------
-- Revocation against live Phase 13 ownership
-- ---------------------------------------------------------------------------
-- The scenario the phase exists to make safe: a member is holding a live conversation when their
-- access is removed. Nothing may be auto-resolved, the AI must not be resumed, the ownership record
-- must survive, and an owner must still be able to recover the work.
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status, configuration)
values ('e1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-000000000002', 'sms', 'Team SMS', 'active', '{}');
insert into public.contacts (id, organization_id, location_id, first_name, phone)
values ('e2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-000000000002', 'Customer', '+15405550111');
insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, mode, status, ai_mode)
values ('e3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001',
        'e1000000-0000-4000-8000-000000000001', 'customer', 'open', 'ai');
insert into public.handoffs (id, organization_id, location_id, conversation_id, mode, status, urgency, reason)
values ('e4000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000001',
        'customer', 'open', 'normal', 'Customer asked for a person');

-- The member who will be revoked is 'second' (membership d...004), currently scoped to South.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000004');
select extensions.is(
  (select outcome from public.claim_my_handoff('e4000000-0000-4000-8000-000000000001')),
  'claimed',
  'an active member claims a handoff'
);
reset role;

select extensions.is(
  (select assigned_user_id from public.handoffs where id = 'e4000000-0000-4000-8000-000000000001'),
  'a0000000-0000-4000-8000-000000000004',
  'the handoff is owned by that member'
);

set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
select extensions.is(
  (select outcome from public.revoke_my_organization_member('d0000000-0000-4000-8000-000000000004')),
  'revoked',
  'the owner revokes a member who is holding live work'
);
reset role;

-- Nothing about the conversation moved on its own.
select extensions.is(
  (select assigned_user_id from public.handoffs where id = 'e4000000-0000-4000-8000-000000000001'),
  'a0000000-0000-4000-8000-000000000004',
  'revocation does not rewrite historical ownership'
);
select extensions.is(
  (select status from public.handoffs where id = 'e4000000-0000-4000-8000-000000000001'),
  'acknowledged',
  'revocation does not auto-resolve the handoff'
);
select extensions.is(
  (select ai_mode from public.conversations where id = 'e3000000-0000-4000-8000-000000000001'),
  'human',
  'revocation does not resume the AI'
);

-- The revoked operator can no longer act, on this or any handoff.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-4000-8000-000000000004');
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.release_my_handoff('e4000000-0000-4000-8000-000000000001')
  $sql$, '42501', 'Handoff is not available')),
  'the revoked operator cannot release the work they were holding'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.resolve_my_handoff('e4000000-0000-4000-8000-000000000001')
  $sql$, '42501', 'Handoff is not available')),
  'the revoked operator cannot resolve it'
);
select extensions.ok(
  (select pg_temp.error_matches($sql$
    select public.claim_my_handoff('e4000000-0000-4000-8000-000000000001')
  $sql$, '42501', 'Handoff is not available')),
  'the revoked operator cannot re-claim it'
);

-- Recovery still works: an owner releases, and another active member claims.
select pg_temp.as_user('a0000000-0000-4000-8000-000000000001');
select extensions.is(
  (select outcome from public.release_my_handoff('e4000000-0000-4000-8000-000000000001')),
  'released',
  'an owner can still release work abandoned by a revoked member'
);
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select extensions.is(
  (select outcome from public.claim_my_handoff('e4000000-0000-4000-8000-000000000001')),
  'claimed',
  'another active member can claim the released work'
);
reset role;

select extensions.is(
  (select ai_mode from public.conversations where id = 'e3000000-0000-4000-8000-000000000001'),
  'human',
  'recovery keeps the conversation with a human rather than resuming automation'
);
-- The Inbox still renders: the display name comes from the preserved profile row, not from an
-- active membership lookup that no longer returns the revoked assignee.
select extensions.is(
  public.handoff_operator_display_name('a0000000-0000-4000-8000-000000000004'),
  'second',
  'a revoked assignee still resolves to a safe display name'
);

select * from extensions.finish();
rollback;

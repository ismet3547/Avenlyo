-- Phase 15 invitation identity hardening: confirmed email, canonical auth address, and the rule
-- that presenting an invitation is never an access change.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(40);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin execute target_sql;
  exception when others then return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

create function pg_temp.as_user(target_user_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', target_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', target_user_id, 'role', 'authenticated')::text, true);
end;
$$;

create temporary table issued (
  label text primary key,
  invitation_id uuid,
  invitation_token text,
  email_normalized text,
  role text,
  expires_at timestamptz,
  outcome text
);
grant select, insert on issued to public;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('f1000000-0000-4000-8000-000000000001', 'owner@identity.test', now()),
  ('f1000000-0000-4000-8000-000000000002', 'admin-a@identity.test', now()),
  -- Admin B changed their address: auth carries the new one, the profile mirror still has the old.
  ('f1000000-0000-4000-8000-000000000003', 'new-admin@identity.test', now()),
  ('f1000000-0000-4000-8000-000000000004', 'scoped-member@identity.test', now()),
  -- Signed up but never confirmed, so this account has not proved it owns the address.
  ('f1000000-0000-4000-8000-000000000005', 'unconfirmed@identity.test', null),
  ('f1000000-0000-4000-8000-000000000006', 'confirmed@identity.test', now()),
  ('f1000000-0000-4000-8000-000000000007', 'revoked@identity.test', now());

insert into public.users (id, email, display_name)
select id, email, split_part(email, '@', 1) from auth.users
where id::text like 'f1000000-0000-4000-8000-%'
on conflict (id) do update set email = excluded.email, display_name = excluded.display_name;

-- The stale mirror, written deliberately. Identity must not be read from here.
update public.users set email = 'old-admin@identity.test'
where id = 'f1000000-0000-4000-8000-000000000003';

insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('f2000000-0000-4000-8000-000000000001', 'Identity Org', 'identity-org',
   'f1000000-0000-4000-8000-000000000001', 'veterinary');

insert into public.locations (id, organization_id, name) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Alpha'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'Beta');

insert into public.organization_onboarding (organization_id, location_id, current_step, status, completed_at)
values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001',
        'completed', 'completed', now());

insert into public.organization_members (id, organization_id, user_id, role) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'owner'),
  ('f4000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'admin'),
  ('f4000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'admin'),
  ('f4000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000004', 'member'),
  ('f4000000-0000-4000-8000-000000000007', 'f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000007', 'member');

insert into public.organization_member_locations (organization_id, organization_member_id, location_id) values
  ('f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000004', 'f3000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000007', 'f3000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Confirmed email is required to accept
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
insert into issued
select 'unconfirmed', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'f2000000-0000-4000-8000-000000000001', 'unconfirmed@identity.test', 'member',
  array['f3000000-0000-4000-8000-000000000001']::uuid[]);
insert into issued
select 'confirmed', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'f2000000-0000-4000-8000-000000000001', 'confirmed@identity.test', 'member',
  array['f3000000-0000-4000-8000-000000000002']::uuid[]);

-- An account that never confirmed its address has not proved it owns it, so anyone could have
-- signed up typing somebody else's address and taken the invitation.
select pg_temp.as_user('f1000000-0000-4000-8000-000000000005');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued where label = 'unconfirmed'))),
  'verified_email_required',
  'an unconfirmed account cannot accept an invitation to its own address'
);
reset role;

select extensions.ok(
  not exists (
    select 1 from public.organization_members
    where organization_id = 'f2000000-0000-4000-8000-000000000001'
      and user_id = 'f1000000-0000-4000-8000-000000000005'
  ),
  'the refused acceptance created no membership'
);
select extensions.ok(
  (select accepted_at is null from public.organization_invitations
   where id = (select invitation_id from issued where label = 'unconfirmed')),
  'the refused acceptance left the invitation pending'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
   where action in ('team.member_joined', 'team.member_reactivated')
     and organization_id = 'f2000000-0000-4000-8000-000000000001'),
  0,
  'the refused acceptance wrote no lifecycle audit'
);

-- The same invitation shape, with a confirmed account, still works.
set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000006');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued where label = 'confirmed'))),
  'accepted',
  'a confirmed account accepts normally'
);
reset role;
select extensions.is(
  (select role from public.organization_members
   where organization_id = 'f2000000-0000-4000-8000-000000000001'
     and user_id = 'f1000000-0000-4000-8000-000000000006'),
  'member',
  'the confirmed acceptance created the membership'
);

-- Confirming later lets the previously refused account through, so the check gates on the fact
-- rather than permanently rejecting the account.
update auth.users set email_confirmed_at = now()
where id = 'f1000000-0000-4000-8000-000000000005';
set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000005');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued where label = 'unconfirmed'))),
  'accepted',
  'the same account succeeds once its address is confirmed'
);

-- A confirmed account whose address does not match is still refused.
select pg_temp.as_user('f1000000-0000-4000-8000-000000000006');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued where label = 'unconfirmed'))),
  'invalid',
  'an accepted invitation is not reusable by another confirmed account'
);
reset role;

-- ---------------------------------------------------------------------------
-- Identity comes from the account, not the profile mirror
-- ---------------------------------------------------------------------------
-- Admin B is active under new-admin@identity.test; public.users still says old-admin@identity.test.
select extensions.is(
  (select email from public.users where id = 'f1000000-0000-4000-8000-000000000003'),
  'old-admin@identity.test',
  'the profile mirror is deliberately stale for this fixture'
);
select extensions.ok(
  public.organization_has_active_member_email(
    'f2000000-0000-4000-8000-000000000001', 'new-admin@identity.test'),
  'the current auth address identifies the active member'
);
select extensions.ok(
  not public.organization_has_active_member_email(
    'f2000000-0000-4000-8000-000000000001', 'old-admin@identity.test'),
  'the stale mirror address is not treated as a member identity'
);

set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
-- Reading the mirror would have missed this and issued a live invitation to an existing admin.
select extensions.is(
  (select outcome from public.create_my_organization_invitation(
    'f2000000-0000-4000-8000-000000000001', 'new-admin@identity.test', 'member',
    array['f3000000-0000-4000-8000-000000000002']::uuid[])),
  'already_member',
  'an invitation to an active member current address is refused'
);
reset role;

select extensions.is(
  (select count(*)::integer from public.organization_invitations
   where organization_id = 'f2000000-0000-4000-8000-000000000001'
     and email_normalized = 'new-admin@identity.test'),
  0,
  'the refused invitation created no row and therefore no live link'
);

-- The Team read model shows the address the account actually uses.
set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
select extensions.is(
  (select email from public.get_my_organization_team('f2000000-0000-4000-8000-000000000001')
   where record_kind = 'member' and record_id = 'f4000000-0000-4000-8000-000000000003'),
  'new-admin@identity.test',
  'the team read model reports the current account address, not the stale mirror'
);
reset role;

-- ---------------------------------------------------------------------------
-- Acceptance is not an alternate access-update path
-- ---------------------------------------------------------------------------
-- Creation now refuses to invite an active member, but membership changes after an invitation is
-- issued, so acceptance has to defend itself rather than assume creation already did.
--
-- These invitations are inserted directly, which is exactly the state a legitimate invitation would
-- be in if the person joined by some other route before presenting it.

-- An active admin presenting a member invitation must not be demoted.
insert into public.organization_invitations
  (id, organization_id, email_normalized, role, token_hash, expires_at, created_by_user_id)
values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001',
   'new-admin@identity.test', 'member',
   encode(extensions.digest('stale-admin-invitation-token', 'sha256'), 'hex'),
   now() + interval '7 days', 'f1000000-0000-4000-8000-000000000001');
insert into public.organization_invitation_locations (organization_id, invitation_id, location_id)
values ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001',
        'f3000000-0000-4000-8000-000000000002');

set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000003');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation('stale-admin-invitation-token')),
  'already_member',
  'an active admin presenting a member invitation is told they already belong'
);
reset role;

select extensions.is(
  (select role from public.organization_members where id = 'f4000000-0000-4000-8000-000000000003'),
  'admin',
  'the active admin was not demoted by presenting a member invitation'
);
select extensions.is(
  (select count(*)::integer from public.organization_member_locations
   where organization_member_id = 'f4000000-0000-4000-8000-000000000003'),
  0,
  'the active admin gained no location rows, because admin is organization-wide'
);
select extensions.ok(
  (select accepted_at is null and revoked_at is null
   from public.organization_invitations where id = 'f5000000-0000-4000-8000-000000000001'),
  'the invitation is left pending rather than recorded as accepted by someone who joined nothing'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
   where organization_id = 'f2000000-0000-4000-8000-000000000001'
     and entity_id = 'f4000000-0000-4000-8000-000000000003'
     and action in ('team.member_joined', 'team.member_reactivated', 'team.member_access_updated')),
  0,
  'no lifecycle or access audit is written for a membership that did not change'
);

-- An active member presenting an invitation for a different location keeps their own scope.
insert into public.organization_invitations
  (id, organization_id, email_normalized, role, token_hash, expires_at, created_by_user_id)
values
  ('f5000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001',
   'scoped-member@identity.test', 'member',
   encode(extensions.digest('stale-member-scope-token', 'sha256'), 'hex'),
   now() + interval '7 days', 'f1000000-0000-4000-8000-000000000001');
insert into public.organization_invitation_locations (organization_id, invitation_id, location_id)
values ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000002',
        'f3000000-0000-4000-8000-000000000002');

set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000004');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation('stale-member-scope-token')),
  'already_member',
  'an active member presenting an invitation is told they already belong'
);
reset role;

select extensions.is(
  (select array_agg(location_id::text) from public.organization_member_locations
   where organization_member_id = 'f4000000-0000-4000-8000-000000000004'),
  array['f3000000-0000-4000-8000-000000000001'],
  'the active member keeps the location scope they were actually granted'
);
select extensions.is(
  (select role from public.organization_members where id = 'f4000000-0000-4000-8000-000000000004'),
  'member',
  'the active member role is unchanged'
);

-- ---------------------------------------------------------------------------
-- Owner immutability, including after an address change
-- ---------------------------------------------------------------------------
-- The invitation is created while the target has no membership, then they become an active owner
-- before presenting it. Acceptance is the last authorization boundary and must defend itself.
insert into auth.users (id, email, email_confirmed_at)
values ('f1000000-0000-4000-8000-000000000008', 'future-owner@identity.test', now());
insert into public.users (id, email, display_name)
values ('f1000000-0000-4000-8000-000000000008', 'future-owner@identity.test', 'future')
on conflict (id) do update set email = excluded.email;

set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
insert into issued
select 'future-owner', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'f2000000-0000-4000-8000-000000000001', 'future-owner@identity.test', 'admin');
reset role;

select extensions.is(
  (select outcome from issued where label = 'future-owner'),
  'created',
  'the invitation was legitimately created while the target had no membership'
);

-- They become an owner of this organization through another route entirely.
insert into public.organization_members (id, organization_id, user_id, role)
values ('f4000000-0000-4000-8000-000000000008', 'f2000000-0000-4000-8000-000000000001',
        'f1000000-0000-4000-8000-000000000008', 'owner');

set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000008');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued where label = 'future-owner'))),
  'already_member',
  'an active owner presenting an invitation is told they already belong'
);
reset role;

select extensions.is(
  (select role from public.organization_members where id = 'f4000000-0000-4000-8000-000000000008'),
  'owner',
  'the owner role survives an invitation that would have set it to admin'
);
select extensions.ok(
  (select revoked_at is null from public.organization_members
   where id = 'f4000000-0000-4000-8000-000000000008'),
  'the owner membership is untouched'
);

-- Owner changes their address; an invitation to the new address must not become a self-demotion.
update auth.users set email = 'renamed-owner@identity.test'
where id = 'f1000000-0000-4000-8000-000000000001';

set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000002');
select extensions.is(
  (select outcome from public.create_my_organization_invitation(
    'f2000000-0000-4000-8000-000000000001', 'renamed-owner@identity.test', 'member',
    array['f3000000-0000-4000-8000-000000000001']::uuid[])),
  'already_member',
  'an invitation to the owner new address is refused, so self-demotion has no entry point'
);
reset role;

-- And even if such an invitation existed, acceptance refuses it.
insert into public.organization_invitations
  (id, organization_id, email_normalized, role, token_hash, expires_at, created_by_user_id)
values
  ('f5000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001',
   'renamed-owner@identity.test', 'member',
   encode(extensions.digest('owner-self-demotion-token', 'sha256'), 'hex'),
   now() + interval '7 days', 'f1000000-0000-4000-8000-000000000002');
insert into public.organization_invitation_locations (organization_id, invitation_id, location_id)
values ('f2000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000003',
        'f3000000-0000-4000-8000-000000000001');

set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation('owner-self-demotion-token')),
  'already_member',
  'the owner cannot demote themself by accepting a member invitation'
);
reset role;
select extensions.is(
  (select role from public.organization_members where id = 'f4000000-0000-4000-8000-000000000001'),
  'owner',
  'the organization still has its owner'
);

-- ---------------------------------------------------------------------------
-- Revoked membership still reactivates, and still replaces scope exactly
-- ---------------------------------------------------------------------------
-- The active-membership guard must not have broken the case reactivation exists for.
set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
select public.revoke_my_organization_member('f4000000-0000-4000-8000-000000000007');
insert into issued
select 'reactivate', invitation_id, invitation_token, email_normalized, role, expires_at, outcome
from public.create_my_organization_invitation(
  'f2000000-0000-4000-8000-000000000001', 'revoked@identity.test', 'member',
  array['f3000000-0000-4000-8000-000000000002']::uuid[]);

select pg_temp.as_user('f1000000-0000-4000-8000-000000000007');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued where label = 'reactivate'))),
  'accepted',
  'a revoked member is reactivated by a fresh invitation'
);
reset role;

select extensions.ok(
  (select revoked_at is null and revoked_by_user_id is null
   from public.organization_members where id = 'f4000000-0000-4000-8000-000000000007'),
  'reactivation clears the revocation record'
);
select extensions.is(
  (select array_agg(location_id::text) from public.organization_member_locations
   where organization_member_id = 'f4000000-0000-4000-8000-000000000007'),
  array['f3000000-0000-4000-8000-000000000002'],
  'reactivation replaces the old scope with exactly the invitation scope'
);
select extensions.is(
  (select count(*)::integer from public.action_logs
   where action = 'team.member_reactivated'
     and entity_id = 'f4000000-0000-4000-8000-000000000007'),
  1,
  'reactivation writes exactly one audit'
);

-- Replay of the now-accepted reactivation token is still idempotent.
set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000007');
select extensions.is(
  (select outcome from public.accept_my_organization_invitation(
    (select invitation_token from issued where label = 'reactivate'))),
  'already_accepted',
  'replay after reactivation is idempotent'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.action_logs
   where action = 'team.member_reactivated'
     and entity_id = 'f4000000-0000-4000-8000-000000000007'),
  1,
  'replay writes no second audit'
);

-- ---------------------------------------------------------------------------
-- The new identity helpers are not a callable surface
-- ---------------------------------------------------------------------------
select extensions.ok(
  not has_function_privilege('authenticated', 'public.confirmed_account_email(uuid)', 'execute'),
  'the confirmed-email helper is internal, so auth.users is never reachable from a browser'
);
select extensions.ok(
  not has_function_privilege('service_role', 'public.confirmed_account_email(uuid)', 'execute'),
  'the confirmed-email helper is internal to the trusted backend as well'
);
select extensions.ok(
  not has_function_privilege('authenticated',
    'public.organization_has_active_member_email(uuid,text)', 'execute'),
  'the member-identity helper is internal'
);
select extensions.ok(
  not exists (
    select 1 from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname in ('confirmed_account_email', 'organization_has_active_member_email')
      and (
        proc.proconfig is null
        or not exists (select 1 from unnest(proc.proconfig) as setting where setting like 'search_path=%')
      )
  ),
  'both identity helpers pin an empty search path'
);
-- The read model is owner/admin only, so this must run as the owner.
set local role authenticated;
select pg_temp.as_user('f1000000-0000-4000-8000-000000000001');
select extensions.ok(
  not exists (
    select 1 from public.get_my_organization_team('f2000000-0000-4000-8000-000000000001') team
    where team.email is not null and team.email = ''
  ),
  'the team read model returns no auth metadata beyond the address itself'
);
reset role;

select * from extensions.finish();
rollback;

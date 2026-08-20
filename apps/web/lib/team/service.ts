import type {
  InvitationAcceptanceRow,
  MemberRole,
  OrganizationInvitationRow,
  OrganizationTeamRow,
} from '@avenlyo/database';
import { z } from 'zod';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

/**
 * Team and invitation data access.
 *
 * Every call is a narrow RPC. The browser has no direct read or write on the membership and
 * invitation tables, so this module is the entire surface, and the database revalidates the caller
 * on each one rather than trusting anything assembled here.
 */

interface TeamRpcCaller {
  (
    name: 'get_my_organization_team',
    args: { target_organization_id: string },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'create_my_organization_invitation',
    args: {
      target_organization_id: string;
      target_email: string;
      target_role: 'admin' | 'member';
      target_location_ids: string[];
    },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'accept_my_organization_invitation',
    args: { target_token: string },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'revoke_my_organization_invitation',
    args: { target_invitation_id: string },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'revoke_my_organization_member',
    args: { target_membership_id: string },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  (
    name: 'update_my_organization_member_access',
    args: {
      target_membership_id: string;
      target_role: 'admin' | 'member';
      target_location_ids: string[];
    },
  ): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

function teamRpc(client: AvenlyoSupabaseClient): TeamRpcCaller {
  return client.rpc.bind(client);
}

export class TeamServiceError extends Error {
  public constructor(operation: string) {
    super(`The team ${operation} could not be completed.`);
    this.name = 'TeamServiceError';
  }
}

const teamRowSchema = z.object({
  record_kind: z.enum(['member', 'invitation']),
  record_id: z.string().uuid(),
  member_user_id: z.string().uuid().nullable(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member']),
  is_active: z.boolean(),
  joined_at: z.string(),
  expires_at: z.string().nullable(),
  invitation_state: z.enum(['pending', 'accepted', 'revoked', 'expired']).nullable(),
  location_ids: z.array(z.string().uuid()),
  location_names: z.array(z.string()),
  active_work_count: z.number().int().nonnegative(),
});

export interface TeamMember {
  readonly activeWorkCount: number;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly isActive: boolean;
  readonly joinedAt: string;
  readonly locationIds: readonly string[];
  readonly locationNames: readonly string[];
  readonly membershipId: string;
  readonly role: MemberRole;
  readonly userId: string | null;
}

export interface TeamInvitation {
  readonly email: string;
  readonly expiresAt: string | null;
  readonly invitationId: string;
  readonly invitedAt: string;
  readonly locationNames: readonly string[];
  readonly role: MemberRole;
  readonly state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export interface TeamOverview {
  readonly invitations: readonly TeamInvitation[];
  readonly members: readonly TeamMember[];
}

/** One bounded read for the whole page. No query per member, none per location. */
export async function loadTeamOverview(
  supabase: AvenlyoSupabaseClient,
  organizationId: string,
): Promise<TeamOverview> {
  const { data, error } = await teamRpc(supabase)('get_my_organization_team', {
    target_organization_id: organizationId,
  });
  if (error || data === null) {
    throw new TeamServiceError('overview');
  }

  const rows: OrganizationTeamRow[] = z.array(teamRowSchema).parse(data);
  const members: TeamMember[] = [];
  const invitations: TeamInvitation[] = [];

  for (const row of rows) {
    if (row.record_kind === 'member') {
      members.push({
        activeWorkCount: row.active_work_count,
        displayName: row.display_name,
        email: row.email,
        isActive: row.is_active,
        joinedAt: row.joined_at,
        locationIds: row.location_ids,
        locationNames: row.location_names,
        membershipId: row.record_id,
        role: row.role,
        userId: row.member_user_id,
      });
      continue;
    }
    invitations.push({
      email: row.email ?? '',
      expiresAt: row.expires_at,
      invitationId: row.record_id,
      invitedAt: row.joined_at,
      locationNames: row.location_names,
      role: row.role,
      state: row.invitation_state ?? 'pending',
    });
  }

  return { invitations, members };
}

const invitationRowSchema = z.object({
  invitation_id: z.string().uuid().nullable(),
  invitation_token: z.string().nullable(),
  email_normalized: z.string(),
  role: z.enum(['admin', 'member']),
  expires_at: z.string().nullable(),
  outcome: z.enum(['created', 'already_member']),
});

export interface CreatedInvitation {
  readonly email: string;
  readonly expiresAt: string | null;
  readonly invitationId: string | null;
  readonly outcome: 'created' | 'already_member';
  /**
   * The plaintext bearer token, available on this response only. It is never stored in a readable
   * form and no later read model can return it, so a lost link is replaced by reissuing, which
   * invalidates the previous one.
   */
  readonly token: string | null;
}

export async function createInvitation(
  supabase: AvenlyoSupabaseClient,
  input: {
    readonly email: string;
    readonly locationIds: readonly string[];
    readonly organizationId: string;
    readonly role: 'admin' | 'member';
  },
): Promise<CreatedInvitation> {
  const { data, error } = await teamRpc(supabase)('create_my_organization_invitation', {
    target_email: input.email,
    target_location_ids: [...input.locationIds],
    target_organization_id: input.organizationId,
    target_role: input.role,
  });
  if (error || !data?.[0]) {
    throw new TeamServiceError('invitation');
  }
  const row: OrganizationInvitationRow = invitationRowSchema.parse(data[0]);
  return {
    email: row.email_normalized,
    expiresAt: row.expires_at,
    invitationId: row.invitation_id,
    outcome: row.outcome,
    token: row.invitation_token,
  };
}

const acceptanceRowSchema = z.object({
  organization_id: z.string().uuid().nullable(),
  organization_name: z.string().nullable(),
  membership_role: z.enum(['admin', 'member']).nullable(),
  outcome: z.enum([
    'accepted',
    'already_accepted',
    'already_member',
    'expired',
    'invalid',
    'invalid_scope',
    'revoked',
    'verified_email_required',
    'wrong_account',
  ]),
});

export type InvitationAcceptance = InvitationAcceptanceRow;

export async function acceptInvitation(
  supabase: AvenlyoSupabaseClient,
  token: string,
): Promise<InvitationAcceptance> {
  const { data, error } = await teamRpc(supabase)('accept_my_organization_invitation', {
    target_token: token,
  });
  if (error || !data?.[0]) {
    throw new TeamServiceError('invitation acceptance');
  }
  const accepted: InvitationAcceptance = acceptanceRowSchema.parse(data[0]);
  return accepted;
}

const outcomeRowSchema = z.object({ outcome: z.string() });

async function mutate(
  supabase: AvenlyoSupabaseClient,
  operation: string,
  request: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<string> {
  void supabase;
  const { data, error } = await request;
  if (error || !data?.[0]) {
    throw new TeamServiceError(operation);
  }
  return outcomeRowSchema.parse(data[0]).outcome;
}

export async function revokeInvitation(
  supabase: AvenlyoSupabaseClient,
  invitationId: string,
): Promise<string> {
  return mutate(
    supabase,
    'invitation revocation',
    teamRpc(supabase)('revoke_my_organization_invitation', { target_invitation_id: invitationId }),
  );
}

export async function revokeMember(
  supabase: AvenlyoSupabaseClient,
  membershipId: string,
): Promise<string> {
  return mutate(
    supabase,
    'member revocation',
    teamRpc(supabase)('revoke_my_organization_member', { target_membership_id: membershipId }),
  );
}

export async function updateMemberAccess(
  supabase: AvenlyoSupabaseClient,
  input: {
    readonly locationIds: readonly string[];
    readonly membershipId: string;
    readonly role: 'admin' | 'member';
  },
): Promise<string> {
  return mutate(
    supabase,
    'access update',
    teamRpc(supabase)('update_my_organization_member_access', {
      target_location_ids: [...input.locationIds],
      target_membership_id: input.membershipId,
      target_role: input.role,
    }),
  );
}

import type { MemberRole } from '@avenlyo/database';

/**
 * The presentation half of the permission matrix.
 *
 * These functions decide what a page renders. They are not authorization: every mutation is
 * revalidated in the database against the caller's current role, so a stale page cannot grant
 * anything. Their job is to avoid showing an action that would be refused, and to avoid showing a
 * disabled control for something the viewer can never do.
 */

export type TeamCapability = 'invite_admin' | 'invite_member' | 'manage_admins' | 'manage_members';

export function teamCapabilities(role: MemberRole): readonly TeamCapability[] {
  if (role === 'owner') {
    return ['invite_admin', 'invite_member', 'manage_admins', 'manage_members'];
  }
  // An admin inviting or editing another admin would be self-escalation by proxy.
  if (role === 'admin') {
    return ['invite_member', 'manage_members'];
  }
  return [];
}

export function canInviteRole(role: MemberRole, target: 'admin' | 'member'): boolean {
  const capabilities = teamCapabilities(role);
  return capabilities.includes(target === 'admin' ? 'invite_admin' : 'invite_member');
}

/** Owner is absent from every list: ownership transfer is a separate future workflow. */
export function invitableRoles(role: MemberRole): readonly ('admin' | 'member')[] {
  return (['admin', 'member'] as const).filter((target) => canInviteRole(role, target));
}

export function canManageMember(actorRole: MemberRole, targetRole: MemberRole): boolean {
  if (targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && targetRole === 'member';
}

/** Only an owner may move somebody between admin and member. */
export function canChangeRole(actorRole: MemberRole, targetRole: MemberRole): boolean {
  return actorRole === 'owner' && targetRole !== 'owner';
}

export function canManageTeam(role: MemberRole): boolean {
  return teamCapabilities(role).length > 0;
}

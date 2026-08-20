import { describe, expect, it } from 'vitest';

import {
  canChangeRole,
  canInviteRole,
  canManageMember,
  canManageTeam,
  invitableRoles,
  teamCapabilities,
} from './capabilities';

/**
 * The presentation half of the permission matrix.
 *
 * These decide what is rendered, never what is allowed: the database revalidates every mutation.
 * They are asserted here so the UI does not offer an action that would be refused, and does not
 * show a disabled control for something the viewer can never do.
 */
describe('owner capabilities', () => {
  it('may invite either role and manage both admins and members', () => {
    expect(teamCapabilities('owner')).toEqual([
      'invite_admin',
      'invite_member',
      'manage_admins',
      'manage_members',
    ]);
    expect(invitableRoles('owner')).toEqual(['admin', 'member']);
    expect(canManageMember('owner', 'admin')).toBe(true);
    expect(canManageMember('owner', 'member')).toBe(true);
  });

  it('is the only role that may move somebody between admin and member', () => {
    expect(canChangeRole('owner', 'member')).toBe(true);
    expect(canChangeRole('owner', 'admin')).toBe(true);
    expect(canChangeRole('admin', 'member')).toBe(false);
  });

  it('cannot manage an owner, because ownership transfer is a separate workflow', () => {
    expect(canManageMember('owner', 'owner')).toBe(false);
    expect(canChangeRole('owner', 'owner')).toBe(false);
  });
});

describe('admin capabilities', () => {
  it('may invite and manage members only', () => {
    expect(invitableRoles('admin')).toEqual(['member']);
    expect(canInviteRole('admin', 'member')).toBe(true);
    expect(canManageMember('admin', 'member')).toBe(true);
  });

  it('cannot invite, edit, or revoke another admin', () => {
    // Otherwise an admin could escalate by proxy.
    expect(canInviteRole('admin', 'admin')).toBe(false);
    expect(canManageMember('admin', 'admin')).toBe(false);
    expect(canChangeRole('admin', 'member')).toBe(false);
  });

  it('cannot touch an owner', () => {
    expect(canManageMember('admin', 'owner')).toBe(false);
  });
});

describe('member capabilities', () => {
  it('has no team mutation authority at all', () => {
    expect(teamCapabilities('member')).toEqual([]);
    expect(invitableRoles('member')).toEqual([]);
    expect(canManageTeam('member')).toBe(false);
    expect(canInviteRole('member', 'member')).toBe(false);
    expect(canManageMember('member', 'member')).toBe(false);
  });
});

describe('owner is never an invitation target', () => {
  it('is absent from every invitable role list', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(invitableRoles(role)).not.toContain('owner');
    }
  });
});

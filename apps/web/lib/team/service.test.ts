import { describe, expect, it, vi } from 'vitest';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import { createInvitation, loadTeamOverview } from './service';

/**
 * The team read model.
 *
 * Two properties matter here. The page is one bounded read, not a query per member or per location.
 * And no read model ever carries an invitation secret: the plaintext token exists only in the
 * creation response, and the hash never leaves the database at all.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const SECRET_TOKEN = 'phase15-fixture-secret-invitation-token-do-not-log';

function clientReturning(rows: unknown[]) {
  const rpc = vi.fn(() => Promise.resolve({ data: rows, error: null }));
  return { client: { rpc } as unknown as AvenlyoSupabaseClient, rpc };
}

const memberRow = {
  record_kind: 'member',
  record_id: '44444444-4444-4444-8444-444444444441',
  member_user_id: '55555555-5555-4555-8555-555555555551',
  display_name: 'Dana',
  email: 'dana@example.test',
  role: 'member',
  is_active: true,
  joined_at: '2026-08-01T00:00:00.000Z',
  expires_at: null,
  invitation_state: null,
  location_ids: ['33333333-3333-4333-8333-333333333331'],
  location_names: ['North'],
  active_work_count: 2,
};

const invitationRow = {
  record_kind: 'invitation',
  record_id: '66666666-6666-4666-8666-666666666661',
  member_user_id: null,
  display_name: null,
  email: 'invited@example.test',
  role: 'member',
  is_active: true,
  joined_at: '2026-08-10T00:00:00.000Z',
  expires_at: '2026-08-17T00:00:00.000Z',
  invitation_state: 'pending',
  location_ids: ['33333333-3333-4333-8333-333333333331'],
  location_names: ['North'],
  active_work_count: 0,
};

describe('team overview', () => {
  it('loads members and invitations in a single request', async () => {
    const { client, rpc } = clientReturning([memberRow, invitationRow]);

    const overview = await loadTeamOverview(client, ORG);

    // One call for the whole page: no N+1 across members or locations.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_my_organization_team', {
      target_organization_id: ORG,
    });
    expect(overview.members).toHaveLength(1);
    expect(overview.invitations).toHaveLength(1);
  });

  it('carries location names and a safe active-work count for each member', () => {
    return loadTeamOverview(clientReturning([memberRow]).client, ORG).then((overview) => {
      expect(overview.members[0]?.locationNames).toEqual(['North']);
      // A count only. The Team page must never expose conversation content.
      expect(overview.members[0]?.activeWorkCount).toBe(2);
    });
  });

  it('reports a revoked member as inactive rather than hiding that they existed', async () => {
    const { client } = clientReturning([{ ...memberRow, is_active: false }]);
    const overview = await loadTeamOverview(client, ORG);
    expect(overview.members[0]?.isActive).toBe(false);
  });

  it('never returns a token or token hash for a pending invitation', async () => {
    const { client } = clientReturning([
      { ...invitationRow, token_hash: 'should-not-be-mapped', invitation_token: SECRET_TOKEN },
    ]);

    const overview = await loadTeamOverview(client, ORG);

    // Even if the database somehow returned one, the mapped shape has nowhere to put it.
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('should-not-be-mapped');
  });
});

describe('invitation creation', () => {
  it('returns the one-time token so the link can be built exactly once', async () => {
    const { client } = clientReturning([
      {
        invitation_id: '66666666-6666-4666-8666-666666666661',
        invitation_token: SECRET_TOKEN,
        email_normalized: 'invited@example.test',
        role: 'member',
        expires_at: '2026-08-17T00:00:00.000Z',
        outcome: 'created',
      },
    ]);

    const created = await createInvitation(client, {
      email: 'Invited@Example.TEST',
      locationIds: ['33333333-3333-4333-8333-333333333331'],
      organizationId: ORG,
      role: 'member',
    });

    expect(created.outcome).toBe('created');
    expect(created.token).toBe(SECRET_TOKEN);
    // The database normalizes; the client shows what was actually stored.
    expect(created.email).toBe('invited@example.test');
  });

  it('reports an existing active member without creating a second invitation', async () => {
    const { client } = clientReturning([
      {
        invitation_id: null,
        invitation_token: null,
        email_normalized: 'dana@example.test',
        role: 'member',
        expires_at: null,
        outcome: 'already_member',
      },
    ]);

    const created = await createInvitation(client, {
      email: 'dana@example.test',
      locationIds: ['33333333-3333-4333-8333-333333333331'],
      organizationId: ORG,
      role: 'member',
    });

    expect(created.outcome).toBe('already_member');
    expect(created.token).toBeNull();
  });
});

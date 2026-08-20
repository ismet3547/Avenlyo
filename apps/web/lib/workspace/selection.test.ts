import { describe, expect, it } from 'vitest';

import {
  findSelectedOption,
  hasMultipleWorkspaces,
  isActionableWorkspace,
  parseWorkspaceSelection,
  resolveWorkspace,
  workspaceOptionKey,
  type WorkspaceOption,
} from './selection';

/**
 * Workspace resolution.
 *
 * The rule under test is that a stored selection is never followed on trust: it has to still be in
 * the caller's authorized set, which is exactly what stops a revoked membership or an unassigned
 * location from continuing to work.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const LOCATION_ONE = '33333333-3333-4333-8333-333333333331';
const LOCATION_TWO = '33333333-3333-4333-8333-333333333332';

function option(overrides: Partial<WorkspaceOption> = {}): WorkspaceOption {
  return {
    locationId: LOCATION_ONE,
    locationName: 'North',
    membershipId: '44444444-4444-4444-8444-444444444444',
    onboardingStatus: 'completed',
    onboardingStep: 'completed',
    organizationId: ORG_A,
    organizationName: 'Org A',
    role: 'owner',
    ...overrides,
  };
}

describe('workspace resolution', () => {
  it('sends an account with no membership to onboarding', () => {
    expect(resolveWorkspace([], null)).toEqual({ kind: 'none' });
  });

  it('uses the only completed context without asking anyone to choose', () => {
    // The ordinary owner with one organization and one location must not gain a selector.
    const only = option();
    expect(resolveWorkspace([only], null)).toEqual({ kind: 'resolved', option: only });
  });

  it('sends an owner mid-setup to their persisted onboarding step', () => {
    const incomplete = option({ onboardingStatus: 'in_progress', onboardingStep: 'business' });
    expect(resolveWorkspace([incomplete], null)).toEqual({
      kind: 'onboarding',
      option: incomplete,
    });
  });

  it('asks for a choice when two locations are available', () => {
    const north = option();
    const south = option({ locationId: LOCATION_TWO, locationName: 'South' });
    const resolution = resolveWorkspace([north, south], null);
    expect(resolution.kind).toBe('select');
  });

  it('asks for a choice when two organizations are available', () => {
    // The case that used to throw MultipleWorkspacesError during ordinary dashboard use.
    const owned = option();
    const invited = option({
      membershipId: '55555555-5555-4555-8555-555555555555',
      organizationId: ORG_B,
      organizationName: 'Org B',
      role: 'member',
    });
    const resolution = resolveWorkspace([owned, invited], null);
    expect(resolution.kind).toBe('select');
  });

  it('honours a stored selection that is still authorized', () => {
    const north = option();
    const south = option({ locationId: LOCATION_TWO, locationName: 'South' });
    const resolution = resolveWorkspace([north, south], {
      locationId: LOCATION_TWO,
      organizationId: ORG_A,
    });
    expect(resolution).toEqual({ kind: 'resolved', option: south });
  });

  it('ignores a selection naming an organization the caller cannot reach', () => {
    // A tampered cookie names a real organization that is simply not theirs.
    const north = option();
    const resolution = resolveWorkspace([north], { locationId: null, organizationId: ORG_B });
    expect(resolution).toEqual({ kind: 'resolved', option: north });
  });

  it('re-resolves when the selected membership has been revoked', () => {
    // Revocation removes the context entirely, so nothing matches and nothing is served.
    expect(resolveWorkspace([], { locationId: LOCATION_ONE, organizationId: ORG_A })).toEqual({
      kind: 'none',
    });
  });

  it('re-resolves when the selected location is no longer assigned', () => {
    const remaining = option({ locationId: LOCATION_TWO, locationName: 'South', role: 'member' });
    const resolution = resolveWorkspace([remaining], {
      locationId: LOCATION_ONE,
      organizationId: ORG_A,
    });
    expect(resolution).toEqual({ kind: 'resolved', option: remaining });
  });

  it('offers a switcher only when there is another actionable context', () => {
    expect(hasMultipleWorkspaces([option()])).toBe(false);
    expect(
      hasMultipleWorkspaces([
        option(),
        option({ locationId: LOCATION_TWO, locationName: 'South' }),
      ]),
    ).toBe(true);
    // An unfinished workspace the user owns is somewhere they can go, so it counts.
    expect(
      hasMultipleWorkspaces([option(), option({ onboardingStatus: 'in_progress', role: 'owner' })]),
    ).toBe(true);
    // An unfinished organization somebody was invited into is not, and cannot exist anyway.
    expect(
      hasMultipleWorkspaces([
        option(),
        option({ onboardingStatus: 'in_progress', role: 'member' }),
      ]),
    ).toBe(false);
  });
});

describe('selection keys', () => {
  it('round-trips an organization and location pair', () => {
    const key = workspaceOptionKey({ locationId: LOCATION_ONE, organizationId: ORG_A });
    expect(parseWorkspaceSelection(key)).toEqual({
      locationId: LOCATION_ONE,
      organizationId: ORG_A,
    });
  });

  it('round-trips an organization with no location', () => {
    const key = workspaceOptionKey({ locationId: null, organizationId: ORG_A });
    expect(parseWorkspaceSelection(key)).toEqual({ locationId: null, organizationId: ORG_A });
  });

  it('rejects a malformed or injected cookie value', () => {
    expect(parseWorkspaceSelection(null)).toBeNull();
    expect(parseWorkspaceSelection('')).toBeNull();
    expect(parseWorkspaceSelection('not-a-uuid:also-not')).toBeNull();
    expect(parseWorkspaceSelection(`${ORG_A}:../../etc`)).toBeNull();
    expect(parseWorkspaceSelection(`:${LOCATION_ONE}`)).toBeNull();
    expect(parseWorkspaceSelection(`${ORG_A};drop table users`)).toBeNull();
  });

  it('cannot manufacture access to a location the caller does not hold', () => {
    // A member assigned to one location edits the cookie to name a third.
    const assigned = option({ role: 'member' });
    const forged = parseWorkspaceSelection(`${ORG_A}:${LOCATION_TWO}`);
    expect(findSelectedOption([assigned], forged)).toBeNull();
  });
});

describe('an unfinished workspace stays reachable', () => {
  const completed = option({
    organizationId: ORG_B,
    organizationName: 'Org B',
    role: 'member',
  });
  const inProgressOwner = option({
    locationName: 'Main location',
    onboardingStatus: 'in_progress',
    onboardingStep: 'business',
    organizationName: 'Org A',
    role: 'owner',
  });

  it('offers both when one workspace is finished and another is still being set up', () => {
    // The case that previously stranded a user: they could work in the finished workspace but had
    // no route back to the one they own and had not finished.
    const resolution = resolveWorkspace([completed, inProgressOwner], null);

    expect(resolution.kind).toBe('select');
    if (resolution.kind !== 'select') return;
    expect(resolution.options).toHaveLength(2);
    expect(resolution.options.map((entry) => entry.organizationName).sort()).toEqual([
      'Org A',
      'Org B',
    ]);
  });

  it('routes a selected finished workspace to the dashboard', () => {
    const resolution = resolveWorkspace([completed, inProgressOwner], {
      locationId: completed.locationId,
      organizationId: ORG_B,
    });
    expect(resolution).toEqual({ kind: 'resolved', option: completed });
  });

  it('routes a selected unfinished workspace to its persisted onboarding step', () => {
    // Never into a dashboard, which assumes a finished workspace.
    const resolution = resolveWorkspace([completed, inProgressOwner], {
      locationId: inProgressOwner.locationId,
      organizationId: ORG_A,
    });
    expect(resolution).toEqual({ kind: 'onboarding', option: inProgressOwner });
    if (resolution.kind !== 'onboarding') return;
    expect(resolution.option.onboardingStep).toBe('business');
  });

  it('shows the switcher while working in the finished workspace', () => {
    // Counting only completed contexts hid the switcher and made the unfinished one unreachable.
    expect(hasMultipleWorkspaces([completed, inProgressOwner])).toBe(true);
  });

  it('treats a lone unfinished owner workspace as the destination, with no selector', () => {
    expect(resolveWorkspace([inProgressOwner], null)).toEqual({
      kind: 'onboarding',
      option: inProgressOwner,
    });
    expect(hasMultipleWorkspaces([inProgressOwner])).toBe(false);
  });

  it('does not treat an invited role in an unfinished organization as actionable', () => {
    // Invitations are refused before onboarding completes, so this should not exist; if it somehow
    // does, it is not a place anyone can work.
    const invitedIntoIncomplete = option({
      onboardingStatus: 'in_progress',
      onboardingStep: 'location',
      organizationId: ORG_B,
      role: 'member',
    });
    expect(isActionableWorkspace(invitedIntoIncomplete)).toBe(false);
    expect(resolveWorkspace([completed, invitedIntoIncomplete], null)).toEqual({
      kind: 'resolved',
      option: completed,
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceOption } from '@/lib/workspace/selection';

import { resolveCompletedWorkspaceContext } from './session';
import type { TenantContext } from './types';

/**
 * Pure decision core of `requireCompletedWorkspace`, tested with an injected `loadContext` rather
 * than a real Supabase client -- the same dependency-injection shape `ensureSingleTenantContext`
 * uses for `loadContexts` -- so the security-critical branching (stale selection, revoked
 * membership, unfinished onboarding) is exercised without mocking `next/navigation`'s `redirect()`,
 * which throws and never returns.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const LOCATION_ONE = '33333333-3333-4333-8333-333333333331';

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

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: ORG_A,
    organizationName: 'Org A',
    primaryIndustryId: 'veterinary',
    websiteUrl: null,
    businessPhone: null,
    membershipId: '44444444-4444-4444-8444-444444444444',
    role: 'owner',
    locationId: LOCATION_ONE,
    locationName: 'North',
    locationTimezone: 'UTC',
    locationAddress: {},
    businessHours: null,
    onboardingStatus: 'completed',
    onboardingStep: 'completed',
    onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveCompletedWorkspaceContext', () => {
  it('sends an account with no workspace to onboarding, without calling loadContext', async () => {
    const loadContext = vi.fn();
    const resolution = await resolveCompletedWorkspaceContext([], null, loadContext);
    expect(resolution).toEqual({ kind: 'redirect', to: '/onboarding' });
    expect(loadContext).not.toHaveBeenCalled();
  });

  it('sends an account with more than one actionable option to the selector, without calling loadContext', async () => {
    const loadContext = vi.fn();
    const options = [
      option(),
      option({ organizationId: '22222222-2222-4222-8222-222222222222', organizationName: 'Org B' }),
    ];
    const resolution = await resolveCompletedWorkspaceContext(options, null, loadContext);
    expect(resolution).toEqual({ kind: 'redirect', to: '/workspace/select' });
    expect(loadContext).not.toHaveBeenCalled();
  });

  it('sends a lone unfinished workspace to its onboarding step, without calling loadContext', async () => {
    const loadContext = vi.fn();
    const incomplete = option({ onboardingStatus: 'in_progress', onboardingStep: 'business' });
    const resolution = await resolveCompletedWorkspaceContext([incomplete], null, loadContext);
    expect(resolution).toEqual({ kind: 'redirect', to: '/onboarding/business' });
    expect(loadContext).not.toHaveBeenCalled();
  });

  it('re-verifies the exact selected location before returning it', async () => {
    const selected = option();
    const loaded = context();
    const loadContext = vi.fn().mockResolvedValue(loaded);

    const resolution = await resolveCompletedWorkspaceContext(
      [selected],
      { locationId: LOCATION_ONE, organizationId: ORG_A },
      loadContext,
    );

    expect(resolution).toEqual({ kind: 'context', context: loaded });
    expect(loadContext).toHaveBeenCalledWith(ORG_A, LOCATION_ONE);
    expect(loadContext).toHaveBeenCalledTimes(1);
  });

  it('re-resolves to the selector when the option was authorized a moment ago and is not now', async () => {
    // The option passed the first check; the second, more specific check against the database
    // found nothing. Authorization can lapse between the two, and this must not serve a stale
    // context when it does.
    const selected = option();
    const loadContext = vi.fn().mockResolvedValue(null);

    const resolution = await resolveCompletedWorkspaceContext(
      [selected],
      { locationId: LOCATION_ONE, organizationId: ORG_A },
      loadContext,
    );

    expect(resolution).toEqual({ kind: 'redirect', to: '/workspace/select' });
  });

  it('routes to onboarding when the freshly loaded context is not actually completed', async () => {
    const selected = option();
    const loaded = context({ onboardingStatus: 'in_progress', onboardingStep: 'location' });
    const loadContext = vi.fn().mockResolvedValue(loaded);

    const resolution = await resolveCompletedWorkspaceContext(
      [selected],
      { locationId: LOCATION_ONE, organizationId: ORG_A },
      loadContext,
    );

    expect(resolution).toEqual({ kind: 'redirect', to: '/onboarding/location' });
  });

  it('ignores a stale selection naming an organization the caller no longer holds', async () => {
    // A revoked membership removes the option entirely, so nothing matches the stored cookie and
    // resolution starts again from what the caller can actually reach.
    const only = option();
    const loadContext = vi.fn().mockResolvedValue(context());

    const resolution = await resolveCompletedWorkspaceContext(
      [only],
      { locationId: LOCATION_ONE, organizationId: '22222222-2222-4222-8222-222222222222' },
      loadContext,
    );

    expect(resolution).toEqual({ kind: 'context', context: context() });
    expect(loadContext).toHaveBeenCalledWith(ORG_A, LOCATION_ONE);
  });
});

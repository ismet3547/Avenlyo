import { describe, expect, it, vi } from 'vitest';

import {
  canVisitOnboardingStep,
  ensureSingleTenantContext,
  getOnboardingDestination,
  MultipleWorkspacesError,
  resolveTenantContexts,
} from './routing';
import type { TenantContext } from './types';

const context: TenantContext = {
  organizationId: 'organization-id',
  organizationName: 'North Star',
  primaryIndustryId: 'veterinary',
  websiteUrl: null,
  businessPhone: null,
  membershipId: 'membership-id',
  role: 'owner',
  locationId: 'location-id',
  locationName: 'Main location',
  locationTimezone: 'UTC',
  locationAddress: {},
  businessHours: null,
  onboardingStatus: 'in_progress',
  onboardingStep: 'location',
  onboardingCompletedAt: null,
};

describe('tenant and onboarding routing', () => {
  it('distinguishes zero, one, and multiple tenant memberships', () => {
    expect(resolveTenantContexts([]).kind).toBe('none');
    expect(resolveTenantContexts([context])).toMatchObject({ kind: 'single', context });
    expect(resolveTenantContexts([context, context]).kind).toBe('multiple');
  });

  it('bootstraps once when an authenticated user has no workspace', async () => {
    let bootstrapped = false;
    const load = vi.fn(() => Promise.resolve(bootstrapped ? [context] : []));

    await expect(
      ensureSingleTenantContext(load, () => {
        bootstrapped = true;
        return Promise.resolve();
      }),
    ).resolves.toEqual(context);
    expect(bootstrapped).toBe(true);
  });

  it('resumes at the persisted current step', () => {
    expect(getOnboardingDestination(context)).toBe('/onboarding/location');
    expect(getOnboardingDestination({ ...context, onboardingStatus: 'completed' })).toBe(
      '/dashboard',
    );
  });

  it('allows editing completed steps but prevents skipping ahead', () => {
    expect(canVisitOnboardingStep(context, 'business')).toBe(true);
    expect(canVisitOnboardingStep(context, 'review')).toBe(false);
  });
});

describe('onboarding with more than one workspace', () => {
  const inProgress: TenantContext = { ...context, organizationId: 'org-in-progress', role: 'owner' };
  const completedElsewhere: TenantContext = {
    ...context,
    onboardingCompletedAt: '2026-08-01T00:00:00.000Z',
    onboardingStatus: 'completed',
    onboardingStep: 'completed',
    organizationId: 'org-invited',
    role: 'member',
  };

  it('resolves the workspace still being set up rather than refusing to continue', async () => {
    // Someone who owns an unfinished workspace and has also accepted an invitation elsewhere used
    // to hit MultipleWorkspacesError and could not finish their own onboarding at all.
    const load = vi.fn(() => Promise.resolve([completedElsewhere, inProgress]));

    await expect(
      ensureSingleTenantContext(load, () => Promise.resolve()),
    ).resolves.toEqual(inProgress);
  });

  it('still refuses when every context is finished, because that belongs in the selector', async () => {
    const load = vi.fn(() =>
      Promise.resolve([completedElsewhere, { ...completedElsewhere, organizationId: 'org-two' }]),
    );

    await expect(ensureSingleTenantContext(load, () => Promise.resolve())).rejects.toThrow(
      MultipleWorkspacesError,
    );
  });

  it('does not bootstrap a second workspace for someone who already has one', async () => {
    const bootstrap = vi.fn(() => Promise.resolve());
    const load = vi.fn(() => Promise.resolve([completedElsewhere, inProgress]));

    await ensureSingleTenantContext(load, bootstrap);

    expect(bootstrap).not.toHaveBeenCalled();
  });
});

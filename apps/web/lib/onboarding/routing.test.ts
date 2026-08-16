import { describe, expect, it, vi } from 'vitest';

import {
  canVisitOnboardingStep,
  ensureSingleTenantContext,
  getOnboardingDestination,
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

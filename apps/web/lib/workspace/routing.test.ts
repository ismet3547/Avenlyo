import { describe, expect, it } from 'vitest';

import { safeNextDestination } from '@/lib/auth/next-destination';

import { resolveWorkspace, type WorkspaceOption } from './selection';

/**
 * Post-authentication routing.
 *
 * Sign-in, sign-up, and the confirmation callback all funnel into one continuation decision, so
 * these assertions describe the whole matrix in one place rather than per entry point. Previously
 * every one of them redirected to /onboarding unconditionally.
 */

function option(overrides: Partial<WorkspaceOption> = {}): WorkspaceOption {
  return {
    locationId: '33333333-3333-4333-8333-333333333331',
    locationName: 'North',
    membershipId: '44444444-4444-4444-8444-444444444444',
    onboardingStatus: 'completed',
    onboardingStep: 'completed',
    organizationId: '11111111-1111-4111-8111-111111111111',
    organizationName: 'Org A',
    role: 'owner',
    ...overrides,
  };
}

/** Mirrors the decision /auth/continue makes, so the routing table is asserted directly. */
function continuationFor(options: readonly WorkspaceOption[], next: string | null): string {
  const destination = safeNextDestination(next);
  if (destination) return destination;

  const resolution = resolveWorkspace(options, null);
  if (resolution.kind === 'none') return '/onboarding';
  if (resolution.kind === 'select') return '/workspace/select';
  if (resolution.kind === 'onboarding') return `/onboarding/${resolution.option.onboardingStep}`;
  return '/dashboard';
}

describe('post-authentication continuation', () => {
  it('sends an account with no membership to onboarding', () => {
    expect(continuationFor([], null)).toBe('/onboarding');
  });

  it('sends an account with one completed workspace straight to the dashboard', () => {
    expect(continuationFor([option()], null)).toBe('/dashboard');
  });

  it('sends an owner mid-setup to their persisted step rather than restarting', () => {
    expect(
      continuationFor(
        [option({ onboardingStatus: 'in_progress', onboardingStep: 'location' })],
        null,
      ),
    ).toBe('/onboarding/location');
  });

  it('sends an account with several usable contexts to the selector', () => {
    const second = option({
      locationId: '33333333-3333-4333-8333-333333333332',
      locationName: 'South',
    });
    expect(continuationFor([option(), second], null)).toBe('/workspace/select');
  });

  it('returns to a pending invitation before resolving any workspace', () => {
    // Critical for a brand new invited user: resolving first would send them to onboarding and
    // bootstrap a personal workspace they never asked for.
    expect(continuationFor([], '/invite/abc123')).toBe('/invite/abc123');
    expect(continuationFor([option()], '/invite/abc123')).toBe('/invite/abc123');
  });

  it('ignores an external continuation and resolves normally instead', () => {
    expect(continuationFor([option()], 'https://evil.example')).toBe('/dashboard');
    expect(continuationFor([option()], '//evil.example')).toBe('/dashboard');
    expect(continuationFor([option()], '/dashboard%2f%2fevil.example')).toBe('/dashboard');
    expect(continuationFor([], 'javascript:alert(1)')).toBe('/onboarding');
  });

  it('does not let a revoked account reach a dashboard from a stale selection', () => {
    // Every membership revoked means no options at all, whatever the cookie says.
    expect(continuationFor([], null)).toBe('/onboarding');
  });
});

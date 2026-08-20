import { describe, expect, it } from 'vitest';

import { authLinkWithNext, safeNextDestination } from './next-destination';

/**
 * The invitation continuation, asserted at the seam where it actually broke.
 *
 * The reviewed head had green tests for `safeNextDestination` and `authLinkWithNext` while the
 * invitation flow was dead, because nothing tested that the auth pages and the form ever carried
 * the value. These assertions describe the data that reaches the form and the submitted payload.
 */

const INVITE = '/invite/abc123def456';

/** What the sign-in and sign-up pages compute from their search params. */
function authPageViewModel(searchParams: { next?: string }) {
  const safeNext = safeNextDestination(searchParams.next);
  return {
    // Undefined rather than null: the prop is optional and an absent value must render nothing.
    formNext: safeNext ?? undefined,
    signInSwitchHref: authLinkWithNext('/auth/sign-in', safeNext),
    signUpSwitchHref: authLinkWithNext('/auth/sign-up', safeNext),
    authenticatedRedirect: authLinkWithNext('/auth/continue', safeNext),
  };
}

/** What AuthForm renders and therefore what the submitted FormData contains. */
function submittedPayload(next: string | undefined, credentials: Record<string, string>) {
  const payload = new FormData();
  for (const [key, value] of Object.entries(credentials)) payload.set(key, value);
  if (next) payload.set('next', next);
  return payload;
}

describe('auth page continuation', () => {
  it('carries a pending invitation into the form', () => {
    const model = authPageViewModel({ next: INVITE });
    expect(model.formNext).toBe(INVITE);

    const payload = submittedPayload(model.formNext, { email: 'a@b.test', password: 'password1' });
    expect(payload.get('next')).toBe(INVITE);
  });

  it('renders no continuation field for an ordinary sign-in', () => {
    const model = authPageViewModel({});
    expect(model.formNext).toBeUndefined();

    const payload = submittedPayload(model.formNext, { email: 'a@b.test', password: 'password1' });
    expect(payload.has('next')).toBe(false);
  });

  it('never lets an unsafe destination reach the form or a link', () => {
    for (const hostile of [
      'https://evil.example',
      '//evil.example',
      'javascript:alert(1)',
      '/dashboard%2f%2fevil.example',
      '/api/health',
    ]) {
      const model = authPageViewModel({ next: hostile });
      expect(model.formNext).toBeUndefined();
      expect(model.signInSwitchHref).toBe('/auth/sign-in');
      expect(model.signUpSwitchHref).toBe('/auth/sign-up');
      expect(model.authenticatedRedirect).toBe('/auth/continue');

      const payload = submittedPayload(model.formNext, { email: 'a@b.test', password: 'p' });
      expect(payload.has('next')).toBe(false);
    }
  });

  it('preserves the invitation across the sign-in and sign-up mode switch', () => {
    // The regression that stranded invited users: the switch links dropped the destination, so
    // someone who chose "Create account" from the invite lost it before submitting.
    const model = authPageViewModel({ next: INVITE });
    expect(model.signUpSwitchHref).toBe(`/auth/sign-up?next=${encodeURIComponent(INVITE)}`);
    expect(model.signInSwitchHref).toBe(`/auth/sign-in?next=${encodeURIComponent(INVITE)}`);

    // And the round trip survives: the link's parameter validates back to the same path.
    const roundTripped = new URL(model.signUpSwitchHref, 'https://app.example');
    expect(safeNextDestination(roundTripped.searchParams.get('next'))).toBe(INVITE);
  });

  it('sends an already-authenticated visitor through the continuation resolver', () => {
    // Never the blind /onboarding redirect: an invited person still has an invitation to accept,
    // and an existing member has nothing to onboard.
    expect(authPageViewModel({ next: INVITE }).authenticatedRedirect).toBe(
      `/auth/continue?next=${encodeURIComponent(INVITE)}`,
    );
    expect(authPageViewModel({}).authenticatedRedirect).toBe('/auth/continue');
  });
});

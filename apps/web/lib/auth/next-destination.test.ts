import { describe, expect, it } from 'vitest';

import { authLinkWithNext, safeNextDestination } from './next-destination';

/**
 * The open-redirect boundary.
 *
 * An invitation link travels through sign-in, sign-up, and email confirmation as a `next`
 * parameter, so the value is attacker-controlled by construction. Anything that is not
 * unambiguously a path on this origin has to fail closed.
 */
describe('safe next destination', () => {
  it('accepts the internal destinations authentication needs to return to', () => {
    expect(safeNextDestination('/invite/abc123')).toBe('/invite/abc123');
    expect(safeNextDestination('/dashboard')).toBe('/dashboard');
    expect(safeNextDestination('/dashboard/settings/team')).toBe('/dashboard/settings/team');
    expect(safeNextDestination('/onboarding')).toBe('/onboarding');
    expect(safeNextDestination('/workspace/select')).toBe('/workspace/select');
  });

  it('rejects an absolute external URL', () => {
    expect(safeNextDestination('https://evil.example')).toBeNull();
    expect(safeNextDestination('http://evil.example/dashboard')).toBeNull();
  });

  it('rejects a protocol-relative URL', () => {
    // A path to the browser, an origin to the network stack.
    expect(safeNextDestination('//evil.example')).toBeNull();
    expect(safeNextDestination('//evil.example/dashboard')).toBeNull();
  });

  it('rejects a javascript or data scheme', () => {
    expect(safeNextDestination('javascript:alert(1)')).toBeNull();
    expect(safeNextDestination('/dashboard:javascript:alert(1)')).toBeNull();
    expect(safeNextDestination('data:text/html,<script>')).toBeNull();
  });

  it('rejects backslash separators several browsers treat as slashes', () => {
    expect(safeNextDestination('/\\evil.example')).toBeNull();
    expect(safeNextDestination('\\\\evil.example')).toBeNull();
  });

  it('rejects encoded separators that reappear after decoding', () => {
    expect(safeNextDestination('/%2f%2fevil.example')).toBeNull();
    expect(safeNextDestination('/%5c%5cevil.example')).toBeNull();
    expect(safeNextDestination('/dashboard%3a%2f%2fevil.example')).toBeNull();
  });

  it('rejects control characters and whitespace used to smuggle a second value', () => {
    expect(safeNextDestination('/dashboard\nLocation: https://evil.example')).toBeNull();
    expect(safeNextDestination('/dashboard\u0000')).toBeNull();
    expect(safeNextDestination(' /dashboard evil')).toBeNull();
  });

  it('rejects an internal path that is not a continuation target', () => {
    // Allowlist, not denylist: an unexpected internal path is refused rather than assumed safe.
    expect(safeNextDestination('/api/health')).toBeNull();
    expect(safeNextDestination('/chat/widget')).toBeNull();
    expect(safeNextDestination('/')).toBeNull();
  });

  it('rejects an absent, empty, or oversized value', () => {
    expect(safeNextDestination(null)).toBeNull();
    expect(safeNextDestination(undefined)).toBeNull();
    expect(safeNextDestination('')).toBeNull();
    expect(safeNextDestination(`/dashboard${'a'.repeat(600)}`)).toBeNull();
  });

  it('drops an unsafe destination from an auth link rather than correcting it', () => {
    expect(authLinkWithNext('/auth/sign-in', '/invite/abc')).toBe(
      '/auth/sign-in?next=%2Finvite%2Fabc',
    );
    expect(authLinkWithNext('/auth/sign-in', 'https://evil.example')).toBe('/auth/sign-in');
    expect(authLinkWithNext('/auth/callback', null)).toBe('/auth/callback');
  });
});

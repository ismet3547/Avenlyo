import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_PROOF_HEADER,
  WORKSPACE_PROOF_MAX_AGE_SECONDS,
  signWorkspaceProof,
  verifyWorkspaceProof,
} from './workspace-proof';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const ORGANIZATION_A = '10000000-0000-4000-8000-000000000001';
const ORGANIZATION_B = '20000000-0000-4000-8000-000000000001';
const NOW = 1_800_000_000;

function proofFor(
  organizationId: string,
  userId = USER,
  issuedAtSeconds = NOW,
  secret = SECRET,
): string {
  const proof = signWorkspaceProof(secret, { issuedAtSeconds, organizationId, userId });
  if (!proof) throw new Error('The fixture failed to sign.');
  return proof;
}

function verify(overrides: Partial<Parameters<typeof verifyWorkspaceProof>[0]> = {}): boolean {
  return verifyWorkspaceProof({
    nowSeconds: NOW,
    organizationId: ORGANIZATION_A,
    proof: proofFor(ORGANIZATION_A),
    secret: SECRET,
    userId: USER,
    ...overrides,
  });
}

describe('workspace proof', () => {
  it('accepts a proof for the organization and user it was minted for', () => {
    expect(verify()).toBe(true);
  });

  it('refuses a proof minted for a different organization', () => {
    // The load-bearing case. This user is a legitimate admin of both organizations, so every
    // membership check passes for B; only the proof knows B is not the selected one.
    expect(verify({ organizationId: ORGANIZATION_B, proof: proofFor(ORGANIZATION_A) })).toBe(false);
    expect(verify({ organizationId: ORGANIZATION_A, proof: proofFor(ORGANIZATION_B) })).toBe(false);
  });

  it('refuses a proof minted for a different user', () => {
    expect(verify({ proof: proofFor(ORGANIZATION_A, OTHER_USER) })).toBe(false);
  });

  it('binds the identity the receiver derived, not one a caller could supply', () => {
    // Verification takes the user from the verified bearer token. A proof captured by another
    // authenticated user is worthless because their own identity will not match the signature.
    expect(verify({ userId: OTHER_USER })).toBe(false);
  });

  it('refuses a missing proof', () => {
    expect(verify({ proof: undefined })).toBe(false);
    expect(verify({ proof: null })).toBe(false);
    expect(verify({ proof: '' })).toBe(false);
  });

  it('refuses a malformed proof without throwing', () => {
    for (const proof of [
      'not-a-proof',
      'v1.',
      'v1.abc.' + 'f'.repeat(64),
      'v2.' + NOW + '.' + 'f'.repeat(64),
      'v1.' + NOW + '.' + 'f'.repeat(63),
      'v1.' + NOW + '.' + 'F'.repeat(64),
    ]) {
      expect(verify({ proof })).toBe(false);
    }
  });

  it('refuses a tampered signature', () => {
    const proof = proofFor(ORGANIZATION_A);
    const flipped = proof.slice(0, -1) + (proof.endsWith('0') ? '1' : '0');
    expect(verify({ proof: flipped })).toBe(false);
  });

  it('refuses a proof signed with a different secret', () => {
    expect(verify({ proof: proofFor(ORGANIZATION_A, USER, NOW, OTHER_SECRET) })).toBe(false);
  });

  it('expires, in both directions, so a captured proof stops being useful', () => {
    expect(verify({ nowSeconds: NOW + WORKSPACE_PROOF_MAX_AGE_SECONDS })).toBe(true);
    expect(verify({ nowSeconds: NOW + WORKSPACE_PROOF_MAX_AGE_SECONDS + 1 })).toBe(false);
    expect(verify({ nowSeconds: NOW - WORKSPACE_PROOF_MAX_AGE_SECONDS - 1 })).toBe(false);
  });

  it('fails closed when the secret is absent or too weak to be worth having', () => {
    expect(verify({ secret: undefined })).toBe(false);
    expect(verify({ secret: '' })).toBe(false);
    expect(verify({ secret: 'short' })).toBe(false);
    // Signing refuses on the same terms, so a misconfigured server sends no proof rather than an
    // unsigned value that might be mistaken for one.
    expect(
      signWorkspaceProof(undefined, {
        issuedAtSeconds: NOW,
        organizationId: ORGANIZATION_A,
        userId: USER,
      }),
    ).toBeNull();
    expect(
      signWorkspaceProof('short', {
        issuedAtSeconds: NOW,
        organizationId: ORGANIZATION_A,
        userId: USER,
      }),
    ).toBeNull();
  });

  it('refuses to sign a claim that is not a real identity pair', () => {
    expect(
      signWorkspaceProof(SECRET, {
        issuedAtSeconds: NOW,
        organizationId: 'not-a-uuid',
        userId: USER,
      }),
    ).toBeNull();
    expect(
      signWorkspaceProof(SECRET, {
        issuedAtSeconds: NOW,
        organizationId: ORGANIZATION_A,
        userId: 'nope',
      }),
    ).toBeNull();
    expect(
      signWorkspaceProof(SECRET, {
        issuedAtSeconds: 0,
        organizationId: ORGANIZATION_A,
        userId: USER,
      }),
    ).toBeNull();
  });

  it('never puts either identifier or the secret in the proof it emits', () => {
    const proof = proofFor(ORGANIZATION_A);
    expect(proof).not.toContain(ORGANIZATION_A);
    expect(proof).not.toContain(USER);
    expect(proof).not.toContain(SECRET);
    expect(proof).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
  });

  it('travels in a header, never a query parameter', () => {
    expect(WORKSPACE_PROOF_HEADER).toBe('x-avenlyo-workspace-proof');
  });
});

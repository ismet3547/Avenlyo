import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The trusted server-to-server proof that a billing mutation is acting on the workspace the caller
 * is actually selected into.
 *
 * The problem this solves is narrow and easy to miss. A billing mutation route can verify a bearer
 * token and can verify that the user administers the organization named in the request body, and
 * still be wrong: a user who legitimately administers both A and B passes both checks for B while
 * selected into A. Membership answers "may this person touch that organization at all", which is
 * not the same question as "is that the organization this session is operating in". Only the web
 * server knows the second answer, because only it resolves and revalidates the stored selection.
 *
 * So the selected organization is signed where it is resolved, and verified where it is used. The
 * proof binds three facts together — the acting user, the selected organization, and the moment it
 * was issued — so it cannot be moved to another organization, replayed by another user, or kept.
 * It is an authenticity check on the routing decision, and deliberately not an authorization: the
 * user's own bearer token still travels with the request, and the database still proves owner or
 * admin authority for itself. A valid proof can never make an unauthorized user authorized.
 *
 * This module is a subpath export precisely so it never reaches a browser bundle: nothing here may
 * be imported by client code, and the secret it consumes is server-only.
 */

export const WORKSPACE_PROOF_HEADER = 'x-avenlyo-workspace-proof';

/**
 * How long a proof stays acceptable. It is short because a proof is minted immediately before the
 * request it accompanies; the window only has to cover normal clock skew between two servers, and
 * every second beyond that is a second a captured proof stays useful.
 */
export const WORKSPACE_PROOF_MAX_AGE_SECONDS = 120;

/** Rejects a secret weak enough to be worth guessing, and refuses to sign with one. */
export const WORKSPACE_PROOF_MIN_SECRET_LENGTH = 32;

const PROOF_PATTERN = /^v1\.(\d{1,15})\.([0-9a-f]{64})$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface WorkspaceProofClaim {
  /** Seconds since the epoch, taken by the signing server. */
  readonly issuedAtSeconds: number;
  /** The organization the web server resolved and revalidated for this request. */
  readonly organizationId: string;
  /** The authenticated user the web server resolved the selection for. */
  readonly userId: string;
}

function isUsableSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= WORKSPACE_PROOF_MIN_SECRET_LENGTH;
}

/**
 * The signed message. Fields are newline-separated rather than concatenated so no combination of
 * identifiers can be rearranged into the same bytes as a different combination.
 */
function message(claim: WorkspaceProofClaim): string {
  return ['v1', claim.userId, claim.organizationId, String(claim.issuedAtSeconds)].join('\n');
}

function digest(secret: string, claim: WorkspaceProofClaim): string {
  return createHmac('sha256', secret).update(message(claim), 'utf8').digest('hex');
}

/** Constant-time comparison that also refuses length-mismatched input without throwing. */
function equals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isValidWorkspaceProofClaim(claim: WorkspaceProofClaim): boolean {
  return (
    UUID_PATTERN.test(claim.organizationId) &&
    UUID_PATTERN.test(claim.userId) &&
    Number.isSafeInteger(claim.issuedAtSeconds) &&
    claim.issuedAtSeconds > 0
  );
}

/**
 * Mints a proof for a resolved selection. Returns null rather than an unsigned value when the
 * secret is missing or too weak, so a misconfigured web server cannot produce a request that
 * looks trusted.
 */
export function signWorkspaceProof(
  secret: string | undefined,
  claim: WorkspaceProofClaim,
): string | null {
  if (!isUsableSecret(secret) || !isValidWorkspaceProofClaim(claim)) return null;
  return `v1.${claim.issuedAtSeconds}.${digest(secret, claim)}`;
}

/**
 * Verifies a proof against what the receiving server independently knows.
 *
 * The caller must pass the user identity it derived from the verified bearer token, never one read
 * from the request body, and the organization the request is actually asking to act on. The proof
 * only matches when both agree with what was signed, which is what makes a body-supplied
 * organization unable to travel on a proof minted for a different one.
 */
export function verifyWorkspaceProof(input: {
  readonly nowSeconds: number;
  readonly organizationId: string;
  readonly proof: string | undefined | null;
  readonly secret: string | undefined;
  readonly userId: string;
}): boolean {
  if (!isUsableSecret(input.secret)) return false;
  if (typeof input.proof !== 'string') return false;
  const parsed = PROOF_PATTERN.exec(input.proof);
  if (!parsed) return false;
  const issuedAtSeconds = Number(parsed[1]);
  const claim: WorkspaceProofClaim = {
    issuedAtSeconds,
    organizationId: input.organizationId,
    userId: input.userId,
  };
  if (!isValidWorkspaceProofClaim(claim)) return false;
  // Skew is allowed in both directions: the signing server's clock may be slightly ahead, and
  // rejecting that would fail closed for a legitimate request in a way an operator cannot debug.
  if (Math.abs(input.nowSeconds - issuedAtSeconds) > WORKSPACE_PROOF_MAX_AGE_SECONDS) return false;
  return equals(parsed[2] ?? '', digest(input.secret, claim));
}

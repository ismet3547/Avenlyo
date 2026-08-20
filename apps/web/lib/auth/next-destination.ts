/**
 * Safe internal continuation targets.
 *
 * An invitation link has to survive sign-in, sign-up, and email confirmation, so the destination
 * travels through auth as a `next` parameter. That parameter is attacker-supplied: a phishing page
 * that gets a user to authenticate and then bounces them to an external clone is exactly the attack
 * an open redirect enables.
 *
 * The rule is an allowlist of shapes, not a denylist of tricks. Anything that is not unambiguously
 * a path on this origin is rejected, so a decoding subtlety nobody anticipated fails closed.
 */

export const DEFAULT_CONTINUATION = '/auth/continue';

/** Only these prefixes are ever worth returning to after authentication. */
const ALLOWED_PREFIXES = ['/invite/', '/dashboard', '/onboarding', '/workspace/'] as const;

export function safeNextDestination(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;

  const value = candidate.trim();
  if (value.length === 0 || value.length > 512) return null;

  // Must be a root-relative path. This alone rejects https://evil.example and javascript: URLs.
  if (!value.startsWith('/')) return null;

  // Protocol-relative: //evil.example is a path to the browser and an origin to the network stack.
  if (value.startsWith('//')) return null;

  // Backslash is treated as a separator by several browsers, so /\evil.example can escape origin.
  if (value.includes('\\')) return null;

  // Control characters and whitespace can split or smuggle a header or URL.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;

  // A percent-encoded separator can reintroduce every case above after the browser decodes it.
  // Decoding once and re-checking is not enough, because the result may decode again, so any
  // encoded slash, backslash, or colon is simply refused.
  if (/%2f|%5c|%3a|%00/i.test(value)) return null;

  // Reject anything that parses as absolute against a different base than our own path.
  const path = value.split(/[?#]/)[0] ?? '';
  if (path.includes(':')) return null;

  return ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
    ? value
    : null;
}

/** Builds an auth link that will return to `next` afterwards, dropping an unsafe one. */
export function authLinkWithNext(base: string, next: string | null | undefined): string {
  const safe = safeNextDestination(next);
  return safe ? `${base}?next=${encodeURIComponent(safe)}` : base;
}

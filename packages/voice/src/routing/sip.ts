import { normalizeE164 } from './phone-number';

export interface SipHeader {
  readonly name: string;
  readonly value: string;
}

function values(headers: readonly SipHeader[], name: string): readonly string[] {
  return headers
    .filter((header) => header.name.trim().toLocaleLowerCase('en-US') === name)
    .map((header) => header.value);
}

function extractNumber(value: string): string | null {
  const match = /(?:tel:|sip:)(\+[1-9][0-9]{7,14})(?:@|[;>?\s]|$)/i.exec(value);
  return normalizeE164(match?.[1]);
}

/** Twilio origination routing trusts Diversion, never To/From/custom tenant-looking headers. */
export function extractTwilioDiversionDid(headers: readonly SipHeader[]): string | null {
  for (const diversion of values(headers, 'diversion')) {
    const did = extractNumber(diversion);
    if (did) return did;
  }
  return null;
}

/** Caller identity is optional. Private, anonymous, malformed, and SIP-only identities become null. */
export function extractCallerE164(headers: readonly SipHeader[]): string | null {
  for (const from of values(headers, 'from')) {
    if (/anonymous|private|blocked/i.test(from)) return null;
    const caller = extractNumber(from);
    if (caller) return caller;
  }
  return null;
}

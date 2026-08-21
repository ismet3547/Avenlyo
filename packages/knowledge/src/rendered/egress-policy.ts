import { isIP } from 'node:net';

import {
  isPublicAddress,
  resolveHostname,
  type DnsResolver,
  type ResolvedAddress,
} from '../crawler/dns-policy';
import { CrawlPolicyError } from '../crawler/types';

/**
 * The destination policy every byte a headless browser sends has to pass.
 *
 * A rendered import runs hostile third-party JavaScript, so the browser is treated as an untrusted
 * client that is allowed to ask for a destination and never allowed to reach one. This module
 * answers one question — may this hostname and port be dialled, and at exactly which address — and
 * the proxy that owns the socket is the only thing that acts on the answer.
 *
 * The reason the answer includes the address is the whole point. Validating a hostname and then
 * letting the client resolve it again is not a control: the second lookup can return a different
 * answer, which is DNS rebinding. Resolution and connection therefore have to happen together, in
 * that order, in the same place.
 */

/** Outbound ports a website may legitimately need. Anything else is a different protocol. */
export const allowedEgressPorts: ReadonlySet<number> = new Set([80, 443]);

export interface EgressPolicyOptions {
  /**
   * Which resolved addresses may be dialled. Production always uses `isPublicAddress`; the seam
   * exists so a test can serve a fixture from loopback without production ever accepting it.
   */
  readonly isAddressAllowed?: (address: string) => boolean;
  readonly allowedPorts?: ReadonlySet<number>;
  readonly resolve?: DnsResolver;
}

export interface AuthorizedDestination {
  /** Every address that passed policy, in resolution order. Only these may be dialled. */
  readonly addresses: readonly ResolvedAddress[];
  readonly hostname: string;
  readonly port: number;
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Parses a proxy authority (`host:port`, or a bracketed IPv6 literal) without inventing a default
 * port. A missing or unparseable port is a rejection rather than an assumption.
 */
export function parseEgressAuthority(
  authority: string,
  fallbackPort?: number,
): { readonly hostname: string; readonly port: number } | null {
  const trimmed = authority.trim();
  if (!trimmed || trimmed.length > 300) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(trimmed);
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : fallbackPort;
    return port === undefined ? null : { hostname: `[${bracketed[1] ?? ''}]`, port };
  }
  const parts = trimmed.split(':');
  if (parts.length > 2) return null;
  const hostname = normalizedHostname(parts[0] ?? '');
  const port = parts[1] ? Number(parts[1]) : fallbackPort;
  if (!hostname || port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return { hostname, port };
}

/**
 * Resolves a destination and returns the addresses that may be dialled, or throws.
 *
 * Every returned address is checked, not just the first: a hostname that answers with one public
 * and one private address is rejected outright rather than partially honoured, because accepting
 * it would let an attacker decide which answer the connection uses.
 */
export async function authorizeEgress(
  hostname: string,
  port: number,
  options: EgressPolicyOptions = {},
): Promise<AuthorizedDestination> {
  const allowedPorts = options.allowedPorts ?? allowedEgressPorts;
  const isAllowed = options.isAddressAllowed ?? isPublicAddress;
  const resolve = options.resolve ?? resolveHostname;
  const normalized = normalizedHostname(hostname);

  if (!normalized) {
    throw new CrawlPolicyError('invalid_url', 'The website requested an invalid destination.');
  }
  if (!allowedPorts.has(port)) {
    throw new CrawlPolicyError('invalid_url', 'The website requested a disallowed network port.');
  }

  // An address literal skips DNS entirely, so it is checked directly rather than resolved. This is
  // the path an attacker uses to name 127.0.0.1 or a metadata endpoint outright.
  const literal =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  const literalFamily = isIP(literal);
  if (literalFamily !== 0) {
    if (!isAllowed(literal)) {
      throw new CrawlPolicyError(
        'dns_private_address',
        'The website requested an unsafe network address.',
      );
    }
    return {
      addresses: [{ address: literal, family: literalFamily === 6 ? 6 : 4 }],
      hostname: normalized,
      port,
    };
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolve(normalized);
  } catch {
    throw new CrawlPolicyError('request_failed', 'A website destination could not be resolved.');
  }
  if (addresses.length === 0 || addresses.some((entry) => !isAllowed(entry.address))) {
    throw new CrawlPolicyError(
      'dns_private_address',
      'The website requested an unsafe network address.',
    );
  }
  return { addresses, hostname: normalized, port };
}

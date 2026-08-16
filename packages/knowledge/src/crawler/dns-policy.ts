import { lookup } from 'node:dns/promises';

import ipaddr from 'ipaddr.js';

import { CrawlPolicyError } from './types';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export async function resolveHostname(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
}

/** Only globally routable unicast addresses may be used for outbound crawl connections. */
export function isPublicAddress(value: string): boolean {
  try {
    const parsed = ipaddr.parse(value);
    if (parsed.kind() === 'ipv6') {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) {
        return ipv6.toIPv4Address().range() === 'unicast';
      }
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

export async function resolvePublicAddresses(
  hostname: string,
  resolver: DnsResolver = resolveHostname,
): Promise<readonly ResolvedAddress[]> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new CrawlPolicyError('request_failed', 'The website hostname could not be resolved.');
  }

  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new CrawlPolicyError(
      'dns_private_address',
      'The website resolves to an unsafe network address.',
    );
  }

  return addresses;
}

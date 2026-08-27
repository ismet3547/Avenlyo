import { describe, expect, it } from 'vitest';

import { CrawlPolicyError } from '../crawler/types';
import { allowedEgressPorts, authorizeEgress, parseEgressAuthority } from './egress-policy';

// A genuinely routable unicast address. Documentation ranges such as 203.0.113.0/24 are reserved,
// and the policy correctly refuses them, which would make them a misleading "public" fixture.
const PUBLIC = [{ address: '93.184.216.34', family: 4 as const }];

function resolverFor(addresses: readonly { address: string; family: 4 | 6 }[]) {
  return () => Promise.resolve(addresses);
}

async function decide(hostname: string, port = 443, addresses = PUBLIC) {
  return authorizeEgress(hostname, port, { resolve: resolverFor(addresses) }).catch(
    (error: unknown) => error,
  );
}

/**
 * Production destination policy. Every case here is something a hostile page can ask a headless
 * browser to fetch, so each one is a rejection the proxy has to make before a socket exists.
 */
describe('production egress policy rejects unsafe destinations', () => {
  it.each([
    ['127.0.0.1', 'loopback IPv4 literal'],
    ['[::1]', 'loopback IPv6 literal'],
    ['10.0.0.5', 'RFC1918 10/8'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['172.16.0.1', 'RFC1918 172.16/12'],
    ['169.254.169.254', 'link-local cloud metadata'],
    ['[fe80::1]', 'IPv6 link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'unspecified'],
    ['[fd00::1]', 'IPv6 unique local'],
  ])('refuses the %s address literal (%s)', async (hostname) => {
    const outcome = await decide(hostname);
    expect(outcome).toBeInstanceOf(CrawlPolicyError);
    expect((outcome as CrawlPolicyError).code).toBe('dns_private_address');
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const outcome = await decide('rebind.example', 443, [{ address: '127.0.0.1', family: 4 }]);
    expect((outcome as CrawlPolicyError).code).toBe('dns_private_address');
  });

  it('refuses a hostname that mixes one public and one private answer', async () => {
    // Partially honouring this would let the attacker choose which answer the socket uses.
    const outcome = await decide('rebind.example', 443, [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    expect((outcome as CrawlPolicyError).code).toBe('dns_private_address');
  });

  it('refuses a hostname that resolves to nothing', async () => {
    const outcome = await decide('empty.example', 443, []);
    expect((outcome as CrawlPolicyError).code).toBe('dns_private_address');
  });

  it('reports an unresolvable hostname without leaking the resolver failure', async () => {
    const outcome = await authorizeEgress('missing.example', 443, {
      resolve: () => Promise.reject(new Error('ENOTFOUND missing.example 10.0.0.53')),
    }).catch((error: unknown) => error);
    expect((outcome as CrawlPolicyError).code).toBe('request_failed');
    expect((outcome as CrawlPolicyError).message).not.toMatch(/ENOTFOUND|10\.0\.0\.53/);
  });

  it.each([22, 25, 3306, 5432, 6379, 8080, 9200, 11211])('refuses port %i', async (port) => {
    const outcome = await decide('example.com', port);
    expect((outcome as CrawlPolicyError).code).toBe('invalid_url');
  });

  it('allows only the standard web ports by default', () => {
    expect([...allowedEgressPorts].sort((left, right) => left - right)).toEqual([80, 443]);
  });

  it('accepts a hostname whose every answer is public', async () => {
    await expect(
      authorizeEgress('example.com', 443, { resolve: resolverFor(PUBLIC) }),
    ).resolves.toMatchObject({ addresses: PUBLIC, hostname: 'example.com', port: 443 });
  });

  it('returns the validated addresses so the caller dials one of them and nothing else', async () => {
    const destination = await authorizeEgress('example.com', 443, {
      resolve: resolverFor([
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
      ]),
    });
    expect(destination.addresses.map((entry) => entry.address)).toEqual([
      '93.184.216.34',
      '93.184.216.35',
    ]);
  });

  it('keeps loopback rejected even when a test seam is available', async () => {
    // The seam exists so fixtures can be served locally. Omitting it must never be permissive.
    await expect(
      authorizeEgress('127.0.0.1', 80, { resolve: resolverFor(PUBLIC) }),
    ).rejects.toBeInstanceOf(CrawlPolicyError);
    await expect(
      authorizeEgress('127.0.0.1', 80, {
        isAddressAllowed: (address) => address === '127.0.0.1',
        resolve: resolverFor(PUBLIC),
      }),
    ).resolves.toMatchObject({ hostname: '127.0.0.1' });
  });
});

describe('proxy authority parsing', () => {
  it('parses host and port', () => {
    expect(parseEgressAuthority('example.com:443')).toEqual({
      hostname: 'example.com',
      port: 443,
    });
  });

  it('applies the CONNECT default port only when one is offered', () => {
    expect(parseEgressAuthority('example.com', 443)).toEqual({
      hostname: 'example.com',
      port: 443,
    });
    expect(parseEgressAuthority('example.com')).toBeNull();
  });

  it('parses a bracketed IPv6 authority', () => {
    expect(parseEgressAuthority('[2001:db8::1]:443')).toEqual({
      hostname: '[2001:db8::1]',
      port: 443,
    });
  });

  it.each(['', ':443', 'a:b:c:443', 'example.com:0', 'example.com:70000', 'example.com:notaport'])(
    'refuses the malformed authority %s',
    (authority) => {
      expect(parseEgressAuthority(authority, 443)).toBeNull();
    },
  );

  it('normalises case and a trailing dot so policy cannot be evaded by spelling', () => {
    expect(parseEgressAuthority('EXAMPLE.com.:443')).toEqual({
      hostname: 'example.com',
      port: 443,
    });
  });
});

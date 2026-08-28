import { describe, expect, it } from 'vitest';

import {
  canonicalClientAddress,
  clientRateKey,
  isInternalAddress,
  trustInternalProxy,
  UNRESOLVED_CLIENT_LABEL,
} from './client-identity';

/**
 * The trusted-proxy boundary.
 *
 * The defect these cover: `request.ip` was the socket peer, which behind Caddy is Caddy, so every
 * visitor on the internet shared one abuse-control identity and therefore one durable quota. The
 * repair must recover the real client without ever letting the client choose what that is.
 */

describe('an address is internal only when our own infrastructure could hold it', () => {
  const internal = [
    '127.0.0.1',
    '10.0.0.7',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.10.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.1.2.3',
  ];
  for (const address of internal) {
    it(`treats ${address} as internal`, () => {
      expect(isInternalAddress(address)).toBe(true);
    });
  }

  const external = [
    '203.0.113.9',
    '8.8.8.8',
    '172.32.0.1', // just outside 172.16/12
    '172.15.255.255',
    '192.169.0.1',
    '2001:db8::1',
    '::ffff:203.0.113.9',
    '::',
    'not-an-address',
    '',
  ];
  for (const address of external) {
    it(`treats ${JSON.stringify(address)} as external`, () => {
      expect(isInternalAddress(address)).toBe(false);
    });
  }

  it('rejects an over-long value rather than parsing it', () => {
    expect(isInternalAddress('1'.repeat(200))).toBe(false);
  });
});

describe('trustInternalProxy decides which hop may speak for the client', () => {
  it('trusts the compose-internal peer', () => {
    expect(trustInternalProxy('172.18.0.2')).toBe(true);
  });

  it('never trusts a public peer, whatever hop it claims to be', () => {
    expect(trustInternalProxy('203.0.113.9')).toBe(false);
    expect(trustInternalProxy('8.8.8.8')).toBe(false);
  });
});

describe('addresses are canonical and bounded before becoming keys', () => {
  it('keeps an IPv4 address whole', () => {
    expect(canonicalClientAddress('203.0.113.9')).toBe('203.0.113.9');
  });

  it('unwraps an IPv4-mapped IPv6 address to the IPv4 it means', () => {
    expect(canonicalClientAddress('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('collapses IPv6 to its /64 so one subscriber cannot mint identities', () => {
    // A single customer is routinely handed a whole /64. Keying on the full address would let one
    // client rotate through billions of them and never meet a quota.
    const first = canonicalClientAddress('2001:db8:1:2:3:4:5:6');
    const second = canonicalClientAddress('2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect(first).toBe('2001:0db8:0001:0002::/64');
    expect(second).toBe(first);
  });

  it('canonicalises equivalent IPv6 spellings to the same key', () => {
    expect(canonicalClientAddress('2001:db8::1')).toBe(
      canonicalClientAddress('2001:0db8:0:0:0:0:0:1'),
    );
  });

  it('drops an IPv6 zone index', () => {
    expect(canonicalClientAddress('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
  });

  const malformed: readonly (string | null | undefined)[] = [
    '',
    '   ',
    'nonsense',
    '999.999.999.999',
    '1.2.3',
    'x'.repeat(120),
    null,
    undefined,
  ];
  for (const value of malformed) {
    it(`fails safely on ${JSON.stringify(value)}`, () => {
      expect(canonicalClientAddress(value)).toBeNull();
    });
  }
});

describe('the rate key is opaque and separates scopes', () => {
  const request = (ip: string) => ({ ip }) as never;

  it('never contains the address it was derived from', () => {
    const key = clientRateKey(request('203.0.113.9'), 'web-chat-poll');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113');
  });

  it('gives two different clients two different keys', () => {
    expect(clientRateKey(request('203.0.113.9'), 'p')).not.toBe(
      clientRateKey(request('198.51.100.4'), 'p'),
    );
  });

  it('gives one client different keys per scope, so one quota cannot spend another', () => {
    expect(clientRateKey(request('203.0.113.9'), 'web-chat-poll')).not.toBe(
      clientRateKey(request('203.0.113.9'), 'web-chat-session'),
    );
  });

  it('gives the same client the same key across spellings of its address', () => {
    expect(clientRateKey(request('::ffff:203.0.113.9'), 'p')).toBe(
      clientRateKey(request('203.0.113.9'), 'p'),
    );
  });

  it('buckets an unparseable address under one fixed label rather than an unbounded key', () => {
    const a = clientRateKey(request('nonsense'), 'p');
    const b = clientRateKey(request('also-nonsense'), 'p');
    expect(a).toBe(b);
    expect(UNRESOLVED_CLIENT_LABEL).toBe('unresolved');
  });
});

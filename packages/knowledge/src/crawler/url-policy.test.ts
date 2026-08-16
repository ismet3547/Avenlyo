import { describe, expect, it } from 'vitest';

import { isPublicAddress, resolvePublicAddresses } from './dns-policy';
import { normalizeCrawlUrl } from './url-policy';

describe('website URL and DNS policy', () => {
  it.each([
    'http://localhost',
    'http://service.localhost',
    'http://service.local',
    'http://127.0.0.1',
    'http://10.0.0.1',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://169.254.169.254',
    'http://0.0.0.0',
    'http://[::1]',
    'http://[fc00::1]',
    'http://[fe80::1]',
    'file:///etc/passwd',
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com:8443',
  ])('rejects unsafe import URL %s', (input) => {
    expect(() => normalizeCrawlUrl(input)).toThrow();
  });

  it('normalizes public hostnames, tracking parameters, fragments, and trailing slashes', () => {
    expect(normalizeCrawlUrl('HTTPS://Example.COM/services/?utm_source=ad#team').toString()).toBe(
      'https://example.com/services',
    );
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.0.1',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:192.168.1.1',
  ])('rejects non-public resolved address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('accepts only DNS answers that are all globally routable', async () => {
    await expect(
      resolvePublicAddresses('public.example', () =>
        Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      ),
    ).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
    await expect(
      resolvePublicAddresses('mixed.example', () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.2', family: 4 },
        ]),
      ),
    ).rejects.toThrow('unsafe network address');
  });
});

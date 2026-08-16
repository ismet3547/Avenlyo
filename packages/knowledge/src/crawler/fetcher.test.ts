import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  nodePinnedTransport,
  SecureFetcher,
  type FetchedResponse,
  type PinnedTransport,
} from './fetcher';
import { defaultCrawlLimits } from './types';

function response(
  url: URL,
  statusCode: number,
  headers: IncomingHttpHeaders = {},
): FetchedResponse {
  return { body: '<html><body>ok</body></html>', bytes: 32, headers, statusCode, url };
}

function publicResolver() {
  return () => Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]);
}

describe('secure redirect handling', () => {
  it('revalidates and follows a public HTTP redirect', async () => {
    const requests: string[] = [];
    const transport: PinnedTransport = {
      request(url) {
        requests.push(url.toString());
        return Promise.resolve(
          url.pathname === '/'
            ? response(url, 302, { location: 'https://example.com/final' })
            : response(url, 200, { 'content-type': 'text/html' }),
        );
      },
    };
    const fetcher = new SecureFetcher({
      dnsResolver: publicResolver(),
      limits: defaultCrawlLimits,
      transport,
    });
    await expect(fetcher.fetch('https://example.com')).resolves.toMatchObject({ statusCode: 200 });
    expect(requests).toEqual(['https://example.com/', 'https://example.com/final']);
  });

  it.each(['http://localhost/private', 'http://127.0.0.1/private'])(
    'rejects a redirect to %s',
    async (target) => {
      const transport: PinnedTransport = {
        request(url) {
          return Promise.resolve(response(url, 302, { location: target }));
        },
      };
      const fetcher = new SecureFetcher({
        dnsResolver: publicResolver(),
        limits: defaultCrawlLimits,
        transport,
      });
      await expect(fetcher.fetch('https://example.com')).rejects.toThrow('public DNS hostname');
    },
  );

  it('rejects redirect loops after the configured cap', async () => {
    const transport: PinnedTransport = {
      request(url) {
        return Promise.resolve(response(url, 302, { location: 'https://example.com/again' }));
      },
    };
    const fetcher = new SecureFetcher({
      dnsResolver: publicResolver(),
      limits: { ...defaultCrawlLimits, maxRedirects: 1 },
      transport,
    });
    await expect(fetcher.fetch('https://example.com')).rejects.toThrow('redirected too many times');
  });

  it('enforces an absolute deadline even when a peer continuously sends data', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      const interval = setInterval(() => response.write('x'), 2);
      response.once('close', () => clearInterval(interval));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    try {
      await expect(
        nodePinnedTransport.request(
          // Call the transport directly: production URL policy rejects literals before this layer.
          new URL(`http://127.0.0.1:${address.port}/`),
          { address: '127.0.0.1', family: 4 },
          30,
          1_000_000,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'request_timeout' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

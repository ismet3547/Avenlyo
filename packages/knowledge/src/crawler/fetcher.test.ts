import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { LookupOptions } from 'node:dns';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  nodePinnedTransport,
  pinnedLookup,
  SecureFetcher,
  type FetchedResponse,
  type PinnedTransport,
} from './fetcher';
import { CrawlPolicyError, defaultCrawlLimits } from './types';

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

/**
 * The pinned DNS adapter, and the Node contract it has to satisfy.
 *
 * The previous adapter ignored the lookup options and always answered in the scalar
 * `(address, family)` form. Node 22 asks for `{ hints: 0, all: true }` on its ordinary connection
 * path, and when `all` is set the array argument is the one it reads — so the address arrived as
 * `undefined` and the connection was rejected with `ERR_INVALID_IP_ADDRESS` before a socket existed.
 * Every crawl of a real hostname failed, reported as a generic unreachable site.
 */
describe('pinned DNS lookup contract', () => {
  const pinned = { address: '203.0.113.10', family: 4 } as const;

  function answer(options: LookupOptions): unknown[] {
    const received: unknown[] = [];
    pinnedLookup(pinned)('example.com', options, (...args: unknown[]) => received.push(...args));
    return received;
  }

  it('answers an all:true request with an address array', () => {
    expect(answer({ all: true })).toEqual([null, [{ address: '203.0.113.10', family: 4 }]]);
  });

  it('keeps the scalar form when Node does not ask for all', () => {
    expect(answer({})).toEqual([null, '203.0.113.10', 4]);
    expect(answer({ all: false })).toEqual([null, '203.0.113.10', 4]);
  });

  it('offers only the one address the DNS policy already validated', () => {
    const [, addresses] = answer({ all: true }) as [null, { address: string }[]];
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.address).toBe(pinned.address);
  });

  it('preserves an IPv6 pin and its family', () => {
    const received: unknown[] = [];
    pinnedLookup({ address: '2001:db8::1', family: 6 })(
      'example.com',
      { all: true },
      (...args: unknown[]) => received.push(...args),
    );
    expect(received).toEqual([null, [{ address: '2001:db8::1', family: 6 }]]);
  });
});

describe('real Node transport over the pinned lookup', () => {
  it('asks the lookup for all addresses on its ordinary connection path', async () => {
    // Documents the contract the adapter has to meet. Node only consults a lookup when the host is
    // not an IP literal, which is why a 127.0.0.1 request never exercised this at all.
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const observed: LookupOptions[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        const probe = httpRequest(
          new URL(`http://pinned.invalid:${port}/`),
          {
            lookup: (_hostname, options, callback) => {
              observed.push(options);
              callback(null, [{ address: '127.0.0.1', family: 4 }]);
            },
          },
          (response) => {
            response.resume();
            response.once('end', resolve);
          },
        );
        probe.once('error', reject);
        probe.end();
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(observed).toHaveLength(1);
    expect(observed[0]?.all).toBe(true);
  });

  it('completes a request whose hostname is resolved only by the pin', async () => {
    const requestedHosts: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      requestedHosts.push(request.headers.host);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body>pinned</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      // `.invalid` never resolves, so this can only connect through the pin. Against the previous
      // adapter it fails with request_failed before the socket opens.
      const result = await nodePinnedTransport.request(
        new URL(`http://pinned.invalid:${port}/`),
        { address: '127.0.0.1', family: 4 },
        5_000,
        1_000_000,
        () => undefined,
      );

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('pinned');
      // The pin changes where the socket dials, never who the request claims to be talking to.
      expect(requestedHosts).toEqual([`pinned.invalid:${port}`]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps certificate verification on and bounds a TLS failure', async () => {
    // A plain HTTP listener answering an https: request. The lookup succeeds and the socket opens,
    // so this exercises the layer past the fix, and the operator still learns nothing about the
    // address, the port, or the TLS failure itself.
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end('not tls');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const failure = await nodePinnedTransport
        .request(
          new URL(`https://pinned.invalid:${port}/`),
          { address: '127.0.0.1', family: 4 },
          5_000,
          1_000_000,
          () => undefined,
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CrawlPolicyError);
      const error = failure as CrawlPolicyError;
      expect(error.code).toBe('request_failed');
      expect(error.message).toBe('The website could not be fetched.');
      expect(error.message).not.toContain('127.0.0.1');
      expect(error.message).not.toContain(String(port));
      expect(error.message).not.toMatch(/certificate|SSL|TLS|ENOTFOUND|ECONN/i);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

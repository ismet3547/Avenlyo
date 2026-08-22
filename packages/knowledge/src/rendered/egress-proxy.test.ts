import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { EgressProxy } from './egress-proxy';

/**
 * The egress boundary, exercised by a real client over real sockets.
 *
 * The policy unit tests prove what the rules say. These prove the proxy obeys them when something
 * actually tries to get out, which is the only version of the guarantee that matters: a hostile
 * page does not ask politely, it opens a connection.
 *
 * Fixtures are served from loopback, so a test-only address seam allows 127.0.0.1. Production
 * omits that seam and the last test in this file proves loopback stays refused without it.
 */

const allowLoopback = (address: string) => address === '127.0.0.1';
const openResolver = () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);

let proxy: EgressProxy | undefined;
let origin: Server | undefined;

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  if (origin) {
    const closing = origin;
    origin = undefined;
    // A tunnelled connection can still be open; the fixture must not wait on a hostile peer.
    closing.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closing.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function startOrigin(handler?: (host: string | undefined) => void): Promise<number> {
  origin = createServer((request, response) => {
    handler?.(request.headers.host);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>origin</body></html>');
  });
  await new Promise<void>((resolve) => origin!.listen(0, '127.0.0.1', resolve));
  return (origin.address() as AddressInfo).port;
}

/** Issues an absolute-form proxied HTTP request, the shape a browser sends to a proxy. */
function proxiedGet(proxyPort: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host: 'lying-client.test' },
        host: '127.0.0.1',
        method: 'GET',
        path: target,
        port: proxyPort,
        timeout: 5_000,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        response.once('end', () => resolve({ body, status: response.statusCode ?? 0 }));
      },
    );
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.end();
  });
}

/** Issues a raw CONNECT and reports the proxy's status line without completing any TLS. */
function proxiedConnect(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let received = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(received.split('\r\n')[0] ?? '');
      }
    });
    socket.once('error', reject);
  });
}

describe('proxied HTTP requests', () => {
  it('forwards an allowed destination and preserves the original Host', async () => {
    const hosts: (string | undefined)[] = [];
    const originPort = await startOrigin((host) => hosts.push(host));
    proxy = new EgressProxy({
      allowedPorts: new Set([originPort]),
      isAddressAllowed: allowLoopback,
      resolve: openResolver,
    });
    const proxyPort = await proxy.listen();

    const result = await proxiedGet(proxyPort, `http://fixture.test:${originPort}/page`);

    expect(result.status).toBe(200);
    expect(result.body).toContain('origin');
    // Pinning changes where the socket dials, never who the request claims to be talking to — and
    // the authority comes from the validated request line, so a client that lies in its own Host
    // header cannot describe a different destination to the origin than the one policy approved.
    expect(hosts).toEqual([`fixture.test:${originPort}`]);
  });

  it('refuses a private destination under production address policy', async () => {
    const originPort = await startOrigin();
    // No address seam: this is exactly the production configuration.
    proxy = new EgressProxy({ allowedPorts: new Set([originPort]), resolve: openResolver });
    const proxyPort = await proxy.listen();

    const result = await proxiedGet(proxyPort, `http://fixture.test:${originPort}/page`);

    expect(result.status).toBe(403);
    expect(proxy.rejectionLog()).toEqual([
      { code: 'dns_private_address', hostname: 'fixture.test', port: originPort },
    ]);
  });

  it('refuses a direct request that is not in absolute proxy form', async () => {
    proxy = new EgressProxy({ isAddressAllowed: allowLoopback, resolve: openResolver });
    const proxyPort = await proxy.listen();

    // A relative path means something is talking to the proxy itself rather than through it.
    await expect(proxiedGet(proxyPort, '/internal')).resolves.toMatchObject({ status: 400 });
  });

  it.each(['https', 'ftp', 'file'])(
    'refuses the %s scheme on the plain request path',
    async (scheme) => {
      proxy = new EgressProxy({ isAddressAllowed: allowLoopback, resolve: openResolver });
      const proxyPort = await proxy.listen();

      await expect(proxiedGet(proxyPort, `${scheme}://fixture.test/x`)).resolves.toMatchObject({
        status: 403,
      });
    },
  );
});

describe('proxied CONNECT tunnels', () => {
  it('opens a tunnel to an allowed destination', async () => {
    const originPort = await startOrigin();
    proxy = new EgressProxy({
      allowedPorts: new Set([originPort]),
      isAddressAllowed: allowLoopback,
      resolve: openResolver,
    });
    const proxyPort = await proxy.listen();

    await expect(proxiedConnect(proxyPort, `fixture.test:${originPort}`)).resolves.toContain('200');
  });

  it.each([
    ['127.0.0.1:443', 'loopback literal'],
    ['169.254.169.254:80', 'cloud metadata'],
    ['10.0.0.5:443', 'RFC1918'],
    ['[::1]:443', 'IPv6 loopback'],
  ])('refuses a tunnel to %s (%s)', async (authority) => {
    proxy = new EgressProxy({ resolve: openResolver });
    const proxyPort = await proxy.listen();

    await expect(proxiedConnect(proxyPort, authority)).resolves.toContain('403');
  });

  it('refuses a tunnel to a non-web port even for a public host', async () => {
    proxy = new EgressProxy({ isAddressAllowed: allowLoopback, resolve: openResolver });
    const proxyPort = await proxy.listen();

    await expect(proxiedConnect(proxyPort, 'fixture.test:22')).resolves.toContain('403');
    expect(proxy.rejectionLog()).toEqual([
      { code: 'invalid_url', hostname: 'fixture.test', port: 22 },
    ]);
  });

  it('refuses a tunnel whose hostname resolves to a private address', async () => {
    // The rebinding case: the name looks ordinary and the answer is not.
    proxy = new EgressProxy({
      allowedPorts: new Set([443]),
      resolve: () => Promise.resolve([{ address: '169.254.169.254', family: 4 as const }]),
    });
    const proxyPort = await proxy.listen();

    await expect(proxiedConnect(proxyPort, 'rebind.test:443')).resolves.toContain('403');
  });
});

describe('import-wide egress budgets', () => {
  it('stops accepting requests past the request budget', async () => {
    const originPort = await startOrigin();
    proxy = new EgressProxy({
      allowedPorts: new Set([originPort]),
      isAddressAllowed: allowLoopback,
      limits: { maxOrigins: 10, maxRequests: 2, socketIdleMs: 5_000 },
      resolve: openResolver,
    });
    const proxyPort = await proxy.listen();

    const target = `http://fixture.test:${originPort}/`;
    await expect(proxiedGet(proxyPort, target)).resolves.toMatchObject({ status: 200 });
    await expect(proxiedGet(proxyPort, target)).resolves.toMatchObject({ status: 200 });
    await expect(proxiedGet(proxyPort, target)).resolves.toMatchObject({ status: 403 });
    expect(proxy.stats().requests).toBe(3);
  });

  it('stops accepting new origins past the origin budget', async () => {
    const originPort = await startOrigin();
    proxy = new EgressProxy({
      allowedPorts: new Set([originPort]),
      isAddressAllowed: allowLoopback,
      limits: { maxOrigins: 1, maxRequests: 50, socketIdleMs: 5_000 },
      resolve: openResolver,
    });
    const proxyPort = await proxy.listen();

    await expect(proxiedGet(proxyPort, `http://first.test:${originPort}/`)).resolves.toMatchObject({
      status: 200,
    });
    // The same origin again is fine; a second distinct one is not.
    await expect(
      proxiedGet(proxyPort, `http://first.test:${originPort}/other`),
    ).resolves.toMatchObject({ status: 200 });
    await expect(proxiedGet(proxyPort, `http://second.test:${originPort}/`)).resolves.toMatchObject(
      { status: 403 },
    );
    expect(proxy.stats().origins).toBe(1);
  });

  it('records only bounded destination facts about a refusal', async () => {
    proxy = new EgressProxy({ resolve: openResolver });
    const proxyPort = await proxy.listen();

    await proxiedGet(proxyPort, 'http://blocked.test/secret-path?token=abc123');

    const log = proxy.rejectionLog();
    expect(log).toHaveLength(1);
    expect(Object.keys(log[0]!).sort()).toEqual(['code', 'hostname', 'port']);
    expect(JSON.stringify(log)).not.toMatch(/secret-path|token|abc123/);
  });
});

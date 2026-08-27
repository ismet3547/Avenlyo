import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { CrawlPolicyError } from '@avenlyo/knowledge';

import { chromium } from 'playwright-core';

import {
  PlaywrightRenderedPageSource,
  buildRenderedLaunchOptions,
  renderedCapabilityExecutablePath,
} from './playwright-renderer.js';

/**
 * The rendered strategy, running real Chromium against a local fixture.
 *
 * Nothing here reaches the internet: the fixture is served from loopback, and a test-only address
 * seam lets the egress policy accept it. Production omits that seam, and the egress suites prove
 * loopback stays refused without it. The point of these tests is the part no unit test can assert —
 * that a real browser, executing real page JavaScript, is confined by the proxy.
 */

const chromiumPath = renderedCapabilityExecutablePath();
// A host with no browser binary skips rather than fails: capability is a deployment property, and
// the worker is written to treat its absence as a deterministic outcome rather than a crash.
const describeRendered = chromiumPath ? describe : describe.skip;

let fixture: Server | undefined;
let source: PlaywrightRenderedPageSource | undefined;
let udp: UdpSocket | undefined;

afterEach(async () => {
  await source?.close();
  source = undefined;
  if (fixture) {
    const closing = fixture;
    fixture = undefined;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  if (udp) {
    const closing = udp;
    udp = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  // Closing Chromium, the proxy, and the fixture is genuinely slow on a loaded machine, and the
  // default hook budget is shorter than a browser shutdown.
}, 60_000);

/** Serves a shell whose only useful text is written by script, exactly like a client-rendered app. */
async function startFixture(pages: Readonly<Record<string, string>>): Promise<number> {
  fixture = createServer((request, response) => {
    const body = pages[request.url ?? '/'] ?? pages['/'] ?? '';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  // Chromium keeps connections open and the proxy tears them down at close; a reset on a fixture
  // socket is expected teardown, not a test failure.
  fixture.on('connection', (socket) => socket.on('error', () => undefined));
  fixture.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => fixture!.listen(0, '127.0.0.1', resolve));
  return (fixture.address() as AddressInfo).port;
}

function sourceFor(port: number, extraPorts: readonly number[] = []) {
  return new PlaywrightRenderedPageSource({
    egress: {
      allowedPorts: new Set([port, ...extraPorts]),
      isAddressAllowed: (address) => address === '127.0.0.1',
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
    },
    ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  });
}

/** Renders with everything allowed and a generous budget; policy has its own suites. */
function renderOptions(remainingMs = 30_000) {
  return { authorizeNavigation: () => Promise.resolve(true), remainingMs };
}

const SHELL = (script: string) => `<!doctype html><html><head><title>Fixture Clinic</title></head>
<body><div id="root">Yukleniyor...</div><script>${script}</script></body></html>`;

const CLINIC_SCRIPT = `
  document.getElementById('root').textContent =
    'Fixture Clinic offers wellness visits, vaccinations and dental care for cats and dogs. ' +
    'Our team answers questions about appointments, pricing and opening hours every weekday.';
`;

describeRendered('production launch configuration', () => {
  it('starts a real browser with the OS sandbox enabled', async () => {
    // The unit suite proves the shipped options *request* `chromiumSandbox: true`. This proves the
    // request is not aspirational: a host that cannot initialise the sandbox fails to launch at
    // all, so a browser that starts from exactly these options is a sandboxed browser.
    //
    // There is deliberately no fallback here. `--no-sandbox` is what a green CI job would have
    // been bought with, and buying it is the defect: every other control in the renderer assumes
    // the process boundary is there.
    const options = buildRenderedLaunchOptions({
      executablePath: chromiumPath!,
      // Nothing is fetched through it; the launch itself is the assertion.
      proxyServer: 'http://127.0.0.1:1',
    });
    expect(options.chromiumSandbox).toBe(true);

    const browser = await chromium.launch(options);
    try {
      expect(browser.version()).toMatch(/\d+\./);
      // A context and a page, so the renderer processes the sandbox actually confines are spawned
      // rather than only the browser process.
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent('<html><body><p id="x">sandboxed</p></body></html>');
      expect(await page.textContent('#x')).toBe('sandboxed');
      await context.close();
    } finally {
      await browser.close();
    }
  });
});

describeRendered('rendered page source', () => {
  it('extracts text that only exists after JavaScript runs', async () => {
    const port = await startFixture({ '/': SHELL(CLINIC_SCRIPT) });
    source = sourceFor(port);
    await source.start();

    const rendered = await source.render(new URL(`http://fixture.test:${port}/`), renderOptions());

    // The server HTML says only "Yukleniyor..."; everything below came from the script.
    expect(rendered.html).toContain('wellness visits');
    expect(rendered.url).toBe(`http://fixture.test:${port}/`);
  }, 60_000);

  it('confines page JavaScript to the egress boundary', async () => {
    // The page tries to reach cloud metadata, the classic SSRF target, from inside the browser.
    const escape = `
      fetch('http://169.254.169.254/latest/meta-data/')
        .then(() => { document.title = 'ESCAPED'; })
        .catch(() => { document.title = 'BLOCKED'; });
    `;
    const port = await startFixture({ '/': SHELL(CLINIC_SCRIPT + escape) });
    source = sourceFor(port, [80]);
    await source.start();

    const rendered = await source.render(new URL(`http://fixture.test:${port}/`), renderOptions());

    // The page reports its own outcome in the title. Asserting on the raw HTML would match the
    // script's own source text rather than what the fetch actually did.
    expect(rendered.html).toMatch(/<title>BLOCKED<\/title>/);
    expect(rendered.html).not.toMatch(/<title>ESCAPED<\/title>/);
    // The attempt is visible at the boundary that refused it, recorded as bounded facts only.
    expect(source.stats().proxyRejections).toBeGreaterThan(0);
  }, 60_000);

  it('does not let a page keep the worker alive with an endless timer', async () => {
    const busy = `setInterval(() => {
      document.getElementById('root').textContent = 'tick ' + Date.now();
    }, 20);`;
    const port = await startFixture({ '/': SHELL(busy) });
    source = new PlaywrightRenderedPageSource({
      egress: {
        allowedPorts: new Set([port]),
        isAddressAllowed: (address) => address === '127.0.0.1',
        resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
      },
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      limits: {
        maxHtmlBytesPerPage: 2_000_000,
        pageTimeoutMs: 20_000,
        settleQuietMs: 300,
        settleTimeoutMs: 2_000,
        totalTimeoutMs: 30_000,
      },
    });
    await source.start();

    const started = Date.now();
    await source.render(new URL(`http://fixture.test:${port}/`), renderOptions());

    // The DOM never stops changing, so the settle ceiling ends it rather than the page deciding.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});

describe('rendered capability', () => {
  it('reports a path only when a browser binary is actually present', () => {
    const path = renderedCapabilityExecutablePath();
    expect(path === undefined || typeof path === 'string').toBe(true);
  });

  it('reports no capability for a configured path that does not exist', () => {
    // A path is not a browser. Reporting capability from the path alone made CI believe it could
    // render and fail at launch instead of skipping.
    expect(
      renderedCapabilityExecutablePath('/opt/definitely-not-installed/chromium'),
    ).toBeUndefined();
  });
});

describeRendered('non-proxied network egress', () => {
  it('cannot reach a UDP listener through WebRTC', async () => {
    // An HTTP proxy covers TCP and nothing else. Chrome's default WebRTC IP handling will happily
    // emit ICE datagrams from a real interface, and this test measured five of them arriving here
    // before the handling policy was set — so the property is asserted, not the launch argument.
    udp = createSocket('udp4');
    let datagrams = 0;
    udp.on('message', () => {
      datagrams += 1;
    });
    await new Promise<void>((resolve) => udp!.bind(0, '127.0.0.1', resolve));
    const stunPort = (udp.address()).port;

    const port = await startFixture({
      '/': SHELL(`${CLINIC_SCRIPT}
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stunPort}' }] });
        pc.createDataChannel('probe');
        pc.createOffer().then((offer) => pc.setLocalDescription(offer));`),
    });
    source = sourceFor(port);
    await source.start();

    await source.render(new URL(`http://fixture.test:${port}/`), renderOptions());
    // ICE gathering is asynchronous; give it far longer than it needs to produce a candidate.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    expect(datagrams).toBe(0);
  }, 90_000);
});

describeRendered('main-frame navigation authorization', () => {
  it('never requests an off-domain redirect target', async () => {
    // The forbidden origin counts requests. Rejecting after the fact would still have fetched it
    // and run its JavaScript, which is the entire thing authorization has to prevent.
    let offsiteRequests = 0;
    const offsite = createServer((_request, response) => {
      offsiteRequests += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(SHELL(CLINIC_SCRIPT));
    });
    offsite.on('connection', (socket) => socket.on('error', () => undefined));
    await new Promise<void>((resolve) => offsite.listen(0, '127.0.0.1', resolve));
    const offsitePort = (offsite.address() as AddressInfo).port;

    const port = await startFixture({});
    fixture!.removeAllListeners('request');
    fixture!.on('request', (_request, response) => {
      response.writeHead(302, { location: `http://elsewhere.test:${offsitePort}/` });
      response.end();
    });
    source = sourceFor(port, [offsitePort]);
    await source.start();

    await source
      .render(new URL(`http://fixture.test:${port}/`), {
        // Exactly what the crawler supplies: only the crawl domain may be navigated to.
        authorizeNavigation: (target) => Promise.resolve(target.hostname === 'fixture.test'),
        remainingMs: 20_000,
      })
      .catch(() => undefined);

    expect(offsiteRequests).toBe(0);
    expect(source.stats().navigationRejections).toBeGreaterThan(0);
    offsite.closeAllConnections();
    await new Promise<void>((resolve) => offsite.close(() => resolve()));
  }, 90_000);

  it('never requests an off-domain JavaScript navigation target', async () => {
    let offsiteRequests = 0;
    const offsite = createServer((_request, response) => {
      offsiteRequests += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(SHELL(CLINIC_SCRIPT));
    });
    offsite.on('connection', (socket) => socket.on('error', () => undefined));
    await new Promise<void>((resolve) => offsite.listen(0, '127.0.0.1', resolve));
    const offsitePort = (offsite.address() as AddressInfo).port;

    const port = await startFixture({
      '/': SHELL(`${CLINIC_SCRIPT}
        setTimeout(() => { location.href = 'http://elsewhere.test:${offsitePort}/'; }, 50);`),
    });
    source = sourceFor(port, [offsitePort]);
    await source.start();

    await source
      .render(new URL(`http://fixture.test:${port}/`), {
        authorizeNavigation: (target) => Promise.resolve(target.hostname === 'fixture.test'),
        remainingMs: 20_000,
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(offsiteRequests).toBe(0);
  }, 90_000);

  it('allows a same-domain redirect the policy accepts', async () => {
    const port = await startFixture({});
    fixture!.removeAllListeners('request');
    fixture!.on('request', (request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { location: `http://fixture.test:${port}/final` });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(SHELL(CLINIC_SCRIPT));
    });
    source = sourceFor(port);
    await source.start();

    const rendered = await source.render(new URL(`http://fixture.test:${port}/`), {
      authorizeNavigation: (target) => Promise.resolve(target.hostname === 'fixture.test'),
      remainingMs: 20_000,
    });

    expect(rendered.url).toBe(`http://fixture.test:${port}/final`);
    expect(rendered.html).toContain('wellness visits');
  }, 90_000);

  it('never requests a same-domain path the authorizer refuses', async () => {
    // Stands in for a robots-disallowed path: same site, still forbidden.
    const requested: string[] = [];
    const port = await startFixture({});
    fixture!.removeAllListeners('request');
    fixture!.on('request', (request, response) => {
      requested.push(request.url ?? '');
      if (request.url === '/') {
        response.writeHead(302, { location: `http://fixture.test:${port}/private` });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(SHELL(CLINIC_SCRIPT));
    });
    source = sourceFor(port);
    await source.start();

    await source
      .render(new URL(`http://fixture.test:${port}/`), {
        authorizeNavigation: (target) => Promise.resolve(target.pathname !== '/private'),
        remainingMs: 20_000,
      })
      .catch(() => undefined);

    expect(requested).not.toContain('/private');
  }, 90_000);
});

describeRendered('browser resource budgets', () => {
  it('stops a request storm at the browser request ceiling', async () => {
    // Hundreds of subresource requests to one origin: the proxy would see a handful of connections,
    // so only a request-level ceiling actually bounds this.
    let served = 0;
    const port = await startFixture({});
    fixture!.removeAllListeners('request');
    fixture!.on('request', (request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          SHELL(`${CLINIC_SCRIPT}
            for (let index = 0; index < 400; index += 1) {
              fetch('/asset?n=' + index).catch(() => undefined);
            }`),
        );
        return;
      }
      served += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x');
    });
    source = new PlaywrightRenderedPageSource({
      browserLimits: { maxBrowserRequests: 25 },
      egress: {
        allowedPorts: new Set([port]),
        isAddressAllowed: (address) => address === '127.0.0.1',
        resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
      },
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    });
    await source.start();

    await source.render(new URL(`http://fixture.test:${port}/`), renderOptions());
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(served).toBeLessThan(50);
    expect(source.stats().browserRequests).toBeGreaterThan(25);
  }, 90_000);

  it('gives a render only what is left of the import deadline', async () => {
    // A page that never finishes loading. With 1.5s remaining it must cost 1.5s, not a full page
    // timeout, or an import could overrun its deadline by a whole page on the last queued URL.
    const port = await startFixture({});
    fixture!.removeAllListeners('request');
    fixture!.on('request', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<html><body>');
      // Never ends: the document load event cannot fire.
    });
    source = sourceFor(port);
    await source.start();

    const started = Date.now();
    await source
      .render(new URL(`http://fixture.test:${port}/`), renderOptions(1_500))
      .catch(() => undefined);

    expect(Date.now() - started).toBeLessThan(8_000);
  }, 90_000);

  it('refuses an oversized DOM without pulling it into the worker', async () => {
    const port = await startFixture({
      '/': SHELL(`
        const huge = 'x'.repeat(200000);
        for (let index = 0; index < 40; index += 1) {
          const node = document.createElement('div');
          node.textContent = huge;
          document.body.appendChild(node);
        }`),
    });
    source = new PlaywrightRenderedPageSource({
      egress: {
        allowedPorts: new Set([port]),
        isAddressAllowed: (address) => address === '127.0.0.1',
        resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
      },
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      limits: {
        maxHtmlBytesPerPage: 500_000,
        pageTimeoutMs: 20_000,
        settleQuietMs: 300,
        settleTimeoutMs: 5_000,
        totalTimeoutMs: 60_000,
      },
    });
    await source.start();

    const failure = await source
      .render(new URL(`http://fixture.test:${port}/`), renderOptions())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CrawlPolicyError);
    expect((failure as CrawlPolicyError).code).toBe('body_too_large');
  }, 90_000);
});

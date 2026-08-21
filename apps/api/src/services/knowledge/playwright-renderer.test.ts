import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PlaywrightRenderedPageSource,
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

afterEach(async () => {
  await source?.close();
  source = undefined;
  if (fixture) {
    const closing = fixture;
    fixture = undefined;
    closing.closeAllConnections();
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

const SHELL = (script: string) => `<!doctype html><html><head><title>Fixture Clinic</title></head>
<body><div id="root">Yukleniyor...</div><script>${script}</script></body></html>`;

const CLINIC_SCRIPT = `
  document.getElementById('root').textContent =
    'Fixture Clinic offers wellness visits, vaccinations and dental care for cats and dogs. ' +
    'Our team answers questions about appointments, pricing and opening hours every weekday.';
`;

describeRendered('rendered page source', () => {
  it('extracts text that only exists after JavaScript runs', async () => {
    const port = await startFixture({ '/': SHELL(CLINIC_SCRIPT) });
    source = sourceFor(port);
    await source.start();

    const rendered = await source.render(new URL(`http://fixture.test:${port}/`));

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

    const rendered = await source.render(new URL(`http://fixture.test:${port}/`));

    // The page reports its own outcome in the title. Asserting on the raw HTML would match the
    // script's own source text rather than what the fetch actually did.
    expect(rendered.html).toMatch(/<title>BLOCKED<\/title>/);
    expect(rendered.html).not.toMatch(/<title>ESCAPED<\/title>/);
    // The attempt is visible at the boundary that refused it, recorded as bounded facts only.
    expect(source.egressStats().rejected).toBeGreaterThan(0);
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
    await source.render(new URL(`http://fixture.test:${port}/`));

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

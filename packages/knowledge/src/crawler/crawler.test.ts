import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

import { WebsiteCrawler } from './crawler';
import { SecureFetcher, type FetchedResponse, type PinnedTransport } from './fetcher';
import { defaultCrawlLimits } from './types';

interface FixtureResponse {
  readonly body?: string;
  readonly headers?: IncomingHttpHeaders;
  readonly statusCode: number;
}

function page(
  url: URL,
  body: string,
  headers: IncomingHttpHeaders = { 'content-type': 'text/html' },
): FetchedResponse {
  return { body, bytes: Buffer.byteLength(body), headers, statusCode: 200, url };
}

function testCrawler(
  pages: ReadonlyMap<string, string | FixtureResponse>,
  robotsByOrigin = new Map<string, string>(),
  requests: string[] = [],
): WebsiteCrawler {
  const transport: PinnedTransport = {
    request(url) {
      requests.push(url.toString());
      if (url.pathname === '/robots.txt') {
        return Promise.resolve(
          page(url, robotsByOrigin.get(url.origin) ?? '', { 'content-type': 'text/plain' }),
        );
      }
      const fixture = pages.get(url.toString());
      if (!fixture)
        return Promise.resolve({ body: '', bytes: 0, headers: {}, statusCode: 404, url });
      if (typeof fixture === 'string') return Promise.resolve(page(url, fixture));
      const body = fixture.body ?? '';
      return Promise.resolve({
        body,
        bytes: Buffer.byteLength(body),
        headers: fixture.headers ?? {},
        statusCode: fixture.statusCode,
        url,
      });
    },
  };
  return new WebsiteCrawler({
    fetcher: new SecureFetcher({
      dnsResolver: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      limits: defaultCrawlLimits,
      transport,
    }),
  });
}

describe('website crawler', () => {
  it('extracts useful static HTML and ignores cross-registrable-domain links', async () => {
    const crawler = testCrawler(
      new Map([
        [
          'https://clinic.example/',
          '<html><head><title>Clinic</title></head><body><nav>Noise</nav><main><h1>Care</h1><p>Useful clinic information for customers.</p><a href="/services">Services</a><a href="https://elsewhere.example/about">Elsewhere</a><script>bad()</script></main></body></html>',
        ],
        [
          'https://clinic.example/services',
          '<html><body><article><h2>Services</h2><p>We offer preventive care and appointments.</p></article></body></html>',
        ],
      ]),
    );
    const result = await crawler.crawl('https://clinic.example');
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.content).toContain('# Care');
    expect(result.pages[0]?.content).not.toContain('Noise');
  });

  it('checks robots before fetching a disallowed root HTML page', async () => {
    const requests: string[] = [];
    const crawler = testCrawler(
      new Map([
        [
          'https://clinic.example/',
          '<html><body><p>Useful page content that is long enough.</p></body></html>',
        ],
      ]),
      new Map([['https://clinic.example', 'User-agent: AvenlyoBot\nDisallow: /']]),
      requests,
    );
    await expect(crawler.crawl('https://clinic.example')).rejects.toThrow(
      'does not allow automated crawling',
    );
    expect(requests).toEqual(['https://clinic.example/robots.txt']);
  });

  it('uses a separate robots policy for each crawled origin', async () => {
    const requests: string[] = [];
    const crawler = testCrawler(
      new Map([
        [
          'https://clinic.example/',
          '<main><h1>Clinic</h1><p>Useful clinic information for customers.</p><a href="https://booking.clinic.example/visit">Book</a></main>',
        ],
        [
          'https://booking.clinic.example/visit',
          '<main><h1>Booking</h1><p>Useful booking information for customers.</p></main>',
        ],
      ]),
      new Map([
        ['https://clinic.example', 'User-agent: *\nAllow: /'],
        ['https://booking.clinic.example', 'User-agent: AvenlyoBot\nDisallow: /'],
      ]),
      requests,
    );
    const result = await crawler.crawl('https://clinic.example');
    expect(result.pages).toHaveLength(1);
    expect(requests).toContain('https://booking.clinic.example/robots.txt');
    expect(requests).not.toContain('https://booking.clinic.example/visit');
  });

  it('imports same-domain redirected content', async () => {
    const crawler = testCrawler(
      new Map<string, string | FixtureResponse>([
        [
          'https://clinic.example/',
          '<main><h1>Clinic</h1><p>Useful clinic information for customers.</p><a href="/services">Services</a></main>',
        ],
        [
          'https://clinic.example/services',
          { statusCode: 302, headers: { location: '/final-services' } },
        ],
        [
          'https://clinic.example/final-services',
          '<main><h1>Services</h1><p>Useful service information for customers and their pets.</p></main>',
        ],
      ]),
    );
    const result = await crawler.crawl('https://clinic.example');
    expect(result.pages.map((candidate) => candidate.canonicalUrl)).toContain(
      'https://clinic.example/final-services',
    );
  });

  it('imports same-registrable-domain subdomain redirects', async () => {
    const crawler = testCrawler(
      new Map<string, string | FixtureResponse>([
        [
          'https://clinic.example/',
          '<main><h1>Clinic</h1><p>Useful clinic information for customers.</p><a href="/book">Book</a></main>',
        ],
        [
          'https://clinic.example/book',
          { statusCode: 302, headers: { location: 'https://booking.clinic.example/visit' } },
        ],
        [
          'https://booking.clinic.example/visit',
          '<main><h1>Booking</h1><p>Useful booking information for customers and their pets.</p></main>',
        ],
      ]),
    );
    const result = await crawler.crawl('https://clinic.example');
    expect(result.pages.map((candidate) => candidate.canonicalUrl)).toContain(
      'https://booking.clinic.example/visit',
    );
  });

  it('skips a redirect outside the established registrable domain before its content is fetched', async () => {
    const requests: string[] = [];
    const crawler = testCrawler(
      new Map<string, string | FixtureResponse>([
        [
          'https://clinic.example/',
          '<main><h1>Clinic</h1><p>Useful clinic information for customers.</p><a href="/services">Services</a></main>',
        ],
        [
          'https://clinic.example/services',
          { statusCode: 302, headers: { location: 'https://unrelated.example/services' } },
        ],
        [
          'https://unrelated.example/services',
          '<main><h1>Unrelated</h1><p>This content must never be imported into clinic knowledge.</p></main>',
        ],
      ]),
      new Map(),
      requests,
    );
    const result = await crawler.crawl('https://clinic.example');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.content).not.toContain('must never be imported');
    expect(requests).not.toContain('https://unrelated.example/services');
  });
});

import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

import { WebsiteCrawler } from './crawler';
import { SecureFetcher, type FetchedResponse, type PinnedTransport } from './fetcher';
import { CrawlPolicyError, defaultCrawlLimits, type CrawlLimits } from './types';

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

interface TestCrawlerOptions {
  readonly byteLimits?: number[];
  readonly limits?: CrawlLimits;
}

function testCrawler(
  pages: ReadonlyMap<string, string | FixtureResponse>,
  robotsByOrigin = new Map<string, string>(),
  requests: string[] = [],
  options: TestCrawlerOptions = {},
): WebsiteCrawler {
  const limits = options.limits ?? defaultCrawlLimits;
  const transport: PinnedTransport = {
    request(url, _address, _timeoutMs, maxBytes, onBodyBytes) {
      requests.push(url.toString());
      options.byteLimits?.push(maxBytes);
      let result: FetchedResponse;
      if (url.pathname === '/robots.txt') {
        result = page(url, robotsByOrigin.get(url.origin) ?? '', { 'content-type': 'text/plain' });
      } else {
        const fixture = pages.get(url.toString());
        if (!fixture) result = { body: '', bytes: 0, headers: {}, statusCode: 404, url };
        else if (typeof fixture === 'string') result = page(url, fixture);
        else {
          const body = fixture.body ?? '';
          result = {
            body,
            bytes: Buffer.byteLength(body),
            headers: fixture.headers ?? {},
            statusCode: fixture.statusCode,
            url,
          };
        }
      }
      if (result.bytes > maxBytes) {
        return Promise.reject(
          new CrawlPolicyError('body_too_large', 'The response exceeded its byte allowance.'),
        );
      }
      try {
        onBodyBytes?.(result.bytes);
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error('The response byte accounting failed.'),
        );
      }
    },
  };
  return new WebsiteCrawler({
    fetcher: new SecureFetcher({
      dnsResolver: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      limits,
      transport,
    }),
    limits,
  });
}

function usefulPage(content: string, href?: string, additionalHtml = ''): string {
  return `<main><h1>Business information</h1><p>${content}</p>${
    href ? `<a href="${href}">Learn more</a>` : ''
  }${additionalHtml}</main>`;
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

  it('bounds the queue and counts short content pages toward the logical page-attempt limit', async () => {
    const requests: string[] = [];
    const links = Array.from({ length: 100 }, (_, index) => `/tiny-${index}`);
    const pages = new Map<string, string | FixtureResponse>([
      [
        'https://clinic.example/',
        usefulPage('Useful root content for customers and their pets.', links[0]),
      ],
    ]);
    for (const link of links) {
      pages.set(`https://clinic.example${link}`, '<main><p>Too short</p></main>');
    }
    // Include every link in the root without retaining more than the remaining 19 candidates.
    pages.set(
      'https://clinic.example/',
      usefulPage(
        'Useful root content for customers and their pets.',
        undefined,
        links.map((link) => `<a href="${link}">Tiny</a>`).join(''),
      ),
    );
    const crawler = testCrawler(pages, new Map(), requests, {
      limits: { ...defaultCrawlLimits, maxPages: 20 },
    });

    const result = await crawler.crawl('https://clinic.example');

    expect(requests.filter((request) => !request.endsWith('/robots.txt'))).toHaveLength(20);
    expect(result.pagesDiscovered).toBe(20);
    expect(result.pagesSkipped).toBe(19);
  });

  it('counts failed content-page fetches toward the logical page-attempt limit', async () => {
    const requests: string[] = [];
    const links = Array.from(
      { length: 100 },
      (_, index) => `<a href="/missing-${index}">Missing</a>`,
    ).join('');
    const crawler = testCrawler(
      new Map([
        [
          'https://clinic.example/',
          usefulPage('Useful root content for customers and their pets.', undefined, links),
        ],
      ]),
      new Map(),
      requests,
      { limits: { ...defaultCrawlLimits, maxPages: 20 } },
    );

    const result = await crawler.crawl('https://clinic.example');

    expect(requests.filter((request) => !request.endsWith('/robots.txt'))).toHaveLength(20);
    expect(result.pagesDiscovered).toBe(20);
    expect(result.pagesSkipped).toBe(19);
  });

  it('counts non-HTML pages toward the logical page-attempt limit', async () => {
    const requests: string[] = [];
    const links = Array.from(
      { length: 100 },
      (_, index) => `<a href="/not-html-${index}">Not HTML</a>`,
    ).join('');
    const pages = new Map<string, string | FixtureResponse>([
      [
        'https://clinic.example/',
        usefulPage('Useful root content for customers and their pets.', undefined, links),
      ],
    ]);
    for (let index = 0; index < 100; index += 1) {
      pages.set(`https://clinic.example/not-html-${index}`, {
        body: 'plain text response',
        headers: { 'content-type': 'text/plain' },
        statusCode: 200,
      });
    }
    const crawler = testCrawler(pages, new Map(), requests, {
      limits: { ...defaultCrawlLimits, maxPages: 20 },
    });

    const result = await crawler.crawl('https://clinic.example');

    expect(requests.filter((request) => !request.endsWith('/robots.txt'))).toHaveLength(20);
    expect(result.pagesDiscovered).toBe(20);
    expect(result.pagesSkipped).toBe(19);
  });

  it('caps a final HTML response to the remaining aggregate download allowance', async () => {
    const requests: string[] = [];
    const byteLimits: number[] = [];
    const root = usefulPage('r'.repeat(80), '/final');
    const final = usefulPage('f'.repeat(80));
    const crawler = testCrawler(
      new Map([
        ['https://clinic.example/', root],
        ['https://clinic.example/final', final],
      ]),
      new Map(),
      requests,
      {
        byteLimits,
        limits: {
          ...defaultCrawlLimits,
          maxTotalDownloadBytes: Buffer.byteLength(root) + Buffer.byteLength(final) - 1,
        },
      },
    );

    await expect(crawler.crawl('https://clinic.example')).rejects.toMatchObject({
      code: 'body_too_large',
    });
    expect(byteLimits[requests.indexOf('https://clinic.example/final')]).toBe(
      Buffer.byteLength(final) - 1,
    );
  });

  it('charges redirect bodies before fetching the final HTML response', async () => {
    const requests: string[] = [];
    const byteLimits: number[] = [];
    const root = usefulPage('r'.repeat(80), '/redirect');
    const redirectBody = 'redirect-body'.repeat(5);
    const final = usefulPage('f'.repeat(80));
    const crawler = testCrawler(
      new Map<string, string | FixtureResponse>([
        ['https://clinic.example/', root],
        [
          'https://clinic.example/redirect',
          { body: redirectBody, headers: { location: '/final' }, statusCode: 302 },
        ],
        ['https://clinic.example/final', final],
      ]),
      new Map(),
      requests,
      {
        byteLimits,
        limits: {
          ...defaultCrawlLimits,
          maxTotalDownloadBytes:
            Buffer.byteLength(root) +
            Buffer.byteLength(redirectBody) +
            Buffer.byteLength(final) -
            1,
        },
      },
    );

    await expect(crawler.crawl('https://clinic.example')).rejects.toMatchObject({
      code: 'body_too_large',
    });
    expect(byteLimits[requests.indexOf('https://clinic.example/final')]).toBe(
      Buffer.byteLength(final) - 1,
    );
  });

  it('charges robots.txt against the aggregate download allowance', async () => {
    const root = usefulPage('r'.repeat(80));
    const robots = '# crawler policy\n'.repeat(8);
    const crawler = testCrawler(
      new Map([['https://clinic.example/', root]]),
      new Map([['https://clinic.example', robots]]),
      [],
      {
        limits: {
          ...defaultCrawlLimits,
          maxTotalDownloadBytes: Buffer.byteLength(robots) + Buffer.byteLength(root) - 1,
        },
      },
    );

    await expect(crawler.crawl('https://clinic.example')).rejects.toMatchObject({
      code: 'body_too_large',
    });
  });

  it('completes a crawl when robots, HTML, and linked pages fit within the aggregate budget', async () => {
    const root = usefulPage('r'.repeat(80), '/services');
    const services = usefulPage('s'.repeat(80));
    const robots = 'User-agent: *\nAllow: /\n';
    const crawler = testCrawler(
      new Map([
        ['https://clinic.example/', root],
        ['https://clinic.example/services', services],
      ]),
      new Map([['https://clinic.example', robots]]),
      [],
      {
        limits: {
          ...defaultCrawlLimits,
          maxTotalDownloadBytes:
            Buffer.byteLength(robots) + Buffer.byteLength(root) + Buffer.byteLength(services),
        },
      },
    );

    await expect(crawler.crawl('https://clinic.example')).resolves.toMatchObject({
      pages: expect.arrayContaining([
        expect.objectContaining({ canonicalUrl: 'https://clinic.example/' }),
        expect.objectContaining({ canonicalUrl: 'https://clinic.example/services' }),
      ]),
    });
  });
});

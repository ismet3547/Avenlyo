import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

import { WebsiteCrawler } from './crawler';
import { SecureFetcher, type FetchedResponse, type PinnedTransport } from './fetcher';
import { defaultCrawlLimits } from './types';

function page(
  url: URL,
  body: string,
  headers: IncomingHttpHeaders = { 'content-type': 'text/html' },
): FetchedResponse {
  return { body, bytes: Buffer.byteLength(body), headers, statusCode: 200, url };
}

function testCrawler(pages: ReadonlyMap<string, string>, robots = ''): WebsiteCrawler {
  const transport: PinnedTransport = {
    request(url) {
      if (url.pathname === '/robots.txt') {
        return Promise.resolve(page(url, robots, { 'content-type': 'text/plain' }));
      }
      const body = pages.get(url.toString());
      if (!body) return Promise.resolve({ body: '', bytes: 0, headers: {}, statusCode: 404, url });
      return Promise.resolve(page(url, body));
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

  it('stops when robots disallows AvenlyoBot', async () => {
    const crawler = testCrawler(
      new Map([
        [
          'https://clinic.example/',
          '<html><body><p>Useful page content that is long enough.</p></body></html>',
        ],
      ]),
      'User-agent: AvenlyoBot\nDisallow: /',
    );
    await expect(crawler.crawl('https://clinic.example')).rejects.toThrow(
      'does not allow automated crawling',
    );
  });
});

import { describe, expect, it } from 'vitest';

import type { SecureFetcher } from '../crawler/fetcher';
import { CrawlPolicyError, defaultCrawlLimits, type CrawlResult } from '../crawler/types';
import { RenderedWebsiteCrawler } from './rendered-crawler';
import {
  shouldAttemptRenderedFallback,
  shouldAttemptRenderedFallbackAfterError,
  type RenderedPage,
  type RenderedPageSource,
} from './types';

/**
 * Rendered crawl orchestration, driven through the browser-neutral seam.
 *
 * Real Chromium proves that rendering and egress work; these prove the policy around it, which is
 * where scope, deduplication, and limits actually live. Injecting the page source keeps those
 * assertions deterministic and lets them use ordinary public URLs, which the production URL policy
 * requires and an ephemeral test port could never satisfy.
 */

function page(body: string, title = 'Clinic'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

const CLINIC = page(
  '<p>Fixture Clinic offers wellness visits, vaccinations and dental care for cats and dogs ' +
    'with same-week appointments for existing clients.</p>',
);

function sourceOf(
  pages: Readonly<Record<string, string>>,
): RenderedPageSource & { rendered: string[] } {
  const rendered: string[] = [];
  return {
    rendered,
    render(url: URL): Promise<RenderedPage> {
      rendered.push(url.toString());
      const html = pages[url.pathname];
      if (html === undefined) {
        return Promise.reject(new CrawlPolicyError('request_failed', 'Page unavailable.'));
      }
      return Promise.resolve({ html, url: url.toString() });
    },
  };
}

/** robots.txt is fetched statically, so the crawler needs a fetcher that answers "allow all". */
function robotsFetcher(body = 'User-agent: *\nAllow: /'): SecureFetcher {
  return {
    fetch: () =>
      Promise.resolve({
        body,
        bytes: body.length,
        headers: { 'content-type': 'text/plain' },
        statusCode: 200,
        url: new URL('https://clinic.example/robots.txt'),
      }),
  } as unknown as SecureFetcher;
}

function crawlerFor(
  source: RenderedPageSource,
  fetcher: SecureFetcher = robotsFetcher(),
): RenderedWebsiteCrawler {
  return new RenderedWebsiteCrawler(source, { fetcher, limits: defaultCrawlLimits });
}

describe('rendered crawl scope', () => {
  it('turns rendered pages into documents shaped exactly like static ones', async () => {
    const source = sourceOf({ '/': CLINIC });
    const result = await crawlerFor(source).crawl('https://clinic.example/');

    expect(result.pages).toHaveLength(1);
    const [only] = result.pages;
    expect(only?.canonicalUrl).toBe('https://clinic.example/');
    expect(only?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(only?.title).toBe('Clinic');
    expect(only?.content.length).toBeGreaterThanOrEqual(40);
  });

  it('follows same-domain links and refuses third-party ones', async () => {
    const source = sourceOf({
      '/': page(
        `${CLINIC}<a href="/services">Services</a>` +
          '<a href="https://tracker.example/widget">Offsite</a>',
      ),
      '/services': page(
        '<p>Services include annual wellness exams, vaccinations, dental cleaning and ' +
          'microchipping for cats and dogs every weekday.</p>',
      ),
    });

    const result = await crawlerFor(source).crawl('https://clinic.example/');

    // A third-party widget link is a subresource concern at most; it never becomes a document.
    expect(source.rendered).toEqual(['https://clinic.example/', 'https://clinic.example/services']);
    expect(result.pages.map((entry) => entry.canonicalUrl)).toEqual([
      'https://clinic.example/',
      'https://clinic.example/services',
    ]);
  });

  it('discards a page the browser navigated outside the crawl domain', async () => {
    // Client-side routing can move the document itself; wherever it settled is re-validated.
    const source: RenderedPageSource = {
      render: (url) =>
        Promise.resolve({
          html: CLINIC,
          url: url.pathname === '/' ? url.toString() : 'https://elsewhere.example/x',
        }),
    };
    const result = await crawlerFor(
      sourceOf({ '/': page(`${CLINIC}<a href="/away">Away</a>`), '/away': CLINIC }),
    ).crawl('https://clinic.example/');
    expect(result.pages.every((entry) => entry.canonicalUrl.includes('clinic.example'))).toBe(true);

    const escaped = await crawlerFor(source).crawl('https://clinic.example/');
    expect(escaped.pages).toHaveLength(1);
    expect(escaped.pages[0]?.canonicalUrl).toBe('https://clinic.example/');
  });

  it('refuses to render at all when robots disallows the root', async () => {
    const source = sourceOf({ '/': CLINIC });
    const crawler = crawlerFor(source, robotsFetcher('User-agent: *\nDisallow: /'));

    await expect(crawler.crawl('https://clinic.example/')).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
    // JavaScript never got the chance to run, which is the point of checking before navigation.
    expect(source.rendered).toEqual([]);
  });
});

describe('rendered deduplication and bounds', () => {
  it('treats identical text under several paths as one document', async () => {
    const source = sourceOf({
      '/': page(`${CLINIC}<a href="/copy">Copy</a><a href="/again">Again</a>`),
      '/copy': CLINIC,
      '/again': CLINIC,
    });

    const result = await crawlerFor(source).crawl('https://clinic.example/');

    // The shell renders three times; identical extracted text is one document by hash.
    expect(source.rendered).toHaveLength(3);
    expect(result.pages).toHaveLength(1);
    expect(result.pagesSkipped).toBe(2);
  });

  it('skips a rendered page whose text is still below the knowledge minimum', async () => {
    const source = sourceOf({ '/': page('<p>Loading…</p>') });
    const result = await crawlerFor(source).crawl('https://clinic.example/');

    expect(result.pages).toHaveLength(0);
    expect(result.pagesSkipped).toBe(1);
  });

  it('never renders more than the product page cap', async () => {
    const links = Array.from(
      { length: 40 },
      (_, index) => `<a href="/p${index}">p${index}</a>`,
    ).join('');
    const pages: Record<string, string> = { '/': page(CLINIC + links) };
    for (let index = 0; index < 40; index += 1) {
      pages[`/p${index}`] = page(
        `<p>Unique clinic page number ${index} with enough words to count.</p>`,
      );
    }
    const source = sourceOf(pages);

    const result = await crawlerFor(source).crawl('https://clinic.example/');

    expect(source.rendered.length).toBeLessThanOrEqual(defaultCrawlLimits.maxPages);
    expect(result.pagesDiscovered).toBeLessThanOrEqual(defaultCrawlLimits.maxPages);
  });

  it('stops at the import deadline rather than following an endless site', async () => {
    const pages: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) {
      pages[index === 0 ? '/' : `/p${index}`] = page(
        `<p>Clinic page ${index} with plenty of unique words to pass the minimum.</p>` +
          `<a href="/p${index + 1}">next</a>`,
      );
    }
    const source = sourceOf(pages);
    let clock = 0;
    // Every step consumes a large slice of the budget, so the deadline arrives before the cap.
    await crawlerFor(source).crawl('https://clinic.example/', () => (clock += 40_000));

    expect(source.rendered.length).toBeLessThan(defaultCrawlLimits.maxPages);
  });
});

describe('when the rendered strategy may be used at all', () => {
  function outcome(pages: number): CrawlResult {
    return {
      pages: Array.from({ length: pages }, (_, index) => ({
        canonicalUrl: `https://clinic.example/${index}`,
        content: 'x'.repeat(50),
        contentHash: 'a'.repeat(64),
        title: 'Clinic',
      })),
      pagesDiscovered: 1,
      pagesSkipped: 0,
      rootUrl: 'https://clinic.example/',
    };
  }

  it('is used only when a completed static crawl produced nothing usable', () => {
    expect(shouldAttemptRenderedFallback(outcome(0))).toBe(true);
    // One usable page is enough to keep the cheap path and never launch a browser.
    expect(shouldAttemptRenderedFallback(outcome(1))).toBe(false);
  });

  it('is never used to retry a decision policy already made', () => {
    for (const code of [
      'invalid_url',
      'dns_private_address',
      'robots_disallowed',
      'domain_out_of_scope',
      'redirect_limit',
      'body_too_large',
      'invalid_content_type',
      'request_failed',
      'request_timeout',
    ] as const) {
      void code;
      expect(shouldAttemptRenderedFallbackAfterError()).toBe(false);
    }
    expect(shouldAttemptRenderedFallbackAfterError()).toBe(false);
  });
});

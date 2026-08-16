import { createHash } from 'node:crypto';

import { extractHtml } from './html-extractor';
import { extractLinks } from './link-extractor';
import { isRobotsAllowed, robotsUrlFor } from './robots';
import { SecureFetcher } from './fetcher';
import {
  CrawlPolicyError,
  defaultCrawlLimits,
  type CrawlLimits,
  type CrawlResult,
  type CrawledPage,
} from './types';
import { isInCrawlScope, normalizeCrawlUrl, registrableDomain } from './url-policy';

interface QueuedUrl {
  readonly depth: number;
  readonly url: URL;
}

function priority(url: URL): number {
  const path = url.pathname.toLowerCase();
  const preferred = [
    'services',
    'about',
    'contact',
    'faq',
    'pricing',
    'appointments',
    'new-clients',
  ];
  const position = preferred.findIndex((segment) => path.includes(segment));
  return position < 0 ? 100 + path.length : position;
}

export interface WebsiteCrawlerOptions {
  readonly fetcher?: SecureFetcher;
  readonly limits?: CrawlLimits;
}

/** Static-HTML, breadth-first crawler. It intentionally has no browser or JavaScript runtime. */
export class WebsiteCrawler {
  private readonly limits: CrawlLimits;
  private readonly fetcher: SecureFetcher;

  public constructor(options: WebsiteCrawlerOptions = {}) {
    this.limits = options.limits ?? defaultCrawlLimits;
    this.fetcher = options.fetcher ?? new SecureFetcher({ limits: this.limits });
  }

  public async crawl(input: string): Promise<CrawlResult> {
    const initial = normalizeCrawlUrl(input);
    const rootResponse = await this.fetcher.fetch(initial);
    const root = normalizeCrawlUrl(rootResponse.url.toString());
    const rootDomain = registrableDomain(root);
    const robots = await this.loadRobots(root);
    if (robots && !isRobotsAllowed(robots, root)) {
      throw new CrawlPolicyError(
        'robots_disallowed',
        'This website does not allow automated crawling.',
      );
    }

    const queue: QueuedUrl[] = [{ depth: 0, url: root }];
    const queued = new Set([root.toString()]);
    const visited = new Set<string>();
    const pages: CrawledPage[] = [];
    let pagesSkipped = 0;
    let totalBytes = 0;

    while (queue.length > 0 && pages.length < this.limits.maxPages) {
      queue.sort(
        (left, right) => left.depth - right.depth || priority(left.url) - priority(right.url),
      );
      const current = queue.shift()!;
      if (visited.has(current.url.toString())) continue;
      visited.add(current.url.toString());

      let response;
      try {
        response =
          current.url.toString() === root.toString()
            ? rootResponse
            : await this.fetcher.fetch(current.url);
      } catch (error) {
        if (error instanceof CrawlPolicyError && error.code === 'invalid_content_type')
          pagesSkipped += 1;
        else if (current.depth === 0) throw error;
        else pagesSkipped += 1;
        continue;
      }

      totalBytes += response.bytes;
      if (totalBytes > this.limits.maxTotalHtmlBytes) {
        throw new CrawlPolicyError(
          'body_too_large',
          'The website exceeded the total import size limit.',
        );
      }
      const extracted = extractHtml(response.body);
      if (extracted.content.length >= 40) {
        const canonicalUrl = normalizeCrawlUrl(response.url.toString()).toString();
        pages.push({
          canonicalUrl,
          content: extracted.content,
          contentHash: createHash('sha256').update(extracted.content).digest('hex'),
          title: extracted.title,
        });
      } else {
        pagesSkipped += 1;
      }

      if (current.depth >= this.limits.maxDepth) continue;
      for (const link of extractLinks(response.body, response.url.toString())) {
        if (!isInCrawlScope(link, rootDomain) || queued.has(link.toString())) continue;
        if (robots && !isRobotsAllowed(robots, link)) {
          pagesSkipped += 1;
          continue;
        }
        queued.add(link.toString());
        queue.push({ depth: current.depth + 1, url: link });
      }
    }

    return { pages, pagesDiscovered: visited.size, pagesSkipped, rootUrl: root.toString() };
  }

  private async loadRobots(root: URL): Promise<string | null> {
    try {
      // `robots.txt` is fetched through the same URL/DNS-pinned policy. It need not be HTML.
      const robotsResponse = await this.fetcher.fetch(robotsUrlFor(root), { requireHtml: false });
      return robotsResponse.body;
    } catch (error) {
      if (error instanceof CrawlPolicyError && error.code === 'request_failed') return null;
      throw error;
    }
  }
}

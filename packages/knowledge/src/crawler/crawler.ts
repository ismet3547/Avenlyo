import { createHash } from 'node:crypto';

import { extractHtml } from './html-extractor';
import { extractLinks } from './link-extractor';
import { parseRobots, robotsUrlFor, type RobotsPolicy } from './robots';
import { CrawlDownloadBudget } from './download-budget';
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
  private readonly robotsByOrigin = new Map<string, Promise<RobotsPolicy | null>>();

  public constructor(options: WebsiteCrawlerOptions = {}) {
    this.limits = options.limits ?? defaultCrawlLimits;
    this.fetcher = options.fetcher ?? new SecureFetcher({ limits: this.limits });
  }

  public async crawl(input: string): Promise<CrawlResult> {
    this.robotsByOrigin.clear();
    const initial = normalizeCrawlUrl(input);
    const downloadBudget = new CrawlDownloadBudget(this.limits.maxTotalDownloadBytes);
    // The initial URL is allowed to establish the final root site after safe redirects.
    // Every request in that redirect chain still has its own origin-specific robots check.
    const rootResponse = await this.fetchHtml(initial, undefined, downloadBudget);
    const root = normalizeCrawlUrl(rootResponse.url.toString());
    const rootDomain = registrableDomain(root);

    const queue: QueuedUrl[] = [{ depth: 0, url: root }];
    const queued = new Set([root.toString()]);
    const visited = new Set<string>();
    const pages: CrawledPage[] = [];
    let pagesSkipped = 0;
    // A redirected request remains one logical page attempt. The root request counts as the first.
    let pageAttempts = 1;

    while (queue.length > 0) {
      queue.sort(
        (left, right) => left.depth - right.depth || priority(left.url) - priority(right.url),
      );
      const current = queue.shift()!;
      if (visited.has(current.url.toString())) continue;
      visited.add(current.url.toString());

      let response;
      try {
        if (current.url.toString() === root.toString()) {
          response = rootResponse;
        } else {
          if (pageAttempts >= this.limits.maxPages) break;
          pageAttempts += 1;
          response = await this.fetchHtml(current.url, rootDomain, downloadBudget);
        }
      } catch (error) {
        if (error instanceof CrawlPolicyError && error.code === 'body_too_large') throw error;
        if (error instanceof CrawlPolicyError && error.code === 'invalid_content_type')
          pagesSkipped += 1;
        else if (current.depth === 0) throw error;
        else pagesSkipped += 1;
        continue;
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
        // There is no value in retaining candidates that cannot be attempted under the page cap.
        if (queue.length >= Math.max(0, this.limits.maxPages - pageAttempts)) break;
        if (!isInCrawlScope(link, rootDomain) || queued.has(link.toString())) continue;
        queued.add(link.toString());
        queue.push({ depth: current.depth + 1, url: link });
      }
    }

    return { pages, pagesDiscovered: pageAttempts, pagesSkipped, rootUrl: root.toString() };
  }

  private async fetchHtml(
    candidate: URL,
    rootDomain: string | undefined,
    downloadBudget: CrawlDownloadBudget,
  ) {
    return this.fetcher.fetch(candidate, {
      beforeRequest: async (target) => {
        if (rootDomain && !isInCrawlScope(target, rootDomain)) {
          throw new CrawlPolicyError(
            'domain_out_of_scope',
            'The website redirected outside its allowed domain.',
          );
        }
        await this.assertRobotsAllowed(target, downloadBudget);
      },
      downloadBudget,
    });
  }

  private async assertRobotsAllowed(
    candidate: URL,
    downloadBudget: CrawlDownloadBudget,
  ): Promise<void> {
    const policy = await this.loadRobots(candidate, downloadBudget);
    if (policy && !policy.isAllowed(candidate)) {
      throw new CrawlPolicyError(
        'robots_disallowed',
        'This website does not allow automated crawling.',
      );
    }
  }

  private async loadRobots(
    candidate: URL,
    downloadBudget: CrawlDownloadBudget,
  ): Promise<RobotsPolicy | null> {
    const origin = candidate.origin;
    const cached = this.robotsByOrigin.get(origin);
    if (cached) return cached;
    const policy = this.fetchRobots(candidate, downloadBudget);
    this.robotsByOrigin.set(origin, policy);
    return policy;
  }

  private async fetchRobots(
    candidate: URL,
    downloadBudget: CrawlDownloadBudget,
  ): Promise<RobotsPolicy | null> {
    try {
      // `robots.txt` is fetched through the same URL/DNS-pinned policy. It need not be HTML.
      const robotsUrl = robotsUrlFor(candidate);
      const robotsResponse = await this.fetcher.fetch(robotsUrl, {
        downloadBudget,
        requireHtml: false,
      });
      return parseRobots(robotsUrl, robotsResponse.body);
    } catch (error) {
      if (error instanceof CrawlPolicyError && error.code === 'request_failed') return null;
      throw error;
    }
  }
}

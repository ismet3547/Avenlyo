import { createHash } from 'node:crypto';

import { CrawlDownloadBudget } from '../crawler/download-budget';
import { SecureFetcher } from '../crawler/fetcher';
import { extractHtml } from '../crawler/html-extractor';
import { extractLinks } from '../crawler/link-extractor';
import { parseRobots, robotsUrlFor, type RobotsPolicy } from '../crawler/robots';
import {
  CrawlPolicyError,
  defaultCrawlLimits,
  type CrawlLimits,
  type CrawlResult,
  type CrawledPage,
} from '../crawler/types';
import { isInCrawlScope, normalizeCrawlUrl, registrableDomain } from '../crawler/url-policy';
import {
  defaultRenderedCrawlLimits,
  type RenderedCrawlLimits,
  type RenderedPageSource,
} from './types';

/**
 * The rendered crawl, expressed in exactly the same policy vocabulary as the static one.
 *
 * Only the way a page's HTML is obtained changes. Robots is still consulted before every top-level
 * navigation, crawl scope is still the root registrable domain, extraction and hashing are still
 * the shared functions, and the page cap is still the same number — so a rendered import produces
 * documents indistinguishable from static ones and cannot reach anywhere a static crawl could not.
 *
 * Robots itself is deliberately fetched statically. `robots.txt` is not a JavaScript document, and
 * asking a browser for it would put the file that grants permission behind the engine it governs.
 */
export class RenderedWebsiteCrawler {
  private readonly limits: CrawlLimits;
  private readonly renderedLimits: RenderedCrawlLimits;
  private readonly fetcher: SecureFetcher;
  private readonly robotsByOrigin = new Map<string, Promise<RobotsPolicy | null>>();

  public constructor(
    private readonly source: RenderedPageSource,
    options: {
      readonly fetcher?: SecureFetcher;
      readonly limits?: CrawlLimits;
      readonly renderedLimits?: RenderedCrawlLimits;
    } = {},
  ) {
    this.limits = options.limits ?? defaultCrawlLimits;
    this.renderedLimits = options.renderedLimits ?? defaultRenderedCrawlLimits;
    this.fetcher = options.fetcher ?? new SecureFetcher({ limits: this.limits });
  }

  public async crawl(input: string, now: () => number = Date.now): Promise<CrawlResult> {
    this.robotsByOrigin.clear();
    const deadline = now() + this.renderedLimits.totalTimeoutMs;
    const robotsBudget = new CrawlDownloadBudget(this.limits.maxTotalDownloadBytes);
    const root = normalizeCrawlUrl(input);
    const rootDomain = registrableDomain(root);

    const queue: { depth: number; url: URL }[] = [{ depth: 0, url: root }];
    const queued = new Set([root.toString()]);
    const visited = new Set<string>();
    const seenContent = new Set<string>();
    const pages: CrawledPage[] = [];
    let pagesSkipped = 0;
    let pageAttempts = 0;

    while (queue.length > 0) {
      // The import-wide deadline outranks the queue: a site that keeps producing links must not be
      // able to keep a worker busy past its budget.
      if (now() >= deadline) break;
      const current = queue.shift()!;
      const key = current.url.toString();
      if (visited.has(key)) continue;
      visited.add(key);
      if (pageAttempts >= this.limits.maxPages) break;
      pageAttempts += 1;

      let html: string;
      let settledUrl: URL;
      try {
        await this.assertRobotsAllowed(current.url, robotsBudget);
        const rendered = await this.source.render(current.url, {
          // Every top-level document request the browser makes is decided here, before it is sent.
          // Checking only where the browser ended up would mean an off-domain or robots-disallowed
          // target had already been fetched and its JavaScript executed.
          authorizeNavigation: (target) =>
            this.isNavigationAllowed(target, rootDomain, robotsBudget),
          // A render may use only what is left of the import, never a fresh page timeout.
          remainingMs: deadline - now(),
        });
        // The settled URL is re-validated too. Authorization stops the request; this stops a page
        // that reached an allowed URL by some path the crawl should not record.
        settledUrl = normalizeCrawlUrl(rendered.url);
        if (!isInCrawlScope(settledUrl, rootDomain)) {
          pagesSkipped += 1;
          continue;
        }
        if (rendered.html.length > this.renderedLimits.maxHtmlBytesPerPage) {
          pagesSkipped += 1;
          continue;
        }
        html = rendered.html;
      } catch (error) {
        // The root is the caller's own URL, so a decision about it is the import's answer. A
        // failure deeper in the crawl only costs that page.
        if (current.depth === 0 && error instanceof CrawlPolicyError) throw error;
        pagesSkipped += 1;
        continue;
      }

      const extracted = extractHtml(html);
      const canonicalUrl = settledUrl.toString();
      const contentHash = createHash('sha256').update(extracted.content).digest('hex');
      if (extracted.content.length < 40 || seenContent.has(contentHash)) {
        // Client-side routing routinely renders the same shell under several paths; identical text
        // is one document, and the hash decides that deterministically.
        pagesSkipped += 1;
      } else {
        seenContent.add(contentHash);
        pages.push({
          canonicalUrl,
          content: extracted.content,
          contentHash,
          title: extracted.title,
        });
      }
      visited.add(canonicalUrl);

      if (current.depth >= this.limits.maxDepth) continue;
      for (const link of extractLinks(html, canonicalUrl)) {
        if (queue.length >= Math.max(0, this.limits.maxPages - pageAttempts)) break;
        // Third-party widgets inject links constantly. A new crawled document must stay inside the
        // website's own registrable domain, whatever a subresource origin was allowed to be.
        if (!isInCrawlScope(link, rootDomain) || queued.has(link.toString())) continue;
        queued.add(link.toString());
        queue.push({ depth: current.depth + 1, url: link });
      }
    }

    return { pages, pagesDiscovered: pageAttempts, pagesSkipped, rootUrl: root.toString() };
  }

  /**
   * The pre-navigation decision: scheme, crawl scope, and robots for the exact target.
   *
   * It answers rather than throws, because it runs inside the browser's request path and a refusal
   * there is an aborted request, not an import failure.
   */
  private async isNavigationAllowed(
    target: URL,
    rootDomain: string,
    robotsBudget: CrawlDownloadBudget,
  ): Promise<boolean> {
    try {
      const normalized = normalizeCrawlUrl(target.toString());
      if (!isInCrawlScope(normalized, rootDomain)) return false;
      await this.assertRobotsAllowed(normalized, robotsBudget);
      return true;
    } catch {
      return false;
    }
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
    const cached = this.robotsByOrigin.get(candidate.origin);
    if (cached) return cached;
    const policy = this.fetchRobots(candidate, downloadBudget);
    this.robotsByOrigin.set(candidate.origin, policy);
    return policy;
  }

  private async fetchRobots(
    candidate: URL,
    downloadBudget: CrawlDownloadBudget,
  ): Promise<RobotsPolicy | null> {
    try {
      const robotsUrl = robotsUrlFor(candidate);
      const response = await this.fetcher.fetch(robotsUrl, { downloadBudget, requireHtml: false });
      return parseRobots(robotsUrl, response.body);
    } catch (error) {
      if (error instanceof CrawlPolicyError && error.code === 'request_failed') return null;
      throw error;
    }
  }
}

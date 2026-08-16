export interface CrawlLimits {
  readonly maxDepth: number;
  readonly maxHtmlBytesPerPage: number;
  readonly maxPages: number;
  readonly maxRedirects: number;
  /** Aggregate response-body limit for HTML pages, redirects, and robots.txt. */
  readonly maxTotalDownloadBytes: number;
  readonly requestTimeoutMs: number;
}

export const defaultCrawlLimits: CrawlLimits = {
  maxDepth: 2,
  maxHtmlBytesPerPage: 1_000_000,
  maxPages: 20,
  maxRedirects: 5,
  maxTotalDownloadBytes: 5_000_000,
  requestTimeoutMs: 8_000,
};

export interface CrawledPage {
  readonly canonicalUrl: string;
  readonly content: string;
  readonly contentHash: string;
  readonly title: string;
}

export interface CrawlResult {
  readonly pages: readonly CrawledPage[];
  readonly pagesDiscovered: number;
  readonly pagesSkipped: number;
  readonly rootUrl: string;
}

export class CrawlPolicyError extends Error {
  public constructor(
    public readonly code:
      | 'body_too_large'
      | 'dns_private_address'
      | 'domain_out_of_scope'
      | 'invalid_content_type'
      | 'invalid_url'
      | 'redirect_limit'
      | 'robots_disallowed'
      | 'request_failed'
      | 'request_timeout',
    message: string,
  ) {
    super(message);
    this.name = 'CrawlPolicyError';
  }
}

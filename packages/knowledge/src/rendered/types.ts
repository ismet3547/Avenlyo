import type { CrawlResult } from '../crawler/types';
import { CrawlPolicyError } from '../crawler/types';

/**
 * The browser-neutral seam between crawl orchestration and whatever actually renders a page.
 *
 * The orchestration in this package knows about robots, crawl scope, extraction, and limits. It
 * knows nothing about Chromium, which is why the web application never has to carry a browser: the
 * concrete renderer lives in the trusted worker runtime and is injected here.
 */

export interface RenderedPage {
  readonly html: string;
  /** The URL the document settled on, after any in-browser navigation the policy allowed. */
  readonly url: string;
}

/**
 * Decides whether one main-frame document navigation may happen, before the network is touched.
 *
 * Checking where the browser ended up is too late: by then the target has already been fetched and
 * its JavaScript executed, which is the whole thing an off-domain or robots-disallowed navigation
 * needed to be prevented from doing. The renderer therefore asks this before continuing any
 * top-level document request, including redirects, so a refused target is never requested at all.
 *
 * This is a policy decision, not the network boundary. DNS resolution and address pinning remain
 * the proxy's job; interception here can never be a substitute for them.
 */
export type MainNavigationAuthorizer = (target: URL) => Promise<boolean>;

export interface RenderOptions {
  /** Consulted before every top-level document request the browser makes. */
  readonly authorizeNavigation: MainNavigationAuthorizer;
  /** All the time this render may use, taken from what is left of the import deadline. */
  readonly remainingMs: number;
}

export interface RenderedPageSource {
  /** Renders one URL that crawl policy has already accepted, and returns its settled DOM. */
  render(url: URL, options: RenderOptions): Promise<RenderedPage>;
}

export interface RenderedCrawlLimits {
  /** Wall-clock ceiling for one page, covering navigation and settle together. */
  readonly pageTimeoutMs: number;
  /** How long the DOM may keep changing before extraction happens anyway. */
  readonly settleTimeoutMs: number;
  /** Quiet period that ends the settle early when the DOM stops changing. */
  readonly settleQuietMs: number;
  /** Wall-clock ceiling for the whole rendered strategy. */
  readonly totalTimeoutMs: number;
  /** Largest rendered DOM accepted for extraction. */
  readonly maxHtmlBytesPerPage: number;
}

export const defaultRenderedCrawlLimits: RenderedCrawlLimits = {
  maxHtmlBytesPerPage: 2_000_000,
  pageTimeoutMs: 20_000,
  settleQuietMs: 600,
  settleTimeoutMs: 6_000,
  totalTimeoutMs: 120_000,
};

/**
 * Whether the rendered strategy may be tried after a completed static crawl.
 *
 * The rule is deliberately narrow: rendering is for a site whose HTML arrived intact and simply had
 * no text in it yet. It is never a way to retry something policy refused. A crawl that threw did
 * not reach this function at all, and a crawl that produced even one usable page keeps the cheap
 * static result, so a browser is launched only when there is nothing else left to try.
 */
export function shouldAttemptRenderedFallback(result: CrawlResult): boolean {
  return result.pages.length === 0;
}

/**
 * A failed static crawl never escalates to a browser.
 *
 * Every `CrawlPolicyError` is a decision — an invalid URL, a private address, a robots refusal, an
 * out-of-scope redirect, a size or redirect limit, an unsupported content type. Re-running any of
 * them in a browser would be using rendering to launder a policy answer, so the whole class is
 * refused, and an unrecognised failure is refused too rather than guessed at.
 */
export function shouldAttemptRenderedFallbackAfterError(): false {
  return false;
}

/** Raised when a site needs rendering and no renderer is configured for this deployment. */
export class RenderCapabilityError extends CrawlPolicyError {
  public constructor() {
    super(
      'request_failed',
      'This website needs JavaScript rendering, which is not available right now.',
    );
    this.name = 'RenderCapabilityError';
  }
}

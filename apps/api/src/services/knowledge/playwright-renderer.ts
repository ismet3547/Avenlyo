import {
  CrawlPolicyError,
  EgressProxy,
  type EgressProxyOptions,
  type RenderedCrawlLimits,
  type RenderedPage,
  type RenderedPageSource,
  defaultRenderedCrawlLimits,
} from '@avenlyo/knowledge';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

/**
 * The concrete Chromium renderer, and the only place in Avenlyo that runs third-party JavaScript.
 *
 * It lives in the trusted worker runtime rather than the web application, so no browser binary is
 * ever part of a Next.js deployment. `playwright-core` is deliberate: it never downloads a browser
 * during install, which keeps every workspace install and CI run deterministic and leaves the
 * decision to provide Chromium to the deployment that actually needs it.
 *
 * All network egress goes through the loopback proxy this class owns. Chromium is launched with a
 * proxy and with loopback bypass disabled, which is what makes the proxy unavoidable: a proxied
 * client hands the hostname to its proxy instead of resolving it, so the browser never performs DNS
 * and there is no second lookup for rebinding to exploit. Request interception below is defence in
 * depth on top of that, never a substitute for it — an intercepted-then-continued request would
 * still let Chromium resolve the destination itself.
 */

/** Resource types that carry no text. Blocking them cuts both exposure and page time. */
const blockedResourceTypes: ReadonlySet<string> = new Set(['font', 'image', 'media', 'websocket']);

export interface PlaywrightRendererOptions {
  readonly egress?: EgressProxyOptions;
  readonly executablePath?: string;
  readonly limits?: RenderedCrawlLimits;
}

/**
 * Reports whether this deployment can render at all, without launching anything.
 *
 * Capability is explicit so a host with no browser binary fails a rendered import deterministically
 * instead of discovering the gap halfway through one.
 */
export function renderedCapabilityExecutablePath(explicit?: string): string | undefined {
  if (explicit) return explicit;
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

export class PlaywrightRenderedPageSource implements RenderedPageSource {
  private readonly limits: RenderedCrawlLimits;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private proxy: EgressProxy | undefined;

  public constructor(private readonly options: PlaywrightRendererOptions = {}) {
    this.limits = options.limits ?? defaultRenderedCrawlLimits;
  }

  /** Starts the proxy and one isolated browser context for a single import. */
  public async start(): Promise<void> {
    const executablePath = renderedCapabilityExecutablePath(this.options.executablePath);
    if (!executablePath) {
      throw new CrawlPolicyError(
        'request_failed',
        'This website needs JavaScript rendering, which is not available right now.',
      );
    }
    this.proxy = new EgressProxy(this.options.egress ?? {});
    await this.proxy.listen();
    this.browser = await chromium.launch({
      args: [
        // Without this, Chromium bypasses the proxy for loopback and private hosts, which is
        // precisely the traffic the proxy exists to refuse.
        '--proxy-bypass-list=<-loopback>',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      executablePath,
      headless: true,
      // The OS sandbox stays on. Disabling it is a common workaround and would remove the last
      // barrier between hostile page JavaScript and this worker process.
      proxy: { server: this.proxy.proxyUrl },
    });
    this.context = await this.browser.newContext({
      acceptDownloads: false,
      // Certificate verification stays with Chromium, end to end, against the original hostname.
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
    });
    this.context.setDefaultNavigationTimeout(this.limits.pageTimeoutMs);
    this.context.setDefaultTimeout(this.limits.pageTimeoutMs);
    await this.context.route('**/*', (route) => {
      const request = route.request();
      const url = request.url();
      const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase();
      if (scheme !== 'http:' && scheme !== 'https:') {
        void route.abort('blockedbyclient');
        return;
      }
      if (blockedResourceTypes.has(request.resourceType())) {
        void route.abort('blockedbyclient');
        return;
      }
      void route.continue();
    });
  }

  public async render(url: URL): Promise<RenderedPage> {
    if (!this.context) throw new CrawlPolicyError('request_failed', 'The renderer is not running.');
    const page = await this.context.newPage();
    // Scoped to popups this page opens, deliberately not every page in the context: a context-wide
    // handler also fires for the page the renderer just created and closes it before it navigates.
    page.on('popup', (opened) => void opened.close().catch(() => undefined));
    try {
      await page.goto(url.toString(), {
        timeout: this.limits.pageTimeoutMs,
        // Never `networkidle`: a page that polls or streams never reaches it, and a hostile one can
        // hold the worker open indefinitely by design.
        waitUntil: 'domcontentloaded',
      });
      const html = await this.settle(page);
      return { html, url: page.url() };
    } catch (error) {
      if (error instanceof CrawlPolicyError) throw error;
      // Playwright errors carry selectors, stack traces, and internal addresses; none of that may
      // reach an operator.
      throw new CrawlPolicyError('request_failed', 'This website page could not be rendered.');
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Waits for the DOM to stop changing, then extracts — bounded on both sides.
   *
   * Polling the rendered size is deterministic in a way `networkidle` is not: a page that keeps
   * mutating simply hits the settle ceiling and is extracted as it stands, so a DOM mutation loop
   * costs a fixed amount of time rather than the whole import.
   */
  private async settle(page: Page): Promise<string> {
    const deadline = Date.now() + this.limits.settleTimeoutMs;
    let previous = '';
    let stableSince = 0;
    for (;;) {
      const html = await page.content();
      if (html === previous) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= this.limits.settleQuietMs) return html;
      } else {
        previous = html;
        stableSince = 0;
      }
      if (Date.now() >= deadline) return html;
      await page.waitForTimeout(150);
    }
  }

  /** Tears down the context, the browser, and the proxy, on success and on failure alike. */
  public async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    await this.proxy?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
    this.proxy = undefined;
  }

  /** Bounded egress counters for operational reporting. Never includes a URL. */
  public egressStats(): { origins: number; rejected: number; requests: number } {
    return this.proxy?.stats() ?? { origins: 0, rejected: 0, requests: 0 };
  }
}

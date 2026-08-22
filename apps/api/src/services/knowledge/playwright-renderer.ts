import { existsSync } from 'node:fs';

import {
  CrawlPolicyError,
  EgressProxy,
  RenderCapabilityError,
  defaultRenderedCrawlLimits,
  type EgressProxyOptions,
  type MainNavigationAuthorizer,
  type RenderOptions,
  type RenderedCrawlLimits,
  type RenderedPage,
  type RenderedPageSource,
} from '@avenlyo/knowledge';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
} from 'playwright-core';

/**
 * The concrete Chromium renderer, and the only place in Avenlyo that runs third-party JavaScript.
 *
 * It lives in the trusted worker runtime rather than the web application, so no browser binary is
 * ever part of a Next.js deployment. `playwright-core` is deliberate: it never downloads a browser
 * during install, which keeps every workspace install and CI run deterministic and leaves providing
 * Chromium to the deployment that actually needs it.
 *
 * Three different boundaries operate here and must not be confused.
 *
 * The *process* boundary is the Chromium OS sandbox, enabled explicitly in
 * `buildRenderedLaunchOptions`. It is the only control that assumes the renderer has already been
 * compromised, and it is the one that has to be stated rather than inherited: Playwright's
 * `launch` contract defaults `chromiumSandbox` to `false`.
 *
 * The *network* boundary is the loopback proxy this class owns. Chromium is launched pointing at it
 * with loopback bypass disabled, which is what makes it unavoidable for TCP: a proxied client hands
 * the hostname to its proxy instead of resolving it, so the browser never performs DNS and there is
 * no second lookup for rebinding to exploit. An HTTP proxy does not cover UDP, though, so WebRTC
 * and QUIC are disabled explicitly below — without that, page JavaScript can emit datagrams from a
 * real interface and the proxy never sees them.
 *
 * The *policy* boundary is request interception. It decides whether a top-level navigation is in
 * scope and robots-allowed before the request is made. Interception is safe for that decision and
 * useless as a network control, because a continued request is still resolved by Chromium — which
 * is exactly why it sits on top of the proxy rather than in place of it.
 */

/** Resource types that carry no text. Blocking them cuts both exposure and page time. */
const blockedResourceTypes: ReadonlySet<string> = new Set(['font', 'image', 'media', 'websocket']);

export interface RenderedBrowserLimits {
  /**
   * Every network request the browser is allowed to make for one import.
   *
   * Deliberately separate from the proxy's connection budget: one CONNECT tunnel can carry many
   * HTTP/2 requests while the proxy sees nothing but opaque TLS bytes, so a connection count is not
   * a request count. This is the ceiling that actually bounds a request storm.
   */
  readonly maxBrowserRequests: number;
}

export const defaultRenderedBrowserLimits: RenderedBrowserLimits = { maxBrowserRequests: 600 };

export interface PlaywrightRendererOptions {
  readonly browserLimits?: RenderedBrowserLimits;
  readonly egress?: EgressProxyOptions;
  readonly executablePath?: string;
  readonly limits?: RenderedCrawlLimits;
}

/**
 * Where a usable browser binary is, or nothing.
 *
 * `executablePath()` reports where a browser *would* live whether or not one was installed, so the
 * path alone is not capability. Checking the file is what turns a host without Chromium into a
 * deterministic "cannot render" answer instead of a launch failure discovered mid-import.
 */
export function renderedCapabilityExecutablePath(explicit?: string): string | undefined {
  const candidate = explicit ?? safeDefaultExecutablePath();
  return candidate && existsSync(candidate) ? candidate : undefined;
}

function safeDefaultExecutablePath(): string | undefined {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

/**
 * Chromium switches that are never negotiable, and the one place they are written down.
 *
 * Frozen and exported so a regression test can read exactly what production passes rather than a
 * copy of it. A test that restated this list would keep passing while the shipped list changed.
 */
export const renderedChromiumArgs: readonly string[] = Object.freeze([
  // Without this, Chromium bypasses the proxy for loopback and private hosts, which is
  // precisely the traffic the proxy exists to refuse.
  '--proxy-bypass-list=<-loopback>',
  // WebRTC can open UDP straight from a real interface, which an HTTP proxy never sees. This
  // is measured rather than assumed: without it, page JavaScript reaches a local UDP listener
  // through ICE candidate gathering.
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  // The pre-rename switch, kept because which one a given Chromium honours is a build
  // detail and the cost of setting both is nothing.
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--enforce-webrtc-ip-permission-check',
  // mDNS candidates are still UDP from a real interface.
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  // QUIC is the other direct-UDP transport that would sidestep an HTTP proxy.
  '--disable-quic',
  '--disable-background-networking',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
]);

/**
 * The production launch configuration, as a value.
 *
 * Extracted from `start()` deliberately. `chromiumSandbox` **defaults to `false`** in Playwright's
 * `BrowserType.launch` contract, so the OS sandbox is not something this code can leave unstated
 * and assume: omitting it ships hostile third-party JavaScript running unsandboxed in the worker
 * process. It was omitted, and the comment claiming otherwise was wrong. Building the options here
 * lets a unit test assert the real shipped value without a browser binary.
 *
 * There is deliberately no sandbox-disabled variant anywhere in this file. If a host cannot start a
 * sandboxed Chromium, the rendered capability is unavailable on that host and `start()` says so;
 * `--no-sandbox` is the workaround that would make every other control here decorative.
 */
export function buildRenderedLaunchOptions(input: {
  readonly executablePath: string;
  readonly proxyServer: string;
}): LaunchOptions {
  return {
    args: [...renderedChromiumArgs],
    // The OS sandbox. Explicit because the library default is off, and this is the last barrier
    // between hostile page JavaScript and the worker process.
    chromiumSandbox: true,
    executablePath: input.executablePath,
    headless: true,
    proxy: { server: input.proxyServer },
  };
}

type InterceptedRoute = Parameters<Parameters<BrowserContext['route']>[1]>[0];

export class PlaywrightRenderedPageSource implements RenderedPageSource {
  private readonly limits: RenderedCrawlLimits;
  private readonly browserLimits: RenderedBrowserLimits;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private proxy: EgressProxy | undefined;
  private browserRequests = 0;
  private navigationRejections = 0;
  private readonly maxNavigationRedirects = 5;
  /** The last URL a navigation was authorized for, which is where the document actually came from. */
  private lastNavigationUrl: string | undefined;
  /**
   * The authorizer for the render currently in flight. Interception is registered once for the
   * context, but the crawler supplies a fresh decision per page; renders are sequential, so one
   * slot is enough, and a navigation arriving between renders is refused rather than guessed at.
   */
  private authorizeNavigation: MainNavigationAuthorizer | undefined;

  public constructor(private readonly options: PlaywrightRendererOptions = {}) {
    this.limits = options.limits ?? defaultRenderedCrawlLimits;
    this.browserLimits = options.browserLimits ?? defaultRenderedBrowserLimits;
  }

  /** Starts the proxy and one isolated browser context for a single import. */
  public async start(): Promise<void> {
    const executablePath = renderedCapabilityExecutablePath(this.options.executablePath);
    if (!executablePath) throw new RenderCapabilityError();
    this.proxy = new EgressProxy(this.options.egress ?? {});
    await this.proxy.listen();
    try {
      this.browser = await chromium.launch(
        buildRenderedLaunchOptions({ executablePath, proxyServer: this.proxy.proxyUrl }),
      );
    } catch {
      // A host that cannot start a sandboxed Chromium has no rendered capability, and that is the
      // whole answer. Retrying without the sandbox is the one recovery this code will not perform,
      // so the failure is reported as a capability outcome rather than laundered into a launch that
      // would run hostile JavaScript unconfined. The underlying Playwright error is dropped on
      // purpose: it carries the executable path and host detail.
      throw new RenderCapabilityError();
    }
    this.context = await this.browser.newContext({
      acceptDownloads: false,
      // Certificate verification stays with Chromium, end to end, against the original hostname.
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
    });
    this.context.setDefaultNavigationTimeout(this.limits.pageTimeoutMs);
    this.context.setDefaultTimeout(this.limits.pageTimeoutMs);
    await this.context.route('**/*', (route) => void this.screen(route));
  }

  /** One decision per browser request, taken before anything reaches the network. */
  private async screen(route: InterceptedRoute): Promise<void> {
    const request = route.request();
    const url = request.url();
    const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    this.browserRequests += 1;
    if (this.browserRequests > this.browserLimits.maxBrowserRequests) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    if (blockedResourceTypes.has(request.resourceType())) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    // Only main-frame document requests are navigations. A cross-origin subresource may still be
    // fetched through the proxy; it simply never becomes a document or a crawled page.
    if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
      if (!(await this.isNavigationAllowed(url))) {
        this.navigationRejections += 1;
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await this.continueNavigation(route, url);
      return;
    }
    await route.continue().catch(() => undefined);
  }

  /**
   * Walks a top-level navigation's redirect chain in Node, authorizing every hop before it is
   * requested.
   *
   * Neither handing the request to Chromium nor fulfilling a 3xx back to it is sufficient: in both
   * cases the browser follows the redirect itself, without a second interception, so the target is
   * fetched and its JavaScript executed before Avenlyo ever sees where it went. Measured, not
   * assumed — a forbidden target server recorded exactly one request under the fulfilled-3xx
   * approach.
   *
   * So each hop is fetched here with redirects disabled, and the next URL is authorized before it
   * is requested at all. Only a final non-redirect response is handed back to the page. This is
   * still the browser's network stack, so the proxy remains the thing that resolves and pins.
   */
  private async continueNavigation(route: InterceptedRoute, initialUrl: string): Promise<void> {
    let currentUrl = initialUrl;
    try {
      for (let hop = 0; hop <= this.maxNavigationRedirects; hop += 1) {
        const response = await route.fetch({ maxRedirects: 0, url: currentUrl });
        const status = response.status();
        if (status < 300 || status > 399) {
          this.lastNavigationUrl = currentUrl;
          await route.fulfill({ response });
          return;
        }
        const location = response.headers()['location'];
        if (!location) break;
        const target = new URL(location, currentUrl);
        if (!(await this.isNavigationAllowed(target.toString()))) {
          this.navigationRejections += 1;
          break;
        }
        currentUrl = target.toString();
      }
    } catch {
      // Fall through to the same bounded refusal; nothing about the failure reaches the page.
    }
    await route.abort('blockedbyclient').catch(() => undefined);
  }

  private async isNavigationAllowed(url: string): Promise<boolean> {
    const authorize = this.authorizeNavigation;
    if (!authorize) return false;
    try {
      return await authorize(new URL(url));
    } catch {
      return false;
    }
  }

  public async render(url: URL, options: RenderOptions): Promise<RenderedPage> {
    if (!this.context) throw new CrawlPolicyError('request_failed', 'The renderer is not running.');
    // A render may never outlive what is left of the import: with 500ms remaining it gets 500ms,
    // not a fresh page timeout.
    const budget = Math.max(0, Math.min(this.limits.pageTimeoutMs, options.remainingMs));
    if (budget === 0) {
      throw new CrawlPolicyError('request_timeout', 'This website took too long to import.');
    }
    this.authorizeNavigation = options.authorizeNavigation;
    this.lastNavigationUrl = undefined;
    const page = await this.context.newPage();
    // Scoped to popups this page opens, deliberately not every page in the context: a context-wide
    // handler also fires for the page the renderer just created and closes it before it navigates.
    page.on('popup', (opened) => void opened.close().catch(() => undefined));
    const deadline = Date.now() + budget;
    try {
      await page.goto(url.toString(), { timeout: budget, waitUntil: 'domcontentloaded' });
      const html = await this.settle(page, deadline);
      // The page still reports the URL it was told to open, because the redirect chain was walked
      // here rather than by the browser. The last authorized hop is where the document came from.
      return { html, url: this.lastNavigationUrl ?? page.url() };
    } catch (error) {
      if (error instanceof CrawlPolicyError) throw error;
      // Playwright errors carry selectors, stack traces, and internal addresses; none of that may
      // reach an operator.
      throw new CrawlPolicyError('request_failed', 'This website page could not be rendered.');
    } finally {
      this.authorizeNavigation = undefined;
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Waits for the DOM to stop changing, then extracts — bounded on both sides, and never pulling an
   * unbounded string across the process boundary.
   *
   * The size is measured *inside* the browser first. Serialising a hostile multi-hundred-megabyte
   * DOM into Node just to discover it is too large is itself the attack, so an oversized document
   * is refused while it is still the browser's problem.
   *
   * Polling is deterministic in a way `networkidle` is not: a page that keeps mutating hits the
   * settle ceiling and is extracted as it stands, so a mutation loop costs a fixed amount of time.
   */
  private async settle(page: Page, deadline: number): Promise<string> {
    const settleUntil = Math.min(deadline, Date.now() + this.limits.settleTimeoutMs);
    let previousLength = -1;
    let stableSince = 0;
    for (;;) {
      // Expressed as a string so the browser-side DOM never has to enter this package's type
      // surface; the API runtime deliberately has no DOM lib.
      const length = await page.evaluate<number>('document.documentElement.outerHTML.length');
      if (length > this.limits.maxHtmlBytesPerPage) {
        throw new CrawlPolicyError(
          'body_too_large',
          'A website page exceeded the import size limit.',
        );
      }
      const now = Date.now();
      if (length === previousLength) {
        if (stableSince === 0) stableSince = now;
        if (now - stableSince >= this.limits.settleQuietMs) return page.content();
      } else {
        previousLength = length;
        stableSince = 0;
      }
      if (now >= settleUntil) return page.content();
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

  /** Bounded counters for operational reporting. Never includes a URL. */
  public stats(): {
    browserRequests: number;
    navigationRejections: number;
    proxyConnections: number;
    proxyRejections: number;
  } {
    const proxy = this.proxy?.stats() ?? { origins: 0, rejected: 0, requests: 0 };
    return {
      browserRequests: this.browserRequests,
      navigationRejections: this.navigationRejections,
      proxyConnections: proxy.requests,
      proxyRejections: proxy.rejected,
    };
  }
}

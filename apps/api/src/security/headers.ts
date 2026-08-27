import type { FastifyHelmetOptions } from '@fastify/helmet';

/**
 * Security headers for a JSON API, which is not the same problem as security headers for a website.
 *
 * The Next.js application and this API are separate surfaces with separate threat models. Most of
 * Helmet's defaults are written for an HTML document a browser renders; several of them actively
 * break a cross-origin JSON API, and switching them on so the changelog can say "Helmet is enabled"
 * would be a regression dressed as hardening. Each one below is therefore either enabled for a
 * stated reason or disabled for one.
 *
 * The constraint that decides most of it: `apps/web` embeds the chat widget in an iframe on a
 * customer's own site, and that iframe calls this API cross-origin. Anything that tells a browser to
 * refuse cross-origin reads of this API's responses breaks the product.
 */
export function buildHelmetOptions(input: {
  readonly isProduction: boolean;
}): FastifyHelmetOptions {
  return {
    /**
     * A JSON API serves no scripts, styles, frames or images, so the honest policy is that nothing
     * may be loaded from it at all. This is not the web application's CSP and deliberately does not
     * resemble one -- it is a statement that any content sniffed out of this surface has no
     * permitted source. `frame-ancestors 'none'` is the meaningful half: it says no page may frame
     * an API response, which is true and worth enforcing.
     */
    contentSecurityPolicy: {
      directives: {
        'base-uri': ["'none'"],
        'default-src': ["'none'"],
        'form-action': ["'none'"],
        'frame-ancestors': ["'none'"],
      },
      // Helmet's defaults are a document policy: they permit `script-src 'self'`, inline styles,
      // images and fonts, because they are written for a page a browser renders. Merging them into
      // an API policy would say this surface may serve scripts, which is both untrue and looser
      // than `default-src 'none'` already is. The four directives above are the whole policy.
      useDefaults: false,
    },

    /**
     * Off, and this one matters. Helmet's default is `same-origin`, which instructs the browser to
     * block cross-origin reads of these responses -- exactly what the embedded chat widget does on
     * every session, message and poll. Enabling it would break Web Chat on every customer site.
     * CORS remains the actual access control for this surface, unchanged by this phase.
     */
    crossOriginResourcePolicy: false,

    /**
     * Off for the same reason: COEP governs what a document may embed, this surface is not a
     * document, and requiring CORP on subresources would break the widget's fetches.
     */
    crossOriginEmbedderPolicy: false,

    /** Irrelevant to a non-document surface; left off rather than set to something inert. */
    crossOriginOpenerPolicy: false,

    /**
     * HSTS only in production, where the API is genuinely behind Caddy's TLS. Emitting it from a
     * local HTTP process teaches a developer's browser to refuse plain HTTP to that host, which is
     * a debugging trap and buys nothing. `preload` is not set: submitting a domain to the browser
     * preload list is a slow-to-reverse decision about the apex domain that belongs to whoever owns
     * DNS, not to this file.
     */
    hsts: input.isProduction
      ? { includeSubDomains: true, maxAge: 15_552_000, preload: false }
      : false,

    /** No referrer on outbound navigation from anything this surface returns. */
    referrerPolicy: { policy: 'no-referrer' },

    /**
     * `X-Content-Type-Options: nosniff`. The one header with unambiguous value here: it stops a
     * browser from re-interpreting a JSON response as something executable.
     */
    noSniff: true,

    /** Legacy header, but free, and consistent with `frame-ancestors 'none'` above. */
    frameguard: { action: 'deny' },

    /** Server fingerprinting: Fastify does not advertise itself, and neither should this. */
    hidePoweredBy: true,

    /** Ancient IE download behaviour; irrelevant and off. */
    ieNoOpen: false,

    /**
     * Off deliberately. `X-XSS-Protection` is deprecated and its filter has been the source of
     * real vulnerabilities; modern guidance is to send `0` or omit it, and CSP above is the actual
     * control.
     */
    xssFilter: false,

    /** No DNS prefetch policy to express from a JSON surface. */
    dnsPrefetchControl: false,

    /** Adobe cross-domain policy files do not exist here. */
    permittedCrossDomainPolicies: false,

    /** Origin-agent cluster hints are a document concern. */
    originAgentCluster: false,
  } satisfies FastifyHelmetOptions;
}

/**
 * `Permissions-Policy`, set directly rather than through Helmet.
 *
 * Helmet does not ship this header, so enabling it means writing it. The API answers no
 * browsing-context feature request, so the honest policy is an empty allowlist for the features
 * worth denying by name -- a browser that somehow renders a response from this surface gets no
 * camera, microphone, geolocation or payment capability from it.
 */
export const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(), payment=()';

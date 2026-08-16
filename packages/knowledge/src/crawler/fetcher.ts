import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { resolvePublicAddresses, type DnsResolver, type ResolvedAddress } from './dns-policy';
import { CrawlPolicyError, type CrawlLimits } from './types';
import { normalizeCrawlUrl } from './url-policy';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export interface FetchedResponse {
  readonly body: string;
  readonly bytes: number;
  readonly headers: IncomingHttpHeaders;
  readonly statusCode: number;
  readonly url: URL;
}

export interface PinnedTransport {
  request(
    url: URL,
    address: ResolvedAddress,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<FetchedResponse>;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw: unknown = headers[name];
  if (typeof raw === 'string') return raw;
  return Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : undefined;
}

function contentTypeIsHtml(headers: IncomingHttpHeaders): boolean {
  const value = headerValue(headers, 'content-type');
  return Boolean(value && /^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(value));
}

/**
 * Node's request lookup callback pins the TCP connection to an already validated DNS answer.
 * The request hostname remains intact, so Host, TLS SNI, and certificate verification all use
 * the original public hostname rather than the resolved IP address.
 */
export const nodePinnedTransport: PinnedTransport = {
  request(url, address, timeoutMs, maxBytes) {
    return new Promise((resolve, reject) => {
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const abort = () => {
        req.destroy(
          new CrawlPolicyError('request_timeout', 'The website did not respond in time.'),
        );
      };
      const req = request(
        url,
        {
          headers: {
            'user-agent': 'AvenlyoBot/0.1 (+https://avenlyo.com)',
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          },
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
          rejectUnauthorized: true,
          servername: url.hostname,
          timeout: timeoutMs,
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              req.destroy(
                new CrawlPolicyError(
                  'body_too_large',
                  'A website page exceeded the import size limit.',
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            resolve({
              body: Buffer.concat(chunks).toString('utf8'),
              bytes,
              headers: response.headers,
              statusCode: response.statusCode ?? 0,
              url,
            });
          });
        },
      );
      req.once('error', (error: Error) => {
        if (error instanceof CrawlPolicyError) reject(error);
        else reject(new CrawlPolicyError('request_failed', 'The website could not be fetched.'));
      });
      req.once('timeout', abort);
      req.end();
    });
  },
};

export interface SecureFetcherOptions {
  readonly dnsResolver?: DnsResolver;
  readonly limits: CrawlLimits;
  readonly transport?: PinnedTransport;
}

export interface FetchOptions {
  readonly requireHtml?: boolean;
}

export class SecureFetcher {
  private readonly dnsResolver: DnsResolver | undefined;
  private readonly transport: PinnedTransport;

  public constructor(private readonly options: SecureFetcherOptions) {
    this.dnsResolver = options.dnsResolver;
    this.transport = options.transport ?? nodePinnedTransport;
  }

  public async fetch(
    input: string | URL,
    fetchOptions: FetchOptions = {},
  ): Promise<FetchedResponse> {
    let current = normalizeCrawlUrl(input.toString());
    for (
      let redirectCount = 0;
      redirectCount <= this.options.limits.maxRedirects;
      redirectCount += 1
    ) {
      const addresses = await resolvePublicAddresses(current.hostname, this.dnsResolver);
      const response = await this.transport.request(
        current,
        addresses[0]!,
        this.options.limits.requestTimeoutMs,
        this.options.limits.maxHtmlBytesPerPage,
      );

      if (redirectStatuses.has(response.statusCode)) {
        const target = headerValue(response.headers, 'location');
        if (!target)
          throw new CrawlPolicyError('request_failed', 'The website returned an invalid redirect.');
        if (redirectCount === this.options.limits.maxRedirects) {
          throw new CrawlPolicyError('redirect_limit', 'The website redirected too many times.');
        }
        current = normalizeCrawlUrl(target, current.toString());
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new CrawlPolicyError(
          'request_failed',
          'The website returned an unsuccessful response.',
        );
      }
      if ((fetchOptions.requireHtml ?? true) && !contentTypeIsHtml(response.headers)) {
        throw new CrawlPolicyError(
          'invalid_content_type',
          'Only HTML website pages can be imported.',
        );
      }
      return response;
    }
    throw new CrawlPolicyError('redirect_limit', 'The website redirected too many times.');
  }
}

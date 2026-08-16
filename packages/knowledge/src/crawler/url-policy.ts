import { isIP } from 'node:net';

import { getDomain } from 'tldts';

import { CrawlPolicyError } from './types';

const trackingParameters = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
]);

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local');
}

function assertAllowedUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CrawlPolicyError('invalid_url', 'Only public HTTP and HTTPS URLs can be imported.');
  }

  if (url.username || url.password) {
    throw new CrawlPolicyError('invalid_url', 'Website URLs cannot include credentials.');
  }

  const hostname = normalizedHostname(url.hostname);
  const addressLiteral =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (!hostname || isLocalHostname(hostname) || isIP(addressLiteral) !== 0) {
    throw new CrawlPolicyError('invalid_url', 'Website URLs must use a public DNS hostname.');
  }

  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new CrawlPolicyError('invalid_url', 'Only standard HTTP and HTTPS ports are allowed.');
  }
}

/** Converts a link to a bounded crawl identity. Query strings are deliberately excluded. */
export function normalizeCrawlUrl(input: string, base?: string): URL {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    throw new CrawlPolicyError('invalid_url', 'Enter a valid public website URL.');
  }

  assertAllowedUrl(url);
  url.hostname = normalizedHostname(url.hostname);
  url.hash = '';
  [...url.searchParams.keys()].forEach((key) => {
    if (trackingParameters.has(key.toLowerCase())) url.searchParams.delete(key);
  });
  // Avoid unbounded calendar, search, and filter permutations during the MVP crawl.
  url.search = '';

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }

  return url;
}

export function registrableDomain(url: URL): string {
  const domain = getDomain(url.hostname, { allowPrivateDomains: false });
  if (!domain) {
    throw new CrawlPolicyError(
      'invalid_url',
      'The website hostname must have a public registrable domain.',
    );
  }
  return domain;
}

export function isInCrawlScope(candidate: URL, rootDomain: string): boolean {
  return registrableDomain(candidate) === rootDomain;
}

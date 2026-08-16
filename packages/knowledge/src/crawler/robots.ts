import robotsParser from 'robots-parser';

import { normalizeCrawlUrl } from './url-policy';

const crawlerUserAgent = 'AvenlyoBot/0.1';

export interface RobotsPolicy {
  isAllowed(candidateUrl: URL): boolean;
}

/**
 * Wraps a standards-oriented parser so grouped user agents, wildcard rules, and
 * RFC-style path matching stay out of the crawler control flow.
 */
export function parseRobots(robotsUrl: URL, contents: string): RobotsPolicy {
  const parsed = robotsParser(robotsUrl.toString(), contents);
  return {
    isAllowed(candidateUrl) {
      return parsed.isAllowed(candidateUrl.toString(), crawlerUserAgent) !== false;
    },
  };
}

export function robotsUrlFor(candidateUrl: URL): URL {
  return normalizeCrawlUrl('/robots.txt', candidateUrl.toString());
}

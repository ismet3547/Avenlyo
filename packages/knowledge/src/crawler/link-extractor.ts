import { load } from 'cheerio';

import { normalizeCrawlUrl } from './url-policy';

export function extractLinks(html: string, baseUrl: string): readonly URL[] {
  const $ = load(html);
  const links = new Map<string, URL>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    try {
      const url = normalizeCrawlUrl(href, baseUrl);
      links.set(url.toString(), url);
    } catch {
      // Uncrawlable and non-web links are intentionally ignored.
    }
  });
  return [...links.values()];
}

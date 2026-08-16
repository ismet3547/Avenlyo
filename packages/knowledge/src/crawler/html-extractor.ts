import { load } from 'cheerio';

export interface ExtractedHtml {
  readonly content: string;
  readonly title: string;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractHtml(html: string): ExtractedHtml {
  const $ = load(html);
  $('script, style, noscript, svg, canvas, iframe, form, nav, footer, aside').remove();
  const title =
    normalizeText($('title').first().text()) ||
    normalizeText($('h1').first().text()) ||
    'Untitled page';
  const root = $('main').first().length
    ? $('main').first()
    : $('article').first().length
      ? $('article').first()
      : $('body').first();
  const blocks: string[] = [];

  root.find('h1, h2, h3, p, li').each((_, element) => {
    const text = normalizeText($(element).text());
    if (!text) return;
    const tag = element.tagName.toLowerCase();
    if (tag === 'h1') blocks.push(`# ${text}`);
    else if (tag === 'h2') blocks.push(`## ${text}`);
    else if (tag === 'h3') blocks.push(`### ${text}`);
    else if (tag === 'li') blocks.push(`- ${text}`);
    else blocks.push(text);
  });

  return { content: blocks.join('\n\n').trim(), title };
}

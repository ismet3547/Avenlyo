import { WebsiteCrawler } from '../crawler/crawler';

import type { KnowledgeImportExecution } from './types';

/** Boundary for today's synchronous runner and a future queued worker. */
export class KnowledgeImportRunner {
  public constructor(private readonly crawler: WebsiteCrawler = new WebsiteCrawler()) {}

  public async run(rootUrl: string): Promise<KnowledgeImportExecution> {
    return this.crawler.crawl(rootUrl);
  }
}

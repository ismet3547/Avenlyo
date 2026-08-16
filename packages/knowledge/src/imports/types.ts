import type { CrawledPage } from '../crawler/types';

export type KnowledgeImportStatus =
  'pending' | 'running' | 'awaiting_review' | 'publishing' | 'completed' | 'failed';

export type ImportedPage = CrawledPage;

export interface KnowledgeImportExecution {
  readonly pages: readonly ImportedPage[];
  readonly pagesDiscovered: number;
  readonly pagesSkipped: number;
  readonly rootUrl: string;
}

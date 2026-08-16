export type KnowledgeImportStatus =
  'pending' | 'running' | 'awaiting_review' | 'publishing' | 'completed' | 'failed';

export interface KnowledgeOverview {
  readonly draftDocuments: number;
  readonly errorMessage: string | null;
  readonly finishedAt: string | null;
  readonly id: string;
  readonly pagesDiscovered: number;
  readonly pagesImported: number;
  readonly readyDocuments: number;
  readonly rootUrl: string;
  readonly startedAt: string | null;
  readonly status: KnowledgeImportStatus;
}

export interface KnowledgeDraftDocument {
  readonly canonicalUrl: string;
  readonly content: string;
  readonly id: string;
  readonly included: boolean;
  readonly status: 'draft' | 'ready' | 'archived';
  readonly title: string;
}

export interface KnowledgeSearchMatch {
  readonly chunkId: string;
  readonly content: string;
  readonly documentId: string;
  readonly similarity: number;
  readonly sourceUrl: string;
  readonly title: string;
}

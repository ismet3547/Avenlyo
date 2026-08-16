export interface KnowledgeMatch {
  readonly chunkId: string;
  readonly content: string;
  readonly documentId: string;
  readonly similarity: number;
  readonly sourceUrl: string | null;
  readonly title: string;
}

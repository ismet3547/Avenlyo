import type { KnowledgeDraftDocument, KnowledgeImportStatus, KnowledgeOverview } from './types';

/**
 * What the review page is looking at, decided in one place.
 *
 * The page used to infer everything from the document list, which was safe only while the web
 * request did the crawling itself: an import with no documents could only mean an import that
 * found nothing. With a durable worker it far more often means the import has not run yet, and
 * telling an operator "no reviewable pages" about work that is still queued is simply wrong.
 */
export type KnowledgeReviewView =
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'progress'; readonly status: 'pending' | 'running' }
  | {
      readonly canPublish: boolean;
      readonly draftCount: number;
      readonly includedCount: number;
      readonly kind: 'review';
    };

export const KNOWLEDGE_EMPTY_IMPORT_MESSAGE =
  'No usable knowledge text could be extracted from this website.';

export const KNOWLEDGE_IMPORT_FAILED_MESSAGE = 'This website import could not be completed.';

/**
 * Whether the drafts are worth reading yet.
 *
 * A queued, running, or failed import has nothing to review, and asking for its documents is a
 * database round trip whose only possible answer is an empty list.
 */
export function knowledgeReviewNeedsDocuments(status: KnowledgeImportStatus): boolean {
  return status !== 'pending' && status !== 'running' && status !== 'failed';
}

export function describeKnowledgeReview(input: {
  readonly documents: readonly KnowledgeDraftDocument[];
  readonly record: KnowledgeOverview;
}): KnowledgeReviewView {
  const { documents, record } = input;
  if (record.status === 'pending' || record.status === 'running') {
    return { kind: 'progress', status: record.status };
  }
  if (record.status === 'failed') {
    // Whatever the worker recorded is already a bounded, operator-safe sentence; there is never a
    // provider error, an address, or a stack behind it.
    return { kind: 'failed', message: record.errorMessage ?? KNOWLEDGE_IMPORT_FAILED_MESSAGE };
  }
  const drafts = documents.filter((document) => document.status === 'draft');
  if (drafts.length === 0) return { kind: 'empty' };
  const includedCount = drafts.filter((document) => document.included).length;
  return {
    // Publishing nothing would reserve the import, call an embedding provider with an empty batch,
    // and release again, so the control stays inert until at least one draft is included.
    canPublish: includedCount > 0,
    draftCount: drafts.length,
    includedCount,
    kind: 'review',
  };
}

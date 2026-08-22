import { describe, expect, it } from 'vitest';

import {
  describeKnowledgeReview,
  knowledgeReviewNeedsDocuments,
  KNOWLEDGE_EMPTY_IMPORT_MESSAGE,
} from './review-view';
import type { KnowledgeDraftDocument, KnowledgeImportStatus, KnowledgeOverview } from './types';

function record(overrides: Partial<KnowledgeOverview> = {}): KnowledgeOverview {
  return {
    draftDocuments: 0,
    errorMessage: null,
    finishedAt: null,
    id: '10000000-0000-4000-8000-000000000001',
    pagesDiscovered: 0,
    pagesImported: 0,
    readyDocuments: 0,
    rootUrl: 'https://clinic.test/',
    startedAt: null,
    status: 'pending',
    ...overrides,
  };
}

function draft(overrides: Partial<KnowledgeDraftDocument> = {}): KnowledgeDraftDocument {
  return {
    canonicalUrl: 'https://clinic.test/services',
    content: 'Wellness visits, vaccinations, and dental care for every patient.',
    id: '20000000-0000-4000-8000-000000000001',
    included: true,
    status: 'draft',
    title: 'Services',
    ...overrides,
  };
}

describe('an import that has not run yet', () => {
  it.each(['pending', 'running'] as const)('shows progress rather than an empty result', (status) => {
    // The queue is the normal state right after the form redirects here. Reporting "no pages" for
    // an import the worker has not reached yet is the failure this replaced.
    const view = describeKnowledgeReview({ documents: [], record: record({ status }) });

    expect(view).toEqual({ kind: 'progress', status });
  });

  it.each(['pending', 'running', 'failed'] as const)(
    'does not read drafts for a %s import',
    (status: KnowledgeImportStatus) => {
      expect(knowledgeReviewNeedsDocuments(status)).toBe(false);
    },
  );

  it('reads drafts once the worker has finished with it', () => {
    expect(knowledgeReviewNeedsDocuments('awaiting_review')).toBe(true);
    expect(knowledgeReviewNeedsDocuments('completed')).toBe(true);
  });
});

describe('an import that failed', () => {
  it('shows the safe message the worker recorded', () => {
    const view = describeKnowledgeReview({
      documents: [],
      record: record({
        errorMessage: 'This website needs JavaScript rendering, which is not available right now.',
        status: 'failed',
      }),
    });

    expect(view).toEqual({
      kind: 'failed',
      message: 'This website needs JavaScript rendering, which is not available right now.',
    });
  });

  it('still says something useful when no message was recorded', () => {
    const view = describeKnowledgeReview({ documents: [], record: record({ status: 'failed' }) });

    expect(view.kind).toBe('failed');
    expect(view).toMatchObject({ message: 'This website import could not be completed.' });
  });
});

describe('an import that finished', () => {
  it('reports a completed crawl that found nothing usable', () => {
    // The crawl succeeded, so this is not a failure: the site simply has no extractable text.
    const view = describeKnowledgeReview({
      documents: [],
      record: record({ status: 'awaiting_review' }),
    });

    expect(view).toEqual({ kind: 'empty' });
    expect(KNOWLEDGE_EMPTY_IMPORT_MESSAGE).toBe(
      'No usable knowledge text could be extracted from this website.',
    );
  });

  it('becomes reviewable with a publishable count', () => {
    const view = describeKnowledgeReview({
      documents: [
        draft({ id: 'a' }),
        draft({ id: 'b', included: false }),
        draft({ id: 'c', included: true }),
      ],
      record: record({ pagesImported: 3, status: 'awaiting_review' }),
    });

    expect(view).toEqual({ canPublish: true, draftCount: 3, includedCount: 2, kind: 'review' });
  });

  it('keeps publishing inert when every draft is excluded', () => {
    const view = describeKnowledgeReview({
      documents: [draft({ included: false })],
      record: record({ status: 'awaiting_review' }),
    });

    // Publishing zero documents would reserve the import and call an embedding provider with an
    // empty batch, only to release it again.
    expect(view).toMatchObject({ canPublish: false, includedCount: 0, kind: 'review' });
  });

  it('ignores already published documents when deciding there is nothing to review', () => {
    const view = describeKnowledgeReview({
      documents: [draft({ status: 'ready' })],
      record: record({ status: 'completed' }),
    });

    expect(view).toEqual({ kind: 'empty' });
  });
});

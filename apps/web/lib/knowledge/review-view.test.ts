import { describe, expect, it } from 'vitest';

import {
  describeKnowledgeReview,
  knowledgeReviewNeedsDocuments,
  KNOWLEDGE_EMPTY_IMPORT_MESSAGE,
  KNOWLEDGE_PUBLISHED_IMPORT_MESSAGE,
  KNOWLEDGE_PUBLISHED_WITHOUT_DOCUMENTS_MESSAGE,
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

  it('still reports a genuinely empty awaiting_review import as empty', () => {
    // The one state the empty message is for: the crawl finished, the worker wrote nothing, and
    // there is no publication to describe instead.
    const view = describeKnowledgeReview({
      documents: [],
      record: record({ status: 'awaiting_review' }),
    });

    expect(view).toEqual({ kind: 'empty' });
  });
});

describe('an import that was published', () => {
  // Found in real staging: publishing succeeded, eight documents went live, and the review page
  // said "No usable knowledge text could be extracted from this website." Publishing turns every
  // included draft into `ready` and every excluded one into `archived`, so a completed import has
  // zero drafts by construction -- and the draft count was the only thing the view looked at.
  it('reports the publication rather than an extraction failure', () => {
    const view = describeKnowledgeReview({
      documents: [
        draft({ id: 'a', status: 'ready' }),
        draft({ id: 'b', status: 'ready' }),
        draft({ id: 'c', included: false, status: 'archived' }),
      ],
      record: record({ pagesImported: 3, readyDocuments: 2, status: 'completed' }),
    });

    expect(view).toEqual({ kind: 'published', readyCount: 2 });
  });

  it('never produces the extraction-empty message merely because no drafts remain', () => {
    const view = describeKnowledgeReview({
      documents: [draft({ status: 'ready' })],
      record: record({ status: 'completed' }),
    });

    expect(view.kind).not.toBe('empty');
    expect(view.kind).toBe('published');
  });

  it('offers nothing to edit or publish', () => {
    const view = describeKnowledgeReview({
      documents: [draft({ status: 'ready' }), draft({ id: 'b', status: 'ready' })],
      record: record({ status: 'completed' }),
    });

    // A completed import is finished. Re-opening it for editing would let an operator change text
    // whose embeddings have already been written, so the view carries no publish affordance at all.
    expect(view).not.toHaveProperty('canPublish');
    expect(view).not.toHaveProperty('draftCount');
  });

  it('tells the truth about a completed import with nothing published', () => {
    // Not a state the publish path can reach -- it publishes at least one document or fails. If it
    // is ever observed, claiming extraction failed would be a guess, and the wrong one.
    const view = describeKnowledgeReview({ documents: [], record: record({ status: 'completed' }) });

    expect(view).toEqual({ kind: 'published', readyCount: 0 });
    expect(KNOWLEDGE_PUBLISHED_WITHOUT_DOCUMENTS_MESSAGE).not.toBe(KNOWLEDGE_EMPTY_IMPORT_MESSAGE);
  });

  it('does not count drafts or archived documents as published', () => {
    const view = describeKnowledgeReview({
      documents: [
        draft({ id: 'a', status: 'ready' }),
        draft({ id: 'b', status: 'draft' }),
        draft({ id: 'c', status: 'archived' }),
      ],
      record: record({ status: 'completed' }),
    });

    expect(view).toEqual({ kind: 'published', readyCount: 1 });
  });

  it('describes publication in words that do not claim extraction failed', () => {
    expect(KNOWLEDGE_PUBLISHED_IMPORT_MESSAGE).toContain('published');
    expect(KNOWLEDGE_PUBLISHED_IMPORT_MESSAGE).not.toContain('No usable');
  });
});

describe('the review state machine covers every import status', () => {
  const statuses: readonly KnowledgeImportStatus[] = [
    'pending',
    'running',
    'awaiting_review',
    'publishing',
    'completed',
    'failed',
  ];

  it.each(statuses)('answers %s with a defined view', (status) => {
    const view = describeKnowledgeReview({
      documents: [draft({ status: status === 'completed' ? 'ready' : 'draft' })],
      record: record({ status }),
    });

    expect(view.kind).toBeDefined();
  });

  it('leaves the states that were already right alone', () => {
    // Guards the shape of this change: only `completed` was rerouted, and a regression that also
    // caught `publishing` would silently stop showing an operator the drafts being published.
    expect(
      describeKnowledgeReview({ documents: [], record: record({ status: 'pending' }) }).kind,
    ).toBe('progress');
    expect(
      describeKnowledgeReview({ documents: [], record: record({ status: 'running' }) }).kind,
    ).toBe('progress');
    expect(
      describeKnowledgeReview({ documents: [], record: record({ status: 'failed' }) }).kind,
    ).toBe('failed');
    expect(
      describeKnowledgeReview({ documents: [draft()], record: record({ status: 'awaiting_review' }) })
        .kind,
    ).toBe('review');
    expect(
      describeKnowledgeReview({ documents: [draft()], record: record({ status: 'publishing' }) })
        .kind,
    ).toBe('review');
  });
});

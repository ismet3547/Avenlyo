import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DraftDocumentForm } from '@/components/knowledge/draft-document-form';
import { ImportProgress } from '@/components/knowledge/import-progress';
import { PublishKnowledgeButton } from '@/components/knowledge/publish-knowledge-button';
import {
  describeKnowledgeReview,
  knowledgeReviewNeedsDocuments,
  KNOWLEDGE_EMPTY_IMPORT_MESSAGE,
} from '@/lib/knowledge/review-view';
import { loadKnowledgeImport, loadKnowledgeReview } from '@/lib/knowledge/service';
import type { KnowledgeDraftDocument } from '@/lib/knowledge/types';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

interface KnowledgeReviewPageProps {
  params: Promise<{ id: string }>;
}

export default async function KnowledgeReviewPage({ params }: KnowledgeReviewPageProps) {
  const { id } = await params;
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member') notFound();
  const auth = await getRequiredAuthContext();
  if (!auth) notFound();

  // The import row is this page's subject now, not the documents. An import reached straight from
  // the form has none yet, and reading state from a missing document list would tell an operator
  // "nothing here" about work that is running perfectly well.
  const record = await loadKnowledgeImport(auth.supabase, id).catch(() => null);
  if (!record) notFound();

  let documents: readonly KnowledgeDraftDocument[] = [];
  if (knowledgeReviewNeedsDocuments(record.status)) {
    try {
      documents = await loadKnowledgeReview(auth.supabase, id);
    } catch {
      notFound();
    }
  }
  const view = describeKnowledgeReview({ documents, record });

  return (
    <section className="max-w-4xl">
      <Link
        className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
        href="/dashboard/ai-front-office/knowledge"
      >
        ← Business Knowledge
      </Link>
      <p className="mt-7 font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Import review
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Review website pages
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        Edit the cleaned text, exclude pages you do not want used, then publish only the included
        drafts. Publishing creates embeddings; it never generates customer-facing answers.
      </p>
      <p className="mt-2 truncate text-sm text-muted-foreground">{record.rootUrl}</p>

      {view.kind === 'progress' ? (
        <div className="mt-6">
          <ImportProgress status={view.status} />
        </div>
      ) : null}

      {view.kind === 'failed' ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
          <p className="font-semibold text-red-900">This website could not be imported</p>
          <p className="mt-2 text-sm leading-6 text-red-800">{view.message}</p>
          <p className="mt-3 text-sm leading-6 text-red-800">
            Return to Business Knowledge to try a different address.
          </p>
        </div>
      ) : null}

      {view.kind === 'empty' ? (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-white p-6 shadow-sm">
          <p className="text-sm leading-6 text-muted-foreground">
            {KNOWLEDGE_EMPTY_IMPORT_MESSAGE} Return to Business Knowledge to try a different
            address, or write the knowledge yourself.
          </p>
        </div>
      ) : null}

      {view.kind === 'review' ? (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-white p-4 shadow-sm">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-ink">{view.includedCount}</span> included of{' '}
              {view.draftCount} draft pages
            </p>
            <PublishKnowledgeButton disabled={!view.canPublish} importId={id} />
          </div>
          <div className="mt-6 space-y-4">
            {documents.map((document) => (
              <DraftDocumentForm document={document} importId={id} key={document.id} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

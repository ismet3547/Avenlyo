import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DraftDocumentForm } from '@/components/knowledge/draft-document-form';
import { PublishKnowledgeButton } from '@/components/knowledge/publish-knowledge-button';
import { loadKnowledgeReview } from '@/lib/knowledge/service';
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
  let documents;
  try {
    documents = await loadKnowledgeReview(auth.supabase, id);
  } catch {
    notFound();
  }

  const draftCount = documents.filter((document) => document.status === 'draft').length;
  const includedCount = documents.filter(
    (document) => document.status === 'draft' && document.included,
  ).length;

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
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-white p-4 shadow-sm">
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-ink">{includedCount}</span> included of {draftCount}{' '}
          draft pages
        </p>
        <PublishKnowledgeButton importId={id} disabled={includedCount === 0} />
      </div>
      <div className="mt-6 space-y-4">
        {documents.length ? (
          documents.map((document) => (
            <DraftDocumentForm document={document} importId={id} key={document.id} />
          ))
        ) : (
          <p className="rounded-xl border border-dashed border-border bg-white p-6 text-sm text-muted-foreground">
            This import has no reviewable pages. Return to Business Knowledge to start another
            import.
          </p>
        )}
      </div>
    </section>
  );
}

'use client';

import { useActionState } from 'react';

import { updateKnowledgeDraftAction } from '@/app/dashboard/ai-front-office/knowledge/actions';
import { knowledgeInitialActionState } from '@/app/dashboard/ai-front-office/knowledge/action-state';
import type { KnowledgeDraftDocument } from '@/lib/knowledge/types';

export function DraftDocumentForm({
  document,
  importId,
}: {
  document: KnowledgeDraftDocument;
  importId: string;
}) {
  const [state, action, isPending] = useActionState(
    updateKnowledgeDraftAction,
    knowledgeInitialActionState,
  );
  return (
    <article className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <form action={action} className="space-y-4">
        <input name="documentId" type="hidden" value={document.id} />
        <input name="importId" type="hidden" value={importId} />
        <div className="flex items-center justify-between gap-4">
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
            <input
              defaultChecked={document.included}
              disabled={isPending}
              name="included"
              type="checkbox"
            />
            Include in published knowledge
          </label>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {document.status}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{document.canonicalUrl}</p>
        <label className="block text-sm font-medium text-ink">
          Title
          <input
            className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            defaultValue={document.title}
            disabled={isPending}
            name="title"
            required
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Cleaned text
          <textarea
            className="mt-1.5 min-h-40 w-full rounded-lg border border-border px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            defaultValue={document.content}
            disabled={isPending}
            name="content"
            required
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-ink transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isPending}
            type="submit"
          >
            {isPending ? 'Saving…' : 'Save draft'}
          </button>
          {state.status !== 'idle' ? (
            <p
              className={
                state.status === 'error' ? 'text-sm text-red-700' : 'text-sm text-emerald-700'
              }
            >
              {state.message}
            </p>
          ) : null}
        </div>
      </form>
    </article>
  );
}

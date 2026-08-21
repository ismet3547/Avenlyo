'use client';

import { useActionState } from 'react';

import { searchKnowledgeAction } from '@/app/dashboard/ai-front-office/knowledge/actions';
import { knowledgeInitialActionState } from '@/app/dashboard/ai-front-office/knowledge/action-state';

export function KnowledgeSearch({ disabled }: { disabled: boolean }) {
  const [state, action, isPending] = useActionState(
    searchKnowledgeAction,
    knowledgeInitialActionState,
  );
  return (
    <section className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.16em] text-primary">
        Retrieval check
      </p>
      <h2 className="mt-2 text-lg font-semibold tracking-tight text-ink">Test your knowledge</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Search published source chunks only. Avenlyo does not generate an answer here.
      </p>
      <form action={action} className="mt-4 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-muted"
          disabled={disabled || isPending}
          name="question"
          placeholder="Do you offer dental cleaning?"
          required
        />
        <button
          className="rounded-lg border border-ink px-3 py-2 text-sm font-semibold text-ink transition hover:bg-ink hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || isPending}
          type="submit"
        >
          {isPending ? 'Searching…' : 'Search'}
        </button>
      </form>
      {state.status === 'error' ? (
        <p className="mt-3 text-sm text-red-700">{state.message}</p>
      ) : null}
      {state.status === 'success' ? (
        <div className="mt-5 space-y-3">
          {state.matches?.length ? (
            state.matches.map((match) => (
              <article className="border-l-2 border-primary/50 pl-3" key={match.chunkId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-ink">{match.title}</p>
                  <p className="font-utility text-xs text-muted-foreground">
                    Similarity: {match.similarity.toFixed(3)}
                  </p>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{match.sourceUrl}</p>
                <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                  {match.content}
                </p>
              </article>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No published knowledge matched that question.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

'use client';

import { useActionState } from 'react';

import {
  knowledgeInitialActionState,
  publishKnowledgeImportAction,
} from '@/app/dashboard/ai-front-office/knowledge/actions';

export function PublishKnowledgeButton({
  importId,
  disabled,
}: {
  importId: string;
  disabled: boolean;
}) {
  const [state, action, isPending] = useActionState(
    publishKnowledgeImportAction,
    knowledgeInitialActionState,
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input name="importId" type="hidden" value={importId} />
      <button
        className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || isPending}
        type="submit"
      >
        {isPending ? 'Publishing…' : 'Publish knowledge'}
      </button>
      {state.status !== 'idle' ? (
        <p
          className={state.status === 'error' ? 'text-sm text-red-700' : 'text-sm text-emerald-700'}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

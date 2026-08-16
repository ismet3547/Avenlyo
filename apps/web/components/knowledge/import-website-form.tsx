'use client';

import { useActionState } from 'react';

import {
  knowledgeInitialActionState,
  startKnowledgeImportAction,
} from '@/app/dashboard/ai-front-office/knowledge/actions';

export function ImportWebsiteForm({
  defaultUrl,
  disabled,
}: {
  defaultUrl: string;
  disabled: boolean;
}) {
  const [state, action, isPending] = useActionState(
    startKnowledgeImportAction,
    knowledgeInitialActionState,
  );

  return (
    <form action={action} className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-start">
      <label className="sr-only" htmlFor="knowledge-root-url">
        Website URL
      </label>
      <input
        className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-muted"
        defaultValue={defaultUrl}
        disabled={disabled || isPending}
        id="knowledge-root-url"
        name="rootUrl"
        placeholder="https://yourbusiness.com"
        required
        type="url"
      />
      <button
        className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || isPending}
        type="submit"
      >
        {isPending ? 'Importing website…' : defaultUrl ? 'Rescan website' : 'Import website'}
      </button>
      {state.status === 'error' ? (
        <p className="text-sm text-red-700 sm:col-span-2">{state.message}</p>
      ) : null}
    </form>
  );
}

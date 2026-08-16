import Link from 'next/link';
import { BookOpenCheck, ShieldCheck, TestTube2 } from 'lucide-react';

import { AgentTestConsole } from '@/components/agent/agent-test-console';
import { knowledgeServerEnv } from '@/lib/knowledge/config';
import { loadKnowledgeOverview } from '@/lib/knowledge/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

export default async function AgentTestPage() {
  const workspace = await requireCompletedWorkspace();
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const auth = await getRequiredAuthContext();
  const overview = auth ? await loadKnowledgeOverview(auth.supabase) : [];
  const hasPublishedKnowledge = overview.some((item) => item.readyDocuments > 0);

  if (!canManage) {
    return (
      <section className="max-w-3xl">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          AI Front Office / Agent Test
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Agent Test is owner/admin-only
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Ask an organization owner or admin to run private AI Front Office simulations.
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        AI Front Office / Agent Test
      </p>
      <div className="mt-3 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
            Test the AI Front Office
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Run controlled, internal-only customer simulations. The agent can search approved
            knowledge and request a human handoff; it cannot book, message, or call anyone.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900">
          <ShieldCheck aria-hidden="true" className="size-3.5" /> Test mode only
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <TestTube2 aria-hidden="true" className="size-5 text-primary" />
          <h2 className="mt-4 font-semibold text-ink">Internal simulation</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            No outbound customer activity.
          </p>
        </article>
        <article className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <BookOpenCheck aria-hidden="true" className="size-5 text-primary" />
          <h2 className="mt-4 font-semibold text-ink">Approved knowledge only</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Draft and archived sources are never retrieved.
          </p>
        </article>
        <article className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
          <h2 className="mt-4 font-semibold text-ink">Bounded tools</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Search business knowledge or request human help.
          </p>
        </article>
      </div>

      {!hasPublishedKnowledge ? (
        <p className="mt-6 rounded-xl border border-border bg-white p-4 text-sm text-muted-foreground shadow-sm">
          Publish approved website knowledge to let the agent answer business-specific questions.{' '}
          <Link
            className="font-semibold text-primary underline-offset-4 hover:underline"
            href="/dashboard/ai-front-office/knowledge"
          >
            Open Business Knowledge
          </Link>
        </p>
      ) : null}

      <div className="mt-6">
        <AgentTestConsole
          available={Boolean(knowledgeServerEnv.OPENAI_API_KEY)}
          hasPublishedKnowledge={hasPublishedKnowledge}
        />
      </div>
    </section>
  );
}

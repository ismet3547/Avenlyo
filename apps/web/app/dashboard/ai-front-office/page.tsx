import Link from 'next/link';
import { BookOpenCheck, PhoneCall, TestTube2 } from 'lucide-react';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';

export default async function AiFrontOfficePage() {
  await requireCompletedWorkspace();

  return (
    <section className="max-w-4xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        AI Front Office
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Controlled AI operations
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        Prepare approved business knowledge, then run internal AI Front Office tests with a small,
        auditable tool set.
      </p>
      <div className="mt-8 grid gap-5 sm:grid-cols-3">
        <Link
          className="rounded-2xl border border-border bg-white p-6 shadow-sm transition hover:border-primary/50 hover:shadow-md"
          href="/dashboard/ai-front-office/knowledge"
        >
          <BookOpenCheck aria-hidden="true" className="size-6 text-primary" />
          <h2 className="mt-4 text-lg font-semibold text-ink">Business Knowledge</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Import, review, and publish the website facts the agent may retrieve.
          </p>
        </Link>
        <Link
          className="rounded-2xl border border-border bg-white p-6 shadow-sm transition hover:border-primary/50 hover:shadow-md"
          href="/dashboard/ai-front-office/voice"
        >
          <PhoneCall aria-hidden="true" className="size-6 text-primary" />
          <h2 className="mt-4 text-lg font-semibold text-ink">Inbound Voice</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Configure the trusted number, human transfer, and live call visibility.
          </p>
        </Link>
        <Link
          className="rounded-2xl border border-border bg-white p-6 shadow-sm transition hover:border-primary/50 hover:shadow-md"
          href="/dashboard/ai-front-office/test-agent"
        >
          <TestTube2 aria-hidden="true" className="size-6 text-primary" />
          <h2 className="mt-4 text-lg font-semibold text-ink">Test Agent</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Simulate customer conversations without sending messages or triggering live operations.
          </p>
        </Link>
      </div>
    </section>
  );
}

import { CheckCircle2 } from 'lucide-react';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default async function DashboardHomePage() {
  const context = await requireCompletedWorkspace();

  return (
    <section className="max-w-4xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        {context.locationName ?? 'Workspace'}
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        {getGreeting()}, {context.organizationName}.
      </h1>
      <div className="mt-8 flex max-w-2xl gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5">
        <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-emerald-700" />
        <div>
          <p className="font-semibold text-emerald-950">Your workspace foundation is ready.</p>
          <p className="mt-1 text-sm leading-6 text-emerald-900/75">
            Your organization, primary location, and industry pack are saved. Conversations and AI
            Front Office configuration arrive in later phases.
          </p>
        </div>
      </div>
    </section>
  );
}
